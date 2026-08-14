import type {
  DecisionResult,
  DecisionRule,
  EvaluateDecisionRequest,
  Explanation,
  JsonValue,
} from "../model/types.js";
import { evaluateCondition } from "./evaluate-condition.js";
import { validateContext } from "./facts.js";
import { identifyRuleset } from "./fingerprint.js";
import {
  effectiveWindowError,
  evaluationTime,
  limitResultErrors,
  missingInputs,
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
  request: EvaluateDecisionRequest,
  evaluatedAt: string,
): Omit<DecisionResult, "status"> {
  return {
    kind: "decision_result",
    ruleset: identifyRuleset(request.ruleset),
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
  request: EvaluateDecisionRequest,
  evaluatedAt: string,
): DecisionResult {
  const paths = new Map<string, Set<string>>();
  for (const item of evaluated) {
    if (item.truth === "UNKNOWN") paths.set(item.rule.id, item.missing);
  }
  const base = resultBase(request, evaluatedAt);
  const matched = evaluated.filter((item) => item.truth === "TRUE").map((item) => item.rule);
  return {
    ...base,
    status: "insufficient_input",
    matchedRules: matched.map((rule) => rule.id),
    explanations: explanations(matched),
    missingInputs: missingInputs(paths, request.ruleset.inputs),
  };
}

export function evaluateDecision(request: EvaluateDecisionRequest): DecisionResult {
  const evaluatedAt = evaluationTime(request.asOf);
  const base = resultBase(request, evaluatedAt);
  const validation = validateRuleset(request.ruleset);
  if (validation.status === "invalid") {
    return {
      ...base,
      status: "invalid_ruleset",
      errors: limitResultErrors(
        validation.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => ({
            code: issue.code,
            message: issue.message,
            ...(issue.paths?.[0] ? { path: issue.paths[0] } : {}),
          })),
      ),
    };
  }

  if (request.expectedVersion && request.expectedVersion !== request.ruleset.version) {
    return {
      ...base,
      status: "version_mismatch",
      errors: [
        {
          code: "RULESET_VERSION_MISMATCH",
          message: `Expected version '${request.expectedVersion}' but received '${request.ruleset.version}'.`,
        },
      ],
    };
  }

  if (request.expectedFingerprint && request.expectedFingerprint !== base.ruleset.fingerprint) {
    return {
      ...base,
      status: "fingerprint_mismatch",
      errors: [
        {
          code: "RULESET_FINGERPRINT_MISMATCH",
          message: `Expected fingerprint '${request.expectedFingerprint}' but received '${base.ruleset.fingerprint}'.`,
        },
      ],
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
    const required = new Map([
      ["$schema", new Set(contextCheck.missingRequired.map((input) => input.path))],
    ]);
    return {
      ...base,
      status: "insufficient_input",
      missingInputs: missingInputs(required, request.ruleset.inputs),
    };
  }

  const evaluated: EvaluatedRule[] = request.ruleset.rules.map((rule) => ({
    rule,
    ...evaluateCondition(rule.when, request.facts, request.ruleset.inputs),
  }));

  if (request.ruleset.hitPolicy === "first") {
    for (const item of evaluated) {
      if (item.truth === "UNKNOWN") return missingForRules([item], request, evaluatedAt);
      if (item.truth === "TRUE") return decisionFrom(base, item.rule);
    }
    return { ...base, status: "no_match" };
  }

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
    if (unknown.length > 0) return missingForRules(evaluated, request, evaluatedAt);
    if (matched[0]) return decisionFrom(base, matched[0].rule);
    return { ...base, status: "no_match" };
  }

  if (request.ruleset.hitPolicy === "collect") {
    if (unknown.length > 0) return missingForRules(evaluated, request, evaluatedAt);
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
    return missingForRules([...matched, ...consequentialUnknown], request, evaluatedAt);
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
