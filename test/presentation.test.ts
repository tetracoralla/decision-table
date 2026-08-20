import { describe, expect, it } from "vitest";

import { presentDecision } from "../src/presentation.js";
import type { DecisionResult } from "../src/model/types.js";

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      const previous = text.charCodeAt(index - 1);
      if (!(previous >= 0xd800 && previous <= 0xdbff)) return true;
    }
  }
  return false;
}

describe("decision presentation", () => {
  it("never truncates a summary between a surrogate pair", () => {
    const result: DecisionResult = {
      kind: "decision_result",
      status: "decided",
      ruleset: { id: "test.decision", version: "1.0.0", fingerprint: "0".repeat(64) },
      evaluatedAt: "2026-08-13T00:00:00.000Z",
      decision: { label: "😀".repeat(200) },
      matchedRules: ["R1"],
      missingInputs: [],
      explanations: [],
      errors: [],
    };
    const summary = presentDecision(result);
    expect(summary).toContain("...");
    expect(hasLoneSurrogate(summary)).toBe(false);
  });
});
