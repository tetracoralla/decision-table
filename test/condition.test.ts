import { describe, expect, it } from "vitest";

import { evaluateCondition } from "../src/core/evaluate-condition.js";
import { compare, input } from "./fixtures.js";

describe("three-valued condition evaluation", () => {
  const inputs = [input("known", "boolean"), input("missing", "boolean")];

  it("short-circuits UNKNOWN AND FALSE to FALSE without irrelevant missing data", () => {
    const result = evaluateCondition(
      {
        op: "all",
        conditions: [compare("missing", "eq", true), compare("known", "eq", false)],
      },
      { known: true },
      inputs,
    );

    expect(result.truth).toBe("FALSE");
    expect([...result.missing]).toEqual([]);
  });

  it("short-circuits UNKNOWN OR TRUE to TRUE", () => {
    const result = evaluateCondition(
      {
        op: "any",
        conditions: [compare("missing", "eq", true), compare("known", "eq", true)],
      },
      { known: true },
      inputs,
    );

    expect(result.truth).toBe("TRUE");
    expect([...result.missing]).toEqual([]);
  });

  it("keeps explicit null distinct from a missing path", () => {
    const nullableInputs = [input("value", "string", false, true)];
    expect(evaluateCondition(compare("value", "eq", null), { value: null }, nullableInputs).truth).toBe("TRUE");
    expect(evaluateCondition(compare("value", "eq", null), {}, nullableInputs).truth).toBe("UNKNOWN");
  });

  it("never orders an explicit null value", () => {
    const nullableInputs = [input("value", "integer", false, true)];
    const result = evaluateCondition(compare("value", "lt", 5), { value: null }, nullableInputs);
    expect(result.truth).toBe("UNKNOWN");
    expect([...result.missing]).toEqual(["value"]);
  });

  it("uses code-point-stable string equality instead of locale collation", () => {
    const stringInputs = [input("value", "string")];
    expect(
      evaluateCondition(compare("value", "eq", "é"), { value: "e\u0301" }, stringInputs).truth,
    ).toBe("FALSE");
  });
});
