import type {
  ConstraintResult,
  DecisionResult,
  JsonValue,
  ValidationResult,
} from "./model/types.js";

function inline(value: JsonValue | JsonValue[]): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 160) return serialized;
  let head = serialized.slice(0, 157);
  // Never cut between a surrogate pair: the lone half would later encode as U+FFFD.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}...`;
}

export function presentDecision(result: DecisionResult): string {
  const identity = `${result.ruleset.id}@${result.ruleset.version}`;
  if (result.status === "decided" && result.decision !== undefined) {
    return `Decision ${inline(result.decision)} from ${identity}; matched ${result.matchedRules.join(", ")}.`;
  }
  if (result.status === "insufficient_input") {
    return `Cannot decide with ${identity}; provide ${result.missingInputs.map((item) => item.path).join(", ")}.`;
  }
  if (result.status === "no_match") return `No rule matched in ${identity}.`;
  if (result.status === "conflict") {
    return `Conflicting rules in ${identity}: ${result.matchedRules.join(", ")}.`;
  }
  return `Decision blocked with status ${result.status} in ${identity}: ${result.errors.map((error) => error.message).join(" ")}`;
}

export function presentConstraint(result: ConstraintResult): string {
  const identity = `${result.ruleset.id}@${result.ruleset.version}`;
  if (result.status === "valid") return `Candidate is valid under ${identity}.`;
  if (result.status === "valid_with_warnings") {
    return `Candidate is valid with ${result.violations.length} soft warning(s) under ${identity}.`;
  }
  if (result.status === "invalid") {
    return `Candidate is invalid under ${identity}: ${result.violations.map((item) => item.code).join(", ")}.`;
  }
  if (result.status === "insufficient_input") {
    return `Cannot complete constraint check under ${identity}; provide ${result.missingInputs.map((item) => item.path).join(", ")}.`;
  }
  return `Constraint check blocked with status ${result.status} in ${identity}: ${result.errors.map((error) => error.message).join(" ")}`;
}

export function presentValidation(result: ValidationResult): string {
  if (result.status === "valid") {
    return `Ruleset ${result.ruleset?.id}@${result.ruleset?.version} is valid with ${result.issues.length} warning(s).`;
  }
  return `Ruleset is invalid: ${result.issues.filter((issue) => issue.severity === "error").map((issue) => issue.code).join(", ")}.`;
}
