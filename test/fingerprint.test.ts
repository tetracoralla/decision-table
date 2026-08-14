import { describe, expect, it } from "vitest";

import { canonicalJson, fingerprintRuleset } from "../src/core/fingerprint.js";
import { decisionRuleset } from "./fixtures.js";

describe("ruleset fingerprint determinism", () => {
  it("orders object keys by fixed UTF-16 code units without locale collation", () => {
    const originalLocaleCompare = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("locale collation must not affect canonical JSON");
    };
    try {
      expect(canonicalJson({ ä: 1, z: 2 })).toBe('{"z":2,"ä":1}');
      const ruleset = decisionRuleset({
        rules: [
          {
            ...decisionRuleset().rules[0]!,
            then: { decision: { ä: 1, z: 2 } },
          },
        ],
      });
      expect(fingerprintRuleset(ruleset)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  });
});
