#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { checkConstraints } from "./core/constraint.js";
import { evaluateDecision } from "./core/decision.js";
import { validateRuleset } from "./core/validate.js";
import {
  CheckConstraintsRequestSchema,
  EvaluateDecisionRequestSchema,
  MODEL_LIMITS,
} from "./model/schemas.js";
import type { JsonObject } from "./model/types.js";

interface ParsedArgs {
  command: string;
  modelPath: string;
  options: Map<string, string | true>;
}

interface InputBudget {
  used: number;
}

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function usage(): string {
  return [
    "Usage:",
    "  decision-table validate <ruleset.json> [--compact]",
    "  decision-table evaluate <ruleset.json> --facts <facts.json> [--expected-version <version>] [--expected-fingerprint <sha256>] [--as-of <ISO datetime>] [--compact]",
    "  decision-table check <ruleset.json> --candidate <candidate.json> [--facts <facts.json>] [--expected-version <version>] [--expected-fingerprint <sha256>] [--as-of <ISO datetime>] [--compact]",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, modelPath, ...rest] = argv;
  if (!command || !modelPath || !["validate", "evaluate", "check"].includes(command)) {
    throw new CliError("USAGE", usage());
  }
  if (modelPath.startsWith("--")) throw new CliError("USAGE", usage());
  const allowedOptions = new Set(
    command === "validate"
      ? ["--compact"]
      : command === "evaluate"
        ? ["--facts", "--expected-version", "--expected-fingerprint", "--as-of", "--compact"]
        : ["--candidate", "--facts", "--expected-version", "--expected-fingerprint", "--as-of", "--compact"],
  );
  const options = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) throw new CliError("USAGE", `Unexpected argument '${token ?? ""}'.`);
    if (!allowedOptions.has(token)) {
      throw new CliError("USAGE", `Option '${token}' is not valid for the '${command}' command.`);
    }
    if (options.has(token)) throw new CliError("USAGE", `Option '${token}' was provided more than once.`);
    if (token === "--compact") {
      options.set(token, true);
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new CliError("USAGE", `Option '${token}' requires a value.`);
    options.set(token, value);
    index += 1;
  }
  return { command, modelPath, options };
}

async function readJson(
  path: string,
  stdinUsed: { value: boolean },
  budget: InputBudget,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let stream: AsyncIterable<Uint8Array | string>;
  if (path === "-") {
    if (stdinUsed.value) throw new CliError("STDIN_REUSED", "Only one input document may use stdin.");
    stdinUsed.value = true;
    stream = process.stdin;
  } else {
    const metadata = await stat(path);
    if (metadata.size > MODEL_LIMITS.maxRequestBytes - budget.used) {
      throw new CliError(
        "REQUEST_TOO_LARGE",
        `Combined input documents exceed ${MODEL_LIMITS.maxRequestBytes} bytes before reading '${path}'.`,
      );
    }
    stream = createReadStream(path);
  }

  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    if (bytes.byteLength > MODEL_LIMITS.maxRequestBytes - budget.used) {
      throw new CliError(
        "REQUEST_TOO_LARGE",
        `Combined input documents exceed ${MODEL_LIMITS.maxRequestBytes} bytes while reading '${path}'.`,
      );
    }
    budget.used += bytes.byteLength;
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new CliError(
      "INVALID_JSON",
      `Input '${path}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function stringOption(options: Map<string, string | true>, name: string): string | undefined {
  const value = options.get(name);
  return typeof value === "string" ? value : undefined;
}

function parseOrThrow<T>(
  schema: {
    safeParse: (value: unknown) =>
      | { success: true; data: T }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const message = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
    .join("; ");
  throw new CliError("INVALID_REQUEST", message);
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const stdinUsed = { value: false };
  const budget: InputBudget = { used: 0 };
  const ruleset = await readJson(args.modelPath, stdinUsed, budget);
  let output: unknown;

  if (args.command === "validate") {
    output = validateRuleset(ruleset);
  } else if (args.command === "evaluate") {
    const factsPath = stringOption(args.options, "--facts");
    if (!factsPath) throw new CliError("USAGE", "evaluate requires --facts <facts.json>.");
    const expectedVersion = stringOption(args.options, "--expected-version");
    const expectedFingerprint = stringOption(args.options, "--expected-fingerprint");
    const asOf = stringOption(args.options, "--as-of");
    const request = parseOrThrow(EvaluateDecisionRequestSchema, {
      ruleset,
      facts: (await readJson(factsPath, stdinUsed, budget)) as JsonObject,
      ...(expectedVersion ? { expectedVersion } : {}),
      ...(expectedFingerprint ? { expectedFingerprint } : {}),
      ...(asOf ? { asOf } : {}),
    });
    output = evaluateDecision(request);
  } else {
    const candidatePath = stringOption(args.options, "--candidate");
    if (!candidatePath) throw new CliError("USAGE", "check requires --candidate <candidate.json>.");
    const factsPath = stringOption(args.options, "--facts");
    const expectedVersion = stringOption(args.options, "--expected-version");
    const expectedFingerprint = stringOption(args.options, "--expected-fingerprint");
    const asOf = stringOption(args.options, "--as-of");
    const request = parseOrThrow(CheckConstraintsRequestSchema, {
      ruleset,
      candidate: (await readJson(candidatePath, stdinUsed, budget)) as JsonObject,
      ...(factsPath ? { facts: (await readJson(factsPath, stdinUsed, budget)) as JsonObject } : {}),
      ...(expectedVersion ? { expectedVersion } : {}),
      ...(expectedFingerprint ? { expectedFingerprint } : {}),
      ...(asOf ? { asOf } : {}),
    });
    output = checkConstraints(request);
  }

  const serialized = JSON.stringify(output, null, args.options.has("--compact") ? 0 : 2);
  if (Buffer.byteLength(serialized) > MODEL_LIMITS.maxResponseBytes) {
    throw new CliError("RESPONSE_TOO_LARGE", "Result exceeds the response byte limit.");
  }
  process.stdout.write(`${serialized}\n`);
  return 0;
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const cliError = error instanceof CliError ? error : new CliError("INTERNAL_ERROR", String(error));
    process.stderr.write(`${JSON.stringify({ error: { code: cliError.code, message: cliError.message } })}\n`);
    process.exitCode = cliError.code === "USAGE" ? 2 : 1;
  });
