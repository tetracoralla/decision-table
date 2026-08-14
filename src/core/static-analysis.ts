import { Decimal } from "decimal.js";

import type {
  Comparator,
  Condition,
  DecisionRuleset,
  InputDefinition,
  InputType,
  JsonObject,
  JsonPrimitive,
  ValidationIssue,
} from "../model/types.js";
import { MODEL_LIMITS } from "../model/schemas.js";
import { canonicalJson } from "./fingerprint.js";

interface Clause {
  path: string;
  comparator: Exclude<Comparator, "neq" | "in">;
  value: JsonPrimitive;
  type: InputType;
}

interface Bound {
  value: JsonPrimitive;
  inclusive: boolean;
}

interface Domain {
  type: InputType;
  equal?: JsonPrimitive;
  lower?: Bound;
  upper?: Bound;
  impossible?: boolean;
}

function comparisonValue(value: JsonPrimitive, type: InputType): Decimal | string | boolean | null {
  if (value === null) return null;
  if (type === "integer" || type === "decimal") return new Decimal(value as string | number);
  if (type === "date" || type === "datetime") return new Decimal(new Date(value as string).valueOf());
  return value as string | boolean;
}

function compare(left: JsonPrimitive, right: JsonPrimitive, type: InputType): number {
  const a = comparisonValue(left, type);
  const b = comparisonValue(right, type);
  if (a instanceof Decimal && b instanceof Decimal) return a.cmp(b);
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const leftText = String(a);
  const rightText = String(b);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

function clausesFor(
  condition: Condition,
  inputs: Map<string, InputDefinition>,
): Clause[] | null {
  if (condition.op === "all") {
    const combined: Clause[] = [];
    for (const child of condition.conditions) {
      const clauses = clausesFor(child, inputs);
      if (!clauses) return null;
      combined.push(...clauses);
    }
    return combined;
  }
  if (condition.op !== "compare") return null;
  if (condition.left.kind !== "fact" || condition.right.kind !== "literal") return null;
  if (Array.isArray(condition.right.value) || condition.comparator === "neq" || condition.comparator === "in") {
    return null;
  }
  const input = inputs.get(condition.left.path);
  if (!input) return null;
  return [
    {
      path: input.path,
      comparator: condition.comparator,
      value: condition.right.value,
      type: input.type,
    },
  ];
}

function strongerLower(current: Bound | undefined, next: Bound, type: InputType): Bound {
  if (!current) return next;
  const cmp = compare(next.value, current.value, type);
  if (cmp > 0) return next;
  if (cmp < 0) return current;
  return { value: current.value, inclusive: current.inclusive && next.inclusive };
}

function strongerUpper(current: Bound | undefined, next: Bound, type: InputType): Bound {
  if (!current) return next;
  const cmp = compare(next.value, current.value, type);
  if (cmp < 0) return next;
  if (cmp > 0) return current;
  return { value: current.value, inclusive: current.inclusive && next.inclusive };
}

function buildDomains(clauses: Clause[]): Map<string, Domain> {
  const domains = new Map<string, Domain>();
  for (const clause of clauses) {
    const domain = domains.get(clause.path) ?? { type: clause.type };
    if (clause.comparator === "eq") {
      if (
        domain.equal !== undefined &&
        compare(domain.equal, clause.value, domain.type) !== 0
      ) {
        domain.impossible = true;
      } else {
        domain.equal = clause.value;
      }
    }
    if (clause.comparator === "gt" || clause.comparator === "gte") {
      domain.lower = strongerLower(
        domain.lower,
        { value: clause.value, inclusive: clause.comparator === "gte" },
        domain.type,
      );
    }
    if (clause.comparator === "lt" || clause.comparator === "lte") {
      domain.upper = strongerUpper(
        domain.upper,
        { value: clause.value, inclusive: clause.comparator === "lte" },
        domain.type,
      );
    }
    domains.set(clause.path, domain);
  }
  return domains;
}

function domainIsSatisfiable(domain: Domain): boolean {
  if (domain.impossible) return false;
  if (domain.equal !== undefined) {
    if (domain.lower) {
      const cmp = compare(domain.equal, domain.lower.value, domain.type);
      if (cmp < 0 || (cmp === 0 && !domain.lower.inclusive)) return false;
    }
    if (domain.upper) {
      const cmp = compare(domain.equal, domain.upper.value, domain.type);
      if (cmp > 0 || (cmp === 0 && !domain.upper.inclusive)) return false;
    }
  }
  if (domain.lower && domain.upper) {
    const cmp = compare(domain.lower.value, domain.upper.value, domain.type);
    if (cmp > 0) return false;
    if (cmp === 0 && (!domain.lower.inclusive || !domain.upper.inclusive)) return false;
  }
  return true;
}

function fromComparable(value: Decimal, type: InputType): JsonPrimitive {
  if (type === "integer") return value.toFixed(0);
  if (type === "decimal") return value.toString();
  if (type === "date") return new Date(value.toNumber()).toISOString().slice(0, 10);
  if (type === "datetime") return new Date(value.toNumber()).toISOString();
  return value.toString();
}

function chooseWitness(domain: Domain): JsonPrimitive | undefined {
  if (!domainIsSatisfiable(domain)) return undefined;
  if (domain.equal !== undefined) return domain.equal;
  if (domain.type === "boolean") return false;
  if (domain.type === "string") return "example";

  const lower = domain.lower ? (comparisonValue(domain.lower.value, domain.type) as Decimal) : undefined;
  const upper = domain.upper ? (comparisonValue(domain.upper.value, domain.type) as Decimal) : undefined;
  const step = domain.type === "date" ? new Decimal(86_400_000) : new Decimal(1);
  let chosen: Decimal;

  if (lower && upper) {
    if (lower.eq(upper)) chosen = lower;
    else if (domain.type === "integer" || domain.type === "date" || domain.type === "datetime") {
      chosen = domain.lower?.inclusive ? lower : lower.plus(step);
    } else {
      chosen = lower.plus(upper).div(2);
    }
  } else if (lower) {
    chosen = domain.lower?.inclusive ? lower : lower.plus(step);
  } else if (upper) {
    chosen = domain.upper?.inclusive ? upper : upper.minus(step);
  } else {
    chosen = new Decimal(0);
  }

  const primitive = fromComparable(chosen, domain.type);
  return domainIsSatisfiable({ ...domain, equal: primitive }) ? primitive : undefined;
}

function writePath(target: JsonObject, path: string, value: JsonPrimitive): void {
  const segments = path.split(".");
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (existing === null || Array.isArray(existing) || typeof existing !== "object") {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as JsonObject;
  }
  const leaf = segments.at(-1);
  if (leaf) cursor[leaf] = value;
}

function overlapExample(
  left: Condition,
  right: Condition,
  inputs: Map<string, InputDefinition>,
): JsonObject | null {
  const leftClauses = clausesFor(left, inputs);
  const rightClauses = clausesFor(right, inputs);
  if (!leftClauses || !rightClauses) return null;

  const merged = buildDomains([...leftClauses, ...rightClauses]);
  const example: JsonObject = {};
  for (const [path, domain] of merged) {
    const witness = chooseWitness(domain);
    if (witness === undefined) return null;
    writePath(example, path, witness);
  }
  return example;
}

export function analyzeDecisionRules(ruleset: DecisionRuleset): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let truncated = false;
  const inputs = new Map(ruleset.inputs.map((input) => [input.path, input]));

  analysis:
  for (let index = 0; index < ruleset.rules.length; index += 1) {
    const rule = ruleset.rules[index];
    if (!rule) continue;
    const clauses = clausesFor(rule.when, inputs);
    if (clauses) {
      const domains = buildDomains(clauses);
      if ([...domains.values()].some((domain) => !domainIsSatisfiable(domain))) {
        issues.push({
          severity: "warning",
          code: "UNREACHABLE_RULE",
          message: `Rule '${rule.id}' has contradictory simple conditions and cannot match.`,
          ruleIds: [rule.id],
        });
        if (issues.length >= MODEL_LIMITS.maxValidationIssues) {
          truncated = true;
          break analysis;
        }
      }
    }

    for (let otherIndex = index + 1; otherIndex < ruleset.rules.length; otherIndex += 1) {
      const other = ruleset.rules[otherIndex];
      if (!other) continue;
      if (canonicalJson(rule.when as never) === canonicalJson(other.when as never)) {
        issues.push({
          severity: ruleset.hitPolicy === "unique" ? "error" : "warning",
          code: ruleset.hitPolicy === "first" ? "UNREACHABLE_RULE" : "DUPLICATE_RULE_CONDITION",
          message:
            ruleset.hitPolicy === "first"
              ? `Rule '${other.id}' is shadowed by earlier rule '${rule.id}'.`
              : `Rules '${rule.id}' and '${other.id}' have the same condition.`,
          ruleIds: [rule.id, other.id],
        });
        if (issues.length >= MODEL_LIMITS.maxValidationIssues) {
          truncated = true;
          break analysis;
        }
        continue;
      }

      if (ruleset.hitPolicy !== "unique") continue;
      const example = overlapExample(rule.when, other.when, inputs);
      if (example) {
        issues.push({
          severity: "error",
          code: "RULE_OVERLAP",
          message: `Rules '${rule.id}' and '${other.id}' can both match under unique hit policy.`,
          ruleIds: [rule.id, other.id],
          example,
        });
        if (issues.length >= MODEL_LIMITS.maxValidationIssues) {
          truncated = true;
          break analysis;
        }
      }
    }
  }

  if (truncated) {
    issues[MODEL_LIMITS.maxValidationIssues - 1] = {
      severity: "warning",
      code: "VALIDATION_ISSUES_TRUNCATED",
      message: `Static analysis stopped returning issues at ${MODEL_LIMITS.maxValidationIssues}.`,
    };
  }
  return issues.slice(0, MODEL_LIMITS.maxValidationIssues);
}
