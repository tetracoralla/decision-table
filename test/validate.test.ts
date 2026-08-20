import { describe, expect, it } from "vitest";

import { evaluateDecision } from "../src/core/decision.js";
import { validateRuleset } from "../src/core/validate.js";
import { EvaluateDecisionRequestSchema } from "../src/model/schemas.js";
import type { ConstraintRuleset } from "../src/model/types.js";
import { compare, decisionRuleset, input, literal } from "./fixtures.js";

describe("ruleset validation", () => {
  it("rejects unknown model fields", () => {
    const result = validateRuleset({ ...decisionRuleset(), sourceOfTruth: "somewhere" });
    expect(result.status).toBe("invalid");
    expect(result.issues[0]?.code).toBe("SCHEMA_INVALID");
    expect(result.issues[0]?.paths).toEqual(["$"]);
    expect(result.issues[0]?.message).toContain("sourceOfTruth");
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

  it("keeps checking literal types after the issue budget fills with warnings", () => {
    const groups = Array.from({ length: 11 }, () => ({
      op: "all" as const,
      conditions: Array.from({ length: 95 }, () => ({
        op: "compare" as const,
        left: literal(1),
        comparator: "eq" as const,
        right: literal(1),
      })),
    }));
    // 1,045 constant-compare warnings come first; the malformed literal comes last,
    // exactly where a per-condition issue budget used to stop looking.
    const when = {
      op: "all" as const,
      conditions: [...groups, compare("amount", "gt", "not-a-number")],
    };
    const ruleset = decisionRuleset({
      inputs: [input("amount", "integer")],
      rules: [{ id: "R1", when, then: { decision: "x" } }],
    });

    const result = validateRuleset(ruleset);
    expect(result.status).toBe("invalid");
    expect(result.issues.some((issue) => issue.code === "INVALID_LITERAL_TYPE")).toBe(false);
    expect(result.issues.at(-1)?.code).toBe("VALIDATION_ISSUES_TRUNCATED");

    const evaluated = evaluateDecision({ ruleset, facts: { amount: 5 } });
    expect(evaluated.status).toBe("invalid_ruleset");
    expect(evaluated.errors[0]?.code).toBe("VALIDATION_ISSUES_TRUNCATED");
  });

  it("does not prove overlap through a date witness outside the strict date range", () => {
    const ruleset = decisionRuleset({
      inputs: [input("d", "date"), input("s", "string")],
      hitPolicy: "unique",
      rules: [
        { id: "R1", when: compare("d", "gt", "9999-12-31"), then: { decision: "never" } },
        {
          id: "R2",
          when: { op: "all", conditions: [compare("d", "gt", "2020-01-01"), compare("s", "eq", "x")] },
          then: { decision: "recent" },
        },
      ],
    });
    const result = validateRuleset(ruleset);
    expect(result.issues.some((issue) => issue.code === "RULE_OVERLAP")).toBe(false);
  });

  it("proves overlap between pre-year-1000 date bounds with a valid witness", () => {
    const ruleset = decisionRuleset({
      inputs: [input("d", "date")],
      hitPolicy: "unique",
      rules: [
        { id: "R1", when: compare("d", "gte", "0500-01-01"), then: { decision: "a" } },
        { id: "R2", when: compare("d", "lte", "0600-01-01"), then: { decision: "b" } },
      ],
    });
    const overlap = validateRuleset(ruleset).issues.find((issue) => issue.code === "RULE_OVERLAP");
    expect(overlap).toMatchObject({ example: { d: "0500-01-01" } });
  });

  it("rejects reserved and dotted keys in context objects at the schema layer", () => {
    const protoFacts = JSON.parse('{"amount": "10000", "__proto__": {"injected": 1}}');
    const protoParse = EvaluateDecisionRequestSchema.safeParse({
      ruleset: decisionRuleset(),
      facts: protoFacts,
    });
    expect(protoParse.success).toBe(false);
    expect(protoParse.success === false && protoParse.error.issues.some((issue) => issue.message.includes("__proto__"))).toBe(true);

    const dottedParse = EvaluateDecisionRequestSchema.safeParse({
      ruleset: decisionRuleset(),
      facts: { "a.b": 1 },
    });
    expect(dottedParse.success).toBe(false);
    expect(dottedParse.success === false && dottedParse.error.issues.some((issue) => issue.message.includes("'.'"))).toBe(true);
  });

  it("applies the JSON node budget cumulatively to the complete ruleset and request", () => {
    const ruleset = decisionRuleset({
      rules: Array.from({ length: 22 }, (_, index) => ({
        id: `R${index}`,
        when: compare("amount", "gt", "0"),
        then: { decision: Array.from({ length: 950 }, () => null) },
      })),
    });
    expect(validateRuleset(ruleset)).toMatchObject({
      status: "invalid",
      issues: expect.arrayContaining([expect.objectContaining({ code: "SCHEMA_INVALID" })]),
    });
    expect(EvaluateDecisionRequestSchema.safeParse({ ruleset, facts: { amount: "1" } }).success).toBe(false);
  });
});
