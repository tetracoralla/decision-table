import type {
  Comparator,
  Condition,
  InputDefinition,
  InputType,
  JsonObject,
  JsonPrimitive,
  Operand,
} from "../model/types.js";
import { parseStrictDate, parseStrictDatetime } from "../model/temporal.js";
import { decimalOf, readPath } from "./facts.js";
import { negate, type TruthValue } from "./tri-state.js";

export interface ConditionEvaluation {
  truth: TruthValue;
  missing: Set<string>;
}

interface ResolvedOperand {
  found: boolean;
  value?: JsonPrimitive | JsonPrimitive[];
  type?: InputType;
  missing?: string;
}

const COMPARATOR_TESTS: Record<Exclude<Comparator, "in">, (comparison: number) => boolean> = {
  eq: (comparison) => comparison === 0,
  neq: (comparison) => comparison !== 0,
  gt: (comparison) => comparison > 0,
  gte: (comparison) => comparison >= 0,
  lt: (comparison) => comparison < 0,
  lte: (comparison) => comparison <= 0,
};

function empty(truth: TruthValue): ConditionEvaluation {
  return { truth, missing: new Set() };
}

function resolveOperand(
  operand: Operand,
  context: JsonObject,
  definitions: Map<string, InputDefinition>,
): ResolvedOperand {
  if (operand.kind === "literal") {
    return { found: true, value: operand.value };
  }

  const read = readPath(context, operand.path);
  const definitionType = definitions.get(operand.path)?.type;
  if (!read.found) {
    return {
      found: false,
      missing: operand.path,
      ...(definitionType ? { type: definitionType } : {}),
    };
  }

  return {
    found: true,
    value: read.value as JsonPrimitive,
    ...(definitionType ? { type: definitionType } : {}),
  };
}

function inferType(left: ResolvedOperand, right: ResolvedOperand): InputType | undefined {
  return left.type ?? right.type;
}

function compareScalar(left: JsonPrimitive, right: JsonPrimitive, type?: InputType): number {
  if (left === null || right === null) {
    return left === right ? 0 : -1;
  }

  if (type === "integer" || type === "decimal") {
    const leftDecimal = decimalOf(left);
    const rightDecimal = decimalOf(right);
    if (leftDecimal === undefined || rightDecimal === undefined) return left === right ? 0 : -1;
    return leftDecimal.cmp(rightDecimal);
  }
  if (type === "date" || type === "datetime") {
    const parse = type === "date" ? parseStrictDate : parseStrictDatetime;
    const leftEpoch = parse(String(left));
    const rightEpoch = parse(String(right));
    if (leftEpoch === undefined || rightEpoch === undefined) return left === right ? 0 : -1;
    return leftEpoch - rightEpoch;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return Object.is(left, right) ? 0 : -1;
}

function compareOperands(
  condition: Extract<Condition, { op: "compare" }>,
  context: JsonObject,
  definitions: Map<string, InputDefinition>,
): ConditionEvaluation {
  const left = resolveOperand(condition.left, context, definitions);
  const right = resolveOperand(condition.right, context, definitions);
  const missing = new Set<string>();
  if (!left.found && left.missing) missing.add(left.missing);
  if (!right.found && right.missing) missing.add(right.missing);
  if (missing.size > 0) return { truth: "UNKNOWN", missing };

  const leftValue = left.value as JsonPrimitive | JsonPrimitive[];
  const rightValue = right.value as JsonPrimitive | JsonPrimitive[];
  const type = inferType(left, right);

  if (condition.comparator === "in") {
    if (!Array.isArray(rightValue) || Array.isArray(leftValue)) return empty("FALSE");
    const found = rightValue.some((candidate) => compareScalar(leftValue, candidate, type) === 0);
    return empty(found ? "TRUE" : "FALSE");
  }

  if (Array.isArray(leftValue) || Array.isArray(rightValue)) return empty("FALSE");
  if (
    ["gt", "gte", "lt", "lte"].includes(condition.comparator) &&
    (leftValue === null || rightValue === null)
  ) {
    const nullFactPaths = [condition.left, condition.right].flatMap((operand) =>
      operand.kind === "fact" && readPath(context, operand.path).value === null ? [operand.path] : [],
    );
    return { truth: "UNKNOWN", missing: new Set(nullFactPaths) };
  }
  const comparison = compareScalar(leftValue, rightValue, type);
  const satisfied = COMPARATOR_TESTS[condition.comparator as Exclude<Comparator, "in">](comparison);
  return empty(satisfied ? "TRUE" : "FALSE");
}

export function evaluateCondition(
  condition: Condition,
  context: JsonObject,
  inputs: InputDefinition[] | Map<string, InputDefinition>,
): ConditionEvaluation {
  const definitions =
    inputs instanceof Map ? inputs : new Map(inputs.map((input) => [input.path, input]));
  return evaluate(condition, context, definitions);
}

function evaluate(
  condition: Condition,
  context: JsonObject,
  definitions: Map<string, InputDefinition>,
): ConditionEvaluation {
  switch (condition.op) {
    case "exists":
      return empty(readPath(context, condition.path).found ? "TRUE" : "FALSE");
    case "compare":
      return compareOperands(condition, context, definitions);
    case "not": {
      const child = evaluate(condition.condition, context, definitions);
      return { truth: negate(child.truth), missing: child.missing };
    }
    case "all": {
      const missing = new Set<string>();
      for (const child of condition.conditions) {
        const result = evaluate(child, context, definitions);
        if (result.truth === "FALSE") return empty("FALSE");
        for (const path of result.missing) missing.add(path);
      }
      return missing.size > 0 ? { truth: "UNKNOWN", missing } : empty("TRUE");
    }
    case "any": {
      const missing = new Set<string>();
      for (const child of condition.conditions) {
        const result = evaluate(child, context, definitions);
        if (result.truth === "TRUE") return empty("TRUE");
        for (const path of result.missing) missing.add(path);
      }
      return missing.size > 0 ? { truth: "UNKNOWN", missing } : empty("FALSE");
    }
  }
}
