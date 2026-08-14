import { describe, expect, it } from "vitest";

import { checkConstraints } from "../src/core/constraint.js";
import { compare, constraintRuleset, input } from "./fixtures.js";

describe("constraint checking", () => {
  it("returns a hard violation and machine-actionable repair hint", () => {
    const result = checkConstraints({
      ruleset: constraintRuleset(),
      candidate: { amount: "15000" },
      facts: { approved: false },
    });

    expect(result.status).toBe("invalid");
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatchObject({
      constraintId: "C1",
      code: "APPROVAL_REQUIRED",
      repairHints: [{ kind: "provide_input", path: "facts.approved" }],
    });
  });

  it("asks for a missing conditional fact rather than treating it as false", () => {
    const result = checkConstraints({
      ruleset: constraintRuleset(),
      candidate: { amount: "15000" },
      facts: {},
    });

    expect(result.status).toBe("insufficient_input");
    expect(result.valid).toBeNull();
    expect(result.missingInputs).toEqual([
      { path: "facts.approved", type: "boolean", requiredBy: ["C1"] },
    ]);
  });

  it("does not require facts for a constraint whose activation is false", () => {
    const ruleset = constraintRuleset({
      inputs: [
        input("candidate.amount", "decimal", true),
        input("candidate.marketing", "boolean", true),
        input("facts.consent", "boolean"),
      ],
      constraints: [
        {
          id: "C1",
          severity: "hard",
          when: compare("candidate.marketing", "eq", true),
          assert: compare("facts.consent", "eq", true),
          violation: { code: "CONSENT_REQUIRED", message: "Consent required." },
        },
      ],
    });

    const result = checkConstraints({
      ruleset,
      candidate: { amount: "1", marketing: false },
      facts: {},
    });
    expect(result.status).toBe("valid");
    expect(result.checkedConstraints).toEqual([]);
  });

  it("returns soft failures as valid with warnings", () => {
    const base = constraintRuleset();
    const ruleset = constraintRuleset({
      constraints: [{ ...base.constraints[0]!, severity: "soft" }],
    });
    const result = checkConstraints({
      ruleset,
      candidate: { amount: "15" },
      facts: { approved: false },
    });
    expect(result.status).toBe("valid_with_warnings");
    expect(result.valid).toBe(true);
  });
});
