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

  it("does not execute a trusted-context callback that fires after the guard completed", async () => {
    const ruleset = constraintRuleset();
    const checker = createApprovedConstraintChecker(
      { ruleset, expected: identifyRuleset(ruleset) },
      () => "2026-08-13T00:00:00.000Z",
    );
    let sideEffects = 0;
    let lateInvocations: Array<Promise<unknown>> = [];
    const guard = createConstraintExecutionGuard(checker, async (_action, run) => {
      // Two fire-and-forget invocations after the guard returns: neither may
      // run the action, and neither may reject into an unwatched promise.
      setTimeout(() => {
        const late = () =>
          run({
            candidate: { amount: "15000" },
            facts: { approved: true },
            async execute() {
              sideEffects += 1;
              return "late";
            },
          });
        lateInvocations = [late(), late()];
      }, 10);
    });

    await expect(guard.execute({ amount: "15000" })).rejects.toThrow(
      ApprovedConstraintConfigurationError,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sideEffects).toBe(0);
    for (const invocation of lateInvocations) {
      await expect(invocation).resolves.toBeUndefined();
    }
  });

  it("joins an invoked continuation before reporting the guarded outcome", async () => {
    const ruleset = constraintRuleset();
    const checker = createApprovedConstraintChecker(
      { ruleset, expected: identifyRuleset(ruleset) },
      () => "2026-08-13T00:00:00.000Z",
    );
    let sideEffects = 0;
    const guard = createConstraintExecutionGuard(checker, async (_action, run) => {
      // A host bug discarded the promise. The guard must still join it instead
      // of returning an error while the side effect completes in the background.
      void run({
        candidate: { amount: "15000" },
        facts: { approved: true },
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          sideEffects += 1;
          return "receipt";
        },
      });
    });

    await expect(guard.execute({ amount: "15000" })).resolves.toMatchObject({
      status: "executed",
      value: "receipt",
    });
    expect(sideEffects).toBe(1);
  });

  it("does not let a trusted-runner error hide a completed side effect", async () => {
    const ruleset = constraintRuleset();
    const checker = createApprovedConstraintChecker(
      { ruleset, expected: identifyRuleset(ruleset) },
      () => "2026-08-13T00:00:00.000Z",
    );
    const guard = createConstraintExecutionGuard(checker, async (_action, run) => {
      await run({
        candidate: { amount: "15000" },
        facts: { approved: true },
        async execute() {
          return "committed";
        },
      });
      throw new Error("runner failed after commit");
    });

    await expect(guard.execute({ amount: "15000" })).resolves.toMatchObject({
      status: "executed",
      value: "committed",
    });
  });
});
