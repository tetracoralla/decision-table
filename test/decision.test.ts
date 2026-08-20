import { describe, expect, it } from "vitest";

import { evaluateDecision } from "../src/core/decision.js";
import { fingerprintRuleset } from "../src/core/fingerprint.js";
import type { DecisionRuleset, JsonObject } from "../src/model/types.js";
import { compare, decisionRuleset, input } from "./fixtures.js";

describe("decision evaluation", () => {
  it("compares decimal strings exactly and returns ruleset identity", () => {
    const result = evaluateDecision({
      ruleset: decisionRuleset(),
      facts: { amount: "10000.0000000000000000001" },
      asOf: "2026-08-13T00:00:00.000Z",
    });

    expect(result.status).toBe("decided");
    expect(result.decision).toBe("approve");
    expect(result.matchedRules).toEqual(["R1"]);
    expect(result.ruleset.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not let a later rule bypass an unknown earlier first-match rule", () => {
    const ruleset = decisionRuleset({
      inputs: [input("vip", "boolean"), input("country", "string")],
      rules: [
        { id: "R1", when: compare("vip", "eq", true), then: { decision: "vip" } },
        { id: "R2", when: compare("country", "eq", "CN"), then: { decision: "standard" } },
      ],
    });

    const result = evaluateDecision({ ruleset, facts: { country: "CN" } });
    expect(result.status).toBe("insufficient_input");
    expect(result.missingInputs).toEqual([
      { path: "vip", type: "boolean", requiredBy: ["R1"] },
    ]);
  });

  it("reports only required inputs that are actually missing", () => {
    const ruleset = decisionRuleset({
      inputs: [input("provided", "boolean", true), input("missing", "boolean", true)],
      rules: [
        {
          id: "R1",
          when: compare("provided", "eq", true),
          then: { decision: "yes" },
        },
      ],
    });

    const result = evaluateDecision({ ruleset, facts: { provided: true } });
    expect(result.status).toBe("insufficient_input");
    expect(result.missingInputs).toEqual([
      { path: "missing", type: "boolean", requiredBy: ["$schema"] },
    ]);
  });

  it("ignores unknown lower-priority rules once a higher-priority match is proven", () => {
    const ruleset = decisionRuleset({
      inputs: [input("country", "string"), input("vip", "boolean")],
      hitPolicy: "priority",
      rules: [
        {
          id: "HIGH",
          priority: 100,
          when: compare("country", "eq", "CN"),
          then: { decision: "cn" },
        },
        {
          id: "LOW",
          priority: 10,
          when: compare("vip", "eq", true),
          then: { decision: "vip" },
        },
      ],
    });

    const result = evaluateDecision({ ruleset, facts: { country: "CN" } });
    expect(result.status).toBe("decided");
    expect(result.decision).toBe("cn");
  });

  it("returns conflict for runtime overlap that conservative static analysis cannot prove", () => {
    const ruleset: DecisionRuleset = decisionRuleset({
      inputs: [input("a", "boolean"), input("b", "boolean")],
      hitPolicy: "unique",
      rules: [
        {
          id: "R1",
          when: { op: "any", conditions: [compare("a", "eq", true), compare("b", "eq", true)] },
          then: { decision: "one" },
        },
        {
          id: "R2",
          when: { op: "not", condition: compare("a", "eq", false) },
          then: { decision: "two" },
        },
      ],
    });

    const result = evaluateDecision({ ruleset, facts: { a: true, b: false } });
    expect(result.status).toBe("conflict");
    expect(result.matchedRules).toEqual(["R1", "R2"]);
    expect(result.errors[0]?.code).toBe("RULE_CONFLICT");
  });

  it("blocks an expired ruleset and a version mismatch", () => {
    const ruleset = decisionRuleset({ effective: { until: "2026-01-01T00:00:00.000Z" } });
    expect(
      evaluateDecision({ ruleset, facts: { amount: "20000" }, asOf: "2026-08-13T00:00:00.000Z" }).status,
    ).toBe("inactive_ruleset");
    expect(
      evaluateDecision({ ruleset: decisionRuleset(), facts: { amount: "20000" }, expectedVersion: "2.0.0" }).status,
    ).toBe("version_mismatch");
  });

  it("pins the exact ruleset content when an expected fingerprint is supplied", () => {
    const ruleset = decisionRuleset();
    expect(
      evaluateDecision({
        ruleset,
        facts: { amount: "20000" },
        expectedFingerprint: fingerprintRuleset(ruleset),
      }).status,
    ).toBe("decided");
    expect(
      evaluateDecision({
        ruleset,
        facts: { amount: "20000" },
        expectedFingerprint: "0".repeat(64),
      }),
    ).toMatchObject({
      status: "fingerprint_mismatch",
      errors: [{ code: "RULESET_FINGERPRINT_MISMATCH" }],
    });
  });

  it("rejects undeclared facts instead of silently ignoring a typo", () => {
    const result = evaluateDecision({
      ruleset: decisionRuleset(),
      facts: { amount: "20000", amuont: "1" },
    });
    expect(result.status).toBe("invalid_input");
    expect(result.errors[0]?.code).toBe("UNKNOWN_FACT");
  });

  it("rejects an undeclared empty object instead of treating it as no facts", () => {
    const result = evaluateDecision({
      ruleset: decisionRuleset(),
      facts: { typo: {} },
    });
    expect(result.status).toBe("invalid_input");
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_FACT", path: "typo" }),
    );
  });

  it("rejects a flat dotted facts key instead of asking for it forever", () => {
    const ruleset = decisionRuleset({
      inputs: [input("user.name", "string", true)],
      rules: [{ id: "R1", when: compare("user.name", "eq", "Ada"), then: { decision: "ok" } }],
    });
    const result = evaluateDecision({ ruleset, facts: { "user.name": "Ada" } });
    expect(result.status).toBe("invalid_input");
    expect(result.errors[0]).toMatchObject({ code: "AMBIGUOUS_FACT_KEY", path: "user.name" });
  });

  it("bounds a cyclic facts object instead of exhausting the heap", () => {
    const facts: JsonObject = {};
    (facts as { self?: JsonObject }).self = facts;
    const result = evaluateDecision({ ruleset: decisionRuleset(), facts });
    expect(result.status).toBe("invalid_input");
    expect(result.errors[0]?.code).toBe("FACT_NODE_LIMIT");
  });
});
