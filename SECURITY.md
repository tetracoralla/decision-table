# Security policy

## Supported version

Security fixes target the latest release on the `main` branch.

## Report a vulnerability

Please use GitHub's private vulnerability reporting for this repository rather
than opening a public issue. Include the affected version, a minimal
reproduction, the expected impact, and any known workaround.

Do not include secrets, production data, or third-party personal information in
the report. Ordinary bugs and feature requests can use GitHub Issues.

## Security boundary

Decision Table parses a tagged data model and never evaluates source strings,
JavaScript, or regular expressions. Its bundled MCP tools are read-only checks;
they do not authorize or perform an external side effect. A host that uses a
constraint result to govern an action remains responsible for trusted facts,
authorization, concurrency, and executing the exact checked action snapshot.
