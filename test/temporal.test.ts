import { describe, expect, it } from "vitest";

import { evaluateDecision } from "../src/core/decision.js";
import { validateRuleset } from "../src/core/validate.js";
import { EvaluateDecisionRequestSchema } from "../src/model/schemas.js";
import { compare, decisionRuleset, input } from "./fixtures.js";

function temporalRuleset() {
  return decisionRuleset({
    inputs: [input("at", "datetime", true)],
    rules: [
      {
        id: "R1",
        when: compare("at", "gt", "2026-02-01T00:00:00.000Z"),
        then: { decision: "after" },
      },
    ],
  });
}

describe("strict temporal semantics", () => {
  it("rejects impossible calendar dates instead of normalizing them", () => {
    const result = evaluateDecision({
      ruleset: temporalRuleset(),
      facts: { at: "2026-02-30T00:00:00.000Z" },
    });
    expect(result).toMatchObject({
      status: "invalid_input",
      errors: [{ code: "INVALID_FACT_TYPE", path: "at" }],
    });
  });

  it("supports exact milliseconds and rejects unsupported sub-millisecond precision", () => {
    expect(
      evaluateDecision({
        ruleset: temporalRuleset(),
        facts: { at: "2026-02-01T00:00:00.001Z" },
      }),
    ).toMatchObject({ status: "decided", decision: "after" });
    expect(
      evaluateDecision({
        ruleset: temporalRuleset(),
        facts: { at: "2026-02-01T00:00:00.0002Z" },
      }).status,
    ).toBe("invalid_input");

    const invalidLiteral = temporalRuleset();
    invalidLiteral.rules[0]!.when = compare("at", "gt", "2026-02-01T00:00:00.0002Z");
    expect(validateRuleset(invalidLiteral)).toMatchObject({
      status: "invalid",
      issues: expect.arrayContaining([expect.objectContaining({ code: "INVALID_LITERAL_TYPE" })]),
    });
  });

  it("uses the same strict datetime contract for effective windows and asOf", () => {
    expect(
      validateRuleset(
        decisionRuleset({ effective: { from: "2026-02-30T00:00:00.000Z" } }),
      ).status,
    ).toBe("invalid");
    expect(
      EvaluateDecisionRequestSchema.safeParse({
        ruleset: temporalRuleset(),
        facts: { at: "2026-02-01T00:00:00.001Z" },
        asOf: "2026-02-30T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
