import { Decimal } from "decimal.js";

import type {
  InputDefinition,
  InputType,
  JsonObject,
  JsonValue,
  ResultError,
} from "../model/types.js";
import { isStrictDate, isStrictDatetime } from "../model/temporal.js";
import { limitResultErrors } from "./runtime.js";

const DECIMAL_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const INTEGER_PATTERN = /^[+-]?(?:0|[1-9]\d*)$/;

export interface PathRead {
  found: boolean;
  value?: JsonValue;
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

export function listLeafPaths(context: JsonObject): string[] {
  const result: string[] = [];
  const pending: Array<{ value: JsonValue; prefix: string }> = [{ value: context, prefix: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (current.value !== null && !Array.isArray(current.value) && typeof current.value === "object") {
      const entries = Object.entries(current.value);
      if (entries.length === 0 && current.prefix) result.push(current.prefix);
      for (const [key, child] of entries) {
        pending.push({ value: child, prefix: current.prefix ? `${current.prefix}.${key}` : key });
      }
    } else if (current.prefix) {
      result.push(current.prefix);
    }
  }
  return result.sort();
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

  for (const actualPath of listLeafPaths(context)) {
    const actual = readPath(context, actualPath);
    const isEmptyStructuralObject =
      structuralPrefixes.has(actualPath) &&
      actual.found &&
      actual.value !== null &&
      !Array.isArray(actual.value) &&
      typeof actual.value === "object";
    if (!byPath.has(actualPath) && !isEmptyStructuralObject) {
      errors.push({
        code: "UNKNOWN_FACT",
        message: `Fact path '${actualPath}' is not declared by the ruleset.`,
        path: actualPath,
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
