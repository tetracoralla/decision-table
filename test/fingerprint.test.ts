import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson, fingerprintRuleset, sha256Hex } from "../src/core/fingerprint.js";
import { compare, constraintRuleset, decisionRuleset } from "./fixtures.js";

function hostSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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

describe("portable hash matches the platform SHA-256", () => {
  const texts = [
    "",
    "{}",
    "HTTPS 认证测试 ✓ {\"z\":2,\"ä\":1}",
    "surrogate pairs 𝕏 🎉 and a NUL-ish \\u0000 byte",
    "x".repeat(10_000),
  ];

  const rulesets = [
    decisionRuleset(),
    constraintRuleset(),
    decisionRuleset({
      version: "2.0.0",
      hitPolicy: "unique",
      rules: [
        {
          id: "R1",
          when: compare("amount", "gte", "10000"),
          then: { decision: { note: "退款 ✓", tags: ["eu", "vip"] } },
        },
      ],
    }),
    decisionRuleset({
      rules: [
        { id: "R9", when: compare("amount", "lte", "0"), then: { decision: "y".repeat(4_000) } },
      ],
    }),
  ];

  it("hashes raw text identically to node:crypto", () => {
    for (const [index, text] of texts.entries()) {
      expect(sha256Hex(text), `text case ${index}`).toBe(hostSha256(text));
    }
  });

  it("fingerprints rulesets identically to node:crypto over canonical JSON", () => {
    for (const [index, ruleset] of rulesets.entries()) {
      expect(fingerprintRuleset(ruleset), `ruleset case ${index}`).toBe(
        hostSha256(canonicalJson(ruleset as never)),
      );
    }
  });
});
