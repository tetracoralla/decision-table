# Decision Table review contract

This contract defines the current-source evidence required to review Decision
Table as a deterministic Agent utility, host-side guard library, CLI, and Codex
plugin. It does not establish that a user-authored ruleset expresses the right
business policy, and a read-only check must never be reported as enforcement.

Read `PRODUCT_MODEL.md` first. The executable Zod schemas and shared core are
the runtime authority; examples, docs, the bundled MCP server, CLI, and Skill
must all remain projections of that one model.

## Authority and carrier map

- `src/model/schemas.ts`, `types.ts`, and `temporal.ts` own the accepted model,
  strict request/result shapes, cumulative limits, and date/time grammar.
- `src/core/` owns three-valued evaluation, decision hit policies, constraint
  checks, exact ruleset identity, conservative static analysis, and the
  host-owned execution guard.
- `src/mcp.ts` and `mcp-schema.ts` own the Agent transport. `src/cli.ts` owns
  explicit human/operator file input. Neither carrier may reinterpret the core.
- `plugins/decision-table/` is the installable product. Its bundled server,
  manifest, MCP configuration, Skill, metadata, and repository marketplace
  entry must agree with current source and stable identities.
- No current Capability Profile or Provider Manifest exists in this repository.
  Capability/Procedure conformance is therefore not a current PASS lane. A
  future integration must start from a small read-only canonical projection;
  it must not standardize host enforcement, policy authorship, or product
  carrier fields by implication.

## Semantic invariants

1. **Only the tagged IR executes.** Conditions are the strict `all`, `any`,
   `not`, `compare`, and `exists` union. Never evaluate strings, JavaScript,
   regular expressions, opaque expression objects, or generated code. Unknown
   request, ruleset, condition, fact, and repair fields fail closed.
2. **Missing is `UNKNOWN`.** Preserve three-valued short-circuit semantics:
   `UNKNOWN AND FALSE` is `FALSE`, `UNKNOWN OR TRUE` is `TRUE`, and `not`
   preserves uncertainty. Missing, null, absent, false, and an invalid typed
   value are distinct. Returned `missingInputs` names only facts that can still
   change the applicable result and identifies their owning rule/constraint.
3. **Hit policies remain distinct.** Review `first`, `unique`, `collect`, and
   `priority` independently, including an earlier unknown before a later match,
   multiple matches, no match, unknowns above/below the winning priority, and
   equal-priority ties. Do not simplify one policy through another.
4. **Typed comparison is exact where promised.** Decimal facts are canonical
   strings and compare through Decimal.js; safe integers remain integers.
   Strings use stable code-unit ordering, and date/datetime comparisons use the
   strict calendar parser. `in`, null, arrays, incompatible fact types, and
   unsupported ordering fail or return uncertainty according to the explicit
   model—never JavaScript coercion.
5. **Ruleset identity and time are visible.** Every domain result carries the
   exact `id`, `version`, SHA-256 fingerprint, and `evaluatedAt`. Fingerprints
   use deterministic recursive key ordering independent of locale and are
   checked against an independent SHA-256 implementation. `expectedVersion`,
   `expectedFingerprint`, and half-open effective windows return explicit
   non-decision statuses. Calls without `asOf` intentionally depend on the
   current host clock; deterministic replay supplies `asOf`.
6. **Static analysis is conservative.** `decision.validate` may report only
   mechanically proven duplicate, unreachable/shadowed, or overlapping rules.
   False negatives outside its supported clause fragment are acceptable and
   must not be relabelled as proof of exclusivity or completeness. Runtime
   conflict handling remains necessary even after validation.
7. **Repair hints are advisory data.** A hint may describe `provide_input` or
   `set_value`, but does not authorize mutation, prove feasibility, or execute
   a repair. Constraint validity, soft warnings, hard violations, missing input,
   and invalid rulesets retain separate result statuses.

## Limits, errors, and Agent cost

All public carriers preserve the current cumulative limits from
`MODEL_LIMITS`: 256 KiB request and complete response envelopes, 256 inputs,
500 rules/constraints, condition depth 32, 10,000 condition nodes, JSON depth
32, 20,000 JSON nodes, 100 children per group, 20 repair hints per constraint,
256 result errors, 1,000 validation issues, and 16,384 characters per bounded
string. Review derived arrays and diagnostic text as part of the same response,
not as free metadata.

- The CLI's multiple input documents share one 256 KiB read budget; file size
  preflight and streamed reads enforce the same whole-call bound. Only one
  document may use stdin. Unknown, duplicate, and command-inapplicable options
  are errors.
- MCP measures the whole serialized request and the complete returned envelope,
  including its text summary. Oversized requests/results return stable bounded
  carrier errors; invalid domain data that fits the request returns a bounded
  typed domain result where the tool contract permits it. The stdio transport
  additionally caps each raw protocol message at 320 KiB, so whitespace or
  envelope metadata cannot exploit the SDK's larger default read buffer before
  the tool-argument budget runs.
- Schema/validation errors are capped with an explicit truncation marker. Do
  not let a long caller value, Zod diagnostic, rule message, or repair payload
  create a larger error path than the input/output budget.
- Normal supported Agent use takes one domain call. The ordinary tool directory
  contains exactly `decision.evaluate`, `decision.validate`, and
  `constraint.check`; `constraint.check_approved` appears only when the host
  supplied a valid approved binding. Tool schemas must expose the complete
  recursive IR rather than opaque `{}` placeholders.

This runtime is synchronous and does not currently expose a batch operation.
Do not invent a batch contract merely for a benchmark. When changing
evaluation, schema generation, static analysis, or the 500-rule/10,000-node
limits, run a reproducible persistent-process profile over minimum, typical,
and maximum valid requests plus invalid worst cases. Record throughput,
p50/p95/p99, event-loop delay, peak RSS, response bytes, failure rate, and a
mixed 8-way burst. Compare before/after on the same machine and corpus. A faster
median does not justify quadratic tail growth, an unbounded schema, or changed
decisions.

## Approved policy and enforcement boundary

`constraint.check`, including an inline ruleset, is advisory. A configured
`constraint.check_approved` is also read-only: it pins policy id, version,
fingerprint, and host time, and prevents the Agent from replacing policy or
backdating the check, but the caller still supplies candidate/facts.

Only `createConstraintExecutionGuard` can join a host-authorized action to a
check, and its correctness depends on a trusted host context. Review the full
sequence, not isolated calls:

```text
actual pending action
  -> bounded immutable snapshot
  -> host transaction/lock
  -> candidate derived from that snapshot + facts loaded by the host
  -> approved constraint check
  -> same frozen snapshot passed to the side-effect executor
```

The executor must never run for a blocked/uncertain/invalid check, a callback
retained past the trusted context, or a duplicate callback. The guard must join
an invocation even when a buggy host discards its promise. If the effect has
already completed, a later runner error cannot truthfully turn the outcome into
“not executed.” Review thrown errors before, during, and after execution,
double invocation, late invocation, action mutation after call, volatile facts,
transaction release, and executor failure as one stateful matrix. Durable
effect proof still comes from the owning external system, not the guard's own
return value.

## Mandatory adversarial matrix

For each changed seam, exercise the smallest relevant rows:

- every hit policy across true/false/unknown, missing required and optional
  facts, null, no match, conflict, priority tie, and consequential unknown;
- strict extra-field rejection at request, ruleset, condition, operand,
  violation, and repair levels; dotted/unreachable context keys, prototype-like
  paths, excessive depth/nodes, wide arrays, long strings, non-finite numbers,
  unsafe integers, cyclic/non-serializable library inputs, and malformed JSON;
- decimal extremes, negative zero where relevant, date leap days, invalid
  calendar dates, offsets, fractional precision, effective boundary instants,
  version mismatch, and same-version fingerprint mismatch;
- static-analysis supported and unsupported shapes, duplicate conditions,
  proven overlap/shadowing, and a runtime conflict it deliberately cannot prove;
- request just below/at/above 256 KiB, cumulative multi-file CLI input, maximum
  validation diagnostics, response-envelope overflow, pretty versus compact
  CLI output, and bounded error text;
- MCP source versus bundled plugin schema/result parity, startup from the real
  plugin directory and a symlinked installed path, malformed approved-policy
  environment configuration, optional fourth-tool exposure, and attempted
  policy/time/fingerprint override;
- host guard allowed/blocked paths, action mutation, untrusted facts, duplicate
  and late callbacks, dropped callback promise, context error before/after
  effect, and exact final side-effect count.

## Rerunnable evidence and lanes

Run from the repository root:

```sh
npm run check
```

This is the development regression lane: typecheck, build, core and adversarial
tests, real CLI and MCP stdio tests, identity/contracts, and portable plugin
checks. Because the test script rebuilds the bundled server first, its MCP tests
exercise the current generated plugin artifact rather than an inherited bundle.

Still report separately:

- **Development regression:** the current `npm run check` result and any focused
  negative regression for the changed seam.
- **Runtime Agent flow:** a freshly installed/updated marketplace plugin in a
  new host task, natural-language routing, one-call result, invalid entry,
  optional approved-binding mode, and process restart. Source-path MCP tests do
  not prove this lane.
- **Runtime human/operator flow:** the built CLI with representative files,
  stdin, failure exit codes, and bounded JSON output. There is no visual editor
  or other human UI in the current product.
- **Host enforcement/effects:** integration in the owning transaction/lock and
  observed external side effect. Library unit tests establish only the guard's
  local behavior.
- **Capability/Procedure:** `NOT PRESENT` until an explicit provider-neutral
  Profile, manifest, adapter, and conformance suite exist and are checked from
  current source.
- **Business acceptance:** only the policy owner can accept whether a ruleset
  expresses the intended judgment; test green is not policy approval.

Close every applicable lane as `PASS`, `FAIL`, or `BLOCKED`, naming the exact
ruleset/version/fingerprint and carrier tested. Any decision defect includes a
minimal ruleset, facts/candidate, `asOf`, actual result, expected result, and the
smallest owning regression.
