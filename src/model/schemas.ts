import * as z from "zod/v4";

import type {
  CheckConstraintsRequest,
  Condition,
  ApprovedConstraintBinding,
  ApprovedConstraintCheckRequest,
  ConstraintResult,
  ConstraintRuleset,
  DecisionResult,
  DecisionRuleset,
  EvaluateDecisionRequest,
  JsonObject,
  JsonValue,
  Ruleset,
  ValidationResult,
} from "./types.js";
import { isStrictDatetime } from "./temporal.js";

export const MODEL_LIMITS = Object.freeze({
  maxRequestBytes: 256 * 1024,
  maxResponseBytes: 256 * 1024,
  maxInputs: 256,
  maxRules: 500,
  maxConditionDepth: 32,
  maxConditionNodes: 10_000,
  maxJsonDepth: 32,
  maxJsonNodes: 20_000,
  maxGroupConditions: 100,
  maxRepairHints: 20,
  maxResultErrors: 256,
  maxValidationIssues: 1_000,
  maxStringLength: 16_384,
});

/** Reserved missing-input owner meaning "required by the ruleset declaration itself". */
export const SCHEMA_REQUIRED_OWNER = "$schema";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const factPath = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/)
  .refine(
    (path) => !path.split(".").some((segment) => ["__proto__", "prototype", "constructor"].includes(segment)),
    "Fact path contains a reserved unsafe segment.",
  );

const boundedString = z.string().max(MODEL_LIMITS.maxStringLength);
const isoDatetime = z
  .string()
  .refine(
    isStrictDatetime,
    "Expected a real ISO datetime with seconds, an explicit offset, and at most millisecond precision.",
  );

let RawJsonValueSchema: z.ZodType<JsonValue>;
RawJsonValueSchema = z.lazy(() =>
  z.union([
    boundedString,
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(RawJsonValueSchema).max(1_000),
    z.record(z.string().max(256), RawJsonValueSchema),
  ]),
);

function jsonTreeViolation(values: unknown[], rejectDottedKeys: boolean): string | undefined {
  const pending: Array<{ value: unknown; depth: number }> = values.map((value) => ({ value, depth: 1 }));
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MODEL_LIMITS.maxJsonNodes || current.depth > MODEL_LIMITS.maxJsonDepth) {
      return `Combined JSON inputs exceed ${MODEL_LIMITS.maxJsonNodes} nodes or depth ${MODEL_LIMITS.maxJsonDepth}.`;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
        if (key === "__proto__") {
          return "JSON objects must not use the reserved key '__proto__'.";
        }
        if (rejectDottedKeys && key.includes(".")) {
          return "JSON object keys must not contain '.'; use nested objects for dotted fact paths.";
        }
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return undefined;
}

function addCumulativeJsonIssue(
  values: unknown[],
  context: z.RefinementCtx,
): void {
  const violation = jsonTreeViolation(values, false);
  if (violation) context.addIssue({ code: "custom", message: violation });
}

function rulesetJsonValues(ruleset: Ruleset): unknown[] {
  if (ruleset.kind === "decision") {
    return ruleset.rules.map((rule) => rule.then.decision);
  }
  return ruleset.constraints.flatMap((constraint) =>
    (constraint.repairHints ?? []).flatMap((hint) =>
      hint.kind === "set_value" ? [hint.value] : [],
    ),
  );
}

// Iterative pre-walk guards: bounds node count and depth before the recursive
// zod schemas run, and reports violations with a specific message instead of a
// type-mismatch error on a replaced value.
function jsonGuard(rejectDottedKeys: boolean) {
  return z.unknown().superRefine((value, context) => {
    const violation = jsonTreeViolation([value], rejectDottedKeys);
    if (violation) context.addIssue({ code: "custom", message: violation });
  });
}

export const JsonValueSchema = z.pipe(jsonGuard(false), RawJsonValueSchema) as unknown as z.ZodType<JsonValue>;

const RawJsonObjectSchema = z.record(z.string().max(256), RawJsonValueSchema);
export const JsonObjectSchema = z.pipe(jsonGuard(false), RawJsonObjectSchema) as unknown as z.ZodType<JsonObject>;

// Context objects (facts/candidate) are addressed by dotted fact paths, so a
// flat key containing '.' can never be read and must be rejected outright.
export const ContextObjectSchema = z.pipe(jsonGuard(true), RawJsonObjectSchema) as unknown as z.ZodType<JsonObject>;

export const InputDefinitionSchema = z.strictObject({
  path: factPath,
  type: z.enum(["boolean", "integer", "decimal", "string", "date", "datetime"]),
  required: z.boolean(),
  nullable: z.boolean(),
  description: z.string().min(1).max(240).optional(),
});

const FactOperandSchema = z.strictObject({
  kind: z.literal("fact"),
  path: factPath,
});

const LiteralOperandSchema = z.strictObject({
  kind: z.literal("literal"),
  value: z.union([
    boundedString,
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(z.union([boundedString, z.number().finite(), z.boolean(), z.null()])).max(1_000),
  ]),
});

export const OperandSchema = z.discriminatedUnion("kind", [FactOperandSchema, LiteralOperandSchema]);

let RawConditionSchema: z.ZodType<Condition>;
RawConditionSchema = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.strictObject({
      op: z.literal("all"),
      conditions: z.array(RawConditionSchema).min(1).max(MODEL_LIMITS.maxGroupConditions),
    }),
    z.strictObject({
      op: z.literal("any"),
      conditions: z.array(RawConditionSchema).min(1).max(MODEL_LIMITS.maxGroupConditions),
    }),
    z.strictObject({
      op: z.literal("not"),
      condition: RawConditionSchema,
    }),
    z.strictObject({
      op: z.literal("compare"),
      left: OperandSchema,
      comparator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in"]),
      right: OperandSchema,
    }),
    z.strictObject({
      op: z.literal("exists"),
      path: factPath,
    }),
  ]),
);

function conditionWithinLocalLimits(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MODEL_LIMITS.maxConditionNodes || current.depth > MODEL_LIMITS.maxConditionDepth) {
      return false;
    }
    if (current.value === null || Array.isArray(current.value) || typeof current.value !== "object") {
      continue;
    }
    const candidate = current.value as Record<string, unknown>;
    if ((candidate.op === "all" || candidate.op === "any") && Array.isArray(candidate.conditions)) {
      for (const child of candidate.conditions) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    } else if (candidate.op === "not") {
      pending.push({ value: candidate.condition, depth: current.depth + 1 });
    }
  }
  return true;
}

export const ConditionSchema = z.pipe(
  z.unknown().superRefine((value, context) => {
    if (!conditionWithinLocalLimits(value)) {
      context.addIssue({
        code: "custom",
        message: `Condition exceeds ${MODEL_LIMITS.maxConditionNodes} nodes or depth ${MODEL_LIMITS.maxConditionDepth}.`,
      });
    }
  }),
  RawConditionSchema,
) as unknown as z.ZodType<Condition>;

const ExplanationSchema = z.strictObject({
  code: identifier,
  message: z.string().min(1).max(1_000),
});

export const RepairHintSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("provide_input"),
    path: factPath,
    message: z.string().min(1).max(500).optional(),
  }),
  z.strictObject({
    kind: z.literal("set_value"),
    path: factPath,
    value: JsonValueSchema,
    message: z.string().min(1).max(500).optional(),
  }),
]);

const EffectiveWindowSchema = z.strictObject({
  from: isoDatetime.optional(),
  until: isoDatetime.optional(),
});

const BaseRulesetShape = {
  schemaVersion: z.literal("1.0"),
  id: identifier,
  version: z.string().min(1).max(128),
  effective: EffectiveWindowSchema.optional(),
  inputs: z.array(InputDefinitionSchema).max(MODEL_LIMITS.maxInputs),
};

export const DecisionRuleSchema = z.strictObject({
  id: identifier,
  priority: z.number().int().safe().optional(),
  when: ConditionSchema,
  then: z.strictObject({
    decision: JsonValueSchema,
    explanation: ExplanationSchema.optional(),
  }),
});

const DecisionRulesetObjectSchema = z.strictObject({
  ...BaseRulesetShape,
  kind: z.literal("decision"),
  hitPolicy: z.enum(["first", "unique", "collect", "priority"]),
  rules: z.array(DecisionRuleSchema).min(1).max(MODEL_LIMITS.maxRules),
});

export const DecisionRulesetSchema = DecisionRulesetObjectSchema
  .superRefine((ruleset, context) =>
    addCumulativeJsonIssue(rulesetJsonValues(ruleset as unknown as DecisionRuleset), context),
  ) as z.ZodType<DecisionRuleset>;

export const ConstraintRuleSchema = z.strictObject({
  id: identifier,
  severity: z.enum(["hard", "soft"]),
  when: ConditionSchema.optional(),
  assert: ConditionSchema,
  violation: ExplanationSchema.extend({
    field: factPath.optional(),
  }),
  repairHints: z.array(RepairHintSchema).max(MODEL_LIMITS.maxRepairHints).optional(),
});

const ConstraintRulesetObjectSchema = z.strictObject({
  ...BaseRulesetShape,
  kind: z.literal("constraint"),
  constraints: z.array(ConstraintRuleSchema).min(1).max(MODEL_LIMITS.maxRules),
});

export const ConstraintRulesetSchema = ConstraintRulesetObjectSchema
  .superRefine((ruleset, context) =>
    addCumulativeJsonIssue(rulesetJsonValues(ruleset as unknown as ConstraintRuleset), context),
  ) as z.ZodType<ConstraintRuleset>;

export const RulesetSchema = z
  .discriminatedUnion("kind", [DecisionRulesetObjectSchema, ConstraintRulesetObjectSchema])
  .superRefine((ruleset, context) =>
    addCumulativeJsonIssue(rulesetJsonValues(ruleset as unknown as Ruleset), context),
  ) as z.ZodType<Ruleset>;

export const EvaluateDecisionRequestSchema = z
  .strictObject({
    ruleset: DecisionRulesetSchema,
    facts: ContextObjectSchema,
    expectedVersion: z.string().min(1).max(128).optional(),
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    asOf: isoDatetime.optional(),
  })
  .superRefine((request, context) =>
    addCumulativeJsonIssue([...rulesetJsonValues(request.ruleset), request.facts], context),
  ) as z.ZodType<EvaluateDecisionRequest>;

export const CheckConstraintsRequestSchema = z
  .strictObject({
    ruleset: ConstraintRulesetSchema,
    candidate: ContextObjectSchema,
    facts: ContextObjectSchema.optional(),
    expectedVersion: z.string().min(1).max(128).optional(),
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    asOf: isoDatetime.optional(),
  })
  .superRefine((request, context) =>
    addCumulativeJsonIssue(
      request.facts
        ? [...rulesetJsonValues(request.ruleset), request.candidate, request.facts]
        : [...rulesetJsonValues(request.ruleset), request.candidate],
      context,
    ),
  ) as z.ZodType<CheckConstraintsRequest>;

export const ApprovedConstraintCheckRequestSchema = z
  .strictObject({
    candidate: ContextObjectSchema,
    facts: ContextObjectSchema.optional(),
  })
  .superRefine((request, context) =>
    addCumulativeJsonIssue(
      request.facts ? [request.candidate, request.facts] : [request.candidate],
      context,
    ),
  ) as z.ZodType<ApprovedConstraintCheckRequest>;

export const ValidationRequestSchema = z.strictObject({
  ruleset: JsonObjectSchema,
});

export const RulesetIdentitySchema = z.strictObject({
  id: identifier,
  version: z.string().min(1).max(128),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const ApprovedConstraintBindingSchema = z.strictObject({
  ruleset: ConstraintRulesetSchema,
  expected: RulesetIdentitySchema,
}) as z.ZodType<ApprovedConstraintBinding>;

const MissingInputSchema = z.strictObject({
  path: factPath,
  type: z.enum(["boolean", "integer", "decimal", "string", "date", "datetime"]),
  requiredBy: z.array(identifier.or(z.literal(SCHEMA_REQUIRED_OWNER))).max(MODEL_LIMITS.maxRules + 1),
});

const ResultErrorSchema = z.strictObject({
  code: identifier,
  message: z.string().min(1).max(2_000),
  path: z.string().min(1).max(512).optional(),
});

const ResultExplanationSchema = ExplanationSchema.extend({ ruleId: identifier });

export const DecisionResultSchema = z.strictObject({
  kind: z.literal("decision_result"),
  status: z.enum([
    "decided",
    "no_match",
    "insufficient_input",
    "conflict",
    "inactive_ruleset",
    "version_mismatch",
    "fingerprint_mismatch",
    "invalid_ruleset",
    "invalid_input",
  ]),
  ruleset: RulesetIdentitySchema,
  evaluatedAt: isoDatetime,
  decision: JsonValueSchema.optional(),
  matchedRules: z.array(identifier).max(MODEL_LIMITS.maxRules),
  missingInputs: z.array(MissingInputSchema).max(MODEL_LIMITS.maxInputs),
  explanations: z.array(ResultExplanationSchema).max(MODEL_LIMITS.maxRules),
  errors: z.array(ResultErrorSchema).max(MODEL_LIMITS.maxResultErrors),
}) as z.ZodType<DecisionResult>;

const ConstraintViolationSchema = ExplanationSchema.extend({
  constraintId: identifier,
  severity: z.enum(["hard", "soft"]),
  field: factPath.optional(),
  repairHints: z.array(RepairHintSchema).max(MODEL_LIMITS.maxRepairHints),
});

export const ConstraintResultSchema = z.strictObject({
  kind: z.literal("constraint_result"),
  status: z.enum([
    "valid",
    "valid_with_warnings",
    "invalid",
    "insufficient_input",
    "inactive_ruleset",
    "version_mismatch",
    "fingerprint_mismatch",
    "invalid_ruleset",
    "invalid_input",
  ]),
  valid: z.boolean().nullable(),
  ruleset: RulesetIdentitySchema,
  evaluatedAt: isoDatetime,
  checkedConstraints: z.array(identifier).max(MODEL_LIMITS.maxRules),
  violations: z.array(ConstraintViolationSchema).max(MODEL_LIMITS.maxRules),
  missingInputs: z.array(MissingInputSchema).max(MODEL_LIMITS.maxInputs),
  errors: z.array(ResultErrorSchema).max(MODEL_LIMITS.maxResultErrors),
}) as z.ZodType<ConstraintResult>;

const ValidationIssueSchema = z.strictObject({
  severity: z.enum(["error", "warning"]),
  code: identifier,
  message: z.string().min(1).max(2_000),
  paths: z.array(z.string().min(1).max(512)).max(MODEL_LIMITS.maxInputs).optional(),
  ruleIds: z.array(identifier).max(MODEL_LIMITS.maxRules).optional(),
  example: JsonObjectSchema.optional(),
});

export const ValidationResultSchema = z.strictObject({
  kind: z.literal("validation_result"),
  status: z.enum(["valid", "invalid"]),
  ruleset: RulesetIdentitySchema.optional(),
  issues: z.array(ValidationIssueSchema).max(MODEL_LIMITS.maxValidationIssues),
}) as z.ZodType<ValidationResult>;
