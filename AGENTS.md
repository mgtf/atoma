# AGENTS.md

Project guidance for coding agents. Read this file before making changes.

This is the ROOT contract. `CLAUDE.md` imports it so Codex and Claude Code
receive the same guidance. It keeps what is cross-cutting: taxonomy, commands,
the release and safe-working contracts, cost and architecture principles,
testing, and the two maps below. A rule that belongs to ONE subsystem lives in
that subsystem's own `AGENTS.md`, beside the code it governs, and is NOT
repeated here — one rule, one home.

**Read the subsystem file before editing that subtree.** Claude Code loads the
sibling `CLAUDE.md` on its own when it opens a file there; Codex merges
`AGENTS.md` from the repository root down to its working directory, so
per-file discovery is guaranteed by neither. The map is an instruction, not a
convenience.

Incident narratives, measurements and dated rationale live under
`docs/incidents/` and are linked, never copied into the prompt. The former
5,452-line engineering record is preserved verbatim (apart from its archive
banner) in
[`docs/incidents/engineering-record-2026-08-14.md`](docs/incidents/engineering-record-2026-08-14.md).
Use it when a rule's rationale matters, not as default session context.

## Subsystem map

| Editing | Read first | What it owns |
|---|---|---|
| `src/atoms/` | [src/atoms/AGENTS.md](src/atoms/AGENTS.md) | supervision loop, planning, prefilter, trust, validation, ground truth, result gates |
| `src/core/` | [src/core/AGENTS.md](src/core/AGENTS.md) | LLM client and transports, models and tier pins, cost accounting, ledger, metrics |
| `src/run/` | [src/run/AGENTS.md](src/run/AGENTS.md) | `startTask`/`runTask`, task profiles, provider construction, run accounting |
| `src/registry/` | [src/registry/AGENTS.md](src/registry/AGENTS.md) | atom-type identity, names and ordinals, bootstrap, trust counters |
| `src/skills/` | [src/skills/AGENTS.md](src/skills/AGENTS.md) | learn, match, credit, compile, trusted dispatch, operator lifecycle |
| `src/tools/` | [src/tools/AGENTS.md](src/tools/AGENTS.md) | elements, sandbox, worker, container isolation, egress, browser probes |
| `src/contracts/` | [src/contracts/AGENTS.md](src/contracts/AGENTS.md) | one schema per shape, probe manifest identity and merge semantics |
| `src/mcp/` | [src/mcp/AGENTS.md](src/mcp/AGENTS.md) | the one MCP over HTTP: tiered tool catalogue, API-token identity, run lease, bounded readers |
| `src/viz/` | [src/viz/AGENTS.md](src/viz/AGENTS.md) | trace projection, GPU client, frozen MUI fallback, gated surfaces, push |
| `src/auth/` | [src/auth/AGENTS.md](src/auth/AGENTS.md) | OAuth gate, organisations, invitations, the platform-admin flag |
| `src/projects/` | [src/projects/AGENTS.md](src/projects/AGENTS.md) | org-scoped projects, their run corpus, artifact manifests, publication |
| `src/launcher/` | [src/launcher/AGENTS.md](src/launcher/AGENTS.md) | the one holder of container-engine access: profiles, networks, orphan reconciliation |
| `src/preview/` | [src/preview/AGENTS.md](src/preview/AGENTS.md) | result preview: deliverable classification, byte policy, instance state |
| `src/github/` | [src/github/AGENTS.md](src/github/AGENTS.md) | GitHub App install, webhooks, repository creation |
| `src/platform/` | [src/platform/AGENTS.md](src/platform/AGENTS.md) | the control-plane audit journal and the one source of notifications |
| `src/cli/` | [src/cli/AGENTS.md](src/cli/AGENTS.md) | operator commands, doctor, burn-in and friction reporting |
| `src/sentinel/` | [src/sentinel/AGENTS.md](src/sentinel/AGENTS.md) | mechanical live watch over runs in flight: rules, sources, hosts |
| `src/supervisor/` | [src/supervisor/AGENTS.md](src/supervisor/AGENTS.md) | post-mortem analyst and the mender: verdicts, idle gate, worktree, pull requests |

Every subsystem file names its own neighbours, so one hop is usually enough.
`npm run docs:check` enforces the shape: each subsystem `AGENTS.md` is listed
above, each has a sibling `CLAUDE.md` holding exactly the import, links resolve,
and no file exceeds its budget.

## Evidence map

| Need | Read here | Deeper evidence |
|---|---|---|
| Run, test, release, backup | [Commands and workflow](#commands-and-workflow) | [Commands / Testing record](docs/incidents/engineering-record-2026-08-14.md#commands) |
| Tier names and persisted identities | [Domain taxonomy](#domain-taxonomy) | [Taxonomy record](docs/incidents/engineering-record-2026-08-14.md#domain-taxonomy) |
| Change an LLM call or validator | [src/atoms](src/atoms/AGENTS.md), [src/core](src/core/AGENTS.md) | [Cost record](docs/incidents/engineering-record-2026-08-14.md#cost-discipline-load-bearing--read-before-changing-any-llm-call-site) |
| Change supervision, routing, trust | [src/atoms](src/atoms/AGENTS.md), [src/registry](src/registry/AGENTS.md) | [Architecture record](docs/incidents/engineering-record-2026-08-14.md#architecture-invariants-dont-violate-these) |
| Change learn/compile/dispatch | [src/skills](src/skills/AGENTS.md) | [Skills record](docs/incidents/engineering-record-2026-08-14.md#skills-persistent-task-patterns) |
| Change tools, worker, sandbox | [src/tools](src/tools/AGENTS.md) | [Tools record](docs/incidents/engineering-record-2026-08-14.md#tools-l1-side-effects) |
| Change MCP lifecycle | [src/mcp](src/mcp/AGENTS.md) | [MCP record](docs/incidents/engineering-record-2026-08-14.md#atoma-as-an-mcp-server-stdio--srcmcp) |
| Change metrics, traces, viz | [src/viz](src/viz/AGENTS.md), [src/core](src/core/AGENTS.md) | [Observability record](docs/incidents/engineering-record-2026-08-14.md#observability) |
| Understand an odd choice | the subsystem file's own intentional-choices section | [Rejected-design record](docs/incidents/engineering-record-2026-08-14.md#considered-and-rejected-do-not-re-propose-naively) |
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
- The 24 `atoma_*` MCP tools are host control/read APIs, not L1 elements; a
  caller sees the subset its tier admits (viewer, member, admin, platform).
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
npm run docs:facts -- --apply         # rewrite the README's derived-facts block
npm run docs:architecture -- --apply  # rewrite the architecture diagram IR
npm run build
npm run release:check
npm run doctor
npm run doctor -- --container
npm run doctor -- --preview
npm run doctor:dev
npm run deploy:preflight            # read-only; exits 75 while a run/preview is live
npm run auth -- list
npm run auth -- invite --role org:owner --ttl-hours 24
npm run auth -- grant-admin --principal <id-or-email>
npm run auth -- revoke-admin --principal <id-or-email>
npm run auth:dev -- list
npm run auth:dev -- invite --role org:owner --ttl-hours 24
npm run projects -- list
npm run projects -- run --project <slug> --as <id-or-email> "<goal>"
npm run projects:dev -- list
npm run sentinel -- --once          # the viz server already hosts this watch
npm run sentinel:dev -- --cost-alert 2.50
npm run analyst -- --once --backfill 2   # post-mortem verdicts; never beside a run
npm run analyst:dev -- --run <id>
npm run mender -- --once                 # cited defect verdicts → a PR on main; a person merges
npm run mender:dev -- --dry-run --once
npm run run:build -- "<goal>"
npm run run:build:dev -- "<goal>"
```

Visualizer commands and their preconditions: [src/viz/AGENTS.md](src/viz/AGENTS.md).

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
npm run backup -- --dest <off-machine mount>   # store+skills+runs+archives, dated, pruned
npm run benchmark -- --dry-run
npm run benchmark -- --out benchmark/results-round<N>.csv --result benchmark/ROUND<N>.md
```

Locales:

```bash
npm run i18n -- check               # all target catalogs + placeholder signatures
npm run i18n -- fix-drift --apply   # blank target values that drifted from EN placeholders
npm run i18n -- translate           # fill every blank target with gpt-5.6-sol (Codex locally; API in CI)
npm run i18n -- sync                # same, but the caller translates (no API key)
```

The viz locale catalogs are JSON (`src/viz/client/locales/`); `en.json` is the
source of truth and a blank or missing target value means "awaiting translation".
Agents and humans editing product copy write **only `en.json`**. Do not add,
translate, or rewrite `fr.json` or any other target catalog — husky
(`.husky/pre-commit` → `i18n.mjs invalidate-staged`) blanks target values whose
EN source changed, and the CI `i18n` job on main (`fix-drift` then `translate`)
fills blanks and commits `[skip ci]`. A missing target key is the same as a
blank: CI translates it. `i18n sync` is an operator tool for a machine without
the API key, not a license for an agent to author translations.
Translation isolates locales — a failing language never discards its siblings'
successes; the job stays red and the next push retries the remaining blanks.
Local translation reuses `codex login` (ChatGPT Plus/Pro); CI requires the
separately billed `OPENAI_API_KEY`. The full contract is in
[src/viz](src/viz/AGENTS.md).

### Release contract

- Supported source verification is `npm ci` then `npm run release:check`.
- The MCP is served by the compiled viz server on `/mcp` (`npm run viz:serve`);
  there is no separate MCP entrypoint since 2026-09-05.
- `npm run auth` is the compiled identity/invitation CLI
  (`node dist/cli/auth.js`); contributors use `npm run auth:dev` for source.
- `release:check` is the release-readiness definition: full check, audit,
  build, the compiled MCP smoke, the compiled auth end-to-end smoke
  (`auth-release-smoke.mjs`: founder login, CLI invite, member admission),
  and the auth/doctor help smokes.
- The BROWSER smoke (`viz:smoke`) is NOT in it, since 2026-08-24. It is the one
  check here that drives a real Chrome, and on CI's CPU rasteriser (2023–3433ms
  per frame, against ~17ms on a developer machine) it both dominated the step
  and failed on its own timing rather than on the change under test — three
  distinct CI-only flakes in one day, plus a 25-minute wall it pushed an
  icon-only commit through. It stays a supported command and remains the
  behavioural proof of the client bundle boundary; run it on a real machine
  before shipping a viz change. Re-arming it in CI needs the runner to render
  faster, or the arms to stop measuring frame time — not a longer timeout.
- `npm run build:worker` consumes an existing `dist/`; the source path is
  `npm run build:worker:dev`.
- `npm run preview:demo` is DEVELOPMENT TOOLING, never a release path: a
  loopback OAuth provider plus a seeded project and delivered static run, so
  the preview surface is clickable on a machine that cannot execute a run.
- `npm run build:preview` builds the preview runtime image. It consumes no
  `dist/` because it contains none: the process it starts is a run's own
  deliverable, not ours. Production pins it by DIGEST, which means pushing it —
  a mutable tag is not an identity, and the configuration refuses one.
- Release archives contain no stores, skills, traces, workspaces, or secrets.
- Checksums must be generated inside the release directory so they name the
  downloadable basename, and must be verified before extraction.
- The worker image must be built from packaged `dist/` and its full import
  closure. Container tests must prove allowed egress and denied control-plane
  access, not merely that an image exists.

`atoma doctor` is quota-free; its rules live in [src/cli/AGENTS.md](src/cli/AGENTS.md).

### Safe working rules

- Preserve unrelated dirty-worktree changes and new files. CI proves a clean
  checkout, so every required source/test must be tracked before claiming a fix.
  The pre-commit hook obeys this too: a PARTIALLY staged file is verified but
  never `--fix`ed or re-staged, because `git add <file>` takes the whole file
  and would commit the hunks you left out (2026-08-27). Same rule for the
  locale catalogs it blanks — one carrying its own unstaged edits is written
  but not staged.
- Never edit `src/` while a burn-in batch is running: the harness launches
  source-level processes per task and would mix code generations.
- A burn-in batch needs the machine to itself. Do not run heavy tests, builds,
  Puppeteer, viz smokes, or competing provider work concurrently.
- Before the next live batch, close every real error from the prior batch at
  its source and add a regression test. Preserve recovered-error evidence.
- Archive `runs/`, `skills/`, and the starting store before restoring or
  replacing state. Live traces and stores are evidence, not scratch data.
- COOLING-OFF: never design a new mechanical gate, heuristic, or validator
  rule during the live session that surfaced the incident. Collect the
  session's incidents, design the contract ONCE against all of them, land it
  as one reviewed commit. Apply pre-construction adversarial review to
  mechanisms you accept, not only to ideas you reject — the 2026-08-14 review
  measured same-day gates as the main source of one-concept-two-definitions
  drift and vocabulary-frozen detectors.

### Parallel agents on one machine

Two agents may hold two `git worktree` checkouts and edit in parallel — that is
what resolves the burn-in rule above, which forbids concurrent EDITS, not
concurrent work. A worktree isolates the source and the repo-relative state for
free: `./atoma.db`, `./skills/` and `./runs/` are cwd-relative and ignored, and
`repoRoot()` derives from the module's own path, so an MCP server launched from
a worktree serves that worktree's store. A fresh worktree therefore starts with
NO store: the registry bootstraps and trust counters begin at zero.

What a worktree does NOT isolate, and what each one must set:

- The build workspace is a fixed HOME path (`~/.atoma/workspaces/build`) and is
  ARCHIVED at the start of every run. Give each worktree its own
  `ATOMA_BUILD_WORKSPACE`, or one agent's run replaces the other's workspace.
- The viz ports are `strictPort`: set `ATOMA_VIZ_DEV_PORT` and
  `ATOMA_VIZ_API_PORT` per worktree. The `atoma-worker:latest` tag is shared
  too — do not rebuild it while another agent's container run is in flight.
- The MCP run lease (`~/.atoma/mcp-run-lock.db`) is machine-global ON PURPOSE.
  Never override `ATOMA_MCP_RUN_LOCK` to win concurrency: it is what keeps two
  runs off one workspace and one provider quota.
- Model quota is one account. Runs and their sub-agents draw on it together, so
  parallel EDITING is safe and parallel RUNNING is not: one live run at a time.

## Cost discipline

Read the subsystem file before changing any LLM call site. The cost rules are
load-bearing and they are stated once, where the call sites are.

- Use the cheapest rank/model that can answer. Planning is reasoning;
  validation is usually a bounded yes/no decision.
- [src/atoms](src/atoms/AGENTS.md) — planning, the prefilter, trust fast paths,
  shared system prompts, strategy caps, aggregation shape.
- [src/core](src/core/AGENTS.md) — the one cost formula, served-model
  accounting, partial usage on errors, cache breakpoints.
- [src/run](src/run/AGENTS.md) — provider construction, `ATOMA_MODEL_L*` pins.

## Contracts and storage

- `src/contracts/` owns shared runtime shapes. Define a schema once, infer
  types from it, and import it everywhere; do not duplicate interfaces.
- `src/core/stores.ts` defines the primary product SQLite store for atom types,
  atom trust, ledger, history, and prefilter cache. Skill `_meta.json` sidecars
  and the operational MCP lease DB are explicit exceptions; do not add another
  product store or silently migrate disposable cache data.
- The registry is one tier-keyed table. Migrations, backups, skill namespaces,
  provenance, and trust resets are part of identity changes.
- The gated deployment surfaces are storage contracts too, one file each:
  - [src/auth](src/auth/AGENTS.md) — identity, organisations, invitations
  - [src/projects](src/projects/AGENTS.md) — org-scoped run storage
  - [src/platform](src/platform/AGENTS.md) — the audit journal
  - [src/viz](src/viz/AGENTS.md) — the HTTP surfaces and push
  - [src/contracts](src/contracts/AGENTS.md) — probe manifests

## Architecture invariants

- `superviseLoop` is the only plan → validate → execute → validate protocol, and
  L2/L3 reuse it for children; never duplicate that loop in concrete atoms. The
  full protocol contract is in [src/atoms](src/atoms/AGENTS.md).
- Creation is fractal: application → L3 → L2 → L1. Registry creation/branching
  owns names and counters.
- Verification is read-only. Supervisors may run fixed probes they own, but
  never replay model-authored shell commands.
- Tools belong to L1 only, and only [src/tools](src/tools/AGENTS.md) may declare
  or execute them. The MCP is not an element surface: [src/mcp](src/mcp/AGENTS.md).

## Skills lifecycle

Orientation only — the contract lives in [src/skills](src/skills/AGENTS.md).
Skills follow learn → match/inject → earn credit → compile → trusted dispatch,
under owner namespaces keyed by atom id (`skills/<atom-id>/`). Compilation's
measured value is maintenance verification, not from-scratch builds, and every
operator lifecycle action is attributable.

## Tools and runtime isolation

Orientation only — the contract lives in [src/tools](src/tools/AGENTS.md). L1 is
the only tier with tools; `ToolSandbox` is the filesystem/process boundary;
container execution is `network none` unless egress is explicitly selected; and
cleanup is mandatory on every exit path.

## MCP server

Orientation only — the contract lives in [src/mcp](src/mcp/AGENTS.md). ONE MCP
for everyone over HTTP on `/mcp`, a tiered catalogue whose visibility follows
the caller's role, bearer API tokens for identity, and runs serialised by
memory state and a SQLite lease. The catalogue is a compatibility contract for
every registered client. Decision record:
[docs/mcp-one-surface-2026-09-05.md](docs/mcp-one-surface-2026-09-05.md).

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

- Do not blindly replay child commands for verification or add supervisor egress.
- Keep one runner with profiles, one cost formula, one selector parser, one
  contract per shape, and one source of live-state truth.
- Every subsystem file carries its own intentional-choices section listing the
  shortcuts already tried and reverted there. Read it before re-proposing one.

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
  EXCEPTION, recorded 2026-08-18: the pre-reset measurement CSVs were archived
  out of the tree with the store, skills and traces, so the round write-ups are
  historical narrative rather than reproducible claims. New measurements
  restore the rule.
- `docs/saas-architecture.md` is a design boundary, not evidence that the local
  product is multi-tenant. Trust counters remain runtime-local.
- Keep outward-facing docs aligned with actual supported commands and packaged
  artifacts. Do not advertise development-only paths as release contracts.
- `docs:check` now GENERATES what is tabular and ASSERTS what is prose. The
  README block between `<!-- atoma:facts:begin -->` and its end marker belongs
  to `scripts/readme-facts.mjs` — edit the derivation, never the block. The
  sentences carrying the same numbers stay hand-written and are only CHECKED,
  because a generator that rewrote prose would silently "correct" a claim whose
  surrounding argument no longer holds. `scripts/repo-facts.mjs` is the single
  derivation and names, in `KNOWN_NARRATIVE`, the README numbers it refuses to
  invent. The architecture diagram follows the same split:
  `docs/ir/atoma.architecture.json` takes its component list from the subsystem
  map above, while placement and edges stay authored in
  `scripts/architecture-ir.mjs`. Rendering it needs a third-party Archify
  checkout and is development tooling — `docs:check` never renders, and CI
  never clones it. Full rationale:
  [`docs/documentation-freshness-2026-09-04.md`](docs/documentation-freshness-2026-09-04.md).

## Historical evidence

The frozen record contains the full dated reasoning behind these rules:

- [engineering record through 2026-08-14](docs/incidents/engineering-record-2026-08-14.md)
- [fan-out + join, first live parallel lanes 2026-08-16](docs/incidents/parallel-fanin-2026-08-16.md)
- [burn-in session 2026-08-21: four batches, 20 runs, six defects](docs/incidents/burn-in-2026-08-21.md)
- [the sentinel's blind spot, measured on a real run 2026-08-23](docs/incidents/sentinel-blind-spot-2026-08-23.md)
- [GPU frame cost on an integrated GPU, measured 2026-09-06](docs/incidents/gpu-frame-cost-2026-09-06.md)
- [external code review](docs/code-review-2026-08-14.md)
- [code review 2026-08-18](docs/code-review-2026-08-18.md)
- [supervisor-held proof attestation (A1) design review 2026-08-22](docs/supervisor-attestation-a1-review-2026-08-22.md)
- [offering a skill to the platform catalog, design review 2026-08-23](docs/platform-skill-offer-review-2026-08-23.md)
- [decided, not built — session snapshot 2026-08-23](docs/decided-not-built-2026-08-23.md)
- [lessons from Lovable — internal architecture review 2026-08-26](docs/lovable-lessons-atoma-2026-08-26.md)
- [per-tier host subscription — design and implementation record 2026-08-28](docs/subscription-per-tier-design-2026-08-28.md)
- [presenting the app under development — Lovable UI study and adopted direction 2026-08-31](docs/live-preview-direction-2026-08-31.md)
- [previewing a run in flight — decision and contract 2026-09-02](docs/in-flight-preview-2026-09-02.md)
- [release soak v0.1.0](docs/release-soak-v0.1.0.md)
- [release acceptance v0.1.1](docs/release-acceptance-v0.1.1.md)
- [release acceptance v0.1.3](docs/release-acceptance-v0.1.3.md)
- [hybrid skills design](docs/hybrid-skills-design.md)
- [SaaS architecture boundary](docs/saas-architecture.md)

Archive files are evidence, not normative imports. Never use an unquoted
`@path` import from this file or from a subsystem file: recursive imports would
put the entire history back into every Claude Code session and defeat this
restructuring.
