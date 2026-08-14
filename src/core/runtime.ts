import type {
  EffectiveWindow,
  InputDefinition,
  MissingInput,
  ResultError,
} from "../model/types.js";
import { MODEL_LIMITS } from "../model/schemas.js";
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

export function requiredMissingMap(inputs: InputDefinition[]): Map<string, Set<string>> {
  const paths = new Set(inputs.filter((input) => input.required).map((input) => input.path));
  return paths.size > 0 ? new Map([["$schema", paths]]) : new Map();
}
