# Product identity

## Canonical name

- Display name: **Decision Table**
- Technical slug: `decision-table`
- Category: deterministic decision and constraint primitive for AI agents
- Canonical description: **Decision Table is a deterministic decision and
  constraint primitive for AI agents.**

The descriptive name is intentional. AI Agents are the primary consumers, so
clear routing and technical discoverability matter more than a separate
human-facing brand. `Decision Table` is used as a product name here, but it is
also a general software term and must not be presented as an exclusive coined
category or as a claim of DMN compatibility.

## Stable identifiers

| Surface | Identifier |
| --- | --- |
| Repository | `tetracoralla/decision-table` |
| Private Node workspace/library | `@openadam/decision-table` |
| CLI | `decision-table` |
| MCP CLI | `decision-table-mcp` |
| Codex marketplace | `decision-table` |
| Codex plugin | `decision-table` |
| Codex Skill | `use-decision-table` |
| MCP server | `decision-table` |
| MCP configuration key | `decision_table` |
| MCP tools | `decision.evaluate`, `decision.validate`, `constraint.check`, `constraint.check_approved` |
| Approved-policy environment variable | `DECISION_TABLE_APPROVED_CONSTRAINT_JSON` |

The public distribution channel is the GitHub repository marketplace and the
Codex plugin within it. The Node package is marked `private` and is not an npm
distribution channel; its scoped name remains the stable workspace and local
library identifier. Display text uses `Decision Table`, paths and distributable
identifiers use `decision-table`, configuration uses `decision_table`, and
environment variables use uppercase snake case.

## Distribution

- Source and marketplace: `https://github.com/tetracoralla/decision-table`
- Install source: `tetracoralla/decision-table`, pinned to the desired Git ref
- Install selector: `decision-table@decision-table`
- Release unit: the repository, including the committed prebuilt MCP server

A user installation must not require an npm account, `npm install`, TypeScript,
or a build step. Contributors use npm only to reproduce the build and checks.
Keep `package.json` and the plugin manifest versions aligned for releases.

## Compatibility boundary

A future branding change does not by itself authorize changes to package, CLI,
plugin, Skill, MCP tool, configuration, or environment-variable identifiers.
Changing a stable identifier requires an explicit compatibility and migration
plan. Product scope remains governed by `PRODUCT_MODEL.md` and the executable
schemas; the name does not expand the tool into a workflow engine, policy
authoring system, general expression evaluator, or visual rule editor.
