import { describe, expect, it } from "vitest";

import { validateRuleset } from "../src/core/validate.js";
import type { ConstraintRuleset } from "../src/model/types.js";
import { compare, decisionRuleset, input } from "./fixtures.js";

describe("ruleset validation", () => {
  it("rejects unknown model fields", () => {
    const result = validateRuleset({ ...decisionRuleset(), sourceOfTruth: "somewhere" });
    expect(result.status).toBe("invalid");
    expect(result.issues[0]?.code).toBe("SCHEMA_INVALID");
  });

  it("rejects undeclared paths and decimal literals encoded as numbers", () => {
    const undeclared = validateRuleset(
      decisionRuleset({ rules: [{ id: "R1", when: compare("missing", "eq", "x"), then: { decision: "x" } }] }),
    );
    expect(undeclared.issues.some((issue) => issue.code === "UNDEFINED_FACT")).toBe(true);

    const inexact = validateRuleset(
      decisionRuleset({ rules: [{ id: "R1", when: compare("amount", "gt", 0.1), then: { decision: "x" } }] }),
    );
    expect(inexact.issues.some((issue) => issue.code === "INVALID_LITERAL_TYPE")).toBe(true);

    const malformed = validateRuleset(
      decisionRuleset({ rules: [{ id: "R1", when: compare("amount", "gt", "not-a-decimal"), then: { decision: "x" } }] }),
    );
    expect(malformed.status).toBe("invalid");
    expect(malformed.issues.some((issue) => issue.code === "INVALID_LITERAL_TYPE")).toBe(true);

    const extremeExponent = validateRuleset(
      decisionRuleset({ rules: [{ id: "R1", when: compare("amount", "gt", "1e99999999999999999"), then: { decision: "x" } }] }),
    );
    expect(extremeExponent.status).toBe("invalid");
  });

  it("proves simple interval overlap under unique hit policy and returns a witness", () => {
    const ruleset = decisionRuleset({
      inputs: [input("age", "integer")],
      hitPolicy: "unique",
      rules: [
        { id: "R1", when: compare("age", "gt", 18), then: { decision: "adult" } },
        { id: "R2", when: compare("age", "gt", 20), then: { decision: "older" } },
      ],
    });
    const result = validateRuleset(ruleset);
    const overlap = result.issues.find((issue) => issue.code === "RULE_OVERLAP");
    expect(result.status).toBe("invalid");
    expect(overlap?.example).toEqual({ age: "21" });
  });

  it("does not report overlap for mutually exclusive equality rules", () => {
    const ruleset = decisionRuleset({
      inputs: [input("country", "string")],
      hitPolicy: "unique",
      rules: [
        { id: "R1", when: compare("country", "eq", "CN"), then: { decision: "cn" } },
        { id: "R2", when: compare("country", "eq", "US"), then: { decision: "us" } },
      ],
    });
    const result = validateRuleset(ruleset);
    expect(result.status).toBe("valid");
    expect(result.issues.some((issue) => issue.code === "RULE_OVERLAP")).toBe(false);
  });

  it("rejects prototype-polluting fact paths and ordered null comparisons", () => {
    const unsafe = validateRuleset(
      decisionRuleset({
        inputs: [input("customer.__proto__.admin", "boolean")],
        rules: [
          {
            id: "R1",
            when: compare("customer.__proto__.admin", "eq", true),
            then: { decision: "x" },
          },
        ],
      }),
    );
    expect(unsafe.status).toBe("invalid");

    const nullOrdering = validateRuleset(
      decisionRuleset({
        inputs: [input("amount", "decimal", false, true)],
        rules: [{ id: "R1", when: compare("amount", "gt", null), then: { decision: "x" } }],
      }),
    );
    expect(nullOrdering.issues.some((issue) => issue.code === "NULL_ORDERING_NOT_SUPPORTED")).toBe(true);

    const nullableOrdering = validateRuleset(
      decisionRuleset({
        inputs: [input("amount", "decimal", false, true)],
        rules: [{ id: "R1", when: compare("amount", "lt", "5"), then: { decision: "x" } }],
      }),
    );
    expect(nullableOrdering.status).toBe("invalid");
    expect(nullableOrdering.issues).toContainEqual(
      expect.objectContaining({ code: "NULL_ORDERING_NOT_SUPPORTED", paths: ["amount"] }),
    );
  });

  it("rejects primitive input paths that collide with their own nested path", () => {
    const result = validateRuleset(
      decisionRuleset({
        inputs: [input("customer", "string"), input("customer.age", "integer")],
        rules: [{ id: "R1", when: compare("customer.age", "gte", 18), then: { decision: "x" } }],
      }),
    );
    expect(result.issues.some((issue) => issue.code === "INPUT_PATH_COLLISION")).toBe(true);
  });

  it("applies the condition-node budget cumulatively across the whole ruleset", () => {
    const repeated = Array.from({ length: 20 }, () => compare("facts.allowed", "eq", true));
    const ruleset: ConstraintRuleset = {
      schemaVersion: "1.0",
      kind: "constraint",
      id: "large.constraint",
      version: "1",
      inputs: [input("facts.allowed", "boolean")],
      constraints: Array.from({ length: 500 }, (_, index) => ({
        id: `C${index}`,
        severity: "hard" as const,
        assert: { op: "all" as const, conditions: repeated },
        violation: { code: "NOT_ALLOWED", message: "Not allowed." },
      })),
    };
    const result = validateRuleset(ruleset);
    expect(result.issues.some((issue) => issue.code === "CONDITION_NODE_LIMIT")).toBe(true);
  });

  it("rejects a deeply nested condition before recursive parsing can exhaust the stack", () => {
    let condition: unknown = compare("amount", "gte", "1");
    for (let index = 0; index < 2_000; index += 1) {
      condition = { op: "not", condition };
    }
    const ruleset = {
      ...decisionRuleset(),
      rules: [{ id: "R1", when: condition, then: { decision: "x" } }],
    };
    const result = validateRuleset(ruleset);
    expect(result.status).toBe("invalid");
    expect(result.issues[0]?.code).toBe("SCHEMA_INVALID");
  });

  it("rejects a deeply nested JSON decision value before recursive parsing", () => {
    let decision: unknown = "x";
    for (let index = 0; index < 2_000; index += 1) decision = { nested: decision };
    const ruleset = {
      ...decisionRuleset(),
      rules: [
        {
          id: "R1",
          when: compare("amount", "gte", "1"),
          then: { decision },
        },
      ],
    };
    expect(validateRuleset(ruleset).status).toBe("invalid");
  });

  it("marks an exact later first-match condition as unreachable", () => {
    const condition = compare("amount", "gte", "10");
    const result = validateRuleset(
      decisionRuleset({
        rules: [
          { id: "R1", when: condition, then: { decision: "a" } },
          { id: "R2", when: condition, then: { decision: "b" } },
        ],
      }),
    );
    expect(result.status).toBe("valid");
    expect(result.issues.some((issue) => issue.code === "UNREACHABLE_RULE")).toBe(true);
  });
});
