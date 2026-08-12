# Changelog

## Unreleased

### Added

- `npm run doctor` provides a quota-free preflight for the configured Node
  runtime, base and tier-routed providers, Docker daemon and worker image.
  Docker failures remain advisory for local runs and become blocking when
  container or egress mode is selected.
- `npm run doctor:dev` exposes the same checks from TypeScript source; release
  checks and extracted archives smoke the compiled command.

### Changed

- The final eight active `no-explicit-any` warnings in test doubles now use
  the real SDK and framework interfaces, leaving CI free of lint annotations.

### Fixed

- File-mutating plan phases now name their exact output paths, allowing the
  trusted-script target guard to refuse read-only verifiers instead of
  silently replacing requested implementation work.
- Skill compilation now rejects interpreter tokens and generic entry filenames
  as package/product names; a live script that had packaged `index.js` as
  `node` was corrected and had its trust counters reset.
- HTTP probe guidance now forbids recording a long-running server process as a
  shell probe; endpoint observations or a finite harness are the evidence.
- HTTP builders now distinguish JSON syntax from semantic field validation and
  probe a blank/wrong-type payload; durable docs use `<port>` placeholders
  rather than the current process's bound port.
- Probe-manifest validation now rejects custom `probe` scenario labels instead
  of inferring a valid web shape from the presence of `smoke`.

## v0.1.2 — 2026-08-12

Corrective release after extending acceptance to Docker, proxied egress and
MCP cancellation from the published v0.1.1 archive.

### Fixed

- `npm run build:worker` now consumes the compiled `dist/` shipped in release
  archives instead of trying to rebuild omitted TypeScript source.
- `npm run build:worker:dev` preserves the source-checkout compile-and-build
  workflow, and fresh-worker CI uses that explicit path.
- The release workflow now builds the worker from the extracted
  production-only archive and runs a quota-free container/egress smoke.

### Release acceptance

- A containerised HTTP task delivered in 387 seconds, 14 LLM calls and
  $0.2705 API-price equivalent; its server, Unicode echo contract and recorded
  harness were independently executed.
- Allowlisted egress returned HTTP 200 while the Docker control plane remained
  unreachable.
- MCP cancellation retained the serialization lease until the process group
  exited, then left no worker container, private network or release-rooted
  process.
- The broader first HTTP attempt exhausted its 600-second budget despite a
  correct final artefact; it remains recorded as a failed diagnostic, not an
  acceptance success.
- Full evidence: [`docs/release-acceptance-v0.1.1.md`](docs/release-acceptance-v0.1.1.md).

## v0.1.1 — 2026-08-12

Corrective release after installing and exercising the published v0.1.0 archive.

### Fixed

- Release checksums now contain the downloadable archive basename instead of
  the workflow-internal `release/` path; the workflow verifies the checksum
  before extracting the archive.
- The compiled MCP smoke derives its client version from `package.json`.

### Release soak

- Installed the release with production dependencies only.
- Started the compiled MCP server and completed a real zero-dependency CLI task.
- Delivered in 437 seconds, 16 LLM calls and $0.2863 API-price equivalent.
- Independently verified `reverse.js`, its missing-argument exit contract,
  README, package metadata and probe manifest.
- Confirmed two learned skills, eight persisted atom types and a clean
  seven-event lifecycle ledger with zero counter drift.

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
