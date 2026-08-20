#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { checkConstraints } from "./core/constraint.js";
import { evaluateDecision } from "./core/decision.js";
import {
  createApprovedConstraintChecker,
  type ApprovedConstraintChecker,
} from "./core/enforcement.js";
import { validateRuleset } from "./core/validate.js";
import {
  CheckConstraintsRequestSchema,
  ApprovedConstraintCheckRequestSchema,
  ConstraintResultSchema,
  DecisionResultSchema,
  EvaluateDecisionRequestSchema,
  MODEL_LIMITS,
  ValidationRequestSchema,
  ValidationResultSchema,
} from "./model/schemas.js";
import type { ConstraintResult, DecisionResult, ValidationResult } from "./model/types.js";
import { asMcpSchema } from "./mcp-schema.js";
import { presentConstraint, presentDecision, presentValidation } from "./presentation.js";

export const TOOL_NAMES = ["decision.evaluate", "decision.validate", "constraint.check"] as const;
export const APPROVED_CHECK_TOOL_NAME = "constraint.check_approved" as const;

export interface ServerOptions {
  approvedConstraintChecker?: ApprovedConstraintChecker;
}

type ToolResult = DecisionResult | ConstraintResult | ValidationResult;

const mcpSchemas = {
  approvedConstraintCheckRequest: asMcpSchema(ApprovedConstraintCheckRequestSchema),
  checkConstraintsRequest: asMcpSchema(CheckConstraintsRequestSchema),
  constraintResult: asMcpSchema(ConstraintResultSchema),
  decisionResult: asMcpSchema(DecisionResultSchema),
  evaluateDecisionRequest: asMcpSchema(EvaluateDecisionRequestSchema),
  validationRequest: asMcpSchema(ValidationRequestSchema),
  validationResult: asMcpSchema(ValidationResultSchema),
};

function toolError(code: string, message: string) {
  const payload = { error: { code, message } };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function respond(result: ToolResult, summary: string) {
  const response = {
    content: [{ type: "text" as const, text: summary }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
  if (Buffer.byteLength(JSON.stringify(response)) > MODEL_LIMITS.maxResponseBytes) {
    return toolError("RESPONSE_TOO_LARGE", "Result exceeds the response byte limit.");
  }
  return response;
}

function requestWithinLimit(input: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(input)) <= MODEL_LIMITS.maxRequestBytes;
}

export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "decision-table", version: "0.1.1" },
    {
      instructions:
        options.approvedConstraintChecker
          ? "Use constraint.check_approved to check candidate data against the host-bound approved ruleset. This remains a read-only check because the caller supplies candidate and facts; only a host-side execution guard can make it mandatory and source trusted facts. Use the inline tools only for advisory analysis."
          : "Use decision.evaluate for a business decision, decision.validate when a ruleset is created or changed, and constraint.check before an advisory candidate check. Missing input is not false; fetch only named missing facts and re-run. These read-only tools do not enforce external side effects.",
    },
  );

  server.registerTool(
    TOOL_NAMES[0],
    {
      title: "Evaluate decision",
      description:
        "Deterministically evaluate an inline versioned decision ruleset from explicit facts; returns the decision, conflicts, or exact missing inputs.",
      inputSchema: mcpSchemas.evaluateDecisionRequest,
      outputSchema: mcpSchemas.decisionResult,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (request) => {
      if (!requestWithinLimit(request)) return toolError("REQUEST_TOO_LARGE", "Request exceeds the byte limit.");
      const result = evaluateDecision(request);
      return respond(result, presentDecision(result));
    },
  );

  server.registerTool(
    TOOL_NAMES[1],
    {
      title: "Validate ruleset",
      description:
        "Validate an inline decision or constraint ruleset before use; reports strict schema errors and conservative proven overlap or shadowing.",
      inputSchema: mcpSchemas.validationRequest,
      outputSchema: mcpSchemas.validationResult,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ ruleset }) => {
      if (!requestWithinLimit({ ruleset })) return toolError("REQUEST_TOO_LARGE", "Request exceeds the byte limit.");
      const result = validateRuleset(ruleset);
      return respond(result, presentValidation(result));
    },
  );

  server.registerTool(
    TOOL_NAMES[2],
    {
      title: "Check constraints",
      description:
        "Deterministically check a proposed candidate against inline versioned constraints; returns violations, missing inputs, and configured repair hints.",
      inputSchema: mcpSchemas.checkConstraintsRequest,
      outputSchema: mcpSchemas.constraintResult,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (request) => {
      if (!requestWithinLimit(request)) return toolError("REQUEST_TOO_LARGE", "Request exceeds the byte limit.");
      const result = checkConstraints(request);
      return respond(result, presentConstraint(result));
    },
  );

  if (options.approvedConstraintChecker) {
    const checker = options.approvedConstraintChecker;
    server.registerTool(
      APPROVED_CHECK_TOOL_NAME,
      {
        title: "Check approved constraints",
        description:
          "Read-only check against the exact host-bound approved ruleset. The caller cannot replace policy or time, but still supplies candidate and facts; the host must verify them before any governed execution.",
        inputSchema: mcpSchemas.approvedConstraintCheckRequest,
        outputSchema: mcpSchemas.constraintResult,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      async (request) => {
        if (!requestWithinLimit(request)) return toolError("REQUEST_TOO_LARGE", "Request exceeds the byte limit.");
        const result = checker.check(request);
        return respond(result, presentConstraint(result));
      },
    );
  }

  return server;
}

function createConfiguredServer(): McpServer {
  const rawBinding = process.env.DECISION_TABLE_APPROVED_CONSTRAINT_JSON;
  if (!rawBinding) return createServer();
  if (Buffer.byteLength(rawBinding) > MODEL_LIMITS.maxRequestBytes) {
    throw new Error("INVALID_APPROVED_CONSTRAINT_CONFIGURATION: host-bound configuration exceeds the byte limit.");
  }
  let binding: unknown;
  try {
    binding = JSON.parse(rawBinding);
  } catch {
    throw new Error("INVALID_APPROVED_CONSTRAINT_CONFIGURATION: host-bound configuration is not valid JSON.");
  }
  return createServer({ approvedConstraintChecker: createApprovedConstraintChecker(binding) });
}

function isDirectEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  serveStdio(createConfiguredServer, {
    // Without this callback the SDK swallows out-of-band errors, including
    // startup configuration failures, and the client only sees a generic
    // internal error with no diagnostic on stderr.
    onerror: (error) => {
      console.error(`decision-table MCP server error: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  console.error("decision-table MCP server running on stdio");
}
