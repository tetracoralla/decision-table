import type {
  EffectiveWindow,
  InputDefinition,
  MissingInput,
  ResultError,
  ValidationIssue,
} from "../model/types.js";
import { MODEL_LIMITS, SCHEMA_REQUIRED_OWNER } from "../model/schemas.js";
import { parseStrictDatetime } from "../model/temporal.js";

export function limitResultErrors(errors: ResultError[]): ResultError[] {
  if (errors.length <= MODEL_LIMITS.maxResultErrors) return errors;
  return [
    ...errors.slice(0, MODEL_LIMITS.maxResultErrors - 1),
    {
      code: "INPUT_ERRORS_TRUNCATED",
      message: `Additional errors were omitted after the first ${MODEL_LIMITS.maxResultErrors - 1}.`,
    },
  ];
}

/** Caps validation issues and replaces the last shown one with a truncation marker. */
export function capValidationIssues(
  issues: ValidationIssue[],
  truncated: boolean,
  scope: string,
): ValidationIssue[] {
  if (!truncated && issues.length <= MODEL_LIMITS.maxValidationIssues) return issues;
  const capped = issues.slice(0, MODEL_LIMITS.maxValidationIssues);
  const marker: ValidationIssue = {
    severity: "warning",
    code: "VALIDATION_ISSUES_TRUNCATED",
    message: `${scope} stopped returning issues at ${MODEL_LIMITS.maxValidationIssues}.`,
  };
  if (capped.length < MODEL_LIMITS.maxValidationIssues) capped.push(marker);
  else capped[MODEL_LIMITS.maxValidationIssues - 1] = marker;
  return capped;
}

/** Maps error-severity validation issues to the result errors both engines report. */
export function invalidRulesetErrors(issues: ValidationIssue[]): ResultError[] {
  const mapped = limitResultErrors(
    issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => ({
        code: issue.code,
        message: issue.message,
        ...(issue.paths?.[0] ? { path: issue.paths[0] } : {}),
      })),
  );
  if (mapped.length === 0) {
    // The shown issues are all warnings, yet validation failed: the error was
    // displaced by the issue cap. Say so instead of reporting an empty reason.
    return [
      {
        code: "VALIDATION_ISSUES_TRUNCATED",
        message: "Ruleset is invalid, but the specific error was truncated by the validation issue limit.",
      },
    ];
  }
  return mapped;
}

export function versionMismatchError(expected: string, actual: string): ResultError {
  return {
    code: "RULESET_VERSION_MISMATCH",
    message: `Expected version '${expected}' but received '${actual}'.`,
  };
}

export function fingerprintMismatchError(expected: string, actual: string): ResultError {
  return {
    code: "RULESET_FINGERPRINT_MISMATCH",
    message: `Expected fingerprint '${expected}' but received '${actual}'.`,
  };
}

export function evaluationTime(asOf?: string): string {
  return asOf ?? new Date().toISOString();
}

export function effectiveWindowError(
  effective: EffectiveWindow | undefined,
  evaluatedAt: string,
): ResultError | undefined {
  if (!effective) return undefined;
  const instant = parseStrictDatetime(evaluatedAt);
  if (instant === undefined) {
    return { code: "INVALID_EVALUATION_TIME", message: `Evaluation time '${evaluatedAt}' is invalid.` };
  }
  if (effective.from && instant < (parseStrictDatetime(effective.from) as number)) {
    return {
      code: "RULESET_NOT_YET_EFFECTIVE",
      message: `Ruleset is not effective until ${effective.from}.`,
    };
  }
  if (effective.until && instant >= (parseStrictDatetime(effective.until) as number)) {
    return {
      code: "RULESET_EXPIRED",
      message: `Ruleset stopped being effective at ${effective.until}.`,
    };
  }
  return undefined;
}

export function missingInputs(
  pathsByOwner: Map<string, Set<string>>,
  inputs: InputDefinition[],
): MissingInput[] {
  const ownersByPath = new Map<string, Set<string>>();
  for (const [owner, paths] of pathsByOwner) {
    for (const path of paths) {
      const owners = ownersByPath.get(path) ?? new Set<string>();
      owners.add(owner);
      ownersByPath.set(path, owners);
    }
  }
  const inputByPath = new Map(inputs.map((input) => [input.path, input]));
  return [...ownersByPath]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, owners]) => ({
      path,
      type: inputByPath.get(path)?.type ?? "string",
      requiredBy: [...owners].sort(),
    }));
}

export function requiredMissingMap(missingRequired: InputDefinition[]): Map<string, Set<string>> {
  const paths = new Set(missingRequired.map((input) => input.path));
  return paths.size > 0 ? new Map([[SCHEMA_REQUIRED_OWNER, paths]]) : new Map();
}
