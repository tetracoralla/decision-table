import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

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
});
