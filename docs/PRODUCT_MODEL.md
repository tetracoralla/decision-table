# Product model

## User and task

The human user is a domain owner or engineer who turns a bounded business
judgment into a versioned, reviewable JSON ruleset and runs it locally. The
Agent user supplies current facts or a proposed action and needs software—not
model reasoning—to return the decision, missing facts, violations, and safe
next repair step.

## Related flows

Human flow: author JSON → validate it → run representative cases → publish or
embed the reviewed ruleset in the owning system.

Agent decision flow: collect facts → call `decision.evaluate` once → act on a
decided result, fetch named missing facts, or escalate a conflict/version issue.

Agent advisory constraint flow: propose a candidate → call `constraint.check` →
use the result for analysis, otherwise apply an authorized repair hint or
escalate.

Approved-check flow: the host binds one approved constraint ruleset plus exact
id, version, and fingerprint and may expose `constraint.check_approved`. The
Agent cannot replace policy or select a historical time, but still supplies
candidate and facts, so this remains read-only analysis.

Enforcement flow: the host passes the actual pending action to
`createConstraintExecutionGuard`, derives candidate data itself, loads facts
from trusted sources, and performs the side effect through the guard inside one
host-owned transaction or lock. The guard checks before execution and passes
the same frozen action snapshot to the executor. No Agent-callable read-only
tool is described as enforcement.

## Existing inventory

The workspace began empty. There are no existing engines, schemas, components,
CLI commands, MCP tools, plugins, or Skills to reuse. The implementation reuses
Zod for the single executable schema model, Decimal.js for exact numeric
comparison, and the official MCP TypeScript SDK for transport. It deliberately
does not create an expression language, solver, workflow engine, database, or
visual editor.

## Shared deterministic core

All surfaces call one core with five operations:

- `evaluateDecision(request)` evaluates a versioned decision ruleset.
- `validateRuleset(ruleset)` performs structural and conservative static checks.
- `checkConstraints(request)` checks a candidate and current facts.
- `createApprovedConstraintChecker(binding)` validates and pins an approved
  ruleset for candidate/fact checks.
- `createConstraintExecutionGuard(checker, context)` joins trusted candidate
  construction, fact loading, checking, and the exact side effect.

The canonical IR is a strict tagged union: `all`, `any`, `not`, `compare`, and
`exists`. Facts are referenced by declared dot paths. No source text is
executed. Conditions evaluate to `TRUE`, `FALSE`, or `UNKNOWN`.

## Agent contract and route budget

The domain exposes three always-available advisory MCP tools:
`decision.evaluate`, `decision.validate`, and `constraint.check`. A host that
provides a valid approved-policy binding additionally exposes
`constraint.check_approved`. All MCP tools are read-only. A normal
supported request should take one domain-tool call. A missing fact may cause one
external lookup and one re-evaluation. Invalid inputs return one stable result;
the Agent should not guess or retry with changed semantics.

The full request schemas are exposed after tool selection. Rulesets are inline
for the first release, avoiding ambient file authority. The CLI accepts explicit
human-selected files and calls the same core.

## Change and freshness model

Rules describe policy; request facts describe current reality. Every ruleset has
an immutable `id` + `version`, an optional effective window, and a computed
fingerprint. Callers may require `expectedVersion`. An out-of-window or version
mismatch returns a non-decision status. Callers may additionally pin
`expectedFingerprint`; an approved-policy binding requires id, version, and
fingerprint to match at startup. The engine never silently falls back to an old
rule.

Date and datetime inputs use strict calendar validation. Datetimes require
seconds, an explicit UTC offset, and zero to three fractional digits; comparisons
therefore preserve the full declared millisecond precision. Fingerprints sort
JSON keys by fixed UTF-16 code-unit order rather than host locale.

This makes staleness visible but cannot discover real-world policy changes by
itself. The owning system must connect its current approved ruleset and make
version rollout/expiry part of its change process.

## Explicit non-goals for v0.1

- full DMN/FEEL/CEL compatibility;
- forward/backward chaining, Rete, CEP, BPMN, or workflow state;
- general counterfactual search or optimization;
- automatically generated rules from prose;
- persistent registry, remote rule service, or visual authoring;
- claiming complete overlap/coverage proofs for arbitrary boolean conditions.
