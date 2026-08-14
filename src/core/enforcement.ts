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

export type TrustedConstraintContextRunner<TResult> = (
  action: ReadonlyJsonObject,
  evaluateAndExecute: (
    context: TrustedConstraintExecutionContext<TResult>,
  ) => Promise<ConstraintExecutionOutcome<TResult>>,
) => Promise<unknown>;

function configurationError(message: string): never {
  throw new ApprovedConstraintConfigurationError(message);
}

function serializedByteLength(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : Buffer.byteLength(serialized);
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
      const actionResult = JsonObjectSchema.safeParse(action);
      if (
        bytes === undefined ||
        bytes > MODEL_LIMITS.maxRequestBytes ||
        !actionResult.success
      ) {
        throw new ConstraintExecutionInputError(
          bytes !== undefined && bytes > MODEL_LIMITS.maxRequestBytes
            ? `Guarded action exceeds ${MODEL_LIMITS.maxRequestBytes} bytes.`
            : "Guarded action must be a bounded serializable JSON object.",
        );
      }

      const snapshot = deepFreezeJson(actionResult.data) as ReadonlyJsonObject;
      let produced: ConstraintExecutionOutcome<TResult> | undefined;
      let contextCalls = 0;
      await runInTrustedContext(snapshot, async (context) => {
        contextCalls += 1;
        if (contextCalls > 1) {
          return configurationError("Trusted execution context invoked the guard more than once.");
        }
        const constraint = checker.check({
          candidate: context.candidate,
          ...(context.facts === undefined ? {} : { facts: context.facts }),
        });
        if (constraint.valid !== true) {
          produced = { status: "blocked", constraint };
          return produced;
        }
        const value = await context.execute(snapshot);
        produced = { status: "executed", constraint, value };
        return produced;
      });

      if (!produced) {
        return configurationError("Trusted execution context did not invoke the guard.");
      }
      return produced;
    },
  });
}
