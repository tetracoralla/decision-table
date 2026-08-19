# Contributing

## Development loop

Node.js 20.19 or later is required.

```sh
npm install
npm run check
```

`npm run check` runs typecheck, build, the full vitest suite, and the
repository contract and plugin validation scripts. Run it before handing over
any change.

The npm project is intentionally private. Do not publish it: supported user
distribution is the GitHub repository marketplace and its Codex plugin.

## Surfaces and validation lanes

- The deterministic core lives in `src/core` and `src/model`; the CLI, MCP
  server, and Codex plugin all call that one core.
- Unit tests do not establish that the real CLI and MCP stdio flows work;
  `test/runtime` drives the built surfaces and must stay green too.
- The prebuilt plugin server at `plugins/decision-table/server/index.mjs` is
  committed on purpose so the plugin installs from a plain repository
  checkout. Rebuild it with `npm run build:plugin` after changing `src/mcp.ts`.
- Test installation from a clean Git checkout before a release; a passing
  source build does not prove that Codex can install the committed plugin.

## Product boundary

Read `AGENTS.md` before proposing changes: it records the product boundary and
the invariants (no source-string evaluation, three-valued conditions, decimal
facts as canonical strings, strict schemas, read-only MCP tools). The canonical
product model is `docs/PRODUCT_MODEL.md`; the selected product name and stable
technical identifiers are recorded in `docs/PRODUCT_IDENTITY.md`.
