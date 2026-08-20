import { utf8ToBytes } from "@noble/hashes/utils.js";
import {
  ApprovedConstraintBindingSchema,
  ApprovedConstraintCheckRequestSchema,
  JsonObjectSchema,
  MODEL_LIMITS,
} from "../model/schemas.js";
import { isStrictDatetime } from "../model/temporal.js";
import type {
  ApprovedConstraintCheckRequest,
  ConstraintExecutionOutcome,
  ConstraintResult,
  JsonValue,
  ReadonlyJsonObject,
  ResultError,
  RulesetIdentity,
  TrustedConstraintExecutionContext,
} from "../model/types.js";
import { checkConstraints } from "./constraint.js";
import { identifyRuleset } from "./fingerprint.js";
import { limitResultErrors } from "./runtime.js";
import { validateRuleset } from "./validate.js";

export class ApprovedConstraintConfigurationError extends Error {
  readonly code = "INVALID_APPROVED_CONSTRAINT_CONFIGURATION";
}

export class ConstraintExecutionInputError extends Error {
  readonly code = "INVALID_GUARDED_ACTION";
}

export interface ApprovedConstraintChecker {
  readonly ruleset: RulesetIdentity;
  check(request: unknown): ConstraintResult;
}

export interface ConstraintExecutionGuard<TResult> {
  readonly ruleset: RulesetIdentity;
  execute(action: unknown): Promise<ConstraintExecutionOutcome<TResult>>;
}

/**
 * evaluateAndExecute resolves to undefined when the invocation is ignored
 * because it arrived after the guard completed or duplicated an invocation;
 * no side effect ran for that ignored call.
 */
export type TrustedConstraintContextRunner<TResult> = (
  action: ReadonlyJsonObject,
  evaluateAndExecute: (
    context: TrustedConstraintExecutionContext<TResult>,
  ) => Promise<ConstraintExecutionOutcome<TResult> | undefined>,
) => Promise<unknown>;

function configurationError(message: string): never {
  throw new ApprovedConstraintConfigurationError(message);
}

function serializedByteLength(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : utf8ToBytes(serialized).length;
  } catch {
    return undefined;
  }
}

function deepFreezeJson<T extends JsonValue>(value: T): T {
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object" || Object.isFrozen(current)) continue;
    Object.freeze(current);
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      pending.push(child);
    }
  }
  return value;
}

function schemaErrors(
  issues: Array<{ path: PropertyKey[]; message: string }>,
): ResultError[] {
  return limitResultErrors(
    issues.map((issue) => ({
      code: "INVALID_REQUEST",
      message: issue.message,
      path: issue.path.join(".") || "$",
    })),
  );
}

function invalidCheckResult(
  ruleset: RulesetIdentity,
  evaluatedAt: string,
  errors: ResultError[],
): ConstraintResult {
  return {
    kind: "constraint_result",
    status: "invalid_input",
    valid: null,
    ruleset,
    evaluatedAt,
    checkedConstraints: [],
    violations: [],
    missingInputs: [],
    errors,
  };
}

export function createApprovedConstraintChecker(
  binding: unknown,
  now: () => string = () => new Date().toISOString(),
): ApprovedConstraintChecker {
  const parsed = ApprovedConstraintBindingSchema.safeParse(binding);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
      .join("; ");
    return configurationError(`Host-bound constraint configuration is invalid: ${message}`);
  }

  const validation = validateRuleset(parsed.data.ruleset);
  if (validation.status === "invalid") {
    return configurationError(
      `Host-bound ruleset is invalid: ${validation.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.code)
        .join(", ")}`,
    );
  }

  const ruleset = deepFreezeJson(parsed.data.ruleset as unknown as JsonValue) as unknown as typeof parsed.data.ruleset;
  const actual = Object.freeze(identifyRuleset(ruleset));
  const expected = parsed.data.expected;
  if (
    actual.id !== expected.id ||
    actual.version !== expected.version ||
    actual.fingerprint !== expected.fingerprint
  ) {
    return configurationError(
      `Host-bound ruleset identity mismatch: expected ${expected.id}@${expected.version}#${expected.fingerprint}, received ${actual.id}@${actual.version}#${actual.fingerprint}.`,
    );
  }

  return Object.freeze({
    ruleset: actual,
    check(request: unknown): ConstraintResult {
      const evaluatedAt = now();
      if (!isStrictDatetime(evaluatedAt)) {
        return configurationError(`Host clock returned invalid datetime '${evaluatedAt}'.`);
      }

      const bytes = serializedByteLength(request);
      if (bytes === undefined) {
        return invalidCheckResult(actual, evaluatedAt, [
          { code: "INVALID_REQUEST", message: "Request must be serializable JSON." },
        ]);
      }
      if (bytes > MODEL_LIMITS.maxRequestBytes) {
        return invalidCheckResult(actual, evaluatedAt, [
          {
            code: "REQUEST_TOO_LARGE",
            message: `Request exceeds ${MODEL_LIMITS.maxRequestBytes} bytes.`,
          },
        ]);
      }

      const requestResult = ApprovedConstraintCheckRequestSchema.safeParse(request);
      if (!requestResult.success) {
        return invalidCheckResult(actual, evaluatedAt, schemaErrors(requestResult.error.issues));
      }
      const approvedRequest: ApprovedConstraintCheckRequest = requestResult.data;
      return checkConstraints({
        ruleset,
        candidate: approvedRequest.candidate,
        ...(approvedRequest.facts ? { facts: approvedRequest.facts } : {}),
        expectedVersion: expected.version,
        expectedFingerprint: expected.fingerprint,
        asOf: evaluatedAt,
      });
    },
  });
}

export function createConstraintExecutionGuard<TResult>(
  checker: ApprovedConstraintChecker,
  runInTrustedContext: TrustedConstraintContextRunner<TResult>,
): ConstraintExecutionGuard<TResult> {
  return Object.freeze({
    ruleset: checker.ruleset,
    async execute(action: unknown): Promise<ConstraintExecutionOutcome<TResult>> {
      const bytes = serializedByteLength(action);
      if (bytes === undefined) {
        throw new ConstraintExecutionInputError("Guarded action must be a bounded serializable JSON object.");
      }
      if (bytes > MODEL_LIMITS.maxRequestBytes) {
        throw new ConstraintExecutionInputError(`Guarded action exceeds ${MODEL_LIMITS.maxRequestBytes} bytes.`);
      }
      const actionResult = JsonObjectSchema.safeParse(action);
      if (!actionResult.success) {
        throw new ConstraintExecutionInputError("Guarded action must be a bounded serializable JSON object.");
      }

      const snapshot = deepFreezeJson(actionResult.data) as ReadonlyJsonObject;
      let produced: ConstraintExecutionOutcome<TResult> | undefined;
      let contextCalls = 0;
      let closed = false;
      let activeInvocation: Promise<ConstraintExecutionOutcome<TResult> | undefined> | undefined;
      let runnerError: unknown;
      let runnerFailed = false;
      let invocationError: unknown;
      let invocationFailed = false;
      try {
        await runInTrustedContext(snapshot, (context) => {
          // A callback retained beyond the trusted context cannot start a side
          // effect. Resolve quietly because the caller may have discarded the
          // returned promise.
          if (closed) return Promise.resolve(undefined);
          contextCalls += 1;
          if (contextCalls > 1) return Promise.resolve(undefined);

          activeInvocation = (async () => {
            const constraint = checker.check({
              candidate: context.candidate,
              ...(context.facts === undefined ? {} : { facts: context.facts }),
            });
            if (constraint.valid !== true) {
              produced = { status: "blocked", constraint };
              return produced;
            }
            if (closed) return;
            const value = await context.execute(snapshot);
            produced = { status: "executed", constraint, value };
            return produced;
          })();
          return activeInvocation;
        });
      } catch (error) {
        runnerFailed = true;
        runnerError = error;
      }
      closed = true;

      // A misconfigured context may call the continuation without returning or
      // awaiting it. Always join that invocation before reporting an outcome so
      // an error cannot hide a side effect that is still completing.
      if (activeInvocation) {
        try {
          await activeInvocation;
        } catch (error) {
          invocationFailed = true;
          invocationError = error;
        }
      }
      if (produced?.status === "executed") return produced;
      if (runnerFailed) throw runnerError;
      if (invocationFailed) throw invocationError;
      if (contextCalls > 1) {
        return configurationError("Trusted execution context invoked the guard more than once.");
      }
      if (!produced) {
        return configurationError("Trusted execution context did not invoke the guard.");
      }
      return produced;
    },
  });
}
