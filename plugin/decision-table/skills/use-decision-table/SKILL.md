---
name: use-decision-table
description: Use Decision Table for deterministic, versioned business judgments and proposed-action checks. Trigger when explicit facts must be evaluated against a decision ruleset, a candidate action must satisfy constraints, a ruleset was created or changed and needs validation, or a result must identify missing facts, conflicting rules, violations, or repair hints instead of relying on model reasoning.
---

# Use Decision Table

Move a bounded business judgment into the deterministic tools. Do not read the
rules and reproduce their logic in prose or model reasoning.

## Choose the tool

- Call `decision.evaluate` when explicit facts must produce a business result.
- Call `decision.validate` whenever a decision or constraint ruleset is new or
  changed, and before trusting it in an execution path.
- Call `constraint.check` for a proposed action or candidate configuration.
- Call `constraint.check_approved` when the host exposes a pinned approved
  ruleset and the user needs a read-only check. The caller still supplies the
  candidate and facts; do not describe this as enforcement.

The selected tool exposes the complete current schema. Do not invent fields or
convert prose into a ruleset unless the user asked to author policy.

## Handle the result

- On `decided`, `valid`, or `valid_with_warnings`, present the business result,
  material warnings, and ruleset version concisely.
- On `insufficient_input`, obtain only the named missing facts from an
  authorized source and call the same tool again. Never treat missing as false.
- On `conflict`, `invalid_ruleset`, `inactive_ruleset`, `version_mismatch`, or
  `fingerprint_mismatch`,
  stop the governed action and ask the ruleset owner to resolve the named issue.
- On `invalid`, do not execute the candidate. Apply a repair hint only when the
  requested change is independently authorized, then re-check.

All tools are read-only. This Skill improves routing but cannot enforce policy.
Do not authorize a governed side effect from either constraint tool alone. Real
enforcement requires the host library guard to derive the candidate from the
actual pending action, load trusted facts, and execute that same action snapshot
only after a valid check.
