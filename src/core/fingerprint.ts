import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

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

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

export function fingerprintRuleset(ruleset: Ruleset): string {
  return sha256Hex(canonicalJson(ruleset as unknown as JsonValue));
}

export function identifyRuleset(ruleset: Ruleset): RulesetIdentity {
  return {
    id: ruleset.id,
    version: ruleset.version,
    fingerprint: fingerprintRuleset(ruleset),
  };
}
