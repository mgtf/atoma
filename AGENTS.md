# AGENTS.md

Project guidance for coding agents. Read this file before making changes.

This is the single normative source for repository rules. `CLAUDE.md` imports
this file so Codex and Claude Code receive the same guidance. Keep active
contracts here; put incident narratives, measurements, and dated rationale in
`docs/incidents/` and link them rather than copying them into the prompt.

The former 5,452-line engineering record is preserved verbatim (apart from its
archive banner) in
[`docs/incidents/engineering-record-2026-08-14.md`](docs/incidents/engineering-record-2026-08-14.md).
Use it when a rule's rationale matters, not as default session context.

## Routing map

| Need | Read here | Deeper evidence |
|---|---|---|
| Run, test, release, registry, skills | [Commands and workflow](#commands-and-workflow) | [Commands / Testing record](docs/incidents/engineering-record-2026-08-14.md#commands) |
| Tier names and persisted identities | [Domain taxonomy](#domain-taxonomy) | [Taxonomy record](docs/incidents/engineering-record-2026-08-14.md#domain-taxonomy) |
| Change an LLM call or validator | [Cost discipline](#cost-discipline); [LLM interaction](#llm-interaction-conventions) | [Cost record](docs/incidents/engineering-record-2026-08-14.md#cost-discipline-load-bearing--read-before-changing-any-llm-call-site) |
| Change supervision, routing, trust | [Architecture invariants](#architecture-invariants) | [Architecture record](docs/incidents/engineering-record-2026-08-14.md#architecture-invariants-dont-violate-these) |
| Change learn/compile/dispatch | [Skills lifecycle](#skills-lifecycle) | [Skills record](docs/incidents/engineering-record-2026-08-14.md#skills-persistent-task-patterns) |
| Change tools, worker, sandbox | [Tools and runtime isolation](#tools-and-runtime-isolation) | [Tools record](docs/incidents/engineering-record-2026-08-14.md#tools-l1-side-effects) |
| Change MCP lifecycle | [MCP stdio server](#mcp-stdio-server) | [MCP record](docs/incidents/engineering-record-2026-08-14.md#atoma-as-an-mcp-server-stdio--srcmcp) |
| Change metrics, traces, burn-in, viz | [Observability and viz](#observability-and-viz) | [Observability record](docs/incidents/engineering-record-2026-08-14.md#observability) |
| Understand an odd choice | [Intentional choices](#intentional-choices-and-rejected-shortcuts) | [Rejected-design record](docs/incidents/engineering-record-2026-08-14.md#considered-and-rejected-do-not-re-propose-naively) |
| Interpret benchmark claims | [Benchmark discipline](#benchmark-and-documentation-discipline) | [Benchmark record](docs/incidents/engineering-record-2026-08-14.md#the-controlled-benchmark-benchmark--four-rounds-and-what-they-settled) |

## What this is

`atoma` is a TypeScript framework for three-tier LLM agent orchestration. See
`README.md` for the public pitch.

The user communicates in French. Respond in French; keep code, comments,
commit messages, and outward-facing documentation in English. Dated internal
reviews and incident reports may retain the language in which they were authored.

## Domain taxonomy

The public composition model is **Element → Molecule → Cell → Tissue**.

- Elements are tools. Invocation names such as `read_file` are immutable wire
  contracts; periodic-table identities from `src/contracts/toolTaxonomy.ts`
  are metadata and never replace invocation names.
- L1 agents are Molecules and are the only rank allowed to invoke elements.
- L2 agents are Cells; they route and validate molecule work.
- L3 agents are botanical Tissues; they decompose top-level goals.
- Curated pools are 118 molecules, 40 cells, and 20 tissues, followed by total
  `<Rank><n>` fallbacks.
- Numeric tiers 1/2/3 remain stable in storage, traces, env vars, and class
  names. Implementation names such as `AtomRegistry`, `Tool`, and
  `atom_types` remain stable too.
- The 13 `atoma_*` MCP tools are host control/read APIs, not L1 elements.
- Public taxonomy aliases coexist with legacy exports for compatibility.

Taxonomy migration is a whole-system operation. `registry migrate-taxonomy`
is dry-run by default; `--apply` backs up and migrates the DB, skill namespaces,
ledger entities, prompts, tools, trust, and disposable caches together. Never
perform only the SQL half. Historical trace prose remains byte-honest; project
structured identities at the typed viz boundary instead of rewriting traces.

## Commands and workflow

Use the repository's pinned Node version.

```bash
nvm use
npm install
npm run typecheck
npm run lint
npm test
npm run check
npm run build
npm run release:check
npm run doctor
npm run doctor -- --container
npm run doctor:dev
npm run run:build -- "<goal>"
npm run run:build:dev -- "<goal>"
npm run mcp
npm run mcp:dev
```

Registry, ledger, skills, burn-in, and diagnostics:

```bash
npm run registry -- list
npm run registry -- show <name>
npm run registry -- history <name>
npm run registry -- rollback <name> --to <version>
npm run registry -- migrate-taxonomy
npm run ledger -- tail 20
npm run ledger -- check
npm run skills -- list
npm run skills -- stats
npm run skills -- show <molecule> <id>
npm run skills -- reset <molecule> <id>
npm run skills -- drop <molecule> <id> [--force]
npm run skills -- merge <molecule> <keep> <absorb>
npm run curriculum -- --dry-run
npm run curriculum
npm run burnin
npm run friction
npm run benchmark -- --dry-run
npm run benchmark -- --out benchmark/results-round<N>.csv --result benchmark/ROUND<N>.md
```

### Release contract

- Supported source verification is `npm ci` then `npm run release:check`.
- Supported compiled MCP entrypoint is `node dist/mcp/stdio.js`.
- `release:check` is the release-readiness definition: full check, audit,
  build, compiled MCP/viz smoke, and doctor help smoke.
- `npm run build:worker` consumes an existing `dist/`; the source path is
  `npm run build:worker:dev`.
- Release archives contain no stores, skills, traces, workspaces, or secrets.
- Checksums must be generated inside the release directory so they name the
  downloadable basename, and must be verified before extraction.
- The worker image must be built from packaged `dist/` and its full import
  closure. Container tests must prove allowed egress and denied control-plane
  access, not merely that an image exists.

`atoma doctor` is quota-free. It proves configuration and local prerequisites,
not that a provider will accept the next billable request. Local Docker failures
are warnings; container/egress modes make them hard failures. Egress implies
container. Do not add remote completion calls to doctor.

### Safe working rules

- Preserve unrelated dirty-worktree changes and new files. CI proves a clean
  checkout, so every required source/test must be tracked before claiming a fix.
- Never edit `src/` while a burn-in batch is running: the harness launches
  source-level processes per task and would mix code generations.
- A burn-in batch needs the machine to itself. Do not run heavy tests, builds,
  Puppeteer, viz smokes, or competing provider work concurrently.
- Before the next live batch, close every real error from the prior batch at
  its source and add a regression test. Preserve recovered-error evidence.
- Archive `runs/`, `skills/`, and the starting store before restoring or
  replacing state. Live traces and stores are evidence, not scratch data.

## Cost discipline

Read this section before changing any LLM call site.

- Use the cheapest rank/model that can answer. Planning is reasoning;
  validation is usually a bounded yes/no decision.
- L2/L3 planning runs `prefilterStrategy` first. Only a high-confidence reuse
  can shortcut L2; low/omitted confidence becomes `escalate`. L3 always performs
  its strategy call because top-tier decomposition is the product.
- L2 may synthesize a one-subtask plan only for high-confidence,
  non-decomposable reuse. Coupled outputs are sequential, not falsely parallel.
- Enrich the L3 prefilter catalog with reachable L1 capabilities; a narrow L2
  may still be the correct router through its children.
- Prefilter caching is exact only. The key includes every decision input and
  error outcomes are not cached. Its measured ceiling is 1.7%; do not tune cap
  or expiry, and never introduce fuzzy/embedding matching without first adding
  validation above the prefilter fast path.
- `viaPrefilter` is internal and omitted from `planSchema`; an LLM must not be
  able to spoof validator bypass.
- Trust fast paths require the configured success threshold (default 3) and zero
  failures. Read it through `trustThreshold()`; invalid or non-positive values
  fall back to the default. Result approval still runs the zero-token ground-truth
  probe first. Contradictions and malformed manifests force review; heuristics
  never reject alone.
- Patching or rolling back a type resets its trust counters.
- `VALIDATION_SYSTEM_PROMPT`, `PREFILTER_SYSTEM_PROMPT`, and
  `SKILL_PREFILTER_SYSTEM_PROMPT` are shared constants. Do not inline per-call
  system prompts and destroy caching.
- Keep remediation feedback bounded (`REMEDIATION_FEEDBACK_MAX_CHARS`) and
  actionable; diagnosis leads so head truncation remains useful.
- Validation parameters stay deterministic and bounded. Raise token caps only
  after observing real truncation.
- Normal L2/L3 plan and validation calls never receive tools/executors. Their
  last-resort tool-bearing self-execution must use `modelForTier(1)` while
  retaining supervisor provenance.
- Strategy calls use `STRATEGY_MAX_TOKENS` and medium effort. The cap includes
  adaptive thinking. Defaults in `planSchema` protect against truncation;
  omitted L3 aggregation defaults to `sequential`.
- Aggregation is behavioral: `concat` and `llm-synthesize` dispatch orthogonal
  subtasks in parallel; `sequential` dispatches shared-artifact phases in order
  and threads `previousStepSummary`. Do not parallelize coupled filesystem work.
- Prompt-cache thresholds are load-bearing. Keep the validation prompt above
  the cheapest model's minimum and confirm `cache_read` on multi-call runs.
- Anthropic tool loops keep one rolling cache breakpoint: clear the prior
  marker before marking the latest tool result. Never exceed four breakpoints.
- `estimateCostUsd` is the only cost formula. Anthropic input, cache-read, and
  cache-creation counters are disjoint; never subtract one from another.

## Contracts and storage

- `src/contracts/` owns shared runtime shapes. Define a schema once, infer
  types from it, and import it everywhere; do not duplicate interfaces.
- Contract examples are parsed at module load. A schema/example mismatch must
  fail tests immediately.
- CLI unknown commands print help and exit non-zero; `--help` exits zero.
- `src/core/stores.ts` defines the primary product SQLite store for atom types,
  atom trust, ledger, history, and prefilter cache. Skill `_meta.json` sidecars
  and the operational MCP lease DB are explicit exceptions; do not add another
  product store or silently migrate disposable cache data.
- Ledger writes are fail-open for run execution but attributable and ordered.
  A ledger failure cannot take down the product; impossible counter directions
  must be surfaced by `ledger check`.
- The registry is one tier-keyed table. Migrations, backups, skill namespaces,
  provenance, and trust resets are part of identity changes.
- Probe manifests are structured records. Normalize paths before recognizing
  `.atoma-probes.json`; machine writers merge entries, and model hand-edits are
  refused.

## Architecture invariants

- `superviseLoop` is the only plan → validate → execute → validate protocol.
  L2 and L3 reuse it; never duplicate the loop in concrete atoms.
- Creation is fractal: application → L3 → L2 → L1. Registry creation/branching
  owns names and counters.
- Escalation branches a type and toggles parent fallback in a `try/finally`.
- `pendingStrategy` couples `plan()` and `execute()` on the same instance. Never
  call `execute()` without the corresponding plan.
- `fallbackMode` bypasses registry delegation and calls self-plan/self-execute.
- Mutation scopes flow through `applyByScope`; update the union and every hook
  together when adding a scope.
- Per-task child memos prevent immediate reuse loops. Initialize task state,
  mark committed children, and pass exclusions to prefilters.
- Run-scoped integrity flags and memos must retain the same reference across
  every `forkBranch`; add fork-propagation coverage for new optional fields.
- Registry descriptions are reusable capability labels, never task narratives.
  Route creation descriptions through `resolveCreationDescription`.
- `runTask(profile, argv)` owns provider, sandbox, traces, skills, budgets,
  signals, watchdogs, and post-mortems. A `TaskProfile` contributes only
  family-specific workspace, seed, canonical catalog, constraints, and env names.
- Canonical bootstrap is idempotent and bucket-specific. Prompt/tool changes
  patch and reset trust only when content genuinely differs.
- Verification is read-only. Supervisors may run fixed probes they own, but
  never replay model-authored shell commands.
- L1 plans express intent in prose; actual tool calls happen during execute.
  Do not encourage large literal `toolCalls` payloads in plans.
- Tool scopes are bucket-specific and enforced twice: prompts/plans must name
  only declared tools, and the executor rejects undeclared tool use.
- Match verification to the artefact: browser UI uses static server plus
  browser validation; HTTP APIs use node server plus fetch; CLI/files use shell
  execution plus read-back. Do not force every artefact through HTML tooling.
- HTTP servers bind `process.env.PORT`, accept port 0, and emit
  `LISTENING_ON_PORT=<N>` once ready.
- Recorded probes support cross-checking but do not make non-zero exits errors.
  Only explicit `match:false` or unequal expected/actual values are mechanical
  contradictions.
- Ground-truth reporting must quote observed tool bytes. Narrative self-report
  alone is not evidence.
- Browser and non-browser ground-truth probes are normally exclusive by bucket.
  A loopback HTTP server that actually returns HTML keeps the file probe and
  appends a browser probe; never replace read-back evidence or browse external URLs.
- Quoted-span checks walk summaries before noisy payloads, ignore diff `OLD:`
  and headers, and treat truncated excerpts as silent rather than refuting.
- Already-satisfied idempotent work is compliant when current ground truth proves
  the requested end state; do not demand meaningless rewrites.
- Keep `VALIDATION_SYSTEM_PROMPT` explicit that L1 plans should contain concrete
  tool-oriented proposed actions while L2/L3 must delegate.

## Skills lifecycle

Skills follow learn → match/inject → earn credit → compile → trusted dispatch.

- Skills live under owner namespaces on disk. Metadata sidecars are data: read
  them strictly before mutation and write atomically. Never turn corruption
  into valid zero counters.
- Match against reusable `when_to_use` capability language, not task theme or
  hidden workspace state the prefilter cannot inspect.
- The skill prefilter runs only when candidates exist. Injection is guidance;
  it never guarantees adherence or credit.
- Credit is usage-conditioned. Atom-type counters move with child outcomes;
  skill counters move only when the skill demonstrably drove the attempt.
- Updates after failure are opportunistic. Invalid skill JSON must not fail an
  otherwise valid run, and an unchanged body is not a revision.
- Auto-created/revised skill bodies must stay within the owner's toolset and
  generalize beyond the triggering task. No task-specific literals.
- Promotion compiles an LLM recipe to a deterministic script only after earned
  successes. Promotion resets script trust; the new executable must earn trust.
- Untrusted scripts run through the normal L1 tool loop. Trusted scripts may
  dispatch deterministically only after all preflight gates pass.
- Script stdout ends with exactly one JSON envelope containing non-null `output`
  and string `summary`. Malformed envelopes and `FAILED`/`ERROR` summary prefixes
  fall back to the validated LLM path; do not invent a separate `ok` field.
- Compiled verification consumes `.atoma-probes.json`; if the manifest exists,
  it is the authority over prose. Preserve each entry's recorded semantics.
- Scratch Node scripts use `.mjs`. The workspace may define incompatible `.js`
  semantics and is fenced from the repository module system.
- Static scanning and compile/refusal stamps are generation-aware. Compare via
  `refusalStampIsCurrent`, never raw constants; fail closed on invalid config.
- Manifest entry shapes are bucket-specific. Shell commands are bare commands,
  not decorated exit-code wrappers. HTTP manifests are ordered sequences.
- `when_to_use` matches subtask text alone. State-on-disk requirements belong
  in the body/preflight, not the match trigger.
- Prefer a sibling compilable skill over overwriting a useful LLM recipe.
- `validateProbeManifest` gates malformed machine input before dispatch.
- Anti-redispatch state is run-scoped. A repeated deterministic output rejected
  for content must not earn credit or be dispatched again in a later phase.
- Deterministic failure streaks demote brittle scripts, but environment/executor
  failures are not evidence against the recipe.
- A deterministic dispatch must prove the deliverable, not merely that named
  files already exist. Mutating work needs relevant before/after change or
  equivalent evidence; pure verification may remain read-only.
- A script without `_fallback.md` is undemotable and must be refused before
  dispatch. Never manufacture a fallback after trust was already lost.
- Event-recovery skills match failure classes mid-run and carry zero LLM cost.
  Their triggers describe reusable failure classes, never task themes.
- `skills drop`, `merge`, `reset`, and review are operator-only lifecycle
  actions. Preserve provenance and emit ledger events.
- Compilation's measured value is maintenance verification, not from-scratch
  builds. Do not spend new rounds tuning it unless task decomposition changes.

## LLM interaction conventions

- Every call goes through `LlmClient`; never call a provider SDK from atoms.
- Model IDs and tier defaults live in `src/core/models.ts`.
- `parseLlmSelector` is the only parser for provider/model selectors. Preserve
  Ollama tags containing colons.
- `RoutingLlmClient` owns cross-vendor tier routing. Record both requested and
  served model so cost attribution follows the actual transport.
- Effort settings belong on strategy calls only. Validators and prefilters are
  deterministic and cheap.
- A transport cannot outlive its deadline. Keep both per-call abort and outer
  watchdog guards, clean abort listeners in `finally`, and account partial usage
  when a provider exposes it.
- Claude CLI and Codex CLI transports run with user tools/config isolated.
  Project `.claude/settings.json` never grants shell permission; personal grants
  belong in ignored local settings. Codex MCP registration is local too.
- Do not confuse interactive Codex with the Codex transport. The transport uses
  explicit safe flags and never inherits the interactive agent's tools.
- Auth checks must match the selected transport without leaking credentials.
- All model-output JSON parsing lives in `src/atoms/json.ts`. Preserve raw text
  on parse failure; never guess a structure.
- Nested Markdown fences can hide evidence. Keep fence-aware extraction and its
  adversarial tests.

## Observability and viz

- `InMemoryMetrics` and `MetricsLlmClient` wrap calls; traces record requested
  model, served model, usage, cost, cache, decisions, and tool actions.
- `RecordingLlmClient` preserves partial and failed attempts. A failure after
  usage is still billable evidence.
- The lifecycle ledger is attributable; registry events distinguish initiator
  from target. Cache hits have their own event kind.
- Burn-in CSVs belong to exactly one writer/schema. Refuse foreign headers
  before append. Measurements committed to the repo must remain parseable.
- `parseRunLog` is legacy text parsing; prefer a future structured stats epilogue
  rather than adding more global regexes.
- The friction report is offline and includes recency. Fix recurring real tool
  errors at their source; do not erase successful recovery evidence.
- Act on friction signatures only when they recur across two consecutive batches
  and their root cause lives inside the sandbox. Host, repository, and harness
  defects require structural fixes rather than learned workarounds.
- Viz projects immutable traces at the typed boundary. Do not mutate raw trace
  prose to display current taxonomy.
- The GPU client deliberately uses two GPU contexts: one R3F backdrop and one
  Pixi UI. Do not add a third context for a tiny widget. Smoke tests assert the
  exact count and both WebGPU and WebGL fallback.
- Keep GPU animation state out of React/Zustand hot paths. Use mutable samples
  read once per frame; do not rebuild the scene for pointer motion.
- `isRunLive` / `isIndexEntryLive` are the only live predicates. The abandoned
  threshold exceeds plausible LLM/tool activity (currently 12 minutes).
- Runs rails remain aligned to viewport projection. Never apply scene parallax
  to causal timeline geometry.
- Pixi objects draw local geometry at local origin, then position the object.
  Avoid double-offset hit targets.
- The brand mark is a single Pixi crystal using teal/amber/violet faces, dynamic
  relighting, reduced-motion support, and no overlapping R3F logo.
- The UI is English and catalog-backed; add strings to i18n catalogs rather than
  hardcoding. Tests enforce representative parity, not every incidental string.
- PWA/service-worker registration is production-only. Keep responses no-store
  where live data must not be hidden by an offline shell.
- Do not name a root client module `api.ts`; Vite's `/api` proxy can intercept it.
- The Launch tab describes families and intentionally does not start runs.

## Tools and runtime isolation

- L1 is the only tier with tools. `src/tools/` owns declarations, registry,
  sandbox, builtins, worker protocol, and execution backends.
- `ToolSandbox` is the filesystem/process boundary. Resolve paths through it;
  do not compare raw user spellings for protected files.
- Default builtins and the closed tool vocabulary must stay in lockstep. Tests
  compare names/order; executor scope is the ultimate permission gate.
- `record_probe` writes the manifest from machine-observed results. Models choose
  what to probe; they do not transcribe the record.
- Worker and in-process backends share contracts from `src/contracts/`; never
  fork protocol shapes.
- Container execution uses `network none` unless explicit egress is selected.
  Egress uses the dedicated internal network/proxy policy, never a plain bridge.
- The worker receives an allowlisted environment, not a spread parent env.
  Credentials and control-plane store paths never cross the boundary.
- Network allowlists compare parsed hostnames; lookalikes and IP literals fail.
- Cleanup is mandatory on success, failure, timeout, signal, and hard-exit paths.
  Network teardown races need bounded retry.
- Docker image packaging is verified statically against the worker import graph
  and dynamically by booting the real image.
- `start_static_server` and `start_node_server` use OS-selected ports and explicit
  readiness markers. Do not kill arbitrary process groups; only safe integer
  PGIDs greater than 1 may reach group syscalls.
- `validate_html` treats smoke input as a JS expression, bounds every supplied
  duration, and ignores Chrome's own favicon 404. Browser console errors remain
  evidence but not every one is a mechanical failure.
- Tool results are truncated before returning to the model, with the relevant
  head/tail retained. Budget-exhausted finalization keeps tools declared so the
  provider transcript remains valid.
- Shared smoke guidance lives in one constant. Do not duplicate or specialize
  it around one widget vocabulary.

## MCP stdio server

- Stdio is the safety boundary. Do not add an HTTP port to the MCP control plane.
- Stdout is JSON-RPC only and must be claimed before importing modules that may
  log. Diagnostics go to stderr.
- `spawnRun` is the sole sanctioned run launcher. Keep compiled/source paths and
  flag ordering aligned; the goal is always the last argument.
- Resolve the repository root once before touching relative store, skill, run,
  or workspace paths.
- Runs are serialized by both in-memory state and the SQLite lease. A second
  start is refused; stale lease recovery must validate PIDs/PGIDs safely.
- Cancellation is a state, not successful completion. Signal the whole validated
  child group, bound termination, and retain trace/status evidence.
- `finishRun` must free the in-memory slot in `finally` even if lease deletion
  fails. Failed cleanup is stderr-only and recoverable as a stale row.
- Hard server backstops bound driver promises that never settle. Partial status
  remains observable rather than becoming a false success.
- MCP readers carry mechanical-review caveats in-band; they do not claim semantic
  approval.
- The exported 13-tool surface is a compatibility contract. Add/remove tools only
  with protocol tests, docs, compiled smoke updates, and explicit rationale.

## Testing and linting

- Tests live under `tests/`, use mocked LLMs, and make no paid calls.
- Registry tests use in-memory SQLite unless migration/backup behavior requires
  a copied real-shaped store.
- Every regression test must exercise the production path that failed. If the
  bug crossed forks, clean checkout, compiled output, or process boundaries,
  the test must cross the same boundary.
- Source-grep tests are acceptable only for architectural absence/presence that
  cannot be observed behaviorally. Prefer behavior and typed contracts.
- New source files must be tracked and included in build/package tests. A local
  untracked import is not a passing implementation.
- `npm run check` means typecheck plus lint plus tests. `release:check` is required
  for release-path changes. Container changes also run worker build/isolation.
- Both `tsconfig.json` and `tsconfig.all.json` must pass. Keep tests type-safe;
  use shared factories from `tests/helpers.ts` rather than stale hand mocks.
- ESLint is calibrated. Do not re-enable `require-await` or restrictive template
  expressions without re-measuring the structural hits. `no-explicit-any` stays
  a warning, including tests.
- `raise()` returns `never`; preserve explicit throws where TypeScript control-flow
  analysis requires them despite a lint suggestion.
- `git diff --check`, a clean status, and exact `HEAD == origin/<branch>` are part
  of autonomous commit/push completion.

## Intentional choices and rejected shortcuts

Read the archived sections before changing something that merely looks odd.

- `DEFAULT_LIMITS.maxExecIterations` and its comparison are pinned by tests;
  change semantics only with an explicit migration of the effective budget.
- L3 construction is async because it may resolve the latest Opus model alias;
  L2 construction has no equivalent lookup and may remain synchronous.
- Context injection appends and is composed later; do not mutate base prompts.
- Registry rollback is roll-forward-to-old-content and resets trust.
- `Atom.toolNames()` is public while tool objects remain protected by design.
- Capability bucket order is semantic; HTTP precedes web when signatures overlap.
- Do not restore the L3 skeletal prefilter shortcut. Decomposition quality was
  worth the one top-tier strategy call.
- Do not add semantic prefilter caching. It removes exactness directly below an
  unvalidated fast path.
- Do not introduce plan templating until a typed instantiation/validation layer
  exists; free-form substitution is another unvalidated router.
- Do not blindly replay child commands for verification or add supervisor egress.
- Do not report compilation as the source of build-task savings. Eight rounds
  support tiering, earned trust, and recipe reuse; compilation dispatched mainly
  on maintenance and did not pay on from-scratch decomposition.
- Keep one runner with profiles, one cost formula, one selector parser, one
  contract per shape, and one source of live-state truth.

## Benchmark and documentation discipline

- Controlled benchmarks are pre-registered and compare both arms on the same
  day/code path. Cross-round ratios are not directly comparable.
- Baseline is one frontier agent with the same sandbox, tools, budgets, cache,
  watchdog, and accounting. Keep it inside the shared runner.
- Executing scorers, not delivery banners, establish correctness. Read artefacts
  before weakening a failed check, then confirm both arms remain stable.
- Preserve benchmark traces and starting/ending stores. `runs/` is ignored and
  therefore not an archive.
- Threshold env vars are call-time inputs; always record them with results.
- Public numeric claims must be reproducible from a repository artefact today.
  State sample size/window and prefer generated medians over pasted live values.
- `docs/saas-architecture.md` is a design boundary, not evidence that the local
  product is multi-tenant. Trust counters remain runtime-local.
- Keep outward-facing docs aligned with actual supported commands and packaged
  artifacts. Do not advertise development-only paths as release contracts.

## Historical evidence

The frozen record contains the full dated reasoning behind these rules:

- [engineering record through 2026-08-14](docs/incidents/engineering-record-2026-08-14.md)
- [external code review](docs/code-review-2026-08-14.md)
- [release soak v0.1.0](docs/release-soak-v0.1.0.md)
- [release acceptance v0.1.1](docs/release-acceptance-v0.1.1.md)
- [release acceptance v0.1.3](docs/release-acceptance-v0.1.3.md)
- [hybrid skills design](docs/hybrid-skills-design.md)
- [SaaS architecture boundary](docs/saas-architecture.md)

Archive files are evidence, not normative imports. Never use an unquoted
`@path` import from this file: recursive imports would put the entire history
back into every Claude Code session and defeat this restructuring.
