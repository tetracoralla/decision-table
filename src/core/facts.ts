import { Decimal } from "decimal.js";

import type {
  InputDefinition,
  InputType,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ResultError,
} from "../model/types.js";
import { MODEL_LIMITS } from "../model/schemas.js";
import { isStrictDate, isStrictDatetime } from "../model/temporal.js";
import { limitResultErrors } from "./runtime.js";

const DECIMAL_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const INTEGER_PATTERN = /^[+-]?(?:0|[1-9]\d*)$/;

export interface PathRead {
  found: boolean;
  value?: JsonValue;
}

/** Parses a primitive as Decimal, or undefined when it is not a finite number. */
export function decimalOf(value: JsonPrimitive): Decimal | undefined {
  if (typeof value === "string" && !DECIMAL_PATTERN.test(value)) return undefined;
  try {
    const decimal = new Decimal(value as string | number);
    return decimal.isFinite() ? decimal : undefined;
  } catch {
    return undefined;
  }
}

export function readPath(context: JsonObject, path: string): PathRead {
  const segments = path.split(".");
  let cursor: JsonValue = context;

  for (const segment of segments) {
    if (cursor === null || Array.isArray(cursor) || typeof cursor !== "object") {
      return { found: false };
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return { found: false };
    }
    cursor = cursor[segment] as JsonValue;
  }

  return { found: true, value: cursor };
}

export interface ContextLeaves {
  leaves: Array<{ path: string; value: JsonValue }>;
  /** Key paths (prefix + dotted key) whose flat key can never be read as a fact path. */
  ambiguousKeys: string[];
  overNodeLimit: boolean;
}

export function collectLeaves(context: JsonObject): ContextLeaves {
  const leaves: ContextLeaves["leaves"] = [];
  const ambiguousKeys: string[] = [];
  let nodes = 0;
  let overNodeLimit = false;
  const pending: Array<{ value: JsonValue; prefix: string }> = [{ value: context, prefix: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MODEL_LIMITS.maxJsonNodes) {
      overNodeLimit = true;
      break;
    }
    if (current.value !== null && !Array.isArray(current.value) && typeof current.value === "object") {
      const entries = Object.entries(current.value);
      if (entries.length === 0 && current.prefix) leaves.push({ path: current.prefix, value: current.value });
      for (const [key, child] of entries) {
        if (key.includes(".")) ambiguousKeys.push(current.prefix ? `${current.prefix}.${key}` : key);
        pending.push({ value: child, prefix: current.prefix ? `${current.prefix}.${key}` : key });
      }
    } else if (current.prefix) {
      leaves.push({ path: current.prefix, value: current.value });
    }
  }
  leaves.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { leaves, ambiguousKeys, overNodeLimit };
}

function isSupportedDecimal(value: string): boolean {
  if (!DECIMAL_PATTERN.test(value)) return false;
  try {
    return new Decimal(value).isFinite();
  } catch {
    return false;
  }
}

export function valueMatchesType(
  value: JsonValue,
  type: InputType,
  nullable: boolean,
): boolean {
  if (value === null) return nullable;

  switch (type) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        (typeof value === "number" && Number.isSafeInteger(value)) ||
        (typeof value === "string" && INTEGER_PATTERN.test(value))
      );
    case "decimal":
      return typeof value === "string" && isSupportedDecimal(value);
    case "string":
      return typeof value === "string";
    case "date":
      return typeof value === "string" && isStrictDate(value);
    case "datetime":
      return typeof value === "string" && isStrictDatetime(value);
  }
}

export interface ContextValidation {
  errors: ResultError[];
  missingRequired: InputDefinition[];
}

export function validateContext(
  context: JsonObject,
  inputs: InputDefinition[],
): ContextValidation {
  const byPath = new Map(inputs.map((input) => [input.path, input]));
  const structuralPrefixes = new Set(
    inputs.flatMap((input) => {
      const segments = input.path.split(".");
      return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("."));
    }),
  );
  const errors: ResultError[] = [];
  const missingRequired: InputDefinition[] = [];

  const collected = collectLeaves(context);
  if (collected.overNodeLimit) {
    return {
      errors: limitResultErrors([
        {
          code: "FACT_NODE_LIMIT",
          message: `Facts exceed ${MODEL_LIMITS.maxJsonNodes} JSON nodes.`,
        },
      ]),
      missingRequired,
    };
  }
  for (const key of collected.ambiguousKeys) {
    errors.push({
      code: "AMBIGUOUS_FACT_KEY",
      message: `Fact object key '${key}' contains '.'; express dotted paths with nested objects.`,
      path: key,
    });
  }

  for (const leaf of collected.leaves) {
    const isEmptyStructuralObject =
      structuralPrefixes.has(leaf.path) &&
      leaf.value !== null &&
      !Array.isArray(leaf.value) &&
      typeof leaf.value === "object";
    if (!byPath.has(leaf.path) && !isEmptyStructuralObject) {
      errors.push({
        code: "UNKNOWN_FACT",
        message: `Fact path '${leaf.path}' is not declared by the ruleset.`,
        path: leaf.path,
      });
    }
  }

  for (const input of inputs) {
    const read = readPath(context, input.path);
    if (!read.found) {
      if (input.required) missingRequired.push(input);
      continue;
    }
    if (!valueMatchesType(read.value as JsonValue, input.type, input.nullable)) {
      errors.push({
        code: "INVALID_FACT_TYPE",
        message: `Fact '${input.path}' must be ${input.nullable ? "nullable " : ""}${input.type}.`,
        path: input.path,
      });
    }
  }

  return { errors: limitResultErrors(errors), missingRequired };
}
