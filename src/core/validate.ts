import type * as z from "zod/v4";

import {
  ConditionSchema,
  MODEL_LIMITS,
  RulesetSchema,
} from "../model/schemas.js";
import type {
  Condition,
  InputDefinition,
  InputType,
  JsonPrimitive,
  Operand,
  Ruleset,
  ValidationIssue,
  ValidationResult,
} from "../model/types.js";
import { valueMatchesType } from "./facts.js";
import { identifyRuleset } from "./fingerprint.js";
import { parseStrictDatetime } from "../model/temporal.js";
import { analyzeDecisionRules } from "./static-analysis.js";

function zodIssues(error: z.ZodError): ValidationIssue[] {
  const issues: ValidationIssue[] = error.issues.map((issue) => ({
    severity: "error",
    code: "SCHEMA_INVALID",
    message: issue.message,
    paths: [issue.path.join(".") || "$"],
  }));
  if (issues.length <= MODEL_LIMITS.maxValidationIssues) return issues;
  return [
    ...issues.slice(0, MODEL_LIMITS.maxValidationIssues - 1),
    {
      severity: "warning",
      code: "VALIDATION_ISSUES_TRUNCATED",
      message: `Schema validation stopped returning issues at ${MODEL_LIMITS.maxValidationIssues}.`,
    },
  ];
}

function visitCondition(
  condition: Condition,
  visitor: (condition: Condition, depth: number) => void,
  depth = 1,
): void {
  visitor(condition, depth);
  if (condition.op === "all" || condition.op === "any") {
    for (const child of condition.conditions) visitCondition(child, visitor, depth + 1);
  } else if (condition.op === "not") {
    visitCondition(condition.condition, visitor, depth + 1);
  }
}

function operandType(
  operand: Operand,
  inputs: Map<string, InputDefinition>,
): InputType | undefined {
  return operand.kind === "fact" ? inputs.get(operand.path)?.type : undefined;
}

function validateLiteralForType(
  value: JsonPrimitive | JsonPrimitive[],
  type: InputType,
  nullable: boolean,
): boolean {
  if (Array.isArray(value)) return value.every((item) => valueMatchesType(item, type, nullable));
  return valueMatchesType(value, type, nullable);
}

interface ConditionSemanticAnalysis {
  issues: ValidationIssue[];
  nodes: number;
}

function validateConditionSemantics(
  condition: Condition,
  inputs: InputDefinition[],
  ownerId: string,
): ConditionSemanticAnalysis {
  const issues: ValidationIssue[] = [];
  const definitions = new Map(inputs.map((input) => [input.path, input]));
  let nodes = 0;
  let deepest = 0;

  visitCondition(condition, (node, depth) => {
    nodes += 1;
    deepest = Math.max(deepest, depth);
    if (issues.length >= MODEL_LIMITS.maxValidationIssues) return;

    if (node.op === "exists") {
      if (!definitions.has(node.path)) {
        issues.push({
          severity: "error",
          code: "UNDEFINED_FACT",
          message: `Condition in '${ownerId}' references undeclared fact '${node.path}'.`,
          paths: [node.path],
          ruleIds: [ownerId],
        });
      }
      return;
    }
    if (node.op !== "compare") return;

    const factOperands = [node.left, node.right].filter(
      (operand): operand is Extract<Operand, { kind: "fact" }> => operand.kind === "fact",
    );
    for (const operand of factOperands) {
      if (!definitions.has(operand.path)) {
        issues.push({
          severity: "error",
          code: "UNDEFINED_FACT",
          message: `Condition in '${ownerId}' references undeclared fact '${operand.path}'.`,
          paths: [operand.path],
          ruleIds: [ownerId],
        });
      }
    }

    const leftType = operandType(node.left, definitions);
    const rightType = operandType(node.right, definitions);
    if (leftType && rightType && leftType !== rightType) {
      issues.push({
        severity: "error",
        code: "INCOMPATIBLE_FACT_TYPES",
        message: `Comparison in '${ownerId}' combines ${leftType} and ${rightType} facts.`,
        ruleIds: [ownerId],
      });
    }

    const comparisonType = leftType ?? rightType;
    if (!comparisonType) {
      issues.push({
        severity: "warning",
        code: "CONSTANT_CONDITION",
        message: `Condition in '${ownerId}' compares two literals.`,
        ruleIds: [ownerId],
      });
    }

    if (node.comparator === "in") {
      if (node.right.kind !== "literal" || !Array.isArray(node.right.value)) {
        issues.push({
          severity: "error",
          code: "INVALID_IN_OPERAND",
          message: `'in' in '${ownerId}' requires a literal array on the right.`,
          ruleIds: [ownerId],
        });
      }
    } else if (
      (node.left.kind === "literal" && Array.isArray(node.left.value)) ||
      (node.right.kind === "literal" && Array.isArray(node.right.value))
    ) {
      issues.push({
        severity: "error",
        code: "ARRAY_COMPARATOR_MISMATCH",
        message: `Only 'in' may compare a literal array in '${ownerId}'.`,
        ruleIds: [ownerId],
      });
    }

    if (["gt", "gte", "lt", "lte"].includes(node.comparator)) {
      const hasNullLiteral = [node.left, node.right].some(
        (operand) => operand.kind === "literal" && operand.value === null,
      );
      const nullableFactPaths = factOperands
        .filter((operand) => definitions.get(operand.path)?.nullable)
        .map((operand) => operand.path);
      if (hasNullLiteral || nullableFactPaths.length > 0) {
        issues.push({
          severity: "error",
          code: "NULL_ORDERING_NOT_SUPPORTED",
          message: `Comparator '${node.comparator}' cannot order null or a nullable fact in '${ownerId}'.`,
          ...(nullableFactPaths.length > 0 ? { paths: nullableFactPaths } : {}),
          ruleIds: [ownerId],
        });
      }
      if (comparisonType && !["integer", "decimal", "date", "datetime"].includes(comparisonType)) {
        issues.push({
          severity: "error",
          code: "ORDERING_NOT_SUPPORTED",
          message: `Comparator '${node.comparator}' is not supported for ${comparisonType} in '${ownerId}'.`,
          ruleIds: [ownerId],
        });
      }
    }

    if (comparisonType) {
      const definition =
        node.left.kind === "fact"
          ? definitions.get(node.left.path)
          : node.right.kind === "fact"
            ? definitions.get(node.right.path)
            : undefined;
      const nullable = definition?.nullable ?? false;
      for (const operand of [node.left, node.right]) {
        if (
          operand.kind === "literal" &&
          !validateLiteralForType(operand.value, comparisonType, nullable)
        ) {
          issues.push({
            severity: "error",
            code: "INVALID_LITERAL_TYPE",
            message: `Literal in '${ownerId}' is not valid ${comparisonType}.`,
            ruleIds: [ownerId],
          });
        }
      }
    }
  });

  if (deepest > MODEL_LIMITS.maxConditionDepth) {
    issues.push({
      severity: "error",
      code: "CONDITION_DEPTH_LIMIT",
      message: `'${ownerId}' condition depth is ${deepest}; maximum is ${MODEL_LIMITS.maxConditionDepth}.`,
      ruleIds: [ownerId],
    });
  }
  return { issues, nodes };
}

function semanticIssues(ruleset: Ruleset): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let truncated = false;
  const appendIssues = (next: ValidationIssue[]): void => {
    const remaining = MODEL_LIMITS.maxValidationIssues - issues.length;
    if (next.length > remaining) truncated = true;
    if (remaining > 0) issues.push(...next.slice(0, remaining));
  };
  const inputPaths = new Set<string>();
  for (const input of ruleset.inputs) {
    if (inputPaths.has(input.path)) {
      issues.push({
        severity: "error",
        code: "DUPLICATE_INPUT",
        message: `Input '${input.path}' is declared more than once.`,
        paths: [input.path],
      });
    }
    const collidingPath = [...inputPaths].find(
      (existing) => input.path.startsWith(`${existing}.`) || existing.startsWith(`${input.path}.`),
    );
    if (collidingPath) {
      issues.push({
        severity: "error",
        code: "INPUT_PATH_COLLISION",
        message: `Input paths '${collidingPath}' and '${input.path}' cannot both describe primitive values.`,
        paths: [collidingPath, input.path],
      });
    }
    inputPaths.add(input.path);
  }

  if (ruleset.effective?.from && ruleset.effective.until) {
    if (
      (parseStrictDatetime(ruleset.effective.from) as number) >=
      (parseStrictDatetime(ruleset.effective.until) as number)
    ) {
      issues.push({
        severity: "error",
        code: "INVALID_EFFECTIVE_WINDOW",
        message: "effective.from must be earlier than effective.until.",
        paths: ["effective"],
      });
    }
  }

  const ids = new Set<string>();
  const owners =
    ruleset.kind === "decision"
      ? ruleset.rules.map((rule) => ({ id: rule.id, conditions: [rule.when] }))
      : ruleset.constraints.map((constraint) => ({
          id: constraint.id,
          conditions: constraint.when ? [constraint.when, constraint.assert] : [constraint.assert],
        }));

  let totalConditionNodes = 0;
  for (const owner of owners) {
    if (ids.has(owner.id)) {
      issues.push({
        severity: "error",
        code: "DUPLICATE_RULE_ID",
        message: `Rule or constraint id '${owner.id}' is duplicated.`,
        ruleIds: [owner.id],
      });
    }
    ids.add(owner.id);
    for (const condition of owner.conditions) {
      const analysis = validateConditionSemantics(condition, ruleset.inputs, owner.id);
      appendIssues(analysis.issues);
      totalConditionNodes += analysis.nodes;
    }
  }
  if (totalConditionNodes > MODEL_LIMITS.maxConditionNodes) {
    issues.push({
      severity: "error",
      code: "CONDITION_NODE_LIMIT",
      message: `Ruleset has ${totalConditionNodes} condition nodes; cumulative maximum is ${MODEL_LIMITS.maxConditionNodes}.`,
    });
  }

  if (ruleset.kind === "decision") {
    if (ruleset.hitPolicy === "priority") {
      for (const rule of ruleset.rules) {
        if (rule.priority === undefined) {
          issues.push({
            severity: "error",
            code: "MISSING_PRIORITY",
            message: `Rule '${rule.id}' requires priority under priority hit policy.`,
            ruleIds: [rule.id],
          });
        }
      }
    } else if (ruleset.rules.some((rule) => rule.priority !== undefined)) {
      issues.push({
        severity: "warning",
        code: "IGNORED_PRIORITY",
        message: `Rule priorities are ignored under '${ruleset.hitPolicy}' hit policy.`,
      });
    }
    if (!issues.some((issue) => issue.severity === "error")) {
      appendIssues(analyzeDecisionRules(ruleset));
    }
  } else {
    const inputByPath = new Map(ruleset.inputs.map((input) => [input.path, input]));
    for (const constraint of ruleset.constraints) {
      if (constraint.violation.field && !inputByPath.has(constraint.violation.field)) {
        issues.push({
          severity: "error",
          code: "UNDEFINED_VIOLATION_FIELD",
          message: `Constraint '${constraint.id}' names undeclared field '${constraint.violation.field}'.`,
          paths: [constraint.violation.field],
          ruleIds: [constraint.id],
        });
      }
      for (const hint of constraint.repairHints ?? []) {
        const input = inputByPath.get(hint.path);
        if (!input) {
          issues.push({
            severity: "error",
            code: "UNDEFINED_REPAIR_PATH",
            message: `Repair hint in '${constraint.id}' names undeclared path '${hint.path}'.`,
            paths: [hint.path],
            ruleIds: [constraint.id],
          });
        } else if (
          hint.kind === "set_value" &&
          !valueMatchesType(hint.value, input.type, input.nullable)
        ) {
          issues.push({
            severity: "error",
            code: "INVALID_REPAIR_VALUE",
            message: `Repair value for '${hint.path}' does not match ${input.type}.`,
            paths: [hint.path],
            ruleIds: [constraint.id],
          });
        }
      }
    }
  }

  if (issues.length > MODEL_LIMITS.maxValidationIssues) {
    truncated = true;
    issues.length = MODEL_LIMITS.maxValidationIssues;
  }
  if (truncated) {
    const marker: ValidationIssue = {
      severity: "warning",
      code: "VALIDATION_ISSUES_TRUNCATED",
      message: `Validation stopped returning issues at ${MODEL_LIMITS.maxValidationIssues}.`,
    };
    if (issues.length >= MODEL_LIMITS.maxValidationIssues) {
      issues[MODEL_LIMITS.maxValidationIssues - 1] = marker;
    } else {
      issues.push(marker);
    }
  }
  return issues.slice(0, MODEL_LIMITS.maxValidationIssues);
}

export function validateRuleset(input: unknown): ValidationResult {
  const parsed = RulesetSchema.safeParse(input);
  if (!parsed.success) {
    return { kind: "validation_result", status: "invalid", issues: zodIssues(parsed.error) };
  }

  const issues = semanticIssues(parsed.data);
  return {
    kind: "validation_result",
    status: issues.some((issue) => issue.severity === "error") ? "invalid" : "valid",
    ruleset: identifyRuleset(parsed.data),
    issues,
  };
}

export function assertConditionSchema(input: unknown): Condition {
  return ConditionSchema.parse(input);
}
