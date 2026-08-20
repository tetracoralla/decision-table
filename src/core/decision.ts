import type {
  DecisionResult,
  DecisionRule,
  EvaluateDecisionRequest,
  Explanation,
  InputDefinition,
  JsonValue,
  RulesetIdentity,
} from "../model/types.js";
import { evaluateCondition } from "./evaluate-condition.js";
import { validateContext } from "./facts.js";
import { identifyRuleset } from "./fingerprint.js";
import {
  effectiveWindowError,
  evaluationTime,
  fingerprintMismatchError,
  invalidRulesetErrors,
  missingInputs,
  requiredMissingMap,
  versionMismatchError,
} from "./runtime.js";
import { validateRuleset } from "./validate.js";

interface EvaluatedRule {
  rule: DecisionRule;
  truth: "TRUE" | "FALSE" | "UNKNOWN";
  missing: Set<string>;
}

function explanations(rules: DecisionRule[]): Array<Explanation & { ruleId: string }> {
  return rules.flatMap((rule) =>
    rule.then.explanation ? [{ ...rule.then.explanation, ruleId: rule.id }] : [],
  );
}

function resultBase(
  identity: RulesetIdentity,
  evaluatedAt: string,
): Omit<DecisionResult, "status"> {
  return {
    kind: "decision_result",
    ruleset: identity,
    evaluatedAt,
    matchedRules: [],
    missingInputs: [],
    explanations: [],
    errors: [],
  };
}

function decisionFrom(
  base: Omit<DecisionResult, "status">,
  rule: DecisionRule,
): DecisionResult {
  return {
    ...base,
    status: "decided",
    decision: rule.then.decision,
    matchedRules: [rule.id],
    explanations: explanations([rule]),
  };
}

function missingForRules(
  evaluated: EvaluatedRule[],
  base: Omit<DecisionResult, "status">,
  inputs: InputDefinition[],
): DecisionResult {
  const paths = new Map<string, Set<string>>();
  for (const item of evaluated) {
    if (item.truth === "UNKNOWN") paths.set(item.rule.id, item.missing);
  }
  const matched = evaluated.filter((item) => item.truth === "TRUE").map((item) => item.rule);
  return {
    ...base,
    status: "insufficient_input",
    matchedRules: matched.map((rule) => rule.id),
    explanations: explanations(matched),
    missingInputs: missingInputs(paths, inputs),
  };
}

export function evaluateDecision(request: EvaluateDecisionRequest): DecisionResult {
  const evaluatedAt = evaluationTime(request.asOf);
  const validation = validateRuleset(request.ruleset);
  const base = resultBase(validation.ruleset ?? identifyRuleset(request.ruleset), evaluatedAt);
  if (validation.status === "invalid") {
    return {
      ...base,
      status: "invalid_ruleset",
      errors: invalidRulesetErrors(validation.issues),
    };
  }

  if (request.expectedVersion && request.expectedVersion !== request.ruleset.version) {
    return {
      ...base,
      status: "version_mismatch",
      errors: [versionMismatchError(request.expectedVersion, request.ruleset.version)],
    };
  }

  if (request.expectedFingerprint && request.expectedFingerprint !== base.ruleset.fingerprint) {
    return {
      ...base,
      status: "fingerprint_mismatch",
      errors: [fingerprintMismatchError(request.expectedFingerprint, base.ruleset.fingerprint)],
    };
  }

  const lifecycleError = effectiveWindowError(request.ruleset.effective, evaluatedAt);
  if (lifecycleError) {
    return { ...base, status: "inactive_ruleset", errors: [lifecycleError] };
  }

  const contextCheck = validateContext(request.facts, request.ruleset.inputs);
  if (contextCheck.errors.length > 0) {
    return { ...base, status: "invalid_input", errors: contextCheck.errors };
  }
  if (contextCheck.missingRequired.length > 0) {
    return {
      ...base,
      status: "insufficient_input",
      missingInputs: missingInputs(
        requiredMissingMap(contextCheck.missingRequired),
        request.ruleset.inputs,
      ),
    };
  }

  const definitions = new Map(request.ruleset.inputs.map((input) => [input.path, input]));

  if (request.ruleset.hitPolicy === "first") {
    for (const rule of request.ruleset.rules) {
      const evaluation = evaluateCondition(rule.when, request.facts, definitions);
      if (evaluation.truth === "UNKNOWN") {
        return missingForRules([{ rule, ...evaluation }], base, request.ruleset.inputs);
      }
      if (evaluation.truth === "TRUE") return decisionFrom(base, rule);
    }
    return { ...base, status: "no_match" };
  }

  const evaluated: EvaluatedRule[] = request.ruleset.rules.map((rule) => ({
    rule,
    ...evaluateCondition(rule.when, request.facts, definitions),
  }));

  const matched = evaluated.filter((item) => item.truth === "TRUE");
  const unknown = evaluated.filter((item) => item.truth === "UNKNOWN");

  if (request.ruleset.hitPolicy === "unique") {
    if (matched.length > 1) {
      return {
        ...base,
        status: "conflict",
        matchedRules: matched.map((item) => item.rule.id),
        explanations: explanations(matched.map((item) => item.rule)),
        errors: [
          {
            code: "RULE_CONFLICT",
            message: "More than one rule matched under unique hit policy.",
          },
        ],
      };
    }
    if (unknown.length > 0) return missingForRules(evaluated, base, request.ruleset.inputs);
    if (matched[0]) return decisionFrom(base, matched[0].rule);
    return { ...base, status: "no_match" };
  }

  if (request.ruleset.hitPolicy === "collect") {
    if (unknown.length > 0) return missingForRules(evaluated, base, request.ruleset.inputs);
    if (matched.length === 0) return { ...base, status: "no_match" };
    return {
      ...base,
      status: "decided",
      decision: matched.map((item) => item.rule.then.decision) as JsonValue[],
      matchedRules: matched.map((item) => item.rule.id),
      explanations: explanations(matched.map((item) => item.rule)),
    };
  }

  const highestMatchedPriority = matched.reduce(
    (highest, item) => Math.max(highest, item.rule.priority as number),
    Number.NEGATIVE_INFINITY,
  );
  const consequentialUnknown = unknown.filter(
    (item) => (item.rule.priority as number) >= highestMatchedPriority,
  );
  if (consequentialUnknown.length > 0) {
    return missingForRules([...matched, ...consequentialUnknown], base, request.ruleset.inputs);
  }
  if (matched.length === 0) return { ...base, status: "no_match" };
  const winners = matched.filter((item) => item.rule.priority === highestMatchedPriority);
  if (winners.length > 1) {
    return {
      ...base,
      status: "conflict",
      matchedRules: winners.map((item) => item.rule.id),
      explanations: explanations(winners.map((item) => item.rule)),
      errors: [
        {
          code: "PRIORITY_TIE",
          message: `Multiple matching rules share priority ${highestMatchedPriority}.`,
        },
      ],
    };
  }
  return decisionFrom(base, winners[0]!.rule);
}
