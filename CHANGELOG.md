# Changelog

## v0.1.0 — 2026-08-12

First reproducible local release of atoma.

### Included

- Three-tier LLM orchestration with symmetric plan/result supervision.
- Persistent atom types, earned trust, learned recipes and guarded script promotion.
- Thirteen-tool MCP server over stdio, with cross-process run serialization and cancellation.
- Ten builtin execution tools, machine-written probe manifests and independent ground-truth checks.
- Local sandbox by default, plus opt-in Docker isolation and allowlisted proxied egress.
- JSON run traces, lifecycle ledger, web visualizer, burn-in harness and controlled benchmark artefacts.
- Hermetic checks, fresh-worker Linux CI, compiled MCP smoke and zero known npm advisories.

### Security and reliability

- Tool children receive a credential-stripped environment and scratch home.
- Filesystem access is symlink-contained; child process groups and browsers are reaped.
- Trusted fast paths still run deterministic ground-truth checks.
- Container runs mount only the workspace, drop capabilities and default to no network.
- MCP stdout is claimed before the application import graph and remains JSON-RPC only.

### Known limits

- Local, single-operator system only: no users, organisations, authentication or multi-tenancy.
- The attached compiled archive supports the MCP server and its build-run path; development,
  benchmark and operator CLIs remain supported from the full source checkout.
- SQLite and filesystem skill storage are not multi-process deployment primitives.
- Container execution is opt-in for local development and requires a locally built worker image.
- Compiled skills are correct and guarded, but the controlled benchmarks do not show them driving
  the measured cost advantage; savings come from tiering, earned trust and recipe reuse.
- Runtime state (`atoma.db`, `skills/`, `runs/`, workspaces and credentials) is never bundled in
  release artefacts.
