export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type ReadonlyJsonValue =
  | JsonPrimitive
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };
export type ReadonlyJsonObject = { readonly [key: string]: ReadonlyJsonValue };

export type InputType =
  | "boolean"
  | "integer"
  | "decimal"
  | "string"
  | "date"
  | "datetime";

export interface InputDefinition {
  path: string;
  type: InputType;
  required: boolean;
  nullable: boolean;
  description?: string;
}

export interface FactOperand {
  kind: "fact";
  path: string;
}

export interface LiteralOperand {
  kind: "literal";
  value: JsonPrimitive | JsonPrimitive[];
}

export type Operand = FactOperand | LiteralOperand;

export type Comparator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in";

export type Condition =
  | { op: "all"; conditions: Condition[] }
  | { op: "any"; conditions: Condition[] }
  | { op: "not"; condition: Condition }
  | { op: "compare"; left: Operand; comparator: Comparator; right: Operand }
  | { op: "exists"; path: string };

export interface Explanation {
  code: string;
  message: string;
}

export type RepairHint =
  | {
      kind: "provide_input";
      path: string;
      message?: string;
    }
  | {
      kind: "set_value";
      path: string;
      value: JsonValue;
      message?: string;
    };

export interface EffectiveWindow {
  from?: string;
  until?: string;
}

export interface DecisionRule {
  id: string;
  priority?: number;
  when: Condition;
  then: {
    decision: JsonValue;
    explanation?: Explanation;
  };
}

export type HitPolicy = "first" | "unique" | "collect" | "priority";

export interface DecisionRuleset {
  schemaVersion: "1.0";
  kind: "decision";
  id: string;
  version: string;
  effective?: EffectiveWindow;
  inputs: InputDefinition[];
  hitPolicy: HitPolicy;
  rules: DecisionRule[];
}

export interface ConstraintRule {
  id: string;
  severity: "hard" | "soft";
  when?: Condition;
  assert: Condition;
  violation: Explanation & { field?: string };
  repairHints?: RepairHint[];
}

export interface ConstraintRuleset {
  schemaVersion: "1.0";
  kind: "constraint";
  id: string;
  version: string;
  effective?: EffectiveWindow;
  inputs: InputDefinition[];
  constraints: ConstraintRule[];
}

export type Ruleset = DecisionRuleset | ConstraintRuleset;

export interface EvaluateDecisionRequest {
  ruleset: DecisionRuleset;
  facts: JsonObject;
  expectedVersion?: string;
  expectedFingerprint?: string;
  asOf?: string;
}

export interface CheckConstraintsRequest {
  ruleset: ConstraintRuleset;
  candidate: JsonObject;
  facts?: JsonObject;
  expectedVersion?: string;
  expectedFingerprint?: string;
  asOf?: string;
}

export interface ApprovedConstraintCheckRequest {
  candidate: JsonObject;
  facts?: JsonObject;
}

export interface RulesetIdentity {
  id: string;
  version: string;
  fingerprint: string;
}

export interface ApprovedConstraintBinding {
  ruleset: ConstraintRuleset;
  expected: RulesetIdentity;
}

export interface TrustedConstraintExecutionContext<TResult> {
  candidate: unknown;
  facts?: unknown;
  execute(action: ReadonlyJsonObject): Promise<TResult>;
}

export type ConstraintExecutionOutcome<TResult> =
  | { status: "executed"; constraint: ConstraintResult; value: TResult }
  | { status: "blocked"; constraint: ConstraintResult };

export interface MissingInput {
  path: string;
  type: InputType;
  requiredBy: string[];
}

export interface ResultError {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  paths?: string[];
  ruleIds?: string[];
  example?: JsonObject;
}

export interface ValidationResult {
  kind: "validation_result";
  status: "valid" | "invalid";
  ruleset?: RulesetIdentity;
  issues: ValidationIssue[];
}

export type DecisionStatus =
  | "decided"
  | "no_match"
  | "insufficient_input"
  | "conflict"
  | "inactive_ruleset"
  | "version_mismatch"
  | "fingerprint_mismatch"
  | "invalid_ruleset"
  | "invalid_input";

export interface DecisionResult {
  kind: "decision_result";
  status: DecisionStatus;
  ruleset: RulesetIdentity;
  evaluatedAt: string;
  decision?: JsonValue | JsonValue[];
  matchedRules: string[];
  missingInputs: MissingInput[];
  explanations: Array<Explanation & { ruleId: string }>;
  errors: ResultError[];
}

export interface ConstraintViolation extends Explanation {
  constraintId: string;
  severity: "hard" | "soft";
  field?: string;
  repairHints: RepairHint[];
}

export type ConstraintStatus =
  | "valid"
  | "valid_with_warnings"
  | "invalid"
  | "insufficient_input"
  | "inactive_ruleset"
  | "version_mismatch"
  | "fingerprint_mismatch"
  | "invalid_ruleset"
  | "invalid_input";

export interface ConstraintResult {
  kind: "constraint_result";
  status: ConstraintStatus;
  valid: boolean | null;
  ruleset: RulesetIdentity;
  evaluatedAt: string;
  checkedConstraints: string[];
  violations: ConstraintViolation[];
  missingInputs: MissingInput[];
  errors: ResultError[];
}
