import { describe, expect, it } from "vitest";

import {
  ApprovedConstraintConfigurationError,
  createApprovedConstraintChecker,
  createConstraintExecutionGuard,
} from "../src/core/enforcement.js";
import { identifyRuleset } from "../src/core/fingerprint.js";
import { constraintRuleset } from "./fixtures.js";

describe("approved constraint checking and guarded execution", () => {
  it("binds ruleset identity and evaluates with host time", () => {
    const ruleset = constraintRuleset();
    const checker = createApprovedConstraintChecker(
      { ruleset, expected: identifyRuleset(ruleset) },
      () => "2026-08-13T00:00:00.000Z",
    );

    const result = checker.check({
      candidate: { amount: "15000" },
      facts: { approved: false },
    });

    expect(checker.ruleset).toEqual(identifyRuleset(ruleset));
    expect(result).toMatchObject({
      status: "invalid",
      valid: false,
      evaluatedAt: "2026-08-13T00:00:00.000Z",
      ruleset: identifyRuleset(ruleset),
    });
  });

  it("refuses a same-version ruleset whose approved fingerprint does not match", () => {
    const approved = constraintRuleset();
    const substituted = constraintRuleset({
      constraints: [
        {
          ...approved.constraints[0]!,
          violation: { ...approved.constraints[0]!.violation, message: "Substituted policy." },
        },
      ],
    });
    expect(() =>
      createApprovedConstraintChecker({ ruleset: substituted, expected: identifyRuleset(approved) }),
    ).toThrow(ApprovedConstraintConfigurationError);
  });

  it("validates and cumulatively bounds public checker requests at runtime", () => {
    const ruleset = constraintRuleset();
    const checker = createApprovedConstraintChecker(
      { ruleset, expected: identifyRuleset(ruleset) },
      () => "2026-08-13T00:00:00.000Z",
    );
    const wide = {
      groups: Array.from({ length: 1_000 }, () => Array.from({ length: 14 }, () => null)),
    };

    expect(checker.check({ candidate: {}, unexpected: true })).toMatchObject({
      status: "invalid_input",
      errors: [expect.objectContaining({ code: "INVALID_REQUEST" })],
    });
    expect(checker.check({ candidate: wide, facts: wide })).toMatchObject({
      status: "invalid_input",
      errors: [expect.objectContaining({ code: "INVALID_REQUEST" })],
    });
    expect(checker.check({ candidate: { huge: "x".repeat(300_000) } })).toMatchObject({
      status: "invalid_input",
      errors: [{ code: "REQUEST_TOO_LARGE" }],
    });
  });

  it("binds trusted facts and the exact action snapshot to guarded execution", async () => {
    const ruleset = constraintRuleset();
    const checker = createApprovedConstraintChecker(
      { ruleset, expected: identifyRuleset(ruleset) },
      () => "2026-08-13T00:00:00.000Z",
    );
    let executorCalls = 0;
    const blockedGuard = createConstraintExecutionGuard(checker, async (action, run) =>
      run({
        candidate: { amount: action.amount },
        facts: { approved: false },
        async execute() {
          executorCalls += 1;
          return "executed";
        },
      }),
    );

    const blocked = await blockedGuard.execute({ amount: "15000", claimedApproved: true });
    expect(blocked).toMatchObject({ status: "blocked", constraint: { valid: false } });
    expect(executorCalls).toBe(0);

    let transactionActive = false;
    let executedAmount: unknown;
    const allowedGuard = createConstraintExecutionGuard(checker, async (action, run) => {
      transactionActive = true;
      try {
        return await run({
          candidate: { amount: action.amount },
          facts: { approved: true },
          async execute(snapshot) {
            expect(transactionActive).toBe(true);
            expect(Object.isFrozen(snapshot)).toBe(true);
            executedAmount = snapshot.amount;
            return "receipt";
          },
        });
      } finally {
        transactionActive = false;
      }
    });
    const action = { amount: "15000" };
    const execution = allowedGuard.execute(action);
    action.amount = "1";
    await expect(execution).resolves.toMatchObject({ status: "executed", value: "receipt" });
    expect(executedAmount).toBe("15000");
  });
});
