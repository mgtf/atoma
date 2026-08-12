# Changelog

## Unreleased

### Added

- `npm run doctor` provides a quota-free preflight for the configured Node
  runtime, base and tier-routed providers, Docker daemon and worker image.
  Docker failures remain advisory for local runs and become blocking when
  container or egress mode is selected.
- `npm run doctor:dev` exposes the same checks from TypeScript source; release
  checks and extracted archives smoke the compiled command.
- `.nvmrc` pins the same Node 22.13.0 runtime used by CI and release jobs.

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
  rather than the current process's bound port, with independent read-back
  forcing review when a numeric loopback port still leaks into markdown.
- Probe-manifest validation now rejects custom `probe` scenario labels instead
  of inferring a valid web shape from the presence of `smoke`.
- The deterministic deliverable gate now compares only proven output targets
  for mutating tasks, so unchanged input files and explicitly negated files no
  longer force a correct script back through the LLM loop; read-only gates also
  ignore file paths mentioned solely under a negation.
- Skill compilation now preserves the scope of quantified requirements: a
  minimum bullet count attached to `## Steps` is not applied to prose-only
  sibling sections.
- Burn-in aborts before appending a row when logs explicitly report exhausted
  weekly/monthly quota, credit, or model subscription entitlement.
- Ollama requests pin a 32K context by default (configurable through
  `OLLAMA_CONTEXT_LENGTH`) because the server's 4K default is smaller than
  atoma's real L1 prompts.
- Task and event skill distillation now require a successful tool action
  observed by the transport; narrative-only results cannot teach recipes.
- Burn-in CSV rows now append the base provider and non-Claude-family call
  count, keeping routed Codex/Ollama calls visible without rewriting history.
- Mutation detection now covers planner vocabulary, preserves full target
  paths, treats negation clause-locally, and routes ungated mutations through
  the validated LLM path.
- Deterministic verification no longer mistakes contingent repair guidance,
  negated creation, or nominal phrases such as "document probe" for a required
  file mutation; unconditional writes remain protected by the deliverable gate.
- HTTP evidence can be machine-recorded through `fetch_url {record:true}`;
  `record_probe` refuses long-running servers and curl/wget before spawning,
  eliminating dead-port manifests and hand-written HTTP clients.
- Post-approval learning/compilation is capped at 120 seconds, and transport
  failures receive a generation-scoped stamp so they cannot block every later
  run; all observed successful calls remain within the new bound.
- L3 planning now chooses semantic CLI entry filenames for packaging phases,
  and the live argv-CLI recipe keeps package/module semantics coherent and
  stays inside its subtask’s output scope.
- Script-skill scaffolding is never re-probed after deletion; web recipes copy
  selectors exactly from source; source-based API documentation never boots or
  curls the server and always uses portable port placeholders.
- Unambiguous pseudo-final `return`/XML-corrupted `output` tool calls are
  normalized into assistant JSON without an error round-trip; other attempts
  receive explicit coaching, and tolerantly wrapped non-JSON L1 results are
  rejected before trust can approve them.
- Intentional empty negative-test fixtures no longer masquerade as broken
  deliverables when a recorded non-zero probe corroborates their purpose.
- Production L1 results with no successful transport-observed action are
  rejected before trust or validator shortcuts; failed structured tool results
  cannot seed task or recovery skills.
- Atom counters support negative-only, transactional compensation with ledger
  projection, allowing false experimental trust to be removed audibly.
- `record_probe` can explicitly supersede one accidental command when a
  corrected probe uses a different command.
- Burn-in quota detection ignores delivered artefact text, canonicalizes base
  and routed providers, and records event-skill learning separately.
- `run_shell` accepts an unambiguous whole line placed in `command` when
  `args` is empty, using the same parser and allowlist as the preferred `cmd`
  form.
- The fallback non-Anthropic operating profile is now live-validated:
  Codex subscription on L3/L2 with `glm-4.5-air` on Z.ai for L1; five
  independently scored runs delivered without Anthropic calls.

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
