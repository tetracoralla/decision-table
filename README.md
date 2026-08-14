# Decision Table

Decision Table is a deterministic decision and constraint primitive for AI
agents. It moves bounded business judgments out of model reasoning and into a
strict, versioned, executable IR.

The first release provides:

- `decision.evaluate`: evaluate facts with `first`, `unique`, `collect`, or
  `priority` hit policy;
- `decision.validate`: validate the model and conservatively prove duplicate,
  overlap, or shadowed rules where supported;
- `constraint.check`: check a proposed candidate and return violations, missing
  inputs, and configured repair hints;
- `constraint.check_approved`: when configured by the host, perform a read-only
  check against an exact approved ruleset that the caller cannot replace or
  backdate;
- one shared TypeScript core, a JSON CLI, and an MCP server plus Codex plugin.

## Install and check

```sh
npm install
npm run check
```

The published npm package includes `plugin/decision-table`. To make the plugin
available in Codex, place that directory in a configured local marketplace and
install `decision-table` from that marketplace. During development, validate
the source plugin with `npm run check:plugin`; after installing or updating it,
start a new Codex task so the MCP tools are loaded from the new plugin process.

## CLI

```sh
npm run cli -- validate examples/payment-approval.decision.json
npm run cli -- evaluate examples/payment-approval.decision.json \
  --facts examples/payment-approval.facts.json \
  --expected-version 1.0.0
npm run cli -- check examples/email-marketing.constraint.json \
  --candidate examples/email-marketing.candidate.json \
  --facts examples/email-marketing.facts.json
```

All output is JSON. Use `-` in place of an input path to read that one document
from stdin. Options not defined for the selected command are rejected. The
ruleset, facts, and candidate documents share one cumulative 256 KiB limit.

For exact content pinning, pass both `--expected-version` and
`--expected-fingerprint <sha256>`.

## Approved checks and host enforcement

Inline `constraint.check` is advisory because its caller supplies the ruleset.
For read-only analysis with a host-approved policy, bind the ruleset before
starting the MCP server:

```js
import {
  createApprovedConstraintChecker,
  createConstraintExecutionGuard,
  fingerprintRuleset,
} from "@openadam/decision-table";

const expected = {
  id: approvedRuleset.id,
  version: approvedRuleset.version,
  fingerprint: fingerprintRuleset(approvedRuleset),
};
const checker = createApprovedConstraintChecker({ ruleset: approvedRuleset, expected });
```

The bundled stdio server exposes `constraint.check_approved` when its host sets
`DECISION_TABLE_APPROVED_CONSTRAINT_JSON` to the same strict binding object.
The Agent cannot replace the policy or backdate the check, but it still supplies
candidate and facts, so this read-only MCP tool is not an execution boundary.

For a governed side effect, keep candidate construction, trusted fact loading,
checking, and execution inside a host-owned context:

```js
const guard = createConstraintExecutionGuard(checker, async (action, run) =>
  database.transaction(async (transaction) =>
    run({
      candidate: candidateFromActualAction(action),
      facts: await loadTrustedFacts(transaction, action),
      execute: (sameActionSnapshot) =>
        executeActualAction(transaction, sameActionSnapshot),
    }),
  ),
);

const outcome = await guard.execute(actualToolArguments);
```

The guard snapshots the actual action, blocks the executor unless constraints
return valid, and passes that same frozen snapshot to execution. The host-owned
context is where a transaction or lock must keep volatile facts valid through
the side effect. The guard is a library boundary and is intentionally not an
Agent-callable MCP tool.

## Ruleset shape

Conditions are tagged data, never executable strings:

```json
{
  "op": "compare",
  "left": { "kind": "fact", "path": "amount" },
  "comparator": "gte",
  "right": { "kind": "literal", "value": "10000" }
}
```

Decimal inputs are strings. Missing paths produce `UNKNOWN`; they are not
coerced to `false`. Datetimes require a real ISO calendar value, explicit
offset, seconds, and no more than millisecond precision. See `examples/` and
`docs/PRODUCT_MODEL.md` for the complete product boundary.
