import type {
  CheckConstraintsRequest,
  ConstraintResult,
  ConstraintViolation,
  JsonObject,
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

function resultBase(
  identity: RulesetIdentity,
  evaluatedAt: string,
): Omit<ConstraintResult, "status" | "valid"> {
  return {
    kind: "constraint_result",
    ruleset: identity,
    evaluatedAt,
    checkedConstraints: [],
    violations: [],
    missingInputs: [],
    errors: [],
  };
}

export function checkConstraints(request: CheckConstraintsRequest): ConstraintResult {
  const evaluatedAt = evaluationTime(request.asOf);
  const validation = validateRuleset(request.ruleset);
  const base = resultBase(validation.ruleset ?? identifyRuleset(request.ruleset), evaluatedAt);
  if (validation.status === "invalid") {
    return {
      ...base,
      status: "invalid_ruleset",
      valid: null,
      errors: invalidRulesetErrors(validation.issues),
    };
  }

  if (request.expectedVersion && request.expectedVersion !== request.ruleset.version) {
    return {
      ...base,
      status: "version_mismatch",
      valid: null,
      errors: [versionMismatchError(request.expectedVersion, request.ruleset.version)],
    };
  }

  if (request.expectedFingerprint && request.expectedFingerprint !== base.ruleset.fingerprint) {
    return {
      ...base,
      status: "fingerprint_mismatch",
      valid: null,
      errors: [fingerprintMismatchError(request.expectedFingerprint, base.ruleset.fingerprint)],
    };
  }

  const lifecycleError = effectiveWindowError(request.ruleset.effective, evaluatedAt);
  if (lifecycleError) {
    return { ...base, status: "inactive_ruleset", valid: null, errors: [lifecycleError] };
  }

  const context: JsonObject = request.facts
    ? { candidate: request.candidate, facts: request.facts }
    : { candidate: request.candidate };
  const contextCheck = validateContext(context, request.ruleset.inputs);
  if (contextCheck.errors.length > 0) {
    return { ...base, status: "invalid_input", valid: null, errors: contextCheck.errors };
  }
  if (contextCheck.missingRequired.length > 0) {
    return {
      ...base,
      status: "insufficient_input",
      valid: null,
      missingInputs: missingInputs(
        requiredMissingMap(contextCheck.missingRequired),
        request.ruleset.inputs,
      ),
    };
  }

  const definitions = new Map(request.ruleset.inputs.map((input) => [input.path, input]));
  const violations: ConstraintViolation[] = [];
  const missing = new Map<string, Set<string>>();
  const checked: string[] = [];

  for (const constraint of request.ruleset.constraints) {
    if (constraint.when) {
      const activation = evaluateCondition(constraint.when, context, definitions);
      if (activation.truth === "FALSE") continue;
      if (activation.truth === "UNKNOWN") {
        missing.set(constraint.id, activation.missing);
        continue;
      }
    }

    checked.push(constraint.id);
    const assertion = evaluateCondition(constraint.assert, context, definitions);
    if (assertion.truth === "UNKNOWN") {
      missing.set(constraint.id, assertion.missing);
      continue;
    }
    if (assertion.truth === "FALSE") {
      violations.push({
        constraintId: constraint.id,
        severity: constraint.severity,
        code: constraint.violation.code,
        message: constraint.violation.message,
        ...(constraint.violation.field ? { field: constraint.violation.field } : {}),
        repairHints: constraint.repairHints ?? [],
      });
    }
  }

  const hardViolations = violations.filter((violation) => violation.severity === "hard");
  if (hardViolations.length > 0) {
    return {
      ...base,
      status: "invalid",
      valid: false,
      checkedConstraints: checked,
      violations,
      missingInputs: missingInputs(missing, request.ruleset.inputs),
    };
  }
  if (missing.size > 0) {
    return {
      ...base,
      status: "insufficient_input",
      valid: null,
      checkedConstraints: checked,
      violations,
      missingInputs: missingInputs(missing, request.ruleset.inputs),
    };
  }
  if (violations.length > 0) {
    return {
      ...base,
      status: "valid_with_warnings",
      valid: true,
      checkedConstraints: checked,
      violations,
    };
  }
  return { ...base, status: "valid", valid: true, checkedConstraints: checked };
}
