import type {
  Condition,
  ConstraintRuleset,
  DecisionRuleset,
  InputDefinition,
  JsonPrimitive,
} from "../src/model/types.js";

export const input = (
  path: string,
  type: InputDefinition["type"],
  required = false,
  nullable = false,
): InputDefinition => ({ path, type, required, nullable });

export const fact = (path: string) => ({ kind: "fact" as const, path });
export const literal = (value: JsonPrimitive | JsonPrimitive[]) => ({
  kind: "literal" as const,
  value,
});
export const compare = (
  path: string,
  comparator: Extract<Condition, { op: "compare" }>["comparator"],
  value: JsonPrimitive | JsonPrimitive[],
): Condition => ({ op: "compare", left: fact(path), comparator, right: literal(value) });

export function decisionRuleset(
  overrides: Partial<DecisionRuleset> = {},
): DecisionRuleset {
  return {
    schemaVersion: "1.0",
    kind: "decision",
    id: "test.decision",
    version: "1.0.0",
    inputs: [input("amount", "decimal")],
    hitPolicy: "first",
    rules: [
      {
        id: "R1",
        when: compare("amount", "gte", "10000"),
        then: { decision: "approve" },
      },
    ],
    ...overrides,
  };
}

export function constraintRuleset(
  overrides: Partial<ConstraintRuleset> = {},
): ConstraintRuleset {
  return {
    schemaVersion: "1.0",
    kind: "constraint",
    id: "test.constraint",
    version: "1.0.0",
    inputs: [
      input("candidate.amount", "decimal", true),
      input("facts.approved", "boolean"),
    ],
    constraints: [
      {
        id: "C1",
        severity: "hard",
        assert: compare("facts.approved", "eq", true),
        violation: {
          code: "APPROVAL_REQUIRED",
          message: "Approval is required.",
          field: "facts.approved",
        },
        repairHints: [{ kind: "provide_input", path: "facts.approved" }],
      },
    ],
    ...overrides,
  };
}
