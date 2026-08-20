import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { identifyRuleset } from "../../src/core/fingerprint.js";
import { MODEL_LIMITS } from "../../src/model/schemas.js";
import type { ConstraintRuleset } from "../../src/model/types.js";

const root = resolve(import.meta.dirname, "../..");
const pluginRoot = process.env.DECISION_TABLE_PLUGIN_ROOT
  ? resolve(process.env.DECISION_TABLE_PLUGIN_ROOT)
  : resolve(root, "plugins/decision-table");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

type JsonSchemaRecord = Record<string, unknown>;

function schemaRef(root: JsonSchemaRecord, reference: unknown): JsonSchemaRecord {
  if (typeof reference !== "string" || !reference.startsWith("#/$defs/")) return {};
  const definitions = root.$defs as JsonSchemaRecord | undefined;
  return (definitions?.[reference.slice("#/$defs/".length)] as JsonSchemaRecord | undefined) ?? {};
}

describe("bundled MCP stdio runtime", () => {
  let client: Client;

  beforeEach(async () => {
    client = new Client({ name: "decision-table-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(pluginRoot, "server/index.mjs")],
      cwd: pluginRoot,
      stderr: "pipe",
    });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
  });

  it("publishes exactly the three direct domain tools", async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "decision.evaluate",
      "decision.validate",
      "constraint.check",
    ]);
    expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
    expect(listed.tools.every((tool) => tool.outputSchema?.type === "object")).toBe(true);
  });

  it("publishes complete recursive request schemas instead of opaque placeholders", async () => {
    const listed = await client.listTools();
    const evaluate = listed.tools.find((tool) => tool.name === "decision.evaluate");
    const validate = listed.tools.find((tool) => tool.name === "decision.validate");
    const check = listed.tools.find((tool) => tool.name === "constraint.check");
    const evaluateSchema = evaluate?.inputSchema as JsonSchemaRecord;
    const evaluateProperties = evaluateSchema.properties as JsonSchemaRecord;
    expect(evaluateSchema.required).toEqual(expect.arrayContaining(["ruleset", "facts"]));
    expect(evaluateProperties.facts).not.toEqual({});

    const decisionRuleset = evaluateProperties.ruleset as JsonSchemaRecord;
    const decisionRules = (decisionRuleset.properties as JsonSchemaRecord).rules as JsonSchemaRecord;
    const decisionRule = decisionRules.items as JsonSchemaRecord;
    const when = (decisionRule.properties as JsonSchemaRecord).when as JsonSchemaRecord;
    const condition = schemaRef(evaluateSchema, when.$ref);
    expect(condition.oneOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ properties: expect.objectContaining({ op: { type: "string", const: "all" } }) }),
        expect.objectContaining({ properties: expect.objectContaining({ op: { type: "string", const: "compare" } }) }),
      ]),
    );
    const decisionOutput = ((evaluate?.outputSchema as JsonSchemaRecord).properties as JsonSchemaRecord)
      .decision as JsonSchemaRecord;
    expect(decisionOutput).not.toEqual({});

    const validationRuleset = (validate?.inputSchema.properties as JsonSchemaRecord)
      .ruleset as JsonSchemaRecord;
    expect(validationRuleset).not.toEqual({});
    const checkSchema = check?.inputSchema as JsonSchemaRecord;
    expect(checkSchema.required).toEqual(expect.arrayContaining(["ruleset", "candidate"]));
    expect((checkSchema.properties as JsonSchemaRecord).candidate).not.toEqual({});
  });

  it("starts from an installed path that contains a symlink", async () => {
    const directory = mkdtempSync(join(tmpdir(), "decision-table-mcp-link-"));
    const linkedPlugin = join(directory, "decision-table");
    symlinkSync(pluginRoot, linkedPlugin, "dir");
    const linkedClient = new Client({ name: "decision-table-link-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(linkedPlugin, "server/index.mjs")],
      cwd: linkedPlugin,
      stderr: "pipe",
    });
    try {
      await linkedClient.connect(transport);
      const listed = await linkedClient.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "decision.evaluate",
        "decision.validate",
        "constraint.check",
      ]);
    } finally {
      await linkedClient.close();
      rmSync(directory, { recursive: true });
    }
  });

  it("calls decision.evaluate in one tool round trip with structured output", async () => {
    const called = await client.callTool({
      name: "decision.evaluate",
      arguments: {
        ruleset: readJson("examples/payment-approval.decision.json"),
        facts: readJson("examples/payment-approval.facts.json"),
        asOf: "2026-08-13T00:00:00.000Z",
      },
    });

    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toMatchObject({ status: "decided", decision: "legal" });
  });

  it("calls validation and constraint checking through the same live transport", async () => {
    const validation = await client.callTool({
      name: "decision.validate",
      arguments: { ruleset: readJson("examples/email-marketing.constraint.json") },
    });
    expect(validation.isError).not.toBe(true);
    expect(validation.structuredContent).toMatchObject({ status: "valid" });

    const checked = await client.callTool({
      name: "constraint.check",
      arguments: {
        ruleset: readJson("examples/email-marketing.constraint.json"),
        candidate: readJson("examples/email-marketing.candidate.json"),
        facts: readJson("examples/email-marketing.facts.json"),
      },
    });
    expect(checked.isError).not.toBe(true);
    expect(checked.structuredContent).toMatchObject({ status: "invalid", valid: false });
  });

  it("lets decision.validate inspect an invalid candidate instead of rejecting before validation", async () => {
    const invalidRuleset = {
      ...(readJson("examples/payment-approval.decision.json") as Record<string, unknown>),
      accidentalField: true,
    };
    const called = await client.callTool({
      name: "decision.validate",
      arguments: { ruleset: invalidRuleset },
    });
    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toMatchObject({
      status: "invalid",
      issues: [expect.objectContaining({ code: "SCHEMA_INVALID" })],
    });
  });

  it("rejects misspelled request fields before execution", async () => {
    const called = await client.callTool({
      name: "decision.evaluate",
      arguments: {
        ruleset: readJson("examples/payment-approval.decision.json"),
        factz: readJson("examples/payment-approval.facts.json"),
      },
    });
    expect(called.isError).toBe(true);
    expect(called.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("Unrecognized key") }),
      ]),
    );
  });

  it("enforces the serialized whole-request byte budget", async () => {
    const oversizedFacts = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`extra_${index}`, "x".repeat(16_000)]),
    );
    const called = await client.callTool({
      name: "decision.evaluate",
      arguments: {
        ruleset: readJson("examples/payment-approval.decision.json"),
        facts: oversizedFacts,
      },
    });
    expect(called.isError).toBe(true);
    expect(called.structuredContent).toEqual({
      error: { code: "REQUEST_TOO_LARGE", message: "Request exceeds the byte limit." },
    });
  });

  it("bounds the complete MCP response envelope including its text summary", async () => {
    const ruleset = {
      schemaVersion: "1.0",
      kind: "constraint",
      id: "response.limit",
      version: "1.0.0",
      inputs: [
        { path: "candidate.allowed", type: "boolean", required: true, nullable: false },
      ],
      constraints: Array.from({ length: 400 }, (_, index) => ({
        id: `C${index}`,
        severity: "hard",
        assert: {
          op: "compare",
          left: { kind: "fact", path: "candidate.allowed" },
          comparator: "eq",
          right: { kind: "literal", value: true },
        },
        violation: {
          code: (`E${index}_` + "X".repeat(120)).slice(0, 128),
          message: "M".repeat(315),
        },
      })),
    };
    const request = { ruleset, candidate: { allowed: false } };
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(MODEL_LIMITS.maxRequestBytes);

    const called = await client.callTool({ name: "constraint.check", arguments: request });
    expect(called.isError).toBe(true);
    expect(called.structuredContent).toEqual({
      error: { code: "RESPONSE_TOO_LARGE", message: "Result exceeds the response byte limit." },
    });
  });

  it("returns a bounded domain result for more unknown facts than the output schema allows", async () => {
    const called = await client.callTool({
      name: "decision.evaluate",
      arguments: {
        ruleset: readJson("examples/payment-approval.decision.json"),
        facts: Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [`typo_${index}`, index])),
      },
    });

    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toMatchObject({ status: "invalid_input" });
    const errors = (called.structuredContent as { errors: Array<{ code: string }> }).errors;
    expect(errors).toHaveLength(256);
    expect(errors.at(-1)?.code).toBe("INPUT_ERRORS_TRUNCATED");
  });

  it("rejects candidate and facts that exceed the cumulative JSON node budget", async () => {
    const wide = {
      groups: Array.from({ length: 1_000 }, () => Array.from({ length: 14 }, () => null)),
    };
    const called = await client.callTool({
      name: "constraint.check",
      arguments: {
        ruleset: readJson("examples/email-marketing.constraint.json"),
        candidate: wide,
        facts: wide,
      },
    });
    expect(called.isError).toBe(true);
    expect(called.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("Combined JSON inputs exceed") }),
      ]),
    );
  });

  it("reports an invalid host-bound configuration on stderr instead of swallowing it", () => {
    // The server factory only runs when a client opens the connection, so send
    // one initialize request to trigger construction of the misconfigured server.
    const initialize =
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":' +
      '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}\n';
    const called = spawnSync(
      process.execPath,
      [resolve(pluginRoot, "server/index.mjs")],
      {
        cwd: pluginRoot,
        encoding: "utf8",
        input: initialize,
        timeout: 15_000,
        env: { ...process.env, DECISION_TABLE_APPROVED_CONSTRAINT_JSON: "{ not valid json" },
      },
    );
    expect(called.stderr).toContain("INVALID_APPROVED_CONSTRAINT_CONFIGURATION");
  });

  it("exposes an honestly named approved-policy check without allowing policy replacement", async () => {
    const ruleset = readJson("examples/email-marketing.constraint.json") as ConstraintRuleset;
    const enforcedClient = new Client({ name: "decision-table-enforcement-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(pluginRoot, "server/index.mjs")],
      cwd: pluginRoot,
      stderr: "pipe",
      env: {
        DECISION_TABLE_APPROVED_CONSTRAINT_JSON: JSON.stringify({
          ruleset,
          expected: identifyRuleset(ruleset),
        }),
      },
    });
    await enforcedClient.connect(transport);
    try {
      const listed = await enforcedClient.listTools();
      const approvedCheckTool = listed.tools.find((tool) => tool.name === "constraint.check_approved");
      expect(approvedCheckTool).toBeDefined();
      expect(approvedCheckTool?.title).toBe("Check approved constraints");
      expect(approvedCheckTool?.inputSchema.properties).not.toHaveProperty("ruleset");
      expect(approvedCheckTool?.inputSchema.properties).not.toHaveProperty("expectedVersion");
      expect(approvedCheckTool?.inputSchema.properties).not.toHaveProperty("expectedFingerprint");
      expect(approvedCheckTool?.inputSchema.properties).not.toHaveProperty("asOf");

      const called = await enforcedClient.callTool({
        name: "constraint.check_approved",
        arguments: {
          candidate: readJson("examples/email-marketing.candidate.json"),
          facts: readJson("examples/email-marketing.facts.json"),
        },
      });
      expect(called.isError).not.toBe(true);
      expect(called.structuredContent).toMatchObject({
        status: "invalid",
        valid: false,
        ruleset: identifyRuleset(ruleset),
      });

      const overrideAttempt = await enforcedClient.callTool({
        name: "constraint.check_approved",
        arguments: {
          candidate: readJson("examples/email-marketing.candidate.json"),
          facts: readJson("examples/email-marketing.facts.json"),
          ruleset,
          asOf: "2000-01-01T00:00:00.000Z",
        },
      });
      expect(overrideAttempt.isError).toBe(true);
    } finally {
      await enforcedClient.close();
    }
  });
});
