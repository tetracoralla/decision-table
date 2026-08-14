# Decision Table repository contract

## Product boundary

This repository owns a deterministic Agent-facing decision interface. It does
not own workflows, business process orchestration, policy authoring by an LLM,
general expression evaluation, optimization, or a visual rule editor.

The canonical model is `docs/PRODUCT_MODEL.md`; the executable Zod schemas in
`src/model/schemas.ts` are the transport and runtime authority. Keep examples,
CLI, MCP, and the Codex Skill on that one model.

## Invariants

- Never evaluate source strings, JavaScript, regular expressions, or an opaque
  expression object. Conditions use the tagged canonical IR only.
- Missing data is `UNKNOWN`, not `false` or `null`. Preserve three-valued
  semantics through `all`, `any`, and `not`.
- Decimal facts are canonical strings. Do not silently accept binary floating
  point for `decimal` inputs.
- Reject unknown request, ruleset, condition, and fact fields. A typo must not
  silently change a decision.
- Every result identifies the exact ruleset id, version, and deterministic
  fingerprint that produced it. Version and effective-window failures are
  ordinary structured statuses.
- Static analysis must only report mechanically proven overlap or shadowing.
  Do not imply full SAT/SMT completeness.
- MCP tools are read-only and idempotent. They accept inline JSON only; do not
  add ambient filesystem authority without a separately granted root and path
  escape tests.
- Keep the ordinary result envelope below the declared response limit and all
  request-wide node, depth, input, and rule limits cumulative.

## Validation lanes

Run `npm run check` for development regression. Separately run the real CLI and
MCP stdio flows in `test/runtime` before claiming those surfaces work. A green
suite does not establish business correctness of a ruleset supplied by a user.

Do not commit automatically.
