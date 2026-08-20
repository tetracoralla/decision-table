import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MODEL_LIMITS } from "../../src/model/schemas.js";

const root = resolve(import.meta.dirname, "../..");

function runCli(args: string[]): Record<string, unknown> {
  const output = execFileSync(process.execPath, [resolve(root, "dist/cli.js"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return JSON.parse(output) as Record<string, unknown>;
}

describe("built CLI runtime", () => {
  it("evaluates a versioned decision from files", () => {
    const result = runCli([
      "evaluate",
      "examples/payment-approval.decision.json",
      "--facts",
      "examples/payment-approval.facts.json",
      "--compact",
    ]);
    expect(result.status).toBe("decided");
    expect(result.decision).toBe("legal");
  });

  it("checks a candidate and returns repair hints", () => {
    const result = runCli([
      "check",
      "examples/email-marketing.constraint.json",
      "--candidate",
      "examples/email-marketing.candidate.json",
      "--facts",
      "examples/email-marketing.facts.json",
      "--compact",
    ]);
    expect(result.status).toBe("invalid");
    expect(result.valid).toBe(false);
  });

  it("rejects unknown and command-irrelevant options before evaluation", () => {
    for (const args of [
      [
        "evaluate",
        "examples/payment-approval.decision.json",
        "--facts",
        "examples/payment-approval.facts.json",
        "--expected-verison",
        "1.0.0",
      ],
      ["validate", "examples/payment-approval.decision.json", "--facts", "examples/payment-approval.facts.json"],
    ]) {
      const called = spawnSync(process.execPath, [resolve(root, "dist/cli.js"), ...args], {
        cwd: root,
        encoding: "utf8",
      });
      expect(called.status).toBe(2);
      expect(called.stdout).toBe("");
      expect(JSON.parse(called.stderr)).toMatchObject({ error: { code: "USAGE" } });
    }
  });

  it("enforces one cumulative byte budget across ruleset, candidate, and facts files", () => {
    const directory = mkdtempSync(join(tmpdir(), "decision-table-cli-"));
    try {
      const candidatePath = join(directory, "candidate.json");
      const factsPath = join(directory, "facts.json");
      writeFileSync(candidatePath, JSON.stringify({ payload: "x".repeat(131_000) }));
      writeFileSync(factsPath, JSON.stringify({ payload: "y".repeat(131_000) }));

      const called = spawnSync(
        process.execPath,
        [
          resolve(root, "dist/cli.js"),
          "check",
          "examples/email-marketing.constraint.json",
          "--candidate",
          candidatePath,
          "--facts",
          factsPath,
        ],
        { cwd: root, encoding: "utf8" },
      );

      expect(called.status).toBe(1);
      expect(called.stdout).toBe("");
      expect(JSON.parse(called.stderr)).toMatchObject({
        error: { code: "REQUEST_TOO_LARGE", message: expect.stringContaining("Combined input documents") },
      });
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("reports an unreadable input document as an input error, not an internal one", () => {
    const called = spawnSync(
      process.execPath,
      [
        resolve(root, "dist/cli.js"),
        "evaluate",
        "examples/payment-approval.decision.json",
        "--facts",
        join(tmpdir(), "decision-table-missing-facts.json"),
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(called.status).toBe(1);
    expect(called.stdout).toBe("");
    expect(JSON.parse(called.stderr)).toMatchObject({
      error: {
        code: "INPUT_UNREADABLE",
        message: expect.stringContaining("decision-table-missing-facts.json"),
      },
    });
  });

  it("applies the response limit to the bytes actually written", () => {
    const directory = mkdtempSync(join(tmpdir(), "decision-table-cli-response-"));
    try {
      const rulesetPath = join(directory, "collect.json");
      const factsPath = join(directory, "facts.json");
      const decision = Array.from({ length: 1_000 }, () => 123_456_789);
      const ruleset = {
        schemaVersion: "1.0",
        kind: "decision",
        id: "response.limit",
        version: "1.0.0",
        inputs: [{ path: "enabled", type: "boolean", required: true, nullable: false }],
        hitPolicy: "collect",
        rules: Array.from({ length: 19 }, (_, index) => ({
          id: `R${index}`,
          when: {
            op: "compare",
            left: { kind: "fact", path: "enabled" },
            comparator: "eq",
            right: { kind: "literal", value: true },
          },
          then: { decision },
        })),
      };
      writeFileSync(rulesetPath, JSON.stringify(ruleset));
      writeFileSync(factsPath, JSON.stringify({ enabled: true }));

      const pretty = spawnSync(
        process.execPath,
        [resolve(root, "dist/cli.js"), "evaluate", rulesetPath, "--facts", factsPath],
        { cwd: root, encoding: "utf8" },
      );
      expect(pretty.status).toBe(1);
      expect(pretty.stdout).toBe("");
      expect(JSON.parse(pretty.stderr)).toMatchObject({ error: { code: "RESPONSE_TOO_LARGE" } });

      const compact = spawnSync(
        process.execPath,
        [resolve(root, "dist/cli.js"), "evaluate", rulesetPath, "--facts", factsPath, "--compact"],
        { cwd: root, encoding: "utf8", maxBuffer: MODEL_LIMITS.maxResponseBytes + 1_024 },
      );
      expect(compact.status).toBe(0);
      expect(Buffer.byteLength(compact.stdout)).toBeLessThanOrEqual(MODEL_LIMITS.maxResponseBytes + 1);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
