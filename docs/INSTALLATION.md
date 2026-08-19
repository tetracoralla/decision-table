# Install Decision Table in Codex

Decision Table is distributed directly from its public GitHub repository. You
do not need an npm account and Codex does not run a package install or build.

## Requirements

- Codex with plugin marketplace support
- Git
- Node.js 20.19 or later available as `node` on `PATH`

## Install

```sh
codex plugin marketplace add tetracoralla/decision-table --ref main
codex plugin add decision-table@decision-table
```

Then start a new Codex task. Plugin installation changes the available Skill
and MCP processes, so an already-running task is not the acceptance path.

Try one of these requests with an inline ruleset and facts:

- “Validate this decision ruleset before I use it.”
- “Evaluate this versioned decision table with these facts.”
- “Check whether this proposed candidate satisfies these constraints.”

The plugin should route these tasks to `decision.validate`,
`decision.evaluate`, or `constraint.check`. Missing facts must be returned as
missing inputs rather than interpreted as false.

## Update

Published releases increment the plugin version. Refresh the Git marketplace,
then reinstall the plugin so Codex copies the new version into its cache:

```sh
codex plugin marketplace upgrade decision-table
codex plugin remove decision-table@decision-table
codex plugin add decision-table@decision-table
```

Start a new Codex task after the update.

## Remove

```sh
codex plugin remove decision-table@decision-table
codex plugin marketplace remove decision-table
```

## Troubleshooting

- If installation cannot start the MCP server, confirm `node --version` is at
  least 20.19 and `node` is available on `PATH`.
- If the Skill appears but the tools do not, reinstall the plugin and start a
  new Codex task; do not validate an update in a task that predates it.
- If behavior differs from the repository, run
  `codex plugin marketplace upgrade decision-table` and reinstall the plugin.
- For source development, add the local repository path as a marketplace and
  run `npm run check`; npm is a contributor tool, not a distribution channel.
