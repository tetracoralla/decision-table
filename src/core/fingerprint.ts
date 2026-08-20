import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type { JsonValue, Ruleset, RulesetIdentity } from "../model/types.js";

function sortValue(value: JsonValue, ancestors: Set<object>): JsonValue {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return null;
    ancestors.add(value);
    const sorted = value.map((child) => sortValue(child, ancestors));
    ancestors.delete(value);
    return sorted;
  }
  if (value !== null && typeof value === "object") {
    if (ancestors.has(value)) return null;
    ancestors.add(value);
    const sorted = Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, sortValue(child, ancestors)]),
    );
    ancestors.delete(value);
    return sorted;
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortValue(value, new Set()));
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

export function fingerprintRuleset(ruleset: Ruleset): string {
  try {
    return sha256Hex(canonicalJson(ruleset as unknown as JsonValue));
  } catch {
    return sha256Hex("__unserializable_ruleset__");
  }
}

export function identifyRuleset(ruleset: Ruleset): RulesetIdentity {
  return {
    id: ruleset.id,
    version: ruleset.version,
    fingerprint: fingerprintRuleset(ruleset),
  };
}
