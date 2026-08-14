import { createHash } from "node:crypto";

import type { JsonValue, Ruleset, RulesetIdentity } from "../model/types.js";

function sortValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortValue(value));
}

export function fingerprintRuleset(ruleset: Ruleset): string {
  return createHash("sha256").update(canonicalJson(ruleset as unknown as JsonValue)).digest("hex");
}

export function identifyRuleset(ruleset: Ruleset): RulesetIdentity {
  return {
    id: ruleset.id,
    version: ruleset.version,
    fingerprint: fingerprintRuleset(ruleset),
  };
}
