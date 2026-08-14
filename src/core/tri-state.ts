export type TruthValue = "TRUE" | "FALSE" | "UNKNOWN";

export function negate(value: TruthValue): TruthValue {
  if (value === "TRUE") return "FALSE";
  if (value === "FALSE") return "TRUE";
  return "UNKNOWN";
}
