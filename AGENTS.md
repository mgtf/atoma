# AGENTS.md

Project-level notes for coding agents. Read this before making changes.

THIS IS THE SINGLE SOURCE OF TRUTH for the project's rules and engineering
record. Codex reads this file natively; Claude Code reads the sibling
`CLAUDE.md`, which is a one-line import of this one for exactly that reason.
Add rules HERE — a rule written in the sibling is invisible to every other
agent, which is the failure the indirection exists to prevent. This file was
itself named `CLAUDE.md` until 2026-08-11; run `git log --follow AGENTS.md` for
the history before the rename, and note that entries below say "this file"
throughout.

## Map (~4500 lines — jump, don't scroll)

| Section | When you need it |
|---|---|
| Commands | run/inspect anything (`build`, `burnin`, `viz`, `registry`, `skills`) |
| Cost discipline | **read before touching ANY LLM call site** |
| Observability | metrics, viz, burn-in ledger, run traces |
| Architecture invariants | before changing the supervision loop / tiers / registry |
| Skills | the learn → compile → dispatch lifecycle and every guard on it |
| LLM interaction conventions | providers, per-tier models, JSON parsing, prompt caching |
| Testing conventions | how to add tests that actually catch the bug class |
| Linting | what ESLint is calibrated to, and the rules deliberately OFF |
| The test suite is type-checked now | the 96 errors nothing was looking at, and the factories that stop them coming back |
| Tools | sandbox, the 10 builtins, their contracts |
| MCP server (stdio) | exposing atoma to Claude Code and other MCP hosts |
| Things that look wrong but aren't | **read before "fixing" something odd** |
| Considered and rejected | **read before proposing an optimization** |
| The controlled benchmark | the atoma-vs-frontier A/B: what it proved, and what it did NOT |

## What this is

`atoma` is a TypeScript framework for three-tier LLM agent orchestration. Every atom
is an LLM-backed agent. See `README.md` for the external pitch.

## Commands

```bash
nvm use                               # .nvmrc = the same Node version as CI
npm install
npm run typecheck                     # tsc --noEmit (strict mode)
npm run lint                          # eslint, type-aware (see the Linting section)
npm run check                         # typecheck + lint + test
npm test                              # vitest run — all mocked, no API key needed
npm run build                         # emits to dist/
npm run release:check                 # check + audit + build + compiled MCP/doctor smokes
npm run doctor                        # compiled quota-free runtime preflight
npm run doctor -- --container         # require Docker daemon + bootable worker
npm run doctor:dev                    # source-level development path
npm run run:build "<goal>"            # supported compiled release path (build first)
npm run run:build:dev "<goal>"        # source-level development path
npm run mcp                           # compiled dist/mcp/stdio.js
npm run mcp:dev                       # source-level MCP entrypoint

npm run registry -- list              # inspect persisted atom types + counters
npm run registry -- list --tier 2
npm run registry -- show Hydrogen
npm run registry -- top --by failure  # sort by failures; also success|ratio
npm run registry -- history Hydrogen  # archived versions: prompt head, tools, who/when/why
npm run registry -- rollback Hydrogen --to 2   # restore v2 content as a NEW live version
npm run registry -- remove Glucose      # delete dynamic-creation debris
npm run registry -- --db ./archived.db list      # override the one store (rarely needed)

npm run ledger -- tail 20             # the lifecycle_events table, newest last
npm run ledger -- check               # project counters, flag the IMPOSSIBLE direction

npm run skills -- list                # all skills: kind, counters, refusal stamps

npm run burnin                        # batch tasks through the REAL pipeline; appends
                                      # per-run economics to burnin/results.csv
npm run burnin -- tasks.json --family cli --out custom.csv --timeout 900000
npm run skills -- list --l1 Helium
npm run skills -- show Helium scaffold-node-ssr-sqlite-api
npm run skills -- reset Helium scaffold-node-ssr-sqlite-api  # zero counters + clear refusal
npm run skills -- stats [--l1 Helium] [--sim 0.5]  # utility view: matches vs driven,
                                      # free-ride gap, lifecycle status, merge candidates
npm run skills -- drop Helium <id> [--force]       # delete a skill (--force if successes>0)
npm run skills -- merge Helium <keep> <absorb>     # keeper absorbs when_to_use; absorbed deleted

npm run curriculum -- --dry-run       # show lifecycle targets, no LLM call
npm run curriculum                    # ONE Sonnet-tier call → burnin/tasks-curriculum.json

npm run friction                      # offline tool-loop friction report from runs/
npm run friction -- --last 50 --tier hard   # zero LLM; run after each burn-in batch

ATOMA_LLM=claude-cli npm run benchmark -- --dry-run   # the controlled A/B; spends nothing
ATOMA_LLM=claude-cli npm run benchmark                # ~2h, machine to itself
node benchmark/score-all.mjs                          # execute + score every deliverable
node benchmark/plot.mjs                               # regenerate docs/benchmark-cost-curve.svg
npm run run:build -- --baseline "<goal>"              # ONE frontier agent, no tiering
```

**LOCAL RELEASE CONTRACT (v0.1).** The supported source path is `npm ci` →
`npm run release:check`; the supported compiled MCP path is
`node dist/mcp/stdio.js`. `release:check` is the one definition of release
readiness: full check, npm audit, build, then a quota-free JSON-RPC smoke
against the compiled server plus a compiled doctor help smoke. Tag workflow
`.github/workflows/release.yml`
repeats it, creates a production-dependency archive and re-tests that extracted
archive before publishing a private GitHub Release. It also builds the worker
from packaged `dist/` and runs a quota-free container/egress smoke: an
allowlisted registry request must succeed while the control plane stays
unreachable. `npm run build:worker` is the RELEASE command and consumes
existing `dist/`; `npm run build:worker:dev` is the SOURCE command that
compiles first. They were one command until the v0.1.1 acceptance matrix tried
it from the archive and got TS5058 because `tsconfig.json` is deliberately not
packaged. The archive carries no store, skills, traces, workspace or
credentials. Source-only operator, benchmark and development CLIs are not
claimed as part of the compiled archive.
Checksums are generated FROM INSIDE the release directory so they contain the
downloadable basename, then verified before extraction — v0.1.0 initially
published its workflow-internal `release/…` path and the first external soak
caught it. Live results are in `docs/release-soak-v0.1.0.md` and
`docs/release-acceptance-v0.1.1.md`; v0.1.2 is the worker-packaging correction.

**`atoma doctor` IS A QUOTA-FREE PREFLIGHT, NOT A PROVIDER HEALTH CALL.**
`npm run doctor` is the compiled release path; `doctor:dev` is the source path.
It checks the package's exact Node engine floor, resolves the base provider and
every explicit `provider:model` tier pin, verifies credential CONFIGURATION
without making a billable completion, and probes Docker plus the worker image.
Docker/worker failures are warnings in local mode and hard failures under
`--container`, `--egress`, `ATOMA_CONTAINER=1` or `ATOMA_EGRESS=1`. The worker
check boots the real image and waits for its hello — `docker image inspect`
alone would have approved the F9 image that existed but died on its missing
import. `resolveToolBackendMode` in `src/run/backendMode.ts` is shared with the
runner so flag/env precedence cannot drift; egress always implies container.
Claude CLI auth is checked with `ANTHROPIC_API_KEY` removed, matching the
transport exactly; Anthropic uses the same zero-request SDK constructor as the
runtime; Ollama calls only `/api/version`; Codex uses login status unless an API
credential is explicitly configured; Z.ai checks its key and endpoint shape.
An exported Anthropic key that a configured route will ignore, and the
debug-only `ATOMA_CLAUDE_MODEL` override that flattens the tier gradient, are
both explicit warnings. No command output that could contain a credential is
rendered. Exit codes:
0 ready, 1 missing required prerequisite, 2 invalid doctor arguments. A green
provider check proves a credential source/login is PRESENT, not that a remote
service will accept the next request — proving that would spend quota and make
doctor itself a run. Doctor also does not make an external egress request:
`--egress` renders that limitation as a warning and points to the deeper
`npm run release:container-smoke`, which exercises both the allowlisted
registry path and control-plane denial.

## Cost discipline (load-bearing — read before changing any LLM call site)

- **The cheapest atom that can answer, SHOULD answer.** Validation is a yes/no;
  strategy/plan generation is real reasoning. So:
  - `L2Atom.plan` / `L3Atom.plan` run on `this.model` (Sonnet / Opus) — but only
    after the Haiku prefilter declines to short-circuit the decision.
  - `validatePlan` / `validateResult` run on `this.validationModel` (Haiku by
    default) via `llmVerdict` in `src/atoms/L2Atom.ts`.
- **Prefilter first, reason second.** In `L2Atom.plan` and `L3Atom.plan`, a
  `prefilterStrategy` call (Haiku, temperature 0, maxTokens 256) scans the
  tier-child catalog for a clear reuse match. On success, a skeletal Plan is
  synthesised locally and the Sonnet/Opus strategy call is SKIPPED entirely.
  Only "escalate" (no clear match, or a new type must be designed) falls
  through to the full supervisor-tier call. Shared prompt:
  `PREFILTER_SYSTEM_PROMPT` in `src/atoms/cost.ts` — constant, cached.
- **Prefilter confidence guard.** The `reuse` variant of
  `prefilterResponseSchema` carries an optional `confidence: "high"|"low"`.
  `prefilterStrategy` in `src/atoms/cost.ts` rewrites any `reuse` outcome
  with non-`high` confidence (including omitted) into an `escalate` before
  returning it. The prompt instructs Haiku to label its own certainty and
  to prefer emitting `escalate` outright when it would otherwise pick
  "low". Rationale: on a single-candidate catalog Haiku used to force-
  match the only available option (observed: `Methane` picking `Hydrogen`
  for a Node/REST task because Hydrogen was the only L1 on record).
  Structurally required regardless of catalog size — the prompt has a
  HARD RULE against single-candidate force-matching.
- **Prefilter decomposable hint.** The `reuse` variant also carries an
  optional `decomposable: boolean`. At **L2** the original contract
  holds: `reuse + !decomposable` fires the skeletal-plan short-circuit
  (happy path, 0 Sonnet), `reuse + decomposable` falls through to the
  full supervisor plan with the target as a `== PREFILTER HINT ==`.
  At **L3** the short-circuit is GONE — every L3 run defers to the
  Opus plan call regardless of the `decomposable` flag, with the
  prefilter target carried forward as a hint. The framework's value
  at the top tier is decomposition reasoning; collapsing that to a
  1-subtask routing decision wasted the tier and produced visibly
  monolithic deliverables (a Pong build that delegated all of
  scaffold+input+physics to a single Hydrogen run, with no per-phase
  smoke checkpoint). Cost: ~+$0.10/run on L3, deliberately accepted.
  The prompt tells Haiku to emit `decomposable: false` when artefacts
  are COUPLED (test imports the lib, package.json runs the test,
  README documents the API, client imports server types, config read
  by code) — at L2 those cases are structurally sequential and a
  single L1 tool-loop beats a fan-out. `decomposable: true` is
  reserved for artefacts GENUINELY orthogonal with no shared
  imports/refs/depends-on (e.g. three unrelated puzzle games, three
  independent web scrapes). Measured impact on the
  library+tests+docs scenario at L2: tightening this rule dropped a
  $0.18 run (1 Opus + 1 Sonnet) to a $0.05 run (0 Opus + 0 Sonnet,
  7 Haiku — 100% L2 happy path).
- **L3 prefilter catalog enrichment — L1 affinity.** When `L3.plan`
  builds the prefilter catalog it appends each L2 description with a
  "REACHABLE L1 CHILDREN" block listing (a) canonical L1s (reachable
  from any L2 via tier-1 prefilter) and (b) L1s dynamically created
  by that L2 (`createdBy` match). Without this, L3.prefilter saw only
  the L2 self-description and escalated on tasks that needed a
  specific L1 bucket the parent L2 didn't mention (observed on the
  library+tests task: "catalog offers only web/HTTP orchestrators"
  → full Opus plan). The enrichment is paired with an `L1-affinity
  rule` clause in `PREFILTER_SYSTEM_PROMPT` so Haiku is told
  explicitly to count children's capabilities in the match decision
  — "an L2 whose own description is narrow can STILL be a valid
  reuse pick if its REACHABLE L1 CHILDREN cover the task's needs."
  The block is formatted on a dedicated line (not a parenthetical
  tail) so Haiku parses it as structure rather than flavour text.
- **Prefilter DECISION CACHE (`src/atoms/prefilterCache.ts`).** Prefilter
  calls are temperature-0 with CONSTANT prompts, so the decision is a
  pure function of its inputs — `prefilterStrategy` serves a repeat
  (task × catalog × exclusions × model × prompt) pair from the
  `prefilter_cache` TABLE in the store: zero tokens, and under claude-cli
  zero 2-5s subprocess spawns (FrugalGPT's completion cache on atoma's
  cheapest slot). Correctness
  lives in the KEY (djb2 over every decision input, NOT the actor
  attribution preamble): registry evolution changes the catalog text and
  misses naturally. Bounds: 7-day expiry (model pins are stable strings
  but served versions shift behind them) + 500-entry oldest-first cap.
  All three PARSED outcomes cache (including the low-confidence
  escalate rewrite); the error-path escalate NEVER does — an LLM hiccup
  must not become a week of escalates. Config: `ATOMA_PREFILTER_CACHE`
  ('0' disables, other values override the DB path; default: the one
  store). vitest pins it to '0'
  globally — mock tests assert exact call counts and a shared cache
  would make test order change which calls fire; cache tests re-enable
  per-test. Covered by `tests/prefilter-cache.test.ts`.
  IT WAS `./atoma-prefilter-cache.json` until 2026-08-09, and the file form
  re-serialised the WHOLE cache on every get AND every put — 217 KB rewritten
  per prefilter call, including on a HIT, purely to increment `hits` — while
  being last-writer-wins across processes on the whole file, so two concurrent
  runs discarded each other's entries wholesale. `INSERT OR REPLACE` and
  `hits = hits + 1` are what it wanted. Eviction orders by ROWID, not by `at`:
  a run writes several decisions inside one millisecond, so an `at` sort ties
  and the tie-break decides arbitrarily whether the entry JUST WRITTEN is the
  one thrown away (the file form got insertion order free from V8's stable
  sort; SQL had to be told — same reason `lifecycle_events` carries a seq).
  Pinned by a same-millisecond burst test that fails against the `at` sort.
  NOT MIGRATED on the move, deliberately: a cache that gets an importer is
  being treated as data.
  **IT IS ALREADY AT ITS CEILING, AND THE CEILING IS 1.7%. DO NOT TRY TO
  TUNE IT.** Live rate at the move: 500 entries (AT the cap, so eviction and
  not the 7-day expiry bounds retention), 9 ever read back — 1.8% — for 11
  hits; then 0 hits over the next five runs. That reads like a tuning problem
  and is not one. Replaying the REAL key (preamble stripped, as
  `prefilterCacheKey` does) over all 748 prefilter calls in the 118 archived
  traces: **735 distinct inputs**, 12 within-run repeats in 3 runs, 1
  across-run. A cache that were infinite, never expired and never missed
  would avoid **13/748 = 1.7%** of calls — worth $0.0003/run, ~0.1% of a mean
  run, ~40s of claude-cli subprocess spawn across the whole corpus. The live
  1.8% IS the ceiling; raising the cap or the expiry cannot move a number
  that is bounded by input uniqueness.
  WHY IT CANNOT REPEAT: the key contains the TASK DESCRIPTION, and no two
  prefilter calls in the system ever see the same one. A run's ~6 calls are
  one per decomposed subtask, and subtask text is freshly authored prose from
  a non-deterministic plan call; top-level goals are novel by construction
  (the curriculum demands it). Decomposition is the production of distinct
  texts, so the cache is keyed on the one input guaranteed to be unique.
  KEPT ANYWAY (operator decision, 2026-08-10): it costs an indexed SELECT and
  it is honest about itself via `registry cache`. The reason NOT to delete a
  mechanism this weak is thin, so the reason not to TRUST it is written here
  instead — if you are wondering why prefilters cost what they do, the cache
  is not the answer and never was.
  THE OBVIOUS IDEA FOR RAISING IT IS THE DANGEROUS ONE. Fuzzy or embedding
  ("semantic cache") matching would hit far more often, and it trades the
  cache's single safety property — exactness — at the one point in the
  pipeline with nothing above it: a prefilter-synthesised plan carries
  `viaPrefilter: true`, which makes `validatePlan` return approved WITHOUT an
  LLM call. A near-match returning the wrong child would therefore reach
  execution unvalidated. Any future attempt has to solve that first, not the
  hit rate.
  REVISIT only if the key stops containing free-form task text, or if real
  (non-burn-in) usage turns out to be repeat-heavy — a human relaunching an
  identical goal after a failure is the one shape that would hit. Do NOT
  revisit on more burn-in batches: they engineer novelty by design, so they
  can only re-measure the same ceiling.
- **Prefilter fast-path in `validatePlan`.** Plans synthesised by the
  prefilter carry an internal `viaPrefilter: true` flag (set in
  `L2.plan` / `L3.plan` on the skeletal-plan literal). Both
  `L2.validatePlan` and `L3.validatePlan` open with an early-return to
  approval when the flag is set — Haiku validating a Haiku-picked one-
  line routing decision produces no new signal and was observed
  rejecting freshly-bootstrapped canonicals (the Node/REST
  Helium-rejected-then-hallucinated-Neon cascade). CRITICAL: the
  flag is deliberately OMITTED from `planSchema` so an LLM cannot
  spoof `viaPrefilter: true` in its routing JSON — `z.object()` strips
  unknown keys at parse, so only the skeletal-plan literal can carry
  the marker into `validatePlan`.
- **Trust fast-path in validators.** Each `validatePlan` / `validateResult`
  checks `registry.getByName(child.name)` and returns an approved verdict
  WITHOUT an LLM call when `successes >= TRUST_THRESHOLD_SUCCESSES` (3) AND
  `failures === 0`.
  **BUT the RESULT fast-path is NOT blind: it runs the ground-truth probe
  first.** The probe costs zero tokens (local fs reads, or one page load for
  the web bucket), so the cheapest path has no excuse to be the least
  verified one — and a trusted type is precisely the one nobody watches any
  more. Observed on the json-cli run: Lithium at 6✓ and Ammonia at 8✓ meant
  ZERO validation calls for the entire run, the read-back probe never fired,
  and a RESULT claiming "exit code 1" shipped while the CLI actually exits 0.
  `checkGroundTruth` returns `{block, contradiction, requiresReview}`;
  `contradiction` is set only on HARD evidence (claimed path MISSING or EMPTY;
  web URL unreachable) — never on console errors or `ok: false`, which are
  judgment calls that would make the fast-path fire false alarms on working
  deliverables. `requiresReview` includes every contradiction plus a
  mechanically MALFORMED probe manifest. Malformation does NOT prove the
  deliverable wrong, so it stays distinct from `contradiction`; but it cannot
  be auto-approved by the exact path that skips the validator, or a trusted
  type keeps earning credit while leaving the deterministic verifier's input
  broken. On either signal the supervisor logs an OVERRIDDEN warning and falls
  through to a full `llmVerdict`, passing the already-computed block via
  `groundTruthBlock` so the probe does not run twice. It never rejects on its
  own: a path-extraction heuristic or health check must not fail a run by
  itself. When the RESULT names no files the probe returns `''` and makes no
  tool calls at all, so trusted subtasks returning plain summaries stay
  exactly as cheap as before. Covered by
  `tests/trust-fastpath-groundtruth.test.ts`, whose clean-manifest cases assert
  ZERO LLM calls — that is the cost-discipline guard. Counters live on `atom_types`; they are bumped by the
  supervise loop's `onApproved` / `onFailed` hooks that L2 and L3 wire to
  `registry.recordSuccess` / `registry.recordFailure`.
- **Patch resets trust.** `AtomRegistry.patch` zeroes `successes` and
  `failures` along with bumping the version — a changed type has to earn trust
  again. `branch` creates a new type that starts at zero.
- **`VALIDATION_SYSTEM_PROMPT` is the ONE system prompt used by every verdict
  call in the whole system.** Deliberately constant so prompt caching
  short-circuits the input bill on repeat validations. Do not inline a custom
  system prompt into a verdict call. Same rule applies to
  `PREFILTER_SYSTEM_PROMPT` and `SKILL_PREFILTER_SYSTEM_PROMPT` (the skill
  prefilter's dedicated prompt — also constant, see the Skills section).
- **Bounded remediation feedback.** A rejection's
  `modifications.additionalContext` is coaching for the NEXT attempt;
  the `REMEDIATION FEEDBACK CONTRACT` block in `VALIDATION_SYSTEM_PROMPT`
  asks for ≤~10 short actionable lines naming the exact artefact at
  fault (SPOQ's measured practice), and `coerceVerdictDefaults`
  truncates anything past `REMEDIATION_FEEDBACK_MAX_CHARS` (1200) with
  an explicit marker — head-truncation, the diagnosis leads. Rationale:
  ballooning diagnostics COACHED RETRIES INTO DEGRADING the artefact on
  the 2026-07-25 run; the prompt asks, the cap enforces. Covered by
  `tests/bounded-feedback.test.ts`.
- Validation params are pinned to `{ temperature: 0, maxTokens: 2048 }`
  (`VALIDATION_PARAMS`, `src/atoms/L2Atom.ts`), prefilter params to
  `{ temperature: 0, maxTokens: 256 }`. Raise either only if you see truncated
  outputs in practice — a Verdict / Prefilter is a small JSON object. (This
  bullet said 512 for months; the code has been 2048 since verdicts started
  carrying reasoning long enough to act on.)
- L3/L2 never pass `tools` or an `executor` on normal plan/validation calls.
  Their explicit LAST-RESORT `selfExecute` fallback is the sole exception:
  supervision has failed and a side-effecting task still needs a deliverable.
  That tool-bearing call MUST use `modelForTier(1)`, never the supervisor model;
  Codex tiers 2/3 are text-only and structurally refuse tool loops. The object
  remains L2/L3 for trace provenance, while the transport role is L1.
- **Happy path tier-by-tier.** L2 happy path (mature L1 child, prefilter
  matches with `!decomposable`) is 100% Haiku — prefilter picks, trust fast-
  path skips validators, L1 does the work. **L3 always pays for one Opus
  call** because the L3 prefilter shortcut is intentionally gone (see
  "Prefilter decomposable hint" above). So a mature-type L3 run is 1 Opus
  (plan) + N Haiku (prefilters + validators short-circuited by trust) +
  L1 tool loop on Haiku. New-type encounters add Sonnet for the L2 plan
  step or Opus for the L3 plan step.
- **Strategy/plan output cap.** L2/L3 `plan()` on the non-fallback path pin
  `maxTokens: STRATEGY_MAX_TOKENS` (**8000**) plus `effort: 'medium'`,
  regardless of the atom type's own configured ceiling. The response is a
  routing JSON pair + a list of subtasks with descriptions. History: 1500 was
  set when L3 emitted skeletal 1-subtask plans and silently truncated
  multi-phase plans on stack tasks (SSR app with SQLite + external API + UI),
  producing unparseable JSON that crashed `planSchema`; 3000 fixed that; 8000
  is the current value because Opus 5 / Sonnet 5 run ADAPTIVE THINKING by
  default and `max_tokens` caps thinking + response TOGETHER — a 3000 cap can
  be consumed entirely by thinking before a single plan token is emitted.
  It is a CAP, not a target: you only pay for what is generated, and
  `effort: 'medium'` keeps thinking volume modest. As defence in depth,
  `expectedOutput` and `aggregation` in `planSchema` are now defaulted
  rather than required, so a future cap-overrun degrades to a parseable
  plan rather than taking the whole run down. The aggregation default is
  `concat` in the shared schema but L3 OVERRIDES it to `sequential` when
  the field was omitted (`L3Atom.plan`, reading the RAW pair so an
  explicit `"concat"` stays honoured): measured 83/83 analysable L3 plans
  emit `sequential`, and `concat` would fan phases out in parallel over a
  shared workspace, dropping the `previousStepSummary` threading —
  the highest-blast-radius choice at exactly the moment we know least.
  Covered by `tests/l3-truncated-plan-aggregation.test.ts`. Fallback/self-exec paths keep the atom's
  full `maxTokens` because they may produce real content.
- **Aggregation modes — `concat`, `llm-synthesize`, `sequential`.**
  The `aggregation.mode` field on a Plan picks how the supervisor
  combines N sub-results AND drives the dispatch shape:
    - `concat` / `llm-synthesize` → subtasks run in PARALLEL via
      `Promise.all`. Use for ORTHOGONAL decomposition (no shared
      artefacts between subtasks). `concat` joins outputs into an array,
      `llm-synthesize` runs one supervisor LLM call to merge.
    - `sequential` → subtasks run ONE AT A TIME with a `for...of` loop.
      Each step's `summary` is threaded into the next step's
      `task.inputs.previousStepSummary` so the next L2/L1 sees the
      narrative state. Aggregation is a no-op LLM-wise: the FINAL
      step's output IS the deliverable, earlier phase summaries are
      preserved in the wrapper summary for trace auditability.
      Use when phases SHARE an evolving artefact (build → extend →
      smoke). The sandbox filesystem is implicitly shared, so phases
      mutate the same on-disk artefact; the threaded `previousStepSummary`
      carries narrative state, not bytes.
  Pick driven by the L3 / L2 plan prompt: PHASED tasks (apps, games,
  multi-step builds) lean toward `sequential`, ORTHOGONAL fan-outs
  (independent research, parallel scrapes) lean toward `concat`. The
  `VALIDATION_SYSTEM_PROMPT` knows about all three modes — sequential
  plans with inter-step dependencies are EXPECTED and must not be
  rejected by Haiku as "structurally broken" (the way parallel plans
  with deps would be). Implementation: the dispatch branch lives in a
  `dispatchSubtasks` private method on both `L2Atom` and `L3Atom`,
  not in `superviseLoop` — the loop is per-subtask, the dispatch
  shape is per-plan.
- **Prompt caching thresholds are load-bearing.** Claude Haiku 4.5's minimum
  cacheable prompt is 4096 tokens, Sonnet 4.6 is 2048. The
  `VALIDATION_SYSTEM_PROMPT` sits at ~5000 tokens — its `== WORKED EXAMPLES ==`
  section is deliberately verbose to clear the Haiku threshold. Trimming the
  examples below ~4100 tokens silently disables caching for every validator
  call (Anthropic does NOT error — `cache_creation_input_tokens` and
  `cache_read_input_tokens` both return 0). Confirm caching is alive via the
  metrics summary's `cache_read` column — it should be > 0 on every run that
  does more than one Haiku call. If it's 0, check the prompt length first.
- **Rolling cache breakpoint in the tool-use loop.**
  `AnthropicLlmClient.complete` places `cache_control: { type: 'ephemeral' }`
  on the LAST `tool_result` block each iteration and CLEARS prior rolling
  markers before adding the new one (`clearRollingBreakpoint`). Anthropic
  caps cache breakpoints at 4 per request — accumulating markers trips a
  `"A maximum of 4 blocks with cache_control may be provided."` 400. The
  two permanent breakpoints are system-prompt and last-tool; the rolling
  third is the one we manage. Long tool loops then cache the entire
  growing conversation at 10% input price — a chess-puzzle run went from
  1.6M uncached tokens to 1.5M cached + 100k new on the same task.
- **One cost formula, one code path.** `estimateCostUsd` in
  `src/core/metrics.ts` is the single source of truth. Anthropic's three
  input counters are DISJOINT — `input_tokens` is ONLY the content after
  the last cache breakpoint, NOT a grand total
  (`total = input + cache_read + cache_creation`). Older formulas that
  subtracted `cache_read` from `inputTokens` produced negative costs on
  cache-heavy runs; do not reintroduce that. Both `InMemoryMetrics.summary`
  and `RecordingLlmClient` import from this one helper.

## Contracts (single source of truth — add shapes HERE)

`src/contracts/` owns every inter-agent interface: the probe-manifest
entry shapes + health check + writer/reader prompt generators
(`probeManifest.ts`), the script stdout envelope + strict parse +
pre-flight gate + scratch-extension policy (`scriptEnvelope.ts`), and
typed witnesses (`witness.ts`, populated onto `Result.evidence` by L1,
propagated by L2/L3 aggregation and consumed by the ground-truth validator).
The first witness revision was write-only: L1 populated the field, every
validator reparsed `output.probes`, aggregation dropped it, and a speculative
`source:"manifest"` variant had no constructor anywhere. Recorded-probe
witnesses now flow end to end; payload parsing remains a legacy fallback, and
the on-disk manifest stays independent supervisor evidence in
`GroundTruthFacts` rather than pretending to be child-reported Result data.
The prompt blocks embed EXAMPLE objects parsed through their schemas at
module load — schema/example drift fails the whole suite. RULE: never
hand-write a JSON shape in a prompt that code elsewhere parses; render
it from a contracts example. Same one-definition rule for the script
INVOCATION ABI (`src/skills/abi.ts`: scratch filename, interpreter,
argv — both dispatch paths import it), the off-scope tool rejection
(`offScopeToolMessage` in `src/core/llm.ts`, used by every transport
loop) and CLI argument parsing (`src/cli/args.ts` — flags anywhere;
unknown commands print help and exit 1, never the silent-help 0). `ledger`
was the last holdout: it still read `argv[0]` directly, so
`ledger --db ./x.db check` failed while the same flag-first form worked in
registry and skills. It now uses the shared parser, and a real-subprocess test
pins both flag orders plus import safety. The probe machinery lives in
`src/atoms/groundTruth.ts` (zero LLM calls by construction); the compile
prompt + generation hash in `src/skills/compilePrompt.ts`; L2Atom
re-exports all the historical names so old imports keep working.

## Observability

- **`InMemoryMetrics` + `MetricsLlmClient`** (`src/core/metrics.ts`) wrap any
  `LlmClient` and record per-call usage. Both examples wrap the Anthropic
  client and print `metrics.formatSummary()` at the end of a run. Use this as
  the ground truth for "did the cost discipline work?" — Opus/Sonnet calls
  should be a single-digit count on any mature-type happy path.
- Cost estimates come from `DEFAULT_PRICES` (approximate USD per M tokens per
  Claude family). Override with a custom `PriceTable` when needed.
- **ONE STORE (`src/core/stores.ts`).** `./atoma.db` holds atom types, their
  version history AND the lifecycle ledger; `./skills/` holds recipe bodies.
  `storeDbPath()` / `skillsDirPath()` are the ONLY resolvers — there used to
  be four copies of the DB rule and they had drifted, because the runner wrote
  `ATOMA_BUILD_DB_PATH` / `./atoma-build.db` while every CLI read
  `ATOMA_DB_PATH` / `./atoma.db`. Each of `cli/registry`, `cli/skills`,
  `cli/ledger` and `viz/server` had grown its own `existsSync('./atoma-build.db')`
  probe to paper over the mismatch, no two written alike, and the viz served
  BOTH files as separate stores in its picker. Same lesson as `usedOrdinals`:
  the drift between two copies of one rule WAS the bug. The split itself dated
  from `research-brief.ts`, deleted when the runner became generic, and its
  store had sat at 0 rows since — while the accidental empty `./atoma.db`
  (created by any bare `npm run registry -- list`) was what every CLI opened
  by default. Per-FAMILY stores were also the wrong axis: atom types and
  skills are deliberately cross-family (`resolveCreationDescription` strips
  task themes precisely so a type earns reuse elsewhere). A second store means
  TENANCY, which is deployment, not a task family.
  MIGRATION RAMP, not a fallback: `storeDbPath` returns `./atoma-build.db`
  only when it has atom types and `./atoma.db` does not. It fires on EMPTY,
  not merely on ABSENT — the first version tested absence, the empty
  `./atoma.db` defeated it, and `tests/run-profile-build.test.ts` failed with
  "no Neuron in the build store", i.e. the silent-loss scenario arriving on
  the one path that still checks. Probing is READONLY and total (a corrupt
  sibling must not throw out of a path resolver). `legacyStoreNotice` prints
  the `mv` so the ramp cannot quietly become permanent. Covered by
  `tests/store-path.test.ts`, three of whose cases fail against the
  absence-only predicate.
- **Lifecycle ledger** (`src/core/ledger.ts`, `npm run ledger -- tail|check`):
  every trust/lifecycle mutation appends an event to the `lifecycle_events`
  TABLE IN THE STORE, from the storage choke points (AtomRegistry
  record*/patch/rollback/mergeInto/compensateCounters, SkillRegistry
  bump/save/promote/demote/refusal/direct-failure/reset). Stage-1
  DUAL-WRITE: counters stay authoritative; `ledger check` projects them and
  flags the IMPOSSIBLE direction (store < ledger = a write path bypassed the
  choke points). Fail-open — a ledger error can never take down a run.
  VALIDATED BY REAL RUNS, 2026-08-10: five burn-in runs on the consolidated
  store wrote 41 events from inside the registry's own transactions, and
  `ledger check` is green with ZERO drift. Two of them were `cli`, chosen
  because that is the only family whose L1 (`Lithium`) owns compiled scripts
  — so it is the only way to exercise DETERMINISTIC DISPATCH, the path that
  writes counters with no validator above it and was therefore the most
  exposed to this change. It fired 4 times, credited the two script skills
  and left the atom-type counters alone, exactly as the contract says. The
  first three runs could not have tested it: the curriculum targeted
  web/http/app and every compiled script lives in the CLI/docs bucket, so
  `deterministic=0` there was structural, not a regression — worth knowing
  before reading a batch's zero as a symptom.
  IT WAS A SIBLING `atoma-ledger.jsonl` until 2026-08-09. Moving it INTO the
  store fixed two things a guard could not:
  (1) THE PAIRING IS PHYSICAL FOR ATOM TYPES. `AtomRegistry` writes through
  its OWN handle, so a `:memory:` registry gets a `:memory:` ledger and the
  events have nowhere else to go. This replaced `ledgerWritesAllowed`, now
  DELETED along with its test — a guard whose condition can no longer arise
  is a test that proves nothing; the property is pinned by "an in-memory
  registry cannot reach the configured store" in `tests/ledger.test.ts`. It
  had bitten TWICE: two throwaway `tsx` scripts left
  `IMPOSSIBLE  Helium: store 2 < ledger 6` permanently, and `viz:demo`'s
  empty `:memory:` registry took the canonical names Hydrogen/Water and put 6
  phantom successes in the real ledger.
  (2) THE COUNTER AND ITS EVENT SHARE A TRANSACTION. `recordSuccess` appended
  BEFORE the `UPDATE`, so a crash between the two left store < ledger — the
  integrity checker could be made to lie by an ill-timed SIGKILL, and runs do
  get SIGKILLed. `patch`/`rollback` events now roll back with their write too.
  The skill side cannot have a transaction (filesystem store), so it gets
  ORDERING: `bump` returns whether a counter moved and the append follows it,
  closing the same window for a `recordSuccess` on a skill with no SKILL.md.
  TWO BYPASSES FOUND while doing this, both now recorded: `mergeInto` moved
  the losers' counters onto the winner with NO event at all (`check` read the
  jump as benign `store > ledger` drift — a mutation the checker was
  structurally blind to), and the skill no-op window above. `type-merge`
  carries the delta so the projection stays exact rather than merely quiet.
  Path: `ATOMA_LEDGER_DB` (defaults to the store; vitest and `viz:demo` pin it
  to scratch — still needed because SkillRegistry has NO store handle and
  resolves a default). `openDb` imports a sibling `atoma-ledger.jsonl` once
  into an empty table (949 events carried across, verified per-kind against
  the archived original), leaving the file in place. REMAINING HONEST GAP: the
  SKILL half of the pairing is still conventional — `check` takes a
  `--skills-dir` — which is the main structural argument for eventually moving
  skill bodies in too. Skill bodies also carry `provenance` ({mechanism,
  model, at} — distilled/revised/compiled) in `_meta.json`, preserved across
  bumps and resets, replaced on rewrite.
- **Registry CLI** (`npm run registry -- ...`): inspect counters, drill into
  any type including version history, sort by success/failure/ratio. Works
  against any SQLite DB via `--db` or `ATOMA_DB_PATH`.
- **TOOL-ERROR LEDGER, measured on the 13 round-4 traces (the latest with every
  fix in place). Read this before "fixing" a tool error.**

  | tool | calls | errors | |
  |---|---|---|---|
  | `record_probe` | 194 | **0** | the whole-line API closed it |
  | `read_file` / `write_file` / `list_files` | 232 | **0** | |
  | `run_shell` | 90 | 6 (7%) | all "is a shell LINE" — FIXED, see below |
  | `edit_file` | 35 | 9 (26%) | 7 double-escapes, and they persist |

  `run_shell` NOW ACCEPTS A WHOLE LINE (`cmd`), exactly as `record_probe` does.
  All six failures were the model passing `grep -n "a phrase" file` as one
  string. `record_probe` had already been fixed for this and leaving
  `run_shell` behind made the two tools disagree about what a command looks
  like — worse than either choice alone. A line needing a shell routes through
  bash (allowlisted, and documented as a sanctioned escape hatch); this
  includes pipes/redirections AND expansion syntax (globs, tilde, braces,
  escapes, leading environment assignments). A plain line is split and still
  allowlist-checked. `{command, args}` still works. A later live recurrence put
  `grep -n "node cli.js" README.md` in `command` with no `args`; that
  unambiguous shape is now normalized through the SAME line parser too. The
  preferred key remains `cmd`, but choosing the legacy field no longer burns a
  failed tool round-trip; executable allowlisting is unchanged.

  THE DOUBLE-ESCAPE IS NOT AUTO-CORRECTED, AND THAT IS A MEASURED DECISION.
  `new_string` carries the same escaping in **7 of 7** cases, so fixing only
  `old_string` writes literal backslash-n INTO the file and fails the next edit
  against it — the message now shows BOTH un-escaped spans. Applying them
  automatically was rejected: **6 of those 7 `new_string`s MIX real newlines
  with escaped ones**, so a blanket un-escape would corrupt any file that
  legitimately contains `"\n"` — a JS source file, for instance. Only 1 of 7
  was provably safe. A retry costs one round-trip (~10s, see the output-token
  entry); corruption costs the deliverable. Revisit only if the mixed fraction
  falls, which would make the un-escape provable.

- **`edit_file`: the double-escape was only 14% of it — MEASURE BEFORE
  BELIEVING THIS ENTRY.** The bullet below was written from a 40-run sample
  and is correct about the mechanism it names, but a full pass over 122
  archived traces (2026-08-10) found **50 `old_string not found` failures and
  the double-escape branch fires on SEVEN**. In the other 43 the argument
  un-escapes to something still absent: the model is not mis-escaping a span
  it holds, it is reconstructing one it half-remembers.
  THE DOMINANT CAUSE IS ONE FILE. **31 of the 50 — 62% of every edit_file
  failure in the corpus — are `.atoma-probes.json`**, and the reason is
  structural rather than sloppiness: it is a JSON record the model must MERGE
  into, and compiled verification scripts rewrite it behind the model's back
  (`node _skill_*.mjs` merging its observations), so a span remembered from an
  earlier tool call is stale BY CONSTRUCTION. Two changes retire that class:
  `record_probe` removes the need to hand-write the manifest at all, and
  `edit_file` now REFUSES that path outright with a message naming the tool.
  Made impossible rather than diagnosed — a better error would still cost a
  wasted round-trip.
  FOR THE REMAINING 17, the same principle the double-escape fix established
  now covers the general case: hand back BYTES, not instructions.
  `findNearestSpan` tries a whitespace-insensitive match (unique only — an
  ambiguous hit would echo a span the model did not mean), then the longest
  leading slice of the argument that actually occurs, and echoes the file's
  real content for that region. Only when nothing resembles the span does the
  message fall back to "re-read the file", which is then the honest advice.
  WHAT COULD NOT BE VALIDATED, recorded so nobody quotes a number that does
  not exist: these 50 historical calls are NOT replayable as a regression
  suite. The file state at the time depended on shell side effects the trace
  does not record, and a replay attempt reported an implausible 50/50 before
  being discarded. `tests/edit-file-nearest-span.test.ts` therefore constructs
  cases matching the observed failure SHAPES rather than lifting them.
- **`edit_file` proves the double-escape instead of describing it.** The
  `old_string not found` message already named WRONG ESCAPING as the common
  cause, and the model kept re-sending the same broken span. Measured over the
  last 40 runs (2026-08-09): **9 of 10 such failures carried two-character
  `\n` sequences** where the file has real newlines — six runs across two
  consecutive days, which is exactly the recurrence AGENTS.md requires before
  acting. So when the defect is PROVABLE for the call in hand — un-escaping
  the argument (`unescapeJsonish`, only the observed sequences, deliberately
  not a JSON parser) matches EXACTLY ONCE — the error now hands back the
  verbatim bytes to copy, bounded by `EDIT_SPAN_ECHO_CHARS` (600). Two matches
  means we cannot prove which span was meant, so it falls back to the generic
  message rather than dressing a guess as a diagnosis. The lesson generalises:
  a diagnosis the model must act on from memory is weaker than the bytes it
  needs. Covered by `tests/edit-file-double-escape.test.ts`, whose fixtures
  are taken from real failing calls.
- **The friction report carries RECENCY (`lastSeen`), or its own action rule
  is unusable.** The report is a lifetime tally, so a fixed defect keeps
  topping it: the favicon 404 held the first four rows the morning AFTER it
  was fixed (24 occurrences across 16 pre-fix runs, 0 in the post-fix run).
  And the rule below — "act only on a signature recurring across two
  CONSECUTIVE batches" — cannot be evaluated from a report with no dates. The
  `last` column makes it checkable at a glance; it is what surfaced the live
  `edit_file` signature above from under a pile of already-fixed noise.
  SUB-DAY RESOLUTION is not cosmetic — the column shipped with day
  granularity and misled its author within the hour. The favicon rows read
  `today` and therefore looked live, when in fact every one came from runs
  started at 04:39–05:10 and the fix had landed at 09:01; the post-fix run
  had zero. On the day a fix lands, "today" cannot separate "before it" from
  "just now", which is precisely when the distinction decides whether you act.
  `ageLabel` now reports minutes, then hours, then days, and is pinned by
  `tests/friction-age.test.ts`.
  THE CLI MODULE IS IMPORT-SAFE. That same test imports `ageLabel` from
  `src/cli/friction.ts`; the file used to call `main()` unconditionally, so a
  fresh checkout — where `runs/` is absent by design — hit `process.exit(1)`
  during test collection. The developer machine's ignored `runs/` directory
  masked the failure and made 1200+ tests look reproducible when they were
  not. The entrypoint now uses the same direct-execution guard as burnin and
  curriculum, and a subprocess test imports it with `ATOMA_RUNS_DIR` pointed
  at a missing path.
- **Friction report** (`npm run friction`, helpers in `src/viz/friction.ts`
  — pure, mirrored on `stats.ts`): aggregates recurring TOOL-LOOP failure
  signatures from the traces the viz already persists (zero LLM, zero
  runtime imports — a reader). Exists because recovered in-loop friction is
  invisible to the learning machinery (no rejection → no event skill, no
  escalation → no body revision) and invisible failures repeat every run.
  HARD tier = executor threw; SOFT tier = failure-shaped results and may be
  task-intrinsic (deliberate error-case probes land there); the
  `distinctArgs` column unmasks pseudo-recurrence (one error text, N
  unrelated task-specific args — validate_html's `smoke check failed`).
  Signatures normalise away everything run-varying (paths→basename, quoted
  filenames→`"<file.ext>"` keeping the extension, `:LINE`→`:#`, ≥2-digit
  runs and hex ids→`#`, leading `[harness tags]` stripped). ACTION RULE:
  a signature earns action only when it recurs across two consecutive
  batches AND its root cause lives INSIDE the sandbox in artefacts the L1
  can read; host/repo/harness causes are environment defects — fix
  structurally. Known blind spots (accepted): claude-cli off-scope calls
  never reach an executor (no VizToolEvent), deterministic dispatch runs
  outside LLM loops (its sensor is `directFailures`). Covered by
  `tests/friction.test.ts`, whose normalisation cases are the adversarial
  review's literal counter-examples.
- **POST-RUN ERROR CLOSURE — no next live run before this is complete.**
  After EVERY burn-in/manual product run, inspect the trace, raw task log and
  friction report and enumerate: every L1 tool executor error, failure-shaped
  tool result, LLM error/timeout, validator rejection, trust override,
  deterministic fallback, malformed/tolerantly-wrapped result and lifecycle
  call that failed. Classify each item explicitly. A deliberate negative probe
  (CLI exit 1 expected by the test, HTTP 400/404 expected by the spec) is
  successful evidence, not an error to erase. Every REAL error must be fixed at
  its owning layer — artefact/recipe/prompt/tool/runtime — and covered offline
  before another live run starts; a green delivery banner does not close errors
  recovered inside the loop. The two-consecutive-batch rule above still governs
  adding a BROAD generic runtime mechanism from a noisy signature; it does not
  license leaving a concrete recipe/tool contract defect unfixed. If no safe
  generic correction is justified, record the exact one-off classification and
  targeted correction rather than silently moving on.
- **A burn-in batch needs the machine to itself.** Beyond the source-edit
  rule below, do not run heavy work (test suites, Puppeteer-spawning
  experiments, another batch) alongside one: measurements taken on a
  loaded machine are not comparable with the rest of the curve. Measured
  twice on 2026-08-08 — 126 leaked Chrome processes turned a 193s task
  into 437s and took two later runs down with them; and a web batch
  launched while the local test suite was running produced two runs whose
  Opus plan call alone ran 932s and blew the 900s budget with nothing to
  show. Both sets of rows were purged as noise. Corollary for reading
  traces: a slow call is not a hung one — the inactivity deadline
  correctly stays quiet while the model streams, and the run budget is
  the backstop for "too slow".
- **NEVER edit `src/` while a burn-in batch is in flight.** The harness
  spawns a FRESH `tsx src/cli/build-app.ts` process per task, so
  each task compiles the source as it stands AT ITS START — an
  intermediate edit becomes the runtime for every task that follows.
  Measured (2026-08-08, curriculum batch): a mid-edit state where
  `bumpDeadline()` was called outside its closure was picked up by the
  next task and threw `bumpDeadline is not defined` on EVERY tool call,
  blocking all file I/O; the run limped to a degraded fallback
  deliverable and its CSV row is noise, not signal. Typecheck catching
  the error a minute later did not help — the process had already
  loaded it. Docs (AGENTS.md), task JSON and the CSV are safe to touch
  mid-batch; anything under `src/` or `skills/` is not.
- **Burn-in harness** (`npm run burnin`, `src/cli/burnin.ts`): runs a task
  batch through the real `run:build` path (one clean workspace per task,
  child spawned in its own process group and group-killed after
  `✓ build finished` — delivered runs that started a server idle on purpose)
  and appends per-run economics to `burnin/results.csv`: cost, duration,
  calls per model tier, deterministic phases, escalations, learned skills,
  trace filename. `provider` and `other_calls` are appended columns: historical
  Claude rows leave them blank/zero, while cross-provider rows no longer hide
  Codex/GLM calls outside O/S/H (the live hybrid read 5 total as O0/S0/H3
  before this). Non-Anthropic batches state that `cost_usd` is an estimated
  API-price equivalent, not local/subscription billing. Every batch extends
  the cost-decay curve AND matures the skill/trust counters — the harness IS
  usage; the viz row renders both provider and `+other` calls. Task file:
  `burnin/tasks-default.json` (`{tasks: [{id, family, goal}]}`); logs under
  `burnin/logs/` (gitignored), CSV committed. Rendered by the viz's
  **Burn-in** tab (`/api/burnin` reads the CSV, override with
  `ATOMA_BURNIN_CSV`): per-family stat cards, an SVG cost-per-run scatter in
  batch order (x axis = experience), and a row table where clicking opens
  the run's full trace in the Runs view. Parsing/summary helpers are pure
  and exported — covered by `tests/burnin.test.ts` on real log excerpts.
- **LIVE PRODUCT ITERATION, 2026-08-12 — delivery banners were not the
  score.** A curriculum batch retested the three failed families from the
  mature store: web $0.4867/14 calls, HTTP $0.3848/16, app $0.2233/13, all
  reported delivered and learned zero new skills (traces
  `2026-08-12T11-09-12-626-0fd1b899`,
  `2026-08-12T11-15-15-409-ed36af8c`,
  `2026-08-12T11-20-46-005-04669100`). Independent execution found three
  different truths. The web calculator passed real DOM edits and arithmetic
  with zero console errors. The HTTP habits API passed create/log/streak, but
  accepted an impossible date and a whitespace-only name — kept as a WATCH item,
  because the user goal did not specify validation and one broadening is not
  enough to change a generic API recipe. Its manifest also contained
  `node server.js` at exit 1: record_probe had timed out the deliberately
  long-running server and a note called that full verification. The HTTP
  writer prompt now forbids server-process shell probes; only endpoint
  observations or a finite harness are evidence.
  The app run exposed the real defect: two zero-LLM phases made it look cheap,
  but trusted `verify-cli-argv-exit-codes` replaced the phase that was supposed
  to ADD `--help` and input validation. The plan had said only "harden the
  existing CLI", so `scriptCanServeSubtask` had no filename target to compare
  and correctly followed its UNPROVABLE⇒OFFER safety rule. The next trusted
  script then packaged the generic `index.js` as a product literally named
  `node`; both shortcuts were credited. Fixes are upstream: both plan prompts
  now require exact output paths on mutating subtasks, and the compile prompt
  says interpreter/generic launch tokens are never product names and must
  refuse when no semantic name is derivable. The live
  `package-and-document-cli` body was patched on the same rule and reset 6/0 →
  0/0 because trust is body-bound.
  A fresh inventory-reorder regression
  (`2026-08-12T11-30-56-844-9376913b`) proved the correction: Opus wrote
  "Harden reorder.js in place"; the read-only verifier was not dispatched;
  the L1 implemented help plus numeric validation; the independent scorer
  passed happy/help/string-price rejection and the run had ZERO friction
  events. Honest cost: $0.4522/22 calls, versus the broken $0.2233/13-call
  shortcut. Correctness cost money; the earlier saving was work not done, the
  same lesson as benchmark round 5.
  Environment check before the batch also found 51 orphaned
  `build/app/server.js` listeners (452 MB, 4–6 days old), all predating the
  burn-in SIGTERM grace fix of 2026-08-08. They were removed; all four new runs
  left zero workspace servers and zero tracked Chromium processes. Treat that
  as historical cleanup, not a live regression unless a future batch leaks one.
- **SECOND LIVE ITERATION, 2026-08-12 — two watch items resolved by data.**
  A lifecycle-targeted batch ran CLI packaging ($0.2240/12 calls), recipe API
  lifecycle ($0.4231/21, including 3 stale-refusal compile calls), and exposed
  widget smoke ($0.2943/12), traces `2026-08-12T11-41-10-936-6c6fd129`,
  `2026-08-12T11-43-53-850-5ab42e5c`,
  `2026-08-12T11-48-44-036-ee273111`. All three delivered with ZERO friction
  events; the earlier Control+a/selector errors therefore did not recur and
  earn no change. Independent scoring again mattered. The packaging artefact
  was correctly named `csv2json` and moved the corrected live script to 2/0.
  The recipe API still accepted a blank title and numeric array member — the
  second consecutive batch with syntactically valid but semantically invalid
  HTTP payloads accepted — and its README pasted the bound port into durable
  examples. The widget worked, but all five manifest entries used scenario
  labels (`probe:"reset_after_increments"`) instead of the literal
  `probe:"web"`; `validateProbeManifest` inferred the web shape from `smoke`
  and returned clean, contradicting the schema.
  The resulting corrections are structural: canonical HTTP prompts and both
  live HTTP recipes now state that JSON parsing is not field validation and
  require a wrong-type/blank-field probe; all HTTP planning/worker paths require
  `<port>` placeholders (including `LISTENING_ON_PORT=<port>`) in durable docs;
  the manifest checker rejects any explicit non-http/non-web `probe` value and
  the web writer plus live smoke recipe name the literal.
  Fresh regressions then delivered an event-registration API
  ($0.4953/18, `2026-08-12T11-58-56-882-370b3313`) and mood tracker
  ($0.3288/14, `2026-08-12T12-05-03-167-4f1ddc20`). External probes confirmed
  blank/wrong-type registrations return 400, every durable URL uses `<port>`,
  the mood state/reset behavior works, and its manifest passes the tightened
  checker. The README's illustrative stdout block still pasted
  `LISTENING_ON_PORT=59420`; the shared guidance now names marker placeholders
  explicitly too, but that last wording has NOT been re-measured. As a
  deterministic backstop, HTTP-child read-back flags numeric loopback URLs or
  LISTENING markers in durable markdown/text and overrides trust for validator
  review; placeholders stay on the fast-path, and a task-explicit fixed port
  remains approvable. Two recovered one-off friction events (missing README
  before it was authored; one malformed smoke variable) do not recur and earn
  no change.
  All five runs left zero workspace servers/Chromium children; ledger remained
  exact. The live package script was also replayed offline: semantic
  `reorder.js` produced package/bin `reorder`, while generic `index.js` refused
  before writing package.json — the intended validated-LLM fallback.
- **THIRD LIVE ITERATION, 2026-08-12 — the dispatch gate had two definitions
  of "target".** Four fresh CLI packaging runs matured and exercised the
  corrected `package-and-document-cli` script: slug-map $0.2846/18 calls,
  pathcase $0.1715/12, titlecase $0.2014/12 and sentenceclip $0.1777/15
  (traces `2026-08-12T12-16-38-476-e3ccbb3c`,
  `2026-08-12T12-20-12-070-7c28e336`,
  `2026-08-12T12-26-57-476-ab29b9b8`,
  `2026-08-12T12-30-54-526-cc0bab45`). The first run carried the script past
  trust. On pathcase, deterministic execution correctly wrote package.json
  and README.md, but the post-dispatch byte gate rejected it because
  pathcase.js — named as an INPUT — was unchanged. After snapshotting only
  `subtaskMutationTargets`, titlecase still false-fell back because its task
  explicitly said "no index.html" and the existence gate used EVERY named
  path, including negations. The match-time filter had already solved both:
  it reasons over proven OUTPUT targets. The downstream gate now uses the same
  target set for mutating tasks; read-only tasks keep the all-named existence
  rule after dropping paths mentioned ONLY under a negation. Regression tests
  carry both exact shapes: package/README/input/no-index for mutation, and
  "Verify config.json; no index.html" for read-only dispatch. A positive
  mention elsewhere still wins over a later "do not rewrite" clause.
  Sentenceclip then produced the first clean deterministic packaging dispatch:
  `deterministic=1`, no fallback, semantic package/bin `sentenceclip`, exact
  recorded examples, independent happy/error scorer green, zero friction and
  zero leaked children. This is the zero-token path paying on the maintenance
  phase it was built for; the run still made 15 LLM calls for planning and the
  novel CLI build, so it is a PHASE saving, never a zero-cost run.
- **FOURTH LIVE ITERATION, 2026-08-12 — quantified requirements keep their
  section scope.** Two file-scribe tasks delivered stream-batch docs/config
  ($0.3509/19 calls, trace `2026-08-12T12-35-51-650-a8dacba1`) and three
  operations guides ($0.2174/13,
  `2026-08-12T12-40-12-661-ded78cb0`). The first task's wording ("Overview,
  Installation and Usage headings") was instrument-ambiguous and produced
  `## Installation and Usage` plus `## Usage`; that is a task-authoring defect,
  not evidence for a runtime change. The second artefact independently passed
  all requested structures, but trusted `verify-markdown-section-structure`
  false-failed all three: it read "at least three bullets under Steps" as
  "every H2 has three bullets", demanding bullets in prose-only
  `## When to use`, then paid the full fallback. Its compiled body now binds a
  numeric item requirement to the nearest explicitly named `##` heading; the
  exact three real files replay clean offline with `itemRequirementSection:
  "Steps"`. The compiler prompt carries the general quantifier-scope rule, and
  the live script reset 7/0 → 0/0 because its body changed.
  Distillation also created `replay-recorded-probes-from-manifest` at 0/0,
  duplicating the trusted `replay-recorded-shell-probes` while reintroducing
  the forbidden `; echo EXIT=$?` command decoration. It was dropped
  immediately; `verify-config-and-doc-headings` was kept as a genuinely
  distinct config+docs verifier. One recovered whole-line grep error occurred
  in the ambiguous first task; no consecutive-batch signature, no harness
  change. Both runs left zero leaked children and ledger projection stayed
  exact.
- **FIFTH LIVE ITERATION, 2026-08-12 — provider failures are not product
  failures, and narrative is not an action.** Claude subscription hit its
  explicit weekly limit during task 1 of a four-task markdown batch. Because
  earlier calls had already spent $0.1513, and each later task paid a
  prefilter/plan before receiving the same denial, the old fast+zero-spend
  heuristic appended FOUR environmental failures instead of aborting. Those
  rows were removed. `looksLikeProviderLimitFailure` now recognises definitive
  weekly/monthly/quota/credit/subscription denials from the raw child log and
  aborts BEFORE appending the first row; transient 429 text stays excluded.
  Replayed against the real GLM subscription 403 after the fix: exit 1,
  header-only CSV (one line), no phantom row.
  Provider experiments then used separate CSVs. Ollama Cloud GLM 5.1 returned
  403 subscription-required. Local DeepSeek 7.6B returned an incomplete,
  structurally wrong plan; local 32B ran ~10 minutes at 70% machine memory and
  lost the fetch without one response. A hybrid with Codex subscription on
  L2/L3 and DeepSeek 7.6B on L1 first hard-400ed because Ollama silently ran
  its 131K-capable model with `num_ctx=4096` while the real L1 prompt was 7520
  tokens. Ollama requests now pin 32768 by default
  (`OLLAMA_CONTEXT_LENGTH`, minimum 8192). The re-run reached 17 calls and
  proved Codex routing, but the 7.6B L1 made ZERO tool calls, fabricated work,
  and eventually failed missing-file validation.
  That failed subtask still distilled two task recipes and one event recovery
  from prose alone — exactly contrary to the learn prompt's "ACTIONS
  demonstrate" rule. L1 now attaches a bounded `{name,ok}` list from the
  transport's real tool observer to `Result.toolCallResults`; task-skill and
  event-skill distillation both require at least one successful observed
  action. The three 0/0 provider-failure skills were dropped. Mock tests invoke
  the observer explicitly, and narrative-only recovered runs pin that neither
  learning path fires. No available local model completed the pipeline, so
  further Ollama attempts are stopped until a stronger tool-capable model or
  cloud entitlement exists; failed provider rows remain isolated in
  `burnin/results-ollama.csv` / `burnin/results-hybrid.csv`, never the Claude
  curve. After removing the quota-denial noise, the main curve's latest 10 are
  10/10 delivered at $0.2945 mean / $0.2943 median, one escalation and one
  deterministic phase (latest 20: 20/20 at $0.3576 mean, seven deterministic).
- **ADVERSARIAL FOLLOW-UP ON THE LIVE ITERATIONS, 2026-08-12.** Seven edge
  cases survived the first fixes; all reproduced before changing code.
  (1) The planner taught "harden" while the mutation detector omitted
  build/create/document/harden; its vocabulary now covers every prompt example.
  (2) A mutating subtask with no provable output target now falls back BEFORE
  script execution — otherwise there is no deliverable gate to justify credit.
  (3) Runtime before/after reads preserve full paths (`docs/README.md`);
  basenames remain only for static script-capability comparison.
  (4) Negation is clause-local: "no index.html" is excluded, "no console
  errors in index.html" still targets the file, and any positive mention wins.
  (5) L1 tool observations classify `{ok:false}`, structured `error`, and
  non-zero exit codes as failed actions rather than treating "did not throw" as
  success. Production L1 results always carry the bounded action list; L2
  mechanically rejects a result with zero successful observed actions BEFORE
  trust or LLM validation. Legacy/test producers may omit the field.
  (6) Provider-limit detection yields to `✓ build finished`, so arbitrary
  artefact text cannot suppress a delivered CSV row; provider labels are
  canonicalized through `resolveBaseProviderKind` and include routed providers.
  (7) `record_probe` accepts `supersedes:"<exact old cmd>"`, removing one
  accidental stale probe only after its corrected replacement ran.
  The hybrid experiment's one false Lithium success and one false Ammonia
  success were removed with transactional negative-only
  `compensateCounters`; two ledger events keep projection exact. Burn-in now
  records task-skill and event-skill learning separately. Targeted suites cover
  all seven directions, including the exact live phrases.
- **SIXTH LIVE ITERATION, 2026-08-12 — non-Anthropic production gradient
  works.** With Claude quota exhausted, the validated replacement is
  L3=`codex:gpt-5.6-sol`, L2=`codex:gpt-5.4-mini` through ChatGPT subscription
  (`OPENAI_API_KEY` deliberately absent), and L1=`zai:glm-4.5-air` for cheap
  prefilters, validators and the tool loop. Base Ollama is only the unused
  fallback because every tier is explicitly routed. The first CLI smoke
  delivered in 213s / 17 calls / $0.1479 estimated API-equivalent; independent
  execution confirmed exact line/word/non-whitespace counts plus missing-file
  failures. A four-task markdown batch then delivered 4/4 at $0.0964–$0.1282,
  every one independently scored for exact headings and item counts. No
  escalation, learning or leaked process occurred; friction was zero except
  the corrected markdown verifier legitimately rejecting one initial file that
  used the wrong list shape, after which the LLM fixed it. The verifier is now
  trusted again at 4/0. Results live separately in
  `burnin/results-openai-zai.csv`; all calls appear under `other_calls` and the
  displayed cost is explicitly an estimate, not ChatGPT subscription or Z.ai
  billing.
- **SEVENTH LIVE ITERATION, 2026-08-12 — classify the work before trying to
  parallelise it.** The four fresh markdown runs each had two L1 execute calls
  and a sequential L3 plan: author the files, THEN verify those same files.
  Running those phases concurrently would be a race, not an optimisation. The
  intended zero-LLM verifier had already reached 4/0 trust, yet a same-task
  measurement still took 275s / 12 calls / $0.1153 estimated and reported
  `deterministic=0`. The direct-dispatch log proved why: the runtime mutation
  guard read the verification planner's contingent "fix then re-run if any
  requirement fails" as an unconditional mutation. After that wording was
  covered, the next plan independently said "shell-based document probe" and
  "without creating browser or server artefacts"; the lexical detector read
  `document` as a verb and ignored the negation, blocking dispatch again.
  `subtaskMutatesFiles` now removes bounded conditional-repair clauses,
  negated mutation verbs and nominal `document probe/check/...` uses before
  applying the unconditional mutation vocabulary. Real writes remain gated:
  "fix README.md", "document the API", and an independent update clause all
  still classify as mutating. The third same-task run took the intended
  deterministic path: 100s / 9 calls / $0.0860 estimated, one zero-LLM phase,
  no friction, and both output files independently scored correct. That is
  −64% wall time and −25% estimated cost from removing a false fallback, with
  no unsafe concurrency and no change to the dependent phase boundary.
- **EIGHTH LIVE ITERATION, 2026-08-12 — recovered errors are still product
  defects.** A same-stack L3 power probe produced more signal than its headline
  cost comparison. With L3=`gpt-5.4-mini`: simple markdown delivered in
  86s/9 calls/$0.0492 estimated with one deterministic phase; CLI delivered in
  254s/17/$0.1197; HTTP failed at 901s/20/$0.2649; web delivered in
  496s/19/$0.2320. Independent execution passed every delivered artefact. The
  completed strong-L3 controls then delivered CLI in 293s/12/$0.1456 and HTTP
  in 663s/10/$0.1805; the web control was intentionally interrupted and its
  partial trace retained. Traces, in order:
  `2026-08-12T17-23-36-529-3e02f6fd`,
  `2026-08-12T17-25-34-844-babada5a`,
  `2026-08-12T17-29-49-282-7b582f95`,
  `2026-08-12T17-44-50-954-4949938c`,
  `2026-08-12T18-02-39-916-e520457c`,
  `2026-08-12T18-07-33-202-0d89591c`, and partial
  `2026-08-12T18-18-38-877-38767f20`.
  The model comparison is NOT clean enough for a default change: the first
  arm warmed stale lifecycle stamps. Plan anatomy is still decisive. Mini
  split CLI/HTTP/web into 3 phases each; strong used 2 in every corresponding
  plan (including the interrupted web trace). The extra phases shared one
  evolving artefact, so concurrency would be a race; coalescing coupled work
  is the optimisation. Mini's CLI did one thing better: it chose semantic
  `csv2json.js`, enabling direct packaging. Strong chose generic `index.js`;
  the packaging script correctly refused to invent a product name and paid
  the LLM fallback. Planning guidance now requires semantic CLI entry names.
  THE LARGEST DEFECT WAS OUTSIDE PLANNING. Mini HTTP spent 275.7s in two
  post-approval compile calls; strong HTTP spent exactly 240.0s in one. Two
  calls returned zero tokens at the old 240s ceiling, and the mini run then
  lacked budget for its final phase. Across all 50 completed post-approval
  calls in the trace corpus, the slowest success was 100.3s. The cap is now
  120s, and transport errors receive a current-generation refusal stamp so
  they cannot consume every subsequent run; the two live casualties were
  stamped explicitly.
  TOOL closure found repeated harness gaps rather than harmless model noise:
  HTTP L1s recorded long-running `node server.js` commands (30s timeout +
  dead port), then improvised curl/node-e clients (`http.delete`, malformed JS,
  sleep/pkill). `fetch_url {record:true}` now machine-appends ordered HTTP
  observations; `record_probe` refuses servers and curl before spawning.
  File-scribe API docs forbid live probing and numeric ports, the CRUD recipe
  excludes health-only checks, web smoke guidance copies exact selectors, and
  script-skill scaffolding is explicitly never re-probed after deletion.
  The two observed unambiguous pseudo-final tools (`return` and the
  XML-corrupted output shape) are normalised directly into assistant JSON
  without an error round-trip; other off-scope calls still reject with exact
  final-answer coaching. Tolerant non-JSON L1 results are mechanically rejected
  before trust. Intentional empty negative-test fixtures are no longer
  contradictions when a recorded non-zero probe corroborates them.
- **NINTH LIVE ITERATION, 2026-08-12 — rejecting the wrong tool is not the
  same as removing the error.** The corrected recipe CRUD regression delivered
  in 379s/19 calls/$0.2307 estimated (trace
  `2026-08-12T19-04-08-195-d26c6387`); independent execution passed list,
  semantic-invalid 400, create/read/delete/404, both durable port placeholders
  were present, and no process leaked. It nevertheless carried TWELVE hard
  tool errors: five correctly-rejected record_probe server/curl calls, six
  ambiguous edit_file spans (the same call repeated four times), and one
  read_file of the manifest before it existed. The final workspace had NO
  manifest at all: every fetch_url omitted `record:true` despite the plan
  promising it. A guard that prevents corruption but still burns a tool turn
  has not closed the defect.
  The correction is mechanical. `record_probe` is no longer declared to HTTP
  L1s. The executor view passed ONLY to L1 automatically adds `record:true` to
  every loopback fetch unless explicitly disabled; supervisor probes retain the
  original read-only executor. Thus ordinary fetch_url calls create the
  manifest before any read and the model cannot choose curl/server recording.
  Ambiguous edit_file errors now include bounded, line-numbered REAL contexts
  for each occurrence plus the explicit replace_all path — the same
  bytes-not-instructions rule that fixed old_string-not-found. Offline
  regression covers both directions before another live run.
- **TENTH LIVE ITERATION, 2026-08-12 — the HTTP error closure reproduced.**
  The exact recipe CRUD task re-ran after the capability-level correction and
  delivered in 352s/13 calls/$0.2015 estimated (trace
  `2026-08-12T19-17-26-480-9e46a3b5`) versus 379s/19 immediately before it.
  The exhaustive event audit found ZERO tool/LLM errors, rejections, trust
  overrides, fallbacks or withheld credits; friction was 0. The L1 made normal
  fetch_url calls without explicitly requesting recording, yet the final
  manifest contained 33 ordered entries, all valid HTTP shape. Independent
  execution passed empty-list 200, semantic-invalid 400, create 201,
  read/delete 200 and post-delete 404; README carried both `<port>`
  placeholders and no numeric loopback port. No child process remained. This
  is the required distinction between a guard that rejects five bad calls and
  a design that makes those calls unreachable.
- **ELEVENTH LIVE ITERATION, 2026-08-12 — a green final state can still have
  unproven intermediate behavior.** The strong-L3 habit widget delivered in
  244s/13 calls/$0.1355 estimated (trace
  `2026-08-12T19-24-49-947-76e5a9c3`), versus 496s/19 under mini L3, and left
  no browser process. Exact selectors were fixed (`#incrementBtn`,
  `#resetBtn`), but post-run closure found three real errors: the initial class
  assigned `this.streak` while defining getter-only `get streak()`, one
  identical edit_file no-op, and a false "smoke non-deterministic" rejection.
  The latter mixed outcomes from BEFORE and AFTER the source edit because the
  tracker keyed only on smoke text. The final artefact independently passed
  increment-to-3, `streak-3`, color change, reset-to-0 and zero console errors,
  but carried a duplicate method definition and its one manifest entry observed
  only the state AFTER reset — it did not prove the intermediate styling it
  claimed.
  Corrections: stuck/oscillation history now keys on smoke + loaded response
  source revision, so fix-and-retry is normal convergence while real same-page
  flakiness still trips. Identical edit_file calls return an explicit
  `unchanged` no-op (which does NOT count as a successful action) rather than a
  hard tool error. Shared web guidance and both live widget recipes require one
  writable backing field, unique method/getter names, and a smoke IIFE that
  captures milestone state BEFORE reset plus final reset state. A rerun is
  required before this class is closed.
- **TWELFTH LIVE ITERATION, 2026-08-12 — zero friction is necessary, not
  sufficient evidence.** The exact widget rerun delivered in
  181s/13 calls/$0.1025 estimated (trace
  `2026-08-12T19-38-25-791-d9beb151`), with ZERO tool/LLM errors, rejections,
  fallbacks, friction or leaked children. The source used one `_streak` backing
  field and no duplicate class method; independent browser execution passed
  streak 0 → 3 (`streak-3`, changed color) → reset 0. But both validate_html
  calls and the manifest observed only the post-reset state. Their diagnostic
  object literally returned `hasStreak3Class:false` and was accepted because
  the old `isSmokeOk` treated every object without an `ok` field as truthy.
  The internal banner therefore over-claimed conditional-style verification.
  `isSmokeOk` now requires explicit `ok === true`; when omitted, any false
  boolean recursively fails the smoke. Guidance and live recipes require
  `{ok: <all milestone+reset assertions>, milestone, reset}`. Expected-false
  diagnostics remain expressible under an explicit true aggregate. A further
  rerun is required; delivered+friction-zero did not close this evidence gap.
- **THIRTEENTH LIVE ITERATION, 2026-08-12 — `ok:true` cannot overrule its own
  false assertions.** The next exact widget rerun delivered in
  303s/13 calls/$0.1362 estimated (trace
  `2026-08-12T19-47-01-991-f7837f7c`) and had no hard tool error or leaked
  child, but two soft failures remained. The initial artefact repeated the
  getter collision on a different field (`statusText`), and the verification
  phase again guessed `#increment-btn`/`#reset-btn`. More importantly, its
  final recorded smoke set `ok:true` while EVERY nested transition assertion
  (`beginner`, `building`, `hot`, `onFire`) was false; the aggregate checked
  only initial/reset state and ignored the milestone object. Explicit `ok`
  alone therefore remained forgeable by omission.
  The smoke contract now treats EVERY boolean field as an assertion: any false
  value fails even beside `ok:true`. Expected-false state must be returned as a
  raw value plus a positively named true comparison. Selector resolution
  accepts a guessed id spelling only when removing hyphen/underscore and case
  yields exactly ONE real DOM id, recording a warning and the exact resolved
  selector; ambiguous/non-id selectors still fail. Widget guidance now
  requires enumerating every class getter and proving no assignment/increment
  targets that getter name before serving. Another exact rerun is required.
- **FOURTEENTH LIVE ITERATION, 2026-08-12 — internal validation failure must
  outrank trust.** The strict-boolean rerun delivered in
  210s/13 calls/$0.1056 estimated (trace
  `2026-08-12T19-58-03-242-94cd8ff0`). Getter/backing-field generation was
  clean and selector spelling was uniquely normalised without a failed
  interaction. The stricter tool correctly rejected the final smoke:
  `ok:true` sat beside six false class assertions. L1 correctly prefixed its
  result with `[INTERNAL VALIDATION FAILED]` — and the trusted Hydrogen result
  was nevertheless approved without a validator, so the run banner still said
  delivered. The mechanism designed to surface the failure was inert on the
  mature path.
  L2 now mechanically rejects that prefix BEFORE trust/LLM validation, exactly
  like the non-JSON and no-successful-action gates. `validate_html` also
  preflights interaction sequences: repeated changes followed by reset are
  refused when the smoke neither drives nor snapshots a milestone before
  reset (explicit app history is also acceptable). This prevents spending a
  browser round on evidence that is structurally incapable of proving the
  intermediate state. A further exact rerun is required.
- **FIFTEENTH LIVE ITERATION, 2026-08-12 — the trust fix worked, then exposed
  the next missing dimension.** The exact web rerun delivered in
  434s/14 calls/$0.1670 estimated (trace
  `2026-08-12T20-08-45-202-347ddfaa`) after the internal-failure gate forced a
  real retry; one legitimate event skill was learned:
  `recover-final-browser-validation-failed`. The final manifest now contained
  honest initial → increment-3 → reset snapshots with `ok:true`, and no process
  leaked. Five recovered validate_html failures explain the wall time: three
  reset-erasure preflights, one real false assertion, and one nested-false
  rejection. The preflight initially failed to recognise
  `afterIncrementStreak` because its snapshot regex required a word boundary;
  external interactions also polluted the "initial" state before a smoke that
  already drove its own transitions.
  More importantly, the final snapshots proved counters/status but omitted the
  conditional CSS class/color the task explicitly required. L1 can no longer
  rely on trust for that omission: L2 now mechanically requires a recorded web
  probe whose smoke AND smokeResult carry class/style/color evidence whenever
  the subtask names styling. Self-driving smokes automatically ignore external
  interactions (with a warning), and suffixed `afterIncrement*` snapshot names
  are recognised. The recovery skill is kept: its trigger and body describe the
  exact generic failure class and it did not cause the rejection.
- **SIXTEENTH LIVE ITERATION, 2026-08-12 — browser evidence was correct while
  its durable encoding was not.** The styling-gated rerun delivered in
  267s/13 calls/$0.1125 estimated (trace
  `2026-08-12T20-26-07-137-fbe59762`). One initial reset-erasure preflight
  fired, then the retry produced the exact required evidence:
  `milestoneStreak=3`, `milestoneClass="streak-display streak-3"`,
  `resetStreak=0`, `resetClass="streak-display streak-0"`, all inside the
  aggregate `ok`; independent browser execution matched it, source had no
  duplicate class method and no child leaked. The remaining durable defect was
  outside the result: `.atoma-probes.json` stored `expected` as an OBJECT,
  while `webEntrySchema` and the replay prompt require a JSON-ENCODED STRING.
  `validateProbeManifest` failed to check that optional field, and the web
  ground-truth branch never health-checked the manifest, so both advertised
  one-definition guarantees were false in this direction.
  The checker now enforces the schema's expected type. A web RESULT reporting
  probes triggers a local manifest health read alongside (not instead of) the
  browser re-validation; malformed/missing manifests override trust for review.
  Web writer guidance and the live recipe explicitly require
  `expected: JSON.stringify(smokeResult)`. The recipe now also says
  `interactions: []` as a hard rule for self-driving milestone/reset smokes.
  Another exact rerun is required for zero friction plus replayable evidence.
- **SEVENTEENTH LIVE ITERATION, 2026-08-12 — "has styling evidence" needs both
  ends of the transition.** The durable-manifest rerun delivered in
  274s/13 calls/$0.1134 estimated (trace
  `2026-08-12T20-38-59-976-accb5809`). Its manifest was structurally clean:
  literal web discriminator and JSON-encoded expected string. The build phase
  independently proved streak-3 class then reset class, and browser scoring
  confirmed the artefact. Two recovered soft failures remained (one
  reset-erasure preflight, one guessed status label). More subtly, the FINAL
  result/manifest entry retained only reset-state class evidence; L2's new gate
  accepted it because it searched for any class/style token rather than BOTH
  milestone and reset.
  `webStylingEvidenceMissing` now accumulates the two required directions across
  recorded probes: styling tied to `milestone`/`afterIncrement`/streak-3 AND
  styling tied to `reset`/`final`, with style terms present in the aggregate
  `ok` clause and returned values. Reset-only evidence is explicitly tested as
  missing. Another exact rerun is required.
- **EIGHTEENTH LIVE ITERATION, 2026-08-12 — correctness closed, technique still
  thrashed.** The bidirectional-styling rerun delivered in
  447s/13 calls/$0.1850 estimated (trace
  `2026-08-12T20-47-20-062-26329238`). Final browser and durable evidence were
  fully correct and replayable: initial/reset class, milestone-7 `fire`,
  milestone-14 `on-fire`, milestone-30 `legendary`, aggregate `ok:true`,
  JSON-encoded expected, no duplicate methods, no console errors and no leaked
  child. The recovery skill injected as designed. But nine soft validation
  failures preceded it: three reset-erasure preflights, guessed IDs/labels,
  wrong expected maxStreak, and several strict-false assertion failures. The
  guards prevented false delivery; the L1 technique still wasted 7.5 minutes.
  Shared guidance and both live widget recipes now provide one canonical
  state-journey template rather than prose: re-read current source; copy exact
  IDs/thresholds/labels/classes; `interactions: []`; reset; capture initial;
  loop to the source-derived threshold; capture milestone class/style; reset;
  capture final; return one aggregate `ok`. Loops replace 30 unrolled
  increments. Another fresh web task is preferable to repeating the same theme
  again: the contract is proven, while technique generalisation needs a novel
  widget.
- **NINETEENTH LIVE ITERATION, 2026-08-12 — the first novel widget falsified
  "every false boolean is an assertion".** A hydration-goal generalisation run
  failed after 818s/26 calls/$0.4571 estimated, four escalations and 22 soft
  browser failures (trace `2026-08-12T20-58-23-018-be9ebaee`). Independent
  execution nevertheless passed count 0 → threshold 4 with `goal-reached` class
  → reset 0, zero console errors; its final manifest was well-formed and
  replayable. Most failures were framework-induced: legitimate raw state such
  as `initial.thresholdReached=false` was treated as a failed assertion even
  when the aggregate `ok` compared it correctly. The last escalation then
  invoked Water's tool-bearing fallback on the L2 Codex model, which
  structurally refuses tool loops, turning a correct workspace into outcome
  failed.
  Explicit `ok` is authoritative again; objects without it still fail on false
  booleans. The task-aware L2 styling gate, now requiring both transition ends,
  carries the omitted-dimension safety property without confusing raw state and
  assertions. Tool-bearing L2/L3 fallback calls route through `modelForTier(1)`
  while retaining supervisor provenance, so Codex can plan but never receives
  tools. `validate_html` now rejects, in the SAME L1 loop, a smoke that returns
  class/style/color data without binding those values into `ok`; L2 reuses the
  same contract helpers. The live build recipe's two targeted revisions were
  kept (observable styling + exact style snapshots); its 2 failures are honest
  history, not reset away.
- **TWENTIETH LIVE ITERATION, 2026-08-12 — novel-widget delivery recovered,
  with technique cost still visible.** The hydration rerun delivered in
  615s/27 calls/$0.2758 estimated (trace
  `2026-08-12T21-23-22-302-aa3d6345`) with two escalations instead of failing
  at fallback. The new L1-model fallback route was not needed at the end, but
  the structural Codex blocker is closed. Independent browser scoring passed
  count 0 → goal 4 with `goal-reached` → reset 0, zero console errors; the
  manifest was valid, JSON-encoded and proved `hasGoalClass:true` at milestone
  and false after reset. A legitimate
  `recover-missing-conditional-style-evidence` event skill was learned and
  kept.
  Friction fell 22 → 4: two reset-erasure preflights and two honest
  source-expectation mismatches ("Keep drinking" vs actual "4 glasses to go",
  empty class vs actual base class). The false-boolean framework cascade
  disappeared. `smokeDrivesIntermediateState` now recognises
  `goalReached`/`thresholdReached` and `after4`/`afterFour` snapshot names, so
  self-driving hydration smokes automatically discard conflicting external
  interactions earlier. Remaining label/class mismatches are true first-pass
  validation findings corrected from source, not silent approvals.
- **TWENTY-FIRST LIVE ITERATION, 2026-08-12 — one guessed RGB caused eleven
  self-inflicted repairs.** A third hydration run delivered in
  459s/16 calls/$0.2723 estimated (trace
  `2026-08-12T21-37-35-921-44f459ec`) with no escalation, valid durable
  milestone/reset evidence and independently correct behavior. Friction was
  nevertheless 11 identical smoke failures. The smoke expected green
  `rgb(39,174,96)` for the glass counter while the actual computed threshold
  color was blue `rgb(52,152,219)`. Instead of accepting observed behavior or
  comparing initial→milestone, the L1 repeatedly rewrote CSS, inline styles,
  specificity and timers around the unchanged guessed literal.
  The canonical state-journey template and both live web recipes now compare
  computed style against the captured initial value unless source explicitly
  proves an exact computed value; guessed RGB literals are forbidden. Smokes
  return a `checks` object with one positively named boolean per requirement
  and derive `ok` through `Object.values(checks).every(Boolean)`, so the first
  failed result names the exact comparison instead of inviting blind CSS edits.
- **TWENTY-SECOND LIVE ITERATION, 2026-08-12 — the diagnostic pattern exposed
  a parser blind spot.** Hydration with named checks delivered in
  447s/19 calls/$0.2101 estimated (trace
  `2026-08-12T21-53-20-432-ac34eced`). Final behavior and durable evidence were
  fully correct, replayable and leak-free; friction fell 11 → 6. Five of those
  six were FALSE framework rejections: the style-binding guard inspected only
  the literal `ok:` clause, so it missed class/style assertions inside
  `checks` when `ok` was correctly derived as
  `Object.values(checks).every(Boolean)`. The sixth was the familiar first-pass
  reset-erasure preflight.
  The shared `smokeOkIncludesStyling` contract now recognises either direct
  style comparisons in `ok` OR the canonical checks/every indirection when the
  checks object contains class/style/color assertions. Both validate_html and
  L2 consume the same helper; a regression test pins the exact live shape.
- **TWENTY-THIRD LIVE ITERATION, 2026-08-12 — repeated CSS repair exhausted the
  whole run despite a correct final workspace.** The next hydration run hit
  900s/41 calls/$0.4890 estimated, six escalations and outcome failed (trace
  `2026-08-12T22-03-19-485-9a61c073`). Independent execution still passed
  count 0 → goal 4 → reset 0 with correct class transition, and the final
  manifest was replayable. The L1 repeatedly asserted the same guessed green
  computed color, then rewrote selector specificity, inline styles, CSS
  variables and timers around that expectation. It also attempted to edit
  smoke code inside index.html once. The final L2 fallback correctly routed to
  the L1 model (the Codex structural error disappeared) but the run signal
  aborted it after the prior thrash consumed the budget.
  `validate_html` now rejects any direct comparison between
  getComputedStyle output and an rgb()/rgba() literal BEFORE launching the
  browser, coaching initial-vs-milestone or source-defined class assertions.
  The live recipes carry the same rule plus named checks. This is a mechanical
  closure for the exact eleven-repeat signature, not another request to "try
  harder".
- **TWENTY-FOURTH LIVE ITERATION, 2026-08-12 — the RGB loop closed; three
  protocol mistakes remained.** Hydration after the literal-RGB preflight
  delivered in 459s/23 calls/$0.2477 estimated, two escalations (trace
  `2026-08-12T22-23-10-308-077293c`). Final artefact and manifest again passed
  independent state/style/replay checks; friction fell 11 → 3. The remaining
  failures were: external four-click interactions PLUS a smoke that added four
  more glasses (observed count 8), one reset-erasure preflight, and an arrow
  IIFE body returned without the final invocation `()`.
  L1 now treats any smoke that calls a known state-mutating method
  (increment/addGlass/increase/reset/clear/advance/click) as authoritative and
  ignores external interactions, not only smokes carrying a recognised
  milestone name. Smoke lexical preflight rejects an arrow/function IIFE body
  that is never invoked and gives the exact `append ()` correction before
  Puppeteer. These are generic protocol closures; no hydration-specific
  expected value was added.
- **TWENTY-FIFTH LIVE ITERATION, 2026-08-12 — cross-family payoff exposed one
  deterministic packaging defect.** A novel dedupe-lines CLI delivered in
  96s/11 calls/$0.1056 estimated with one zero-LLM packaging phase, zero
  escalations and ZERO friction (trace
  `2026-08-12T22-35-03-872-45fd2b52`). Independent execution passed ordered
  deduplication, blank-line removal, missing-argument and missing-file exits;
  package/bin/README were semantically named and all six manifest invocations
  replayed. The audit still found that the trusted packaging script emitted
  `"test":"node ./dedupe-lines.js"` (and the same `start`), so npm test failed
  by construction because this CLI requires one file argument.
  The live script now omits unproven package scripts and was reset 9/0 → 0/0:
  changing an unwatched body without resetting trust would violate the exact
  body-bound rule the direct path relies on. Offline replay produced the same
  package/docs/probe result with no `scripts` field. The compiler prompt now
  requires every emitted package command to be an exact successful
  machine-recorded invocation with shipped fixtures, otherwise scripts are
  omitted. A successful deterministic envelope is evidence for what the script
  reports; it is not permission to invent adjacent metadata.
- **TWENTY-SIXTH LIVE ITERATION, 2026-08-12 — real probes can prove the wrong
  JSON shape.** The first validated re-earn run for the corrected packaging
  script delivered word-frequency in 237s/17 calls/$0.2097 estimated, with no
  direct phase and one recovered rejection (trace
  `2026-08-12T22-40-15-482-0316dbd2`). The first L1 attempt actually emitted
  the requested object map, but its final envelope truncated; the retry rewrote
  the implementation to an array of `{word,count}` records. Five probes were
  real and clean, so both validators approved despite the goal's explicit
  "JSON object mapping". Independent scoring also found the ASCII tokenizer
  turning `café` into `caf` despite the UTF-8 requirement.
  L2 now mechanically compares an explicit `JSON object` / `JSON array`
  requirement with every parseable successful recorded stdout BEFORE trust or
  LLM validation; non-JSON/mixed stdout remains for judgment. The live argv
  recipe names both the container rule and Unicode property escapes, and now
  asks for a non-ASCII fixture when UTF-8 is explicit. The false Lithium and
  Ammonia successes were transactionally removed; the driving recipe gained
  one honest failure.
  The packaging phase exposed two independent lifecycle issues. GLM emitted
  the complete final Result as an off-scope `json` tool call; the transport now
  normalises that third observed pseudo-final shape only when its nested value
  parses to `{output,summary}`. More importantly, the untrusted script recipe
  was ignored: L1 manually authored equivalent files, type trust skipped the
  adherence validator, and the new script body gained 1/0 without executing.
  L1 now records a content-free transport witness only after a successful
  `_skill_<id>.<ext>` write is followed by a successful run_shell invocation
  naming that exact scratch file. L2 mechanically forces
  `activeSkillFollowed:false` for an active script lacking that witness, on
  both trust and full-verdict paths. The false 1/0 was reset to 0/0. The
  missing-envelope recovery skill was kept: unlike the other findings, it
  describes the real first-attempt failure and its cause remains possible.
- **Web visualiser** (`src/viz/`, `npm run viz`): records every LLM call
  (prompt + response + usage + tier/atom routing) and every registry
  mutation (`create` / `patch` / `branch` / counter bumps) during a run,
  then serves a self-contained HTML UI on http://127.0.0.1:4111. Wired into
  both examples via `RecordingLlmClient` (wraps any `LlmClient`) and
  `RecordingRegistry` (subclasses `AtomRegistry`) — both observers only,
  zero effect on runtime behaviour. Runs are persisted as JSON under
  `./runs/` (override with `ATOMA_RUNS_DIR`). `npm run viz:demo` generates
  a mocked run with no API key so the UI always has something to render.
  Role inference in `recordingLlm.ts` keys off the stable `VALIDATION_SYSTEM_PROMPT`,
  `PREFILTER_SYSTEM_PROMPT`, and `SKILL_PREFILTER_SYSTEM_PROMPT` markers plus
  the `You are atom "X" (tier N)` preamble — keep those markers stable or
  update `classify()` accordingly.

## Architecture invariants (don't violate these)

- **`superviseLoop` is the ONLY implementation of the plan→validate→execute→validate
  protocol.** Both L2 (supervising L1) and L3 (supervising L2) reuse it. Do not
  duplicate the loop inside concrete atom classes.
- **Fractal tier creation:** application creates L3, L3 creates L2, L2 creates L1.
  Never instantiate an atom outside this cascade without updating the registry.
- **Registry is a single tier-keyed table** (`atom_types` with `tier` column).
  Do not split it into per-tier tables.
- **Naming comes from taxonomies only.** Use `AtomRegistry.create/branch`; never
  pass a name in directly except via the `overrideName` parameter on `branch` for
  explicit opt-out (used rarely, e.g. when the LLM supplies a semantic name).
- **Escalation path writes a branched type to the registry** (in the
  `branchOnEscalation` hook) and toggles `parent.setFallbackMode(true)` around the
  parent's self plan/execute. The `finally` block must reset it.
- **`pendingStrategy` is stateful** inside `L2Atom` / `L3Atom` between `plan()` and
  `execute()` in a single cycle. The supervise loop always calls them in pairs,
  so this is safe — but never call `execute()` without a preceding `plan()` on
  the same instance.
- **`fallbackMode` short-circuits the plan/execute logic** in L2/L3: they skip the
  registry/delegation path and call `selfPlan`/`selfExecute` directly. Any new
  tier atom needs to respect this flag.
- **Mutation scopes** (`ephemeral` / `patch` / `branch`) are dispatched by the
  `applyByScope` hook; the loop treats them uniformly. Add new scopes by editing
  the `MutationScope` union *and* each hook implementation (in `L2Atom`, `L3Atom`).
- **Anti-loop memo**: each supervisor (L2, L3) owns a `TaskChildrenMemo` from
  `src/atoms/cost.ts` that records which children it already tried during the
  current task and auto-clears on task boundary. The prefilter is told to
  exclude them so it cannot re-pick a child that just proved itself incapable
  within the same supervise-loop cycle. Call `beginTask(task.description)` at
  the top of `plan()`, `mark(name)` after committing to a child, and read
  `excluded()` when threading into `prefilterStrategy`.
- **Registry descriptions are CAPABILITY labels, NEVER task narratives.**
  `L2Atom.createSubtaskL1` and `L3Atom.createSubtaskL2` both route the
  seed/fallback description through `resolveCreationDescription` in
  `src/atoms/capability.ts`. A task-themed seed ("Mate-in-1 chess builder,
  8x8 board, drag-and-drop") is dropped in favour of a tool-signature-
  derived label ("single-file web artefact builder: writes index.html,
  serves locally, validates via headless browser"). Rationale: the
  description is the prefilter key on subsequent runs — if it encodes
  theme, the catalog fills with task-bound singletons that prefilter
  refuses to reuse cross-domain and the next run spawns yet another
  near-clone. Task-specific context still reaches the atom via
  `handle(task, ctx)` and the system-prompt template that bakes the
  subtask description at creation time. Legacy registry entries from
  before this rule may still carry task-themed descriptions; leave them
  alone, they'll lose the prefilter race naturally.
- **The RUNNER is generic, the PROFILE is the family (`src/run/`).**
  `runTask(profile, argv)` in `src/run/runner.ts` owns everything
  family-independent: provider selection + cross-vendor routing, sandbox and
  builtins, trace recording, the skill-lifecycle flags, the run budget and
  abort signal, signal handling, the last-resort watchdog, the post-mortem.
  A `TaskProfile` (`src/run/profile.ts`) contributes ONLY what a task family
  changes: workspace prep, the tier-3 seed, the canonical catalog seeding,
  the Task constraints, and the env-var names for store/workspace/budget.
  `src/cli/build-app.ts` is now a 20-line shell over the pair, and
  `src/examples/` is GONE — the folder name was the last of the lie.
  WHY: the 541-line example WAS the product — the burn-in harness spawns it
  per task, its stdout is the source of `burnin/results.csv`, and this file
  documented it as load-bearing in a dozen places. The cost of that was
  measured twice: `research-brief.ts` silently lacked every safety guarantee
  added to the build path (no `ATOMA_LLM` branch, no tools, no watchdog, no
  signal handling) and shared `atoma-ledger.jsonl` with a DIFFERENT store,
  violating the ledger's one-store rule; and `curriculum.ts`'s copy of the
  provider switch had drifted (it never matched the bare `claude` alias).
  DESIGNED AGAINST N=1 ON PURPOSE: the interface is a faithful cut of an
  anatomy pass over the old file, not an anticipation of a second family —
  adding knobs "while we are here" is the speculative generality this file
  refuses everywhere else.
  TWO THINGS THE MOVE COULD HAVE BROKEN, both now pinned by
  `tests/run-profile-build.test.ts`: (a) the tier-3 seed — `seedL3` re-aligns
  the persisted prompt whenever the constant changes and `patch` ZEROES trust,
  so one drifted character would have been the project's first tier-3 patch
  and cost Neuron its record, with Methane (133/0) and Water (36/0) behind the
  same pass; the test hashes the constant AND compares it against the live
  store (through a COPY — `openDb` runs `exec(SCHEMA)` + migrations, so
  pointing a test at the real registry would have `npm test` writing to it);
  (b) the console output, which `parseRunLog` reads to build the 146-row cost
  curve — the runner owns exactly three of its markers (`✓ build finished`,
  `--- run failed ---`, `TIMEOUT after`). Verified beyond the tests by running
  the pre- and post-refactor entrypoints side by side against a throwaway copy
  of the store: byte-identical stdout, byte-identical registry versions.
  `parseRunnerArgs` deliberately does NOT use `src/cli/args.ts` — `parseCliArgs`
  treats `--clean-workspace` as a flag-WITH-VALUE and would swallow the goal,
  silently falling every burn-in task back to the default Minesweeper goal.
  WHEN A SECOND PROFILE IS JUSTIFIED: a family that is NOT artefact-producing
  appears on two consecutive batches AND needs a tool bucket `pickTools`
  cannot make. Today 8/8 burn-in families write files. Note also that a new
  family needs a VERIFICATION story before it needs a profile — without
  mechanisable ground truth there are no honest trust counters, hence no
  fast-path, no promotion, no deterministic dispatch.
- **Canonical bootstrap in `src/run/profiles/build.ts`.** On every run we
  call five idempotent seeders from `src/atoms/capability.ts`:
  `ensureCanonicalL1` / `ensureCanonicalL2` (web build bucket,
  marked `bootstrap-canonical`), `ensureCanonicalHttpL1` /
  `ensureCanonicalHttpL2` (Node HTTP server bucket, marked
  `bootstrap-canonical-http`), and `ensureCanonicalFileScribeL1`
  (file-scribe bucket for JSON/markdown/text authoring, marked
  `bootstrap-canonical-filescribe`). Three L1 buckets + two L2
  orchestrators give L3.prefilter / L2.prefilter an obvious
  reusable target on day one for every recipe family the project
  handles. Without the HTTP canonicals the first Node/REST run had
  no L1 in its bucket and force-matched the web canonical
  (Methane-picks-Hydrogen — the #3/#4/#5 fix series' trigger).
  Without the file-scribe canonical, L2 routed file-authoring
  subtasks (README.md, config.json) to Helium (HTTP L1) and got
  correctly rejected on domain mismatch (#12). No file-scribe L2
  counterpart — Methane acts as an agnostic router that dispatches
  to Lithium for file-flavoured subtasks via its own prefilter.
  Helpers look up existing entries by `createdBy` marker, refresh
  tools AND the system prompt via `patch` on hit (prompt refresh is
  conditional — the patch no-op guard keeps unchanged runs free and
  counter-preserving; a genuinely changed seed prompt re-aligns the
  persisted row and legitimately resets trust), or create otherwise.
  the build profile applies the same conditional-refresh pattern to the
  Neuron L3 seed prompt.
- **Verification is READ-ONLY by design: the supervisor never replays the
  child's commands.** It may run FIXED, idempotent probes it owns
  (`validate_html` loading a URL; the file read-back), but it does not execute
  command strings the child names. Measured before deciding: of 185 recorded
  RESULT payloads only 3 (1.6%) carried a structured `cmd` + expected-output
  claim, so the *safe* subset had almost no trigger surface, while the subset
  with real coverage (prose, 14%) would mean regex-extracting model-authored
  shell strings — the exact failure class behind two false overrides, with the
  blast radius escalated from "phantom missing file" to "ran the wrong
  command". Real samples also need shell-quote parsing
  (`node index.js "Héllo Wörld — Ça va, 42 fois!!"`), and execution is not
  idempotent, so verifying could mutate the artefact being verified. Instead we
  RAISED THE EVIDENCE FORMAT (see below): the child records what it observed,
  the supervisor reads and cross-checks. If you are tempted to add command
  replay, re-read this paragraph first.
- **A compiled skill must contain NO task-specific literals.** The registry
  already forbids task narratives in descriptions
  (`resolveCreationDescription`); the same rule is load-bearing for promoted
  script BODIES, and more so — a markdown recipe saying "document the real
  invocations" adapts to the next task, a compiled
  `invocations = ['node index.js sample.txt']` cannot. Observed on the
  caesar-cli run: `document-cli-from-source`, promoted after being learned on
  a file-analyzer task, shipped a README documenting
  `node index.js sample.txt` / `npm start -- sample.txt` for a Caesar-cipher
  CLI — both print the usage message instead of ciphering. Every validator
  approved it, correctly per their contract: the probe record covered the
  CLI's real behaviour and the read-back confirmed the README exists, but
  nothing checks whether documented examples are APPLICABLE to this artefact.
  `compileSkillToScript`'s prompt now requires deriving everything
  task-specific from the workspace and argv[2], and exiting NON-ZERO rather
  than inventing a plausible example — a script that fabricates documentation
  is worse than one that refuses. Guarded by an assertion on the compile
  prompt in `tests/skill-promote.test.ts`.
- **`output.probes[]` — machine-readable probe record.** The evidence contract
  asks L1s for `output.probes: [{cmd, exitCode, stdout, note?}]`, plus
  `expectedStdout`/`actualStdout`/`match` when they compare against an
  expectation. `extractRecordedProbes` normalises the shapes children already
  emitted spontaneously (`examples_verified`, snake_case variants) so
  formalising the field did not invalidate them. The read-back probe renders
  the record next to the file excerpts and invites the validator to cross-check
  documentation against it — that comparison is a JUDGMENT and stays with the
  LLM. Only two things are decided in code, both mechanically unambiguous:
  `match: false`, and `expected` ≠ `actual` when both are present. A non-zero
  `exitCode` is explicitly NOT a failure (error-case probes are supposed to
  exit non-zero). Motivating defect: the json-cli run documented "exit code 1"
  while the CLI exits 0 — detectable with zero execution, because the
  inconsistency was between what the child observed and what it wrote down.
- **GROUND-TRUTH evidence contract for non-web/http L1s.**
  `GROUND_TRUTH_EVIDENCE_LINES` in `src/atoms/capability.ts` teaches
  the generic evidence-reporting contract (paste run_shell stdout,
  read_file excerpts of written files, list_files lines into a
  `== GROUND TRUTH ==` block in `summary`). Appended to: the
  file-scribe canonical prompt, the unknown-bucket branch of
  `buildNarrowL1Prompt`, and BOTH prompt sources of `createSubtaskL1`
  (planner-authored seeds included — Sonnet/Opus seeds never spell
  out the reporting contract). Added after the wc-cli live run: the
  doc-phase L1s produced six correct READMEs in a row but returned
  narrative-only summaries, and the Haiku validator (correctly)
  rejected each as unverifiable self-reporting — two escalation
  branches of pure churn. The web and HTTP canonicals keep their own
  domain-specific ground-truth sections; this is the bucket-neutral
  fallback. Covered by `tests/canonical-filescribe-bootstrap.test.ts`.
- **L1 plan shape — ASPIRATIONAL prose, no literal toolCalls.**
  `L1Atom.plan` now explicitly forbids emitting a `toolCalls` array
  in the plan response (#11). The plan expresses INTENT via the
  `proposedAction` prose field; the execute phase's tool-use loop
  carries out the actual sequence. Earlier shape asked for a
  `toolCalls: [{name, args}]?` option, and the LLM used it to paste
  full file contents into `write_file.args.content` — which
  repeatedly got truncated mid-string by the output maxTokens cap
  and then rejected by the validator as "incomplete payload",
  triggering a repeat-rejection escalation cascade. `planSchema`
  still tolerates `toolCalls` (legacy parse safety) but the L1 plan
  prompt never asks for it.
- **Bucket-scoped tool filtering in the canonical helpers.** Each
  `ensureCanonical*` pipes its caller-supplied toolset through
  `pickTools(tools, scope)` before creating/patching so a kitchen-
  sink caller (the runner passes all 10 tools) still produces a
  narrow canonical: the web L1 gets {write_file, read_file,
  list_files, start_static_server, validate_html}; the HTTP L1 gets
  {write_file, read_file, list_files, run_shell, fetch_url,
  start_node_server}. Without this, the kitchen-sink signature
  matches the FIRST bucket in `CAPABILITY_BUCKETS` and every
  canonical gets the same label, collapsing the whole per-bucket
  discrimination we rely on. Bucket order matters too: `http-server-
  build+probe` precedes `web-artefact-build+validate` so a
  kitchen-sink L1 created dynamically (mergeTools from L2) lands on
  the HTTP label when start_node_server is present.
- **HTTP bucket contract (`start_node_server` + `fetch_url`).** The
  L1 HTTP canonical writes server code that reads `process.env.PORT`
  and emits the literal line `LISTENING_ON_PORT=<N>` on stdout once
  bound. `start_node_server` injects `PORT=0` and parses that marker
  to discover the OS-assigned port — without the marker the tool
  times out. This contract is baked into `CANONICAL_HTTP_L1_SYSTEM_
  PROMPT_LINES`; new tools in the http bucket must preserve or
  replace it explicitly.
- **Auxiliary vs required overlap in `capabilityDescription`.** When
  a tool is in a bucket's `required` list AND in `AUXILIARY_TOOLS`
  (e.g. `run_shell` for the http-server bucket), the primary bucket
  label already describes how it is used — so `capabilityDescription`
  skips the auxiliary trailer for those tools. Without the skip,
  CANONICAL_L2_HTTP_DESCRIPTION could not stay in sync with
  `capabilityDescription(httpTools, 2)`.
- **Plan-time verification is ARTEFACT-MATCHED.** Both plan prompts
  (`L3Atom.plan`, `L2Atom.plan`) carry a `== VERIFICATION MATCHES THE
  ARTEFACT ==` block: browser-rendered pages → start_static_server +
  validate_html; HTTP servers/APIs → start_node_server + fetch_url;
  CLI tools / scripts / configs / docs → run_shell executing the
  artefact + file read-back, with verification usually folded INTO
  the build phase. Added after the clock-cli live run (2026-07-25)
  where the Opus plan gave a Node CLI a "serve + validate_html"
  phase 2 — Hydrogen burned 9 failed static-server boots and
  fabricated a parasitic index.html just to have something to serve
  (~half the run's calls wasted). L3's own plan has NO validator
  above it (there is no L4), so the plan prompt is the only place
  this class of defect can be stopped. Do not trim the block; it's
  covered by `tests/plan-verification-guidance.test.ts`.
- **Bucket-aware narrow prompts.** `buildNarrowL1Prompt(subtask,
  childTools)` in `L2Atom.ts` and `buildNarrowL2Prompt(subtask,
  childTools)` in `L3Atom.ts` pick their tool-sequence body from the
  child's bucket via `bucketIdForTools(tools)` — HTTP bucket gets the
  LISTENING_ON_PORT sequence (reuses `CANONICAL_HTTP_L1_SYSTEM_
  PROMPT_LINES`), web bucket gets the write/serve/validate_html loop
  + `SMOKE_DESIGN_GUIDANCE`, unknown buckets get a generic "use only
  your declared tools" template with NO smoke guidance. Without this
  gate, the narrow prompt unconditionally appended
  `SMOKE_DESIGN_GUIDANCE` — which taught HTTP atoms to reach for
  validate_html even when it wasn't in their declared tools, and the
  executor happily ran whatever the model asked for. Fix #8b.
  `createSubtaskL1` mirrors the rule: only appends
  `SMOKE_DESIGN_GUIDANCE` when the merged tools include
  `validate_html`. New L1/L2 escalation-branch paths must thread
  `childTools` (via `registry.getByName(child.name)?.tools` since
  `Atom.tools` is protected) into the builder or they'll regress.
- **Executor scope enforcement.** `AnthropicLlmClient.complete`'s
  tool-use loop gates every `tool_use` block against `req.tools`
  BEFORE invoking the executor: an off-scope request is turned into
  a `tool_result` with `is_error: true` listing the declared tools,
  so the model sees the rejection inline without burning a real tool
  execution. Gate is DISABLED when `req.tools` is empty/absent (no
  declaration to enforce). Defence in depth paired with bucket-aware
  prompts: even if future guidance regresses or a model hallucinates
  a tool name, the executor won't silently honour it. Fix #8a.
- **Plan-side toolset scope (#F1, the #8a sibling upstream).** The
  app-task-tracker post-mortem found a WHOLE verification phase that
  silently never ran: the plan demanded `validate_html` on an HTTP-bucket
  child, no validator could see the child's toolset, and under claude-cli
  an off-scope attempt leaves no trace. Now: (a) `L2.validatePlan` runs a
  MECHANICAL pre-check (`undeclaredToolMentions` in `verdict.ts` — closed
  `BUILTIN_TOOL_VOCABULARY`, negation-aware ±40-char window) BEFORE EVERY
  fast-path (trust AND `viaPrefilter`); the skeletal prefilter plan copies the
  task description, so user-authored tool names can reach it too. ≥2
  non-negated mentions of an undeclared tool
  auto-reject with coaching, zero LLM (threshold 2 because a plan that
  USES a tool names it repeatedly — the motivating plan: 7× — while
  echoes/deferrals are single, and a false positive burns a healthy
  child's replan cycle); (b) tier-1 verdicts carry a `Child's DECLARED
  TOOLS` line and `VALIDATION_SYSTEM_PROMPT` a TOOLSET SCOPE rule (with a
  thin-evidence softener on the RESULT side). Known residuals, accepted:
  the L3→L2 chain has no mechanical gate (tools live at L1; the plan
  prompt rules cover L3 prose) and intent phrased without the exact tool
  name slips the mechanical net (the validator line is the belt there).
  **THE CLOSED VOCABULARY DECOUPLED FROM `defaultBuiltinTools`, AND IT IS
  ENFORCED NOW.** `record_probe` shipped into every shell-owning scope and
  was never added to `BUILTIN_TOOL_VOCABULARY` — and a name absent from the
  closed list is unreachable by construction, so for its whole life it was
  the one builtin NO call site could report as undeclared. The docstring
  already said "Update when `defaultBuiltinTools` gains a tool"; a
  disciplinary rule with nothing enforcing it decoupled, exactly as the
  en/fr parity rule had. A test now compares the two lists (order included
  — both are literal, so a mirrored order costs nothing and makes the drift
  readable in the diff). NEVER a permission hole: the executor gate in
  `llm.ts` rejects any tool_use absent from `req.tools` whatever this list
  says, so a miss cost a wasted cycle, not an unsanctioned call. The
  REACHABLE half was the SHARED-CATALOG donor filter, not the plan
  pre-check: `file-scribe` requires only `write_file`, so the visibility
  lattice offers file-scribe recipes to a WEB reader (which has
  `write_file` and no shell), and a donor naming `record_probe` —
  legitimate on its own host — was offered to a reader that cannot execute
  it. Inert on the live catalog when it landed (no body named the tool),
  so the value
  is forward-looking. Adding the name is false-positive-safe for the text
  that names it most, which is worth knowing before rewording it: the
  contract's own `no record_probe in your declared tools` hand-write branch
  is suppressed by the negation window, and the affirmative mentions live
  in system prompts, which are never scanned. NOTE while you are here:
  `createSubtaskL1` appends `GROUND_TRUTH_EVIDENCE_LINES` — hence the
  record_probe block — UNCONDITIONALLY, where `SMOKE_DESIGN_GUIDANCE` is
  gated on `validate_html`. Not changed: the contract carries its own
  no-tool branch, and re-cutting a canonical prompt path costs trust
  counters for a case that hand-writing already covers.
- **Ground-truth probe is a WEB-bucket invariant, not universal.**
  `probeGroundTruth` (in `L2Atom.ts`, invoked from `llmVerdict` on
  RESULT verdicts) only fires when BOTH (a) `ctx.tools` has
  `validate_html` AND (b) the CHILD atom declares `validate_html` in
  its own `toolNames()`. The child gate was added after an HTTP-
  bucket Helium returned `"http://localhost:59375/"` and the probe
  ran Puppeteer against a JSON API, got "errors", rejected a valid
  result, cascade. `Atom.toolNames()` is the public accessor to the
  declared tool names (the full tools array stays protected). Fix #9.
- **QUOTED SPAN verification — the read-back probe checks the child's quote
  against the WHOLE file.** The excerpt rendered into the evidence block is a
  fixed 400-char HEAD (`FILE_PROBE_EXCERPT_CHARS`), so on any larger file the
  block is structurally SILENT about the region a child is most likely to
  quote. MEASURED (round 7): the `wclite.js` line the children cited sat at
  byte 1000 of 1312, 2.5x beyond the window — so an honest quote and a
  fabricated one were the same bytes to the validator, and it refused all of
  them. Four rejections, three atom branches, $1.38 on one run, on a
  deliverable that was correct throughout.
  `extractQuotedSpans` pulls spans the RESULT ATTRIBUTES to a file
  ("Line 24 of x.js:", "x.js line 19 implementation:") plus unattributed
  quoted/code spans; the probe emits `QUOTED SPAN … — FOUND` or
  `— NOT FOUND`, and a NOT FOUND on an ATTRIBUTED span sets
  `facts.quotedSpanNotFound` → a contradiction, which overrides the trust
  fast-path. It costs zero tokens and zero extra tool calls: the content was
  already read.
  THREE GUARDS, each measured against the real payloads, all in the same
  direction — a false NOT-FOUND would fabricate a contradiction on a correct
  deliverable, which is the one outcome this must not have.
  (a) Only ATTRIBUTED spans can contradict; an unattributed span is
  corroboration-only, because "absent from the files I happened to read" says
  nothing about a file the child never named.
  (b) Only CODE-SHAPED spans can contradict (`spanCanContradict`): an
  attributed pattern matched the PROSE after a label
  ("wclite.js line 21 verified: --chars: 35, --lines: 3…"), which is absent
  from the file by construction — that was a live false positive, caught
  before shipping.
  (c) Comparison is exact, then whitespace-collapsed — a child re-typing a
  line normalises indentation, and failing over a tab is not a defect worth
  reporting.
  TWO IMPLEMENTATION TRAPS, both hit: walking the payload's STRING VALUES is
  NOT equivalent to stringify-then-unescape, because source code routinely
  contains a literal backslash-n (the trailing-newline regex at issue) which
  JSON escapes to a double backslash — a blanket unescape cut the span in
  half. And `summary` must be walked FIRST: a payload whose `output` held 45
  strings pushed it past the budget and the quote went unchecked. Result on
  the 8 archived round-7 rejections: 7 corroborated, 0 false positives.
  Covered by `tests/quoted-span-groundtruth.test.ts`, whose two subtlest
  guards were verified to FAIL when neutralised.
- **ALREADY-SATISFIED WORK IS COMPLIANCE (`VALIDATION_SYSTEM_PROMPT`).** A
  sequential plan shares one workspace, so a subtask may ask for a change an
  earlier phase already made. The subtask text is a snapshot of intent written
  before any phase ran; the validator had no rule for this and sided with the
  text, rejecting honest convergence as evasion. The class is RARE — 5
  occurrences in 302 archived runs, all in 2 runs of one round — and
  EXPENSIVE: it carried the whole distance between round 7's 1.00x and the
  2.24x its other four runs read.
  The rule approves only on evidence the child did NOT author (a QUOTED SPAN
  FOUND line, or a read-back excerpt showing the end state) and rejects a bare
  assertion. FOUR THINGS IT MUST KEEP DOING, each from an adversarial finding:
  it NAMES the narration rule it qualifies ("does NOT relax the narration rule
  above") — an unreconciled clause loses to the older CRITICAL-marked,
  example-anchored one, and the reject half would then win alone, making the
  incident WORSE; it never claims anything general about probes (a transcribed
  probe is indistinguishable from one never run); it states that a TRUNCATED
  EXCERPT IS SILENT, NEVER REFUTING (one cascade head was a rejection for
  "the excerpt is truncated — cannot verify"); and its coaching asks for
  `record_probe` + a re-read, NEVER for a quoted string — additionalContext is
  injected verbatim into the retry, so asking for a string coaches the next
  attempt to produce it. Anchored by Worked Examples 9 and 10, both directions.
  ALSO FIXED THERE: the embedded-ground-truth EXCEPTION was written for HTTP
  children while `GROUND_TRUTH_EVIDENCE_LINES` makes the block MANDATORY for
  every non-web L1 — so a CLI child obeying its own contract met a carve-out
  that did not cover it. Widened to name file/CLI children explicitly.
  CONSEQUENCE, not a defect: an already-satisfied phase legitimately skips a
  recipe's steps, so `activeSkillFollowed: false` is EXPECTED there and skill
  credit is withheld by design. Do not read flat skill counters on a
  maintenance round as an adherence-gate bug.
- **Two ground-truth probes, MUTUALLY EXCLUSIVE by bucket — with ONE
  hybrid append.** `probeGroundTruth` dispatches: a child declaring
  `validate_html` gets the web load-and-look probe; every other
  file-producing child gets `probeFilesGroundTruth` — the supervisor-side
  READ-BACK probe (#F9). HYBRID refinement (app-task-tracker post-mortem):
  when the non-web child's RESULT carries a LOOPBACK URL and a zero-LLM
  sniff (one fetch_url; requires status 200 + text/html) says the server
  serves HTML, the browser load-and-look block is APPENDED to the
  read-back probe — never displacing it (88/166 archived RESULTs carry a
  URL; a content-triggered swap would have re-opened the #F9 fabrication
  hole on most of the family). Loopback-only by construction (a RESULT
  quoting an external docs link must not trigger supervisor egress, let
  alone Puppeteer on a third-party site rendered as ground truth), and
  the 200 requirement keeps Express-default HTML 404s from flipping pure
  JSON APIs into the incident-#9 Puppeteer-noise cascade. Covered by
  `tests/toolscope-precheck.test.ts`.
  Running both would double the cost and, on a non-web artefact, add
  Puppeteer noise the validator reads as a contradiction.
  The read-back probe re-reads the workspace itself and hands the
  validator facts instead of narration: which claimed paths exist,
  their real sizes, a bounded excerpt of each (`FILE_PROBE_MAX_FILES`
  = 6, `FILE_PROBE_EXCERPT_CHARS` = 400), plus a `list_files` of the
  root — which also surfaces debris the deliverable should not carry.
  No prompt cooperation from the child, no LLM call, only local fs
  tool calls. Why it exists: the web probe returned `''` for
  file-scribe children, so their RESULTs were judged on SELF-REPORTING
  alone — a child that under-reported its evidence got rejected for it
  (a wasted supervise cycle on a correct deliverable), and a
  FABRICATED claim passed every validator (run
  `2026-07-25T22-10-42`: a README asserted a Node version requirement
  drifting 10.0.0 → 14.0.0 → 12.0 while `package.json` had no
  `engines` field, approved three times).
  Two load-bearing details: `extractResultFilePaths` requires a file
  extension to START WITH A LETTER, otherwise version strings like
  `1.0.0` parse as filenames and the block reports phantom missing
  files; and the evidence block instructs the validator to reject ONLY
  on a contradiction (claimed-but-missing / claimed-but-empty /
  excerpt-refuted) and explicitly NOT because an excerpt is truncated
  or the child's description was terse — that framing is what keeps
  the probe from re-creating the over-demanding rejections the audit
  found. Both probes now also honour `ctx.signal`.
- **`VALIDATION_SYSTEM_PROMPT` must explicitly endorse the L1 plan
  shape.** The TIERING CONTRACT section names `toolCalls` as a valid
  L1 plan field and states "aspirational toolCalls at plan time are
  EXPECTED" plus "placeholders / references to runtime data the plan
  cannot yet know are acceptable". Without this, Haiku over-applied
  the L2/L3-must-delegate rule to L1 plans and rejected every L1
  that pre-declared its tool sequence (observed in the Node/REST
  run: three consecutive `"L1 must NOT propose tool invocations"`
  rejects → escalate → branch cascade). Do NOT trim this section;
  it's specifically load-bearing for the HTTP canonical happy path.
  Fix #10.

## Skills (persistent task patterns)

Skills are reusable how-to recipes attached to L1 atoms,
filesystem-backed and shared across runs. They're orthogonal to
the atom-type registry: an atom's IDENTITY (name, system prompt,
tool signature) lives in `atom_types`; an atom's repertoire of
LEARNED PATTERNS lives in `./skills/<l1-name>/<skill-id>/`.

- **SHARED CATALOG — visibility lattice (commits A′/B/C, 2026-08-08).**
  Skills are STORED per-L1 (layout below — zero migration; the
  adversarial design pass rejected bucket directories: the flagship
  duplicated recipes lived in DIFFERENT buckets, `sanitise` rejects the
  `+` in bucket ids, and a re-key would have orphaned ~290 ledger
  events) but VISIBILITY at match time is bucket-shaped: a donor
  namespace is offered to a reader iff the donor's bucket is EXECUTABLE
  by the reader — `required(bucket(donorTools)) ⊆ readerTools`
  (`src/skills/visibility.ts`, pure; `bucketIdForToolNames` /
  `bucketRequiredToolNames` in capability.ts). Subset test, not bucket
  equality: http readers execute file-scribe recipes, never the
  reverse; orphaned namespaces are never donors. Home is FIRST and
  unfiltered; donors are sorted (the prefilter decision cache hashes
  catalog text). Donor per-skill filters: `kind: script` requires the
  invocation ABI (`write_file`+`run_shell`) in the reader — a script
  body is Node source the text scan cannot read, and without this a
  web reader could trigger shell execution through trusted dispatch or
  brick a donor's earned counters with failures from runs it can never
  drive; `kind: llm` bodies pass `undeclaredToolMentions` against the
  reader. CREDIT/BLAME land on the OWNER namespace via the
  `(id, ownerNs)` pair on the L1 INSTANCE (`setActiveSkill(id, owner)`
  / `activeSkillOwner()`) — never on context state: the legacy-branch
  escalation path returns an untagged instance, and context-read credit
  would pay a skill for a run the branch delivered without it. The
  promotion scan takes the OWNER's tools (deterministic across
  crediting hosts); match-time quarantine keeps the READER's tools.
  Ledger bumps carry `detail.via` when the executing atom differs from
  the owner — the cross-namespace channel arming 3/0 and 5/0 stays
  auditable. The anti-redispatch memo sweeps the UNION of memoised
  summaries (twin scripts with different ids would sidestep an id
  key). The learn no-overwrite guard scans all VISIBLE namespaces.
  Kill switch: `ATOMA_SKILL_SHARED_CATALOG=0` = exact legacy behaviour,
  reversible at any instant (nothing on disk changes). Deliberately
  deferred: event-skill lattice widening (one line at its loadFor,
  gated on unmeasured evidence), a CLI visibility view (needs --db;
  add when operator need shows), per-bucket directories (re-propose
  only if COUNTER-sharing across bodies is ever wanted — which "trust
  is body-bound" forbids). Covered by `tests/skill-visibility.test.ts`.
- **Disk layout** (`src/skills/registry.ts`):
  ```
  ./skills/<l1-name>/<skill-id>/SKILL.md     — frontmatter + body
  ./skills/<l1-name>/<skill-id>/_meta.json   — counters + updatedAt
  ```
  `SKILL.md` carries YAML-style frontmatter (`id`, `description`,
  `when_to_use`, `kind: llm|script`) followed by a markdown body.
  Counters live in a sidecar JSON specifically so `recordSuccess`
  / `recordFailure` never touch human-authored content. The id is
  validated via `isSafeSkillId` (kebab-case, 3–60 chars) so a
  malicious id can't escape the namespace via `..`. `SkillRegistry`
  override path: `skillsDirPath()` / `ATOMA_SKILLS_DIR` (default `./skills`).

- **Skills stay ON DISK — considered against moving them into the store,
  2026-08-09, and deferred with a trigger.** The atom registry and the ledger
  were consolidated into one `atoma.db` the same day, so the question is live:
  why not the third store too? Four reasons, in descending weight.
  (a) **`SKILL.md` IS the interchange format, not a serialisation of one.** It
  is the Agent Skills base spec — `skills export` emits it, Claude Code reads
  it verbatim, and `parseFrontmatter` already migrates `id:` → `name:`
  opportunistically. As rows it becomes invisible: reading one recipe would
  need an export step, and `grep -r` over the catalog — how the hygiene pass
  and the shareability review are actually done — stops existing.
  (b) **Editing a body by hand is a SANCTIONED path used twice**, both times
  deliberately bypassing `save()` to preserve `compiledGeneration` and 28
  earned successes (`readme-from-verified-runs`, `verify-cli-argv-exit-codes`).
  In a DB that is either a new CLI verb or sqlite3 surgery on a text blob.
  (c) **The only driver is SaaS, which is not built.** `docs/saas-architecture.md`
  wants globally-shared bodies, and a DB is the right answer THERE. Building
  it now is the speculative generality this file refuses everywhere else, and
  it would put 24 recipes carrying real trust (23✓, 16✓) through a migration
  to serve zero present users.
  (d) The **rejected middle path** — counters in the DB, bodies on disk — is
  strictly worse: it turns `promoteToScript`'s three-file write into a
  genuinely distributed transaction, and helps SaaS not at all, since bodies
  are what get shared.
  WHAT THE MOVE WOULD REALLY HAVE FIXED, now fixed in place instead: a torn
  `_meta.json` used to read as a SILENT 0/0, and the next bump persisted
  `0 + 1` — every write is a whole-object non-atomic `writeFileSync`, so a
  crash mid-write replaced months of earned trust with a plausible number, no
  error, no trace. `readMetaChecked` now makes `bump` REFUSE (leaving the file
  recoverable and, since `bump` returns false, filing no ledger event for a
  bump that never landed) and warns loudly. That was the concrete data-loss
  mode; the remaining sidecar weakness is `promoteToScript`'s three-file
  sequence, which has never been observed to tear.
  REVISIT when a SECOND tenant exists, or when a body write is observed to
  tear in practice. NOT for tidiness: the honest cost of the split today is
  one sentence in `ledger check`'s output (`--skills-dir` still has to name
  the right tree — the one half of the ledger's old KNOWN LIMIT that stays
  conventional) and a second thing to back up.

- **Match → inject (#C2a).** `L2.runSubtask` runs a Haiku skill-
  prefilter against the resolved L1's persistent skill catalog
  BEFORE entering the supervise loop. The prefilter REUSES
  `prefilterStrategy` from `cost.ts` (same schema, same low →
  escalate confidence guard) but with the dedicated
  `SKILL_PREFILTER_SYSTEM_PROMPT` — NOT the atom-catalog prompt.
  Rationale: `PREFILTER_SYSTEM_PROMPT` carries a HARD RULE against
  single-candidate force-matching that is correct for atoms (a
  mismatch burns a supervision cycle) but inverted for skills: a
  young skill library usually has exactly ONE recipe, and it exists
  precisely because a task like this one succeeded before. Under the
  shared prompt Haiku escalated on one-skill catalogs, the run lost
  the injection, and the learn branch then paid a Sonnet call to
  distill a skill that was already on disk (deduped only after the
  spend). The skill prompt drops the single-candidate rule plus the
  L1-affinity/decomposable clauses (meaningless for skills) and
  matches on WORKFLOW SHAPE, not surface domain words.
  On a `reuse + high-confidence` match, the matched skill body is
  injected into the L1's effective system prompt via the existing
  `Atom.injectContext` mechanism, wrapped in clearly-delimited
  `== ACTIVE SKILL: <id> ==` … `== END ACTIVE SKILL ==` blocks
  that are easy to grep in traces. The instance is tagged via
  `L1Atom.setActiveSkill(id)` so the supervise-loop hooks know
  which skill drove the run.

- **The adherence gate does NOT cover the mature path — accepted, not
  overlooked.** Measured on a live two-pass burn-in: pass 2 ran 31 trust
  fast-paths against 7 validator LLM calls, and ZERO carried the
  adherence block. The reason is structural, not a defect: the two
  mechanisms that make a mature store cheap — the trust fast-path and
  deterministic dispatch — both bypass the LLM validator, and those are
  exactly the runs where a skill is driving. Where the gate IS asked, the
  model complies (measured: 4 blocks presented, 4 fields emitted, 100%).
  DECISION (2026-08-06): accept the ceiling rather than sample it. The
  residual risk — a skill credited for a run it did not drive, arming the
  5/0 compile trigger — is already bounded downstream: `promoteToScript`
  ZEROES the counters, so a compiled script must still earn 3 clean runs
  through the validated loop before it dispatches unwatched. Paying for
  an extra validator on trusted runs would tax the exact path the whole
  cost discipline exists to make free. Revisit only if a compiled script
  is ever traced back to a skill that never drove a run.
- **Trust counters per skill (#C2a).** `onApproved` and `onFailed`
  hooks bump `_meta.json.successes` / `_meta.json.failures` on the
  matched skill in addition to the existing atom-type counters. A
  skill earns trust independently of its host atom; the same atom
  type can host multiple skills with very different trust profiles.

- **Usage-conditioned skill credit (adherence gate).** Skill counters
  only move when the skill actually DROVE the run. `L2.validateResult`
  shows the RESULT validator the active recipe (`renderActiveSkillBlock`
  in `verdict.ts`, body capped at `ADHERENCE_BODY_MAX_CHARS` = 2000) and
  the constant `== ACTIVE SKILL ADHERENCE ==` section of
  `VALIDATION_SYSTEM_PROMPT` asks for an extra verdict field
  `activeSkillFollowed: true|false`. `superviseLoop` threads the
  approving verdict into `onApproved` and the cycle's last RESULT
  verdict into `onFailed`; both hooks WITHHOLD the skill bump (and
  `onFailed` also the script-demotion check) on an AFFIRMATIVE `false`.
  The escalation skill-update path is gated the same way via
  `lastResultVerdictSkillFollowed(trace)` (`capability.ts`) — revising a
  recipe against a diagnosis about work that never followed it corrupts
  the recipe, and the `save()` would clear the promotion-refusal stamp.
  Rationale: counters are TRIGGERS, not stats — unearned successes arm
  the promote-threshold compile trigger on recipes that never demonstrably worked;
  one unearned failure blocks promotion until an operator
  `skills reset`. Deliberate asymmetries: `undefined` (trust fast-path
  skipped the LLM, legacy verdict, model omission) preserves the legacy
  bump — `false` must be an affirmative observation, and the prompt says
  so ("when the evidence is too thin to tell, emit true"); adherence is
  asked on RESULT verdicts only (a plan merely states intent to follow);
  atom-TYPE counters always move regardless (the child did succeed/fail,
  whatever it was following); the signal never gates approval itself.
  The field is `nullish` in `verdictSchema` with tolerant coercion in
  `coerceVerdictDefaults` ("true"/"false" strings coerced, garbage
  dropped) so a sloppy emission can never fail an otherwise-valid
  verdict. Deterministic dispatch (`runScriptSkillDirect`) is untouched:
  it wrote and executed the script itself, adherence is structural.
  Covered by `tests/skill-credit-gating.test.ts`.

- **Update on failure (#C2b).** When a run driven by a skill
  ESCALATES, `branchOnEscalation` enters the SKILL UPDATE PATH
  before the legacy registry-branch path:
    1. Extract the verbatim validator diagnosis via
       `extractBranchDiagnostic(trace)`.
    2. Sonnet (`this.model`) generates a TARGETED revision of the
       skill body (`improveSkillBody`) — instructed to keep changes
       focused, not balloon the length, and return the body
       unchanged if the failure is environmental.
    3. `SkillRegistry.save` overwrites the body but PRESERVES the
       counters (the C1 save contract).
    4. A fresh L1 instance is returned with the updated skill
       injected; the supervise loop's `hasTriedBranch` mechanism
       gives it ONE clean cycle. If it also fails, the loop falls
       through to the parent fallback path (skill failure +1 on
       `_meta.json` so the churn is observable).
  Falls back to the legacy branch path on Sonnet error / empty
  response — skill update is OPPORTUNISTIC, never mandatory.

- **Auto-creation (#C3).** ON by default in `npm run run:build`.
  Pass `--no-learn-skills` (or set `ATOMA_SKILL_LEARN=0`) to disable
  for a single run. The lib (`L2Atom.onApproved`) still reads
  `ATOMA_SKILL_LEARN === '1'` at hook time — `runTask` writes
  that env var to '1' by default before invoking `l3.handle`, and to
  '0' when `--no-learn-skills` is passed. Marginal cost is ~1 Sonnet
  call (~$0.003) per novel-task success — kept on by default because
  in practice "I forgot the flag" was the dominant failure mode and
  the safety guards (id sanity check, no-overwrite of existing ids,
  tolerant JSON parser) absorb the bulk of the bad-distillation
  risk.
  When a run completes WITHOUT a matched skill and is
  approved by the validator, Sonnet distills it into a new skill
  via `learnSkillFromRun`: the prompt asks for `{id, description,
  when_to_use, body}` as JSON and parses tolerantly via
  `parseSkillDraft` (accepts `when_to_use` and `whenToUse`,
  fenced JSON, prose-with-JSON). Guards: malformed JSON → debug
  log + skip; `isSafeSkillId` rejects unsafe ids; an existing skill
  with the same id is NEVER overwritten (counter-preserving).
  Costs one Sonnet call per learning event. The LIBRARY hook is off unless
  `ATOMA_SKILL_LEARN=1`; `runTask` deliberately sets it to 1 by default, while
  direct library consumers and tests pay nothing unless they opt in.

- **Skill-prefilter fires when at least one skill exists.**
  `matchSkill` short-circuits without an LLM call when the registry
  returns 0 skills for the L1, but it still sets
  `skillMatchAttempted = true` — so a novel run on a skill-less L1
  is correctly recognised as a learning opportunity. Tests that
  drive the skill-prefilter LLM slot must pre-seed at least one
  scarecrow skill so the slot actually fires.

- **Promotion llm→script (#C2c).** When a `kind: 'llm'` skill crosses
  `TRUST_PROMOTE_THRESHOLD_SUCCESSES` (3 — was 5; the 2026-08-07
  threshold experiment showed the count never changed a compile verdict,
  only delayed it) with zero recorded failures,
  the L2's `onApproved` hook fires `tryPromoteSkill` which (a) loads
  the skill, (b) re-checks eligibility, (c) makes ONE Sonnet compile
  call (`compileSkillToScript`) asking for a deterministic Node
  script body OR a refusal, (d) on success calls
  `SkillRegistry.promoteToScript` which stashes the original llm body
  in `_fallback.md` and rewrites SKILL.md with `kind: script` +
  `language: node`. Counters are PRESERVED across promotion.
  Demotion fires from `onFailed` when a `kind: 'script'` skill drives
  a run that escalates: `recordFailure` has already bumped the
  failure counter, then `demoteToLlm` reads `_fallback.md` and
  rewrites SKILL.md back to `kind: llm` with the original body. The
  `failures > 0` clause inside `tryPromoteSkill` then blocks
  accidental re-promotion until the operator resets the counters
  (`npm run skills -- reset <l1> <id>` — also clears the
  `promotionRefusedAt` compile-refusal stamp, the other permanent
  dead-end). Gated by `ATOMA_SKILL_PROMOTE` env var:
  ON by default in `runTask` (toggle with `--no-promote-skills`),
  OFF in the lib so unit-test runs don't make stray Sonnet calls.
  Marginal cost is ~1 Sonnet call (~$0.01) per promotion event.
  `_fallback.md` is INTENTIONALLY left in place after demotion so a
  future re-promotion (post-counter-reset) can compare against the
  historical body.

- **`kind: 'script'` skills execute via tool-loop while UNTRUSTED,
  deterministically once TRUSTED (#C4).** Two paths:
    - UNTRUSTED (successes < 3, or any failure): `skillContextBlock`
      injects an active-skill block whose body tells the L1 to: (1)
      pass the JSON-encoded subtask description as argv[2], (2)
      `write_file _skill_<id>.<ext>` with the script body verbatim,
      (3) `run_shell <interpreter> _skill_<id>.<ext> [args...]`,
      (4) return the stdout envelope. ONE LLM round-trip + 2 tool
      calls regardless of script length.
    - TRUSTED (`shouldTrustSkill` in `cost.ts`: 3+ successes, 0
      failures — every freshly promoted script qualifies since
      promotion needs promote-threshold/0): `L2.runSubtask` short-circuits into
      `runScriptSkillDirect`, which performs the SAME two tool calls
      itself. ZERO LLM calls — no L1 plan/execute, no validators.
      The exit code + stdout envelope IS the ground truth. ANY
      deviation (non-zero exit, missing envelope, tool error) falls
      back to the untrusted path above, and a deterministic failure
      deliberately does NOT bump the skill failure counter — only a
      full supervise-loop escalation counts (that's also what drives
      script→llm demotion). On success the dispatch bumps the SKILL
      counter itself (the loop's onApproved never runs) and leaves
      atom-type counters untouched (the L1 model never executed).
      Kill switch: `ATOMA_SKILL_DIRECT=0` (or `--no-direct-skills`
      in `runTask`); default ON.
  **The envelope parse is the ONLY gate on this path** (it returns before
  the supervise loop, so no validator sees the result and `onFailed` —
  hence `demoteToLlm` — is unreachable from it). The exit code alone is
  not enough: a compiled script can announce its own failure and still
  exit 0. Measured on the freshly-promoted `document-cli-from-source`,
  run in a workspace without the CLI:
  `{"output":null,"summary":"FAILED: index.js ... not found ..."}` with
  `EXIT=0` — accepted, then credited via `recordSuccess`, entrenching a
  broken script at 6/0, 7/0… `parseScriptEnvelope` therefore rejects
  `output: null | undefined` and any `summary` matching
  `/^\s*(FAILED|ERROR)\b/i` as OFF-CONTRACT (→ back to the validated LLM
  loop, no counter bump), and `compileSkillToScript`'s prompt now
  *requires* a non-zero exit on failure.
- **Promotion RESETS the skill's counters** (`SkillRegistry.promoteToScript`).
  They used to be preserved ("a body reformulation of an already-trusted
  skill") — wrong, and dangerously so: the successes were all earned by the
  MARKDOWN recipe under a validated LLM loop, while the compiled script is a
  brand-new artefact that has never executed once. Inheriting 5/0 armed the
  no-validator deterministic dispatch (`shouldTrustSkill` needs 3/0) on the
  script's very FIRST match. The script form now earns its 3 clean runs
  through the validated loop before running unwatched. Note the corollary
  for `demoteToLlm`: the counters it preserves are the script form's own,
  since promotion already cleared the markdown form's.
  The script's stdout MUST be a single JSON line of shape
  `{"output": ..., "summary": "<one sentence with embedded == GROUND
  TRUTH == block>"}`; `compileSkillToScript`'s prompt enforces this,
  and `parseScriptEnvelope` in `src/contracts/scriptEnvelope.ts` is the strict parse the
  deterministic path applies (LLM path stays tolerant — the L1 is
  told how to wrap plain stdout).
- **Pre-flight envelope gate on deterministic dispatch.**
  `runScriptSkillDirect` calls `scriptDeclaresEnvelope(skill.body)`
  BEFORE `write_file` and returns null (→ LLM loop) when the body
  never names `output`/`summary`. `parseScriptEnvelope` alone rejects
  off-contract scripts only AFTER they have run and had their side
  effects. Concrete case: the hand-authored
  `skills/Lithium/scaffold-package-json` reads argv POSITIONALLY
  (`name`, `version`, `description...`) whereas direct dispatch passes
  ONE arg — the JSON-encoded subtask description. Dispatching it wrote
  a `package.json` whose `name` was the whole task sentence, exited 0,
  printed prose, failed the parse, and handed the LLM loop a workspace
  already polluted. The gate is a cheap token check on purpose: a
  false negative only falls back to the validated LLM loop (which
  handles these scripts correctly, since there the L1 derives the
  positional args itself), whereas the failure being closed is a
  false positive.
- **Probe manifest — the deterministic interface for verification
  (#C5).** `PROBE_MANIFEST_FILENAME` (`.atoma-probes.json`, workspace
  root): `{"version":1,"entries":[{"cmd","exitCode","stdout","stderr"}]}`
  with FULL verbatim outputs, merged by cmd. Three contract sites teach
  it: `GROUND_TRUTH_EVIDENCE_LINES` tells every non-web L1 to write it
  after verifying invocations with run_shell; `compileSkillToScript`'s
  `PROBE MANIFEST` block makes compiled verification scripts read it as
  PRIMARY input (re-run each cmd, byte-for-byte diff; prose parsing is
  fallback only) and makes scripts that verify invocations write/merge
  it; the `reverify-cli-readme-invocations` skill body is manifest-first.
  WHY: two compile generations of prose-parsing verification — the
  second under an explicitly hardened INPUT VARIANCE prompt, visibly
  obeyed — failed offline regression on 6/6 real archived workspaces
  (extraction found nothing on three README styles, claims parsing found
  nothing on another, multi-line stdout got truncated to its first line
  on the last). Free-form model-authored markdown is not a parseable
  interface; a machine-written JSON record is. The README stays for
  humans, machine verification reads machine input. The live
  `readme-from-verified-runs` compiled script was hand-patched (via
  `SkillRegistry.save`, counters preserved) to write the manifest — it
  already collected exactly the needed data.
- **Node scratch scripts are `.mjs` — the workspace owns `.js` semantics.**
  `scriptExtension('node')` returns `mjs`: the scratch `_skill_*` file
  lands in the WORKSPACE, and a task-authored root `package.json` with
  `"type": "module"` flipped a bare-`.js` scratch to ESM — the compiled
  CommonJS script died with "require is not defined in ES module scope"
  (triov batch, 2026-08-02: two consecutive dispatch failures → natural
  #C4b demotion of a logically sound script; the full self-healing stack
  executed autonomously across two runs with zero failed deliverables —
  working as designed, on the wrong root cause). The INVARIANT is the
  explicit extension — never bare `.js`; ESM (`.mjs`) over `.cjs` is the
  house-coherence choice, the repo itself being `"type": "module"` +
  NodeNext. The compile prompt pins ESM (import from 'node:…', no
  __dirname/__filename — use process.cwd()). A legacy CommonJS body
  written to `.mjs` crashes cleanly on first dispatch and the
  directFailures streak demotes it — stragglers are covered. The skill
  demoted by the original incident was reset (sanctioned path) to
  re-earn compilation under the fixed runtime.
- **The workspace is FENCED from the repo's module system
  (`ensureModuleResolutionBoundary`, `src/run/workspace.ts`).** The
  inverse leak of the `.mjs` bullet above: Node resolves a `.js` file's
  module system by walking UP to the nearest package.json, and the
  workspace lives under the atoma repo (`"type": "module"`) — so a task
  shipping CommonJS `.js` files WITHOUT a local package.json crashed with
  "require is not defined in ES module scope", caused by a file OUTSIDE
  the sandbox jail that no L1 or validator can see. Measured (HTTP
  burn-in, 2026-08-07): 8/10 runs wrote no local package.json; exactly
  the ones whose L1 happened to pick the CJS style crashed and converted
  to ESM in-loop. This class CANNOT self-improve through the skill
  machinery — runs end approved (no rejection → no event-skill learning,
  no escalation → no body revision) and each in-loop self-repair is
  locally correct while leaving nothing durable behind; the needed fact
  lives outside every observer's world. Hence a structural fix: a
  sentinel `{}` package.json in the workspace's PARENT (harness-owned
  `build/`), written by `prepareWorkspace` ONLY when the nearest ancestor
  manifest above it is `"type": "module"` — innocent layouts are never
  touched, and a task-authored package.json still wins (closer to the
  file). Covered by `tests/workspace-boundary.test.ts` with real `node`
  spawns both directions.
- **An UNCHANGED skill revision is NOT a revision.** `improveSkillBody`
  is explicitly told to return the body as-is when the failure was
  environmental — but saving it anyway is harmful twice over: `save()`
  clears the promotion-refusal stamp on the premise that the body
  changed (so the anti-thrash guard evaporates), and the one-shot branch
  retry then re-runs an identical recipe against an identical diagnosis
  for a guaranteed-identical outcome. The escalation path now compares
  trimmed bodies and treats "unchanged" as "no revision available",
  falling through to the legacy registry-branch path. Covered in
  `skill-prefilter-injection.test.ts`.
- **A demotion stamps the COMPILING generation.** `promoteToScript`
  records `compiledGeneration` (the `COMPILE_PROMPT_GENERATION` that
  produced the script body); `noteDirectFailure`'s stamp uses THAT value,
  not the generation in force at demotion time. Without this the
  generation gate defeats itself through a side door: the two-shape
  manifest fix landed, the OLD script failed once more, and stamping the
  NEW generation re-parked the skill against the very compiler that would
  have fixed it. A script produced by compiler A failing tells you nothing
  about compiler B's output. Covered in `skill-promote.test.ts`.
- **Refusal stamps come in TWO CURRENCIES — compare via
  `refusalStampIsCurrent`, never `===`.** Compile/scan refusals stamp
  `REFUSAL_GENERATION` (compile hash + scan hash, dash-joined: either
  input changing deserves one retry); demotions stamp the compile-only
  generation that produced the failing script (a runtime failure is
  falsified only by a different compiler — the scan doesn't shape the
  emitted body). Both constants and the predicate live in
  `src/skills/generations.ts` (lifecycle.ts re-exports); the FOUR
  comparison sites (tryPromoteSkill gate, `skills show`, `skills stats`,
  curriculum target selection) all take the predicate. History: strict
  comparison against the combined string treated every demotion stamp as
  stale — a brittle script compiled by the CURRENT compiler would be
  recompiled into the same body forever (1 Sonnet + 2 failed dispatches +
  fallback per lap); the curriculum CLI had the inverse bug (compared
  against compile-only, so combined stamps never matched and
  currently-refused skills were listed as retry candidates). Covered in
  `skill-promote.test.ts` (two-currency describe).
- **Lifecycle thresholds are operator-configurable at call time.**
  `trustThreshold()` / `promoteThreshold()` / `demoteAfter()` in
  `src/atoms/cost.ts` read `ATOMA_TRUST_THRESHOLD` /
  `ATOMA_PROMOTE_THRESHOLD` / `ATOMA_DEMOTE_AFTER`, defaulting to the
  documented constants (3 / 3 / 2 — still what tests assert; promote
  was 5 until the 2026-08-07 experiment). Read at
  CALL time so a single run can be made more cautious without a rebuild.
  Invalid, zero or negative values fall back to the DEFAULT rather than
  disabling a gate: a typo must never make the system less careful.
  Use `shouldTrustType` / `shouldTrustSkill` (which call the helpers) —
  never compare against the raw constants in new code.
- **Three manifest entry shapes, one per bucket.** `{cmd, exitCode,
  stdout, stderr}` (shell), `{probe:"http", method, path, status, body}`
  and `{probe:"web", file, interactions, smoke, expected, consoleErrors}`.
  Web interactions MUST be SELECTOR-based, never pixel coordinates —
  `validate_html` accepts coordinates, so the contract has to forbid them
  (observed live: two web runs in one batch, one recording
  {selector:"#toggle"} and one {x:304,y:392} — the latter is worthless
  after any re-render; the validator now flags it, and the prompt tells
  the L1 to ADD an id to the artefact when no selector exists).
  The web shape deliberately records the FILE + interactions + smoke
  expression and NOT the served URL: the port is fresh every run, so a
  URL is unreplayable while those three are exactly what lets a later
  pass re-serve and re-validate. The compile prompt lists all three and
  instructs the compiler to REFUSE promotion when a recipe's core work is
  web validation — a compiled script has no browser tooling, and a script
  that pretends to validate a page is worse than no script. That refusal
  is the honest ceiling for the web family until (if ever) a
  browser-capable dispatch path exists.
- **A shell `cmd` is the BARE command — `; echo EXIT=$?` decorations are
  a contract violation all three sides know about.** Observed
  (cli-envcheck, 2026-08-06): the build-phase L1 recorded every cmd with
  the display decoration, so every recorded `exitCode` was echo's
  (always 0 — the CLI's real error-case codes survived only inside
  stdout strings) and the replay diffed against corrupted expectations:
  two phantom mismatches auto-demoted the 30✓ compiled verifier — the
  demotion machinery working as designed on the wrong root cause. Now:
  the shell WRITER block forbids recording decorations (exit codes
  belong in `exitCode`), `validateProbeManifest` reports a decorated cmd
  (`DECORATED_CMD_RE`, exported) so the read-back probe surfaces it to
  the validator mid-run, and the READER block tells compiled scripts to
  SKIP such entries with a note instead of replaying them — plus exactly
  ONE comparison tolerance: a difference only in trailing newline is a
  match (transcription trims vary; everything else stays byte-for-byte).
  FIELD-level sibling (`PORT_BEARING_STDOUT_RE`): a recorded stdout
  embedding `LISTENING_ON_PORT=<n>` is run-varying by construction —
  the health check reports it, the reader compares exitCode ONLY for
  that entry (never writing the fresh port back), and the http writer
  block makes the harness entry MANDATORY-when-a-test-script-exists,
  stdout omitted. Observed (batch 14): two DIFFERENT writer-compliance
  failures of this one contract (harness entry omitted entirely; entry
  recorded WITH port-bearing stdout) each charged the healthy compiled
  replayer a directFailure — two in a row demoted it, and the demotion
  stamp (older compiler) correctly granted the recompile that brought
  it back under the full current contract. The machinery converges,
  but each lap costs a demotion cycle — hence fixing the WRITER side.
  Covered by the decorated-cmds describe in `tests/contracts.test.ts`.
- **An HTTP manifest is a SEQUENCE; the CRUD family cannot compile from
  it alone.** Two facts found by the first live HTTP promotion attempt.
  (a) The writer used to say "merge by method+path" — a real CRUD
  manifest recorded POST /recipes FOUR times (201, 400 malformed, 400
  missing-fields, repeat), so merging on the route would collapse the
  sequence and delete every error case. The http block now says APPEND
  in order, never merge. (b) `httpEntrySchema` carries NO request
  payload, so a compiled script cannot replay mutations — replaying only
  the GETs against a freshly booted server fails by construction. The
  writer therefore also asks for an EXECUTABLE probe harness recorded as
  a SHELL entry (`{"cmd":"node <harness>","exitCode":0}`, no `stdout` —
  the bound port varies), which the already-compiled shell path can
  replay. Do NOT add a `requestBody` field speculatively: no accumulated
  manifest carries one, so a script compiled against it would fail on
  4/6 real archived workspaces and demote itself in two runs.
- **Distillation steers verification recipes at MACHINE input.** The
  learn prompt used to list "invocations documented in the README" among
  the derivable sources; the HTTP verification skill duly learned "step
  1: from the spec/README, list each route", reached 5✓, and was refused
  at compile time as irreducible judgment — correctly. The prompt now
  carries an INPUT PRECEDENCE clause: when the run wrote
  `.atoma-probes.json`, step 1 MUST read it; prose is a named fallback,
  never the authority. Pinned by `tests/skill-auto-creation.test.ts`.
- **`when_to_use` IS MATCHED AGAINST THE SUBTASK TEXT ALONE — a condition
  about DISK STATE is unevaluable, and that is what keeps verification
  recipes from compiling.** The prefilter is a cheap model shown the next
  subtask's wording and the recipe's one-line `when_to_use`. It never sees the
  workspace. So "a probe manifest already exists in the workspace" is not a
  weak matching condition, it is an impossible one.
  MEASURED, 2026-08-10 benchmark, 19 runs from an empty store — the split is
  clean and it is the same host atom on both sides:

  | phrased as | matches |
  |---|---|
  | `replay-cli-probe-manifest` — "a probe manifest already exists in the workspace" | 2 |
  | `verify-cli-against-probes-manifest` — "an entry script and fixture exist on disk" | 2 |
  | `verify-cli-argv-exit-codes` — "README/**task** lists concrete invocations…" | 9 |
  | `package-and-document-cli` — "**Task asks to** add package.json + README…" | 5 |
  | `replay-recorded-shell-probes` — 3 text-evaluable clauses + an explicit exclusion | 22 |

  Recipes that describe WHAT THE TASK ASKS FOR get picked; recipes that
  describe THE STATE OF THE DISK do not. Consequence in the benchmark:
  deterministic dispatch fired ZERO times across 19 runs and the whole 35%
  saving came from the trust fast-path and recipe reuse instead.
  IT IS A RATE PROBLEM, NOT A BLOCK. An earlier revision of this entry said
  the starved siblings "cannot advance… not in ten runs and not in a hundred".
  That was wrong and the data says so: by the end of the benchmark both sat at
  2 matches / 2 successes — `promotion-in-1`, ONE success short — and the
  mature catalog holds five compiled scripts that reached dispatch through
  exactly this shape. The defect delays compilation by roughly 5-10 runs; it
  does not prevent it. The benchmark simply stopped before the payoff.
  ALSO WRONG IN THAT REVISION, recorded because it is the more seductive
  story: the cause is NOT a monolithic recipe out-competing its sibling for
  the same phase. The siblings were never in the running at all. Nothing needs
  to be taken away from the build recipe.
  FIXED AT THE GENERATOR (2026-08-10). `learnSkillFromRun`'s prompt now carries
  a HARD RULE stating that `when_to_use` is matched against subtask text alone,
  with the measured table above, plus a repeat of it inside the
  verification-split block — a verification recipe acts on a previous phase's
  artefacts and is the one most tempted to describe itself by them (both
  casualties were verification recipes). Pinned by
  `tests/skill-auto-creation.test.ts`.
  THE LESSON UNDERNEATH, which is the part worth carrying: this rule was
  ALREADY in this file, written up for `replay-probe-harness` — "the prefilter
  never sees the workspace, so 'a manifest exists' is NOT a usable matching
  condition". It had been applied BY HAND to one skill and never fed back into
  the generator, so the generator kept producing unmatchable recipes for
  months. A lesson documented but not wired into the thing that generates the
  artefact is a lesson that gets re-learned at full price.
  DETECTION, so a recurrence is seen rather than inferred from a cost curve:
  `skills stats` flags `under-matched(when_to_use?)` on a non-event recipe
  below the promote threshold whose matches are ≤ 1/5 of its busiest sibling's,
  when that sibling has ≥ 10 (`isUnderMatched`, `src/skills/stats.ts`). A
  RATIO, because 2 matches is healthy in a young catalog and pathological
  beside a sibling at 15. Verified to discriminate: it flags exactly the two
  known casualties in the archived benchmark catalog and fires zero times
  across the 24-skill mature catalog.
  VERIFIED, ROUND 2 (`benchmark/ROUND2.md`, 19 runs from an empty store): the
  registered bar was met — 1 compilation and 1 zero-LLM phase, against 0 and 0
  in round 1 — but the attribution is PARTIAL and the honest reading is worth
  more than the win. The recipe that compiled is a DOCUMENTATION recipe at 11
  matches, not either of the two verification recipes the fix targeted, which
  ended at 0 and 2 matches out of 16 despite both being reformulated. So
  text-evaluable phrasing is NECESSARY BUT NOT SUFFICIENT. The likelier
  remaining cause is visible in the plans: this task decomposes into build and
  document and rarely produces a standalone re-verification phase at all, so
  there is little demand to match. A second contributor: the two verification
  recipes overlap at 0.52 and split what little there is. The
  `under-matched(when_to_use?)` flag still fires on both, and its question mark
  now earns its place — phrasing is no longer the obvious answer.
  ECONOMICS DID NOT MOVE. atoma's mean was $0.5314 in round 1 and $0.5358 in
  round 2. The apparent jump from −35% to −47% saving is ENTIRELY control-arm
  drift (+23.7%, a different day on a subscription-served model) — the drift
  check registered in advance is what caught it. One dispatch in fourteen runs
  does not shift a mean.
  AND IT REVEALED THE NEXT DEFECT, which is now the binding constraint: the
  compiled script armed, fired once at $0.1913 / 7 calls, then took two contract
  failures and auto-demoted. Root cause, measured by hand-replaying archived
  manifests: THE MANIFEST RECORDS TRUNCATED STDOUT. In every failing case the
  recorded output is a strict PREFIX of the real one (371 chars against 2008;
  65 against 1029), so a byte-for-byte replay can never match, and
  `validateProbeManifest` checks structure rather than completeness so nothing
  notices. Most workspaces are clean — 6 of 8 replay perfectly — which is why
  the script dispatches successfully sometimes and demotes anyway. Unfixed: the
  choice between teaching the writer harder, recording a length/hash so
  truncation is detectable, and making the reader treat "recorded is a strict
  prefix of actual" as a truncated record rather than a failure.
- **Not every skill is compilable, and matching breadth is the tell.**
  `Helium/probe-crud-json-api-lifecycle` sits at 7✓ and stays `kind: llm`
  on purpose. Its four observed prefilter matches were: one genuine
  verification, and THREE authoring subtasks ("write README.md", "write
  probe.js" ×2). A compiled script would print a valid envelope and write
  no file → validator rejects → `failures = 1` → and `tryPromoteSkill`'s
  `if (skill.failures > 0) return;` blocks re-promotion permanently,
  escapable only by the counter-zeroing `skills reset`. Compiling a skill
  whose matches include file-deliverable tasks is a trap: the success
  case is self-destructive. Check what a skill is actually MATCHED to
  (not what its description claims) before wanting it compiled.
- **Make a family compilable via a SIBLING skill, never by overwriting
  the trusted one's body.** Full trace analysis (10 real matches, not the
  4 sampled above) split probe-crud's traffic 6/3/1: six live-API
  exercising subtasks that themselves enumerate per-route expectations
  (a manifest-replay recipe is structurally CONTRARY to those), three
  authoring, ONE harness-replay — the only compilable shape. Overwriting
  the body would have (a) armed `tryPromoteSkill` with 10 inherited
  successes on a recipe that never demonstrably drove a run (`matches ==
  successes`: several were free-ride credits), (b) risked `failures = 1`
  → permanent promotion block if the first post-save match was a live-API
  subtask, and (c) killed the recipe that serves 60% of the family's real
  traffic. `Helium/replay-probe-harness` is the sibling: born 0/0,
  manifest-first, its `when_to_use` names the observed phrasing ("run
  the test script") and structurally excludes live-API exercising
  (per-route enumerations) — clauses the prefilter can actually evaluate
  from the subtask text (it never sees the workspace, so "a manifest
  exists" is NOT a usable matching condition).
- **A verifier merges observations into the manifest ONLY after every
  comparison passed.** On a failing pass the manifest stays UNCHANGED —
  merging failing observations overwrites recorded expectations with the
  regressed values and the NEXT replay passes against the corrupted
  record (regression whitewashing: the value-level sibling of the
  add-stdout shape bug). The first compiled generation of
  `verify-cli-argv-exit-codes` shipped with the write ahead of the
  mismatch gate — found by adversarial review, fixed by direct body edit
  (counters + `compiledGeneration` preserved), and the rule now rides
  `manifestReaderLines` into every future compile. Offline-tested both
  ways: clean replay exit 0 + merge; sabotaged expectation → exit 1 +
  byte-identical manifest.
- **Field names in the manifest are EXACT, and a rename is named back.**
  The contract is taught by rendered examples, and L1s paraphrase it into
  variants — measured twice, both as rejection cascades on runs that had
  already produced a CORRECT manifest and then re-authored it wholesale:
  four cycles on `{kind, expect}` instead of `{probe, status}` (~$0.80
  run) and five on `expectExitCode` instead of `exitCode` (~$0.63 run).
  Two-sided fix: the writer block states the names are exact with the
  observed renames spelled out, and `validateProbeManifest` NAMES the
  rename it detects (`CANONICAL_ALIASES` → "this entry has \"expect\";
  the field is named \"status\"") instead of only reporting the absence,
  which left the writer guessing. Turns a cascade into one coached
  cycle. Note the compounding cause, fixed separately: both runs had
  re-authored the whole file instead of read-merge-append.
- **The probe manifest is health-checked (`validateProbeManifest`).**
  The manifest is written by PROMPT (L1 evidence contracts) and read by
  COMPILED SCRIPTS with no validator between them — a malformed one
  silently breaks every future deterministic dispatch and surfaces far
  from its cause. The read-back probe now validates it and reports
  either `well-formed` or the specific breakage into the evidence block.
  Tolerant by design: unknown extra fields pass (forward compat) and a
  manifest MIXING shell + http entries is VALID (documented contract);
  only structural breakage is reported (bad JSON, version ≠ 1, entries
  not an array or empty, per-entry shape missing its required fields).
  A reported breakage sets `GroundTruthFacts.manifestMalformed`, which makes
  `checkGroundTruth.requiresReview` override the trust fast-path without
  pretending the deliverable itself is mechanically contradicted. Before
  this structured signal, `MALFORMED` existed only in the rendered block:
  untrusted results showed it to Haiku, while trusted types returned approval
  before any validator saw the block — the health check was silently inert on
  the path that most needed it.
  It knows all THREE shapes, and since the contracts extraction the sync
  is STRUCTURAL: writers, reader and checker all render/check the
  schema-validated examples in `src/contracts/probeManifest.ts`, and
  `tests/contracts.test.ts` pins the round-trip (what writers emit, the
  reader teaches and the checker accepts). Add a shape THERE, nowhere
  else — the hand-written era produced two one-sided-contract incidents
  (iteration 16 nearly broke iteration 4).
  GATED on the child having reported probes — a plain file-scribe
  deliverable pays no extra tool call, which keeps the exact-call-count
  assertions in the #F9 tests (a deliberate cost guard) intact.
  Covered by `tests/probe-manifest-validation.test.ts`.
- **Refusal stamps EXPIRE with the compile-prompt generation.**
  `COMPILE_PROMPT_GENERATION` (`src/skills/compilePrompt.ts`) is a djb2 hash of
  `buildCompileSkillPrompt`'s static template rendered with fixed
  placeholders — edit any line of the compile prompt and the id changes.
  `markPromotionRefused` records it; `tryPromoteSkill` IGNORES (and
  clears, via `clearPromotionRefusal`) a stamp whose generation differs
  from the current one, giving the evolved compiler exactly one shot.
  Rationale: the stamp's premise is "recompiling this body reproduces the
  same script", which is FALSE once the compiler itself changed. Observed
  live: the probe-manifest contract landed, a demoted HTTP skill was
  stamped under the old prompt, and benefiting from the new contract
  required a manual `skills reset` — the only operator intervention in an
  otherwise autonomous cycle. Legacy stamps (no generation recorded) are
  treated as stale and retried once. Same-generation stamps still
  short-circuit before the Sonnet call, so the anti-thrash guarantee is
  intact. Covered by `skill-promote.test.ts` (both directions).
- **Anti-redispatch guard: a reproduced dispatch OUTPUT routes to the
  LLM loop.** A trusted script is deterministic — same workspace, same
  byte-identical result. When an upstream validator rejects that result
  on CONTENT, the mechanical contract still passed (exit 0 + envelope),
  so no directFailure, no demotion, and the skill got CREDITED — and the
  replan re-matched the same script for the same outcome. Measured
  (epoch-5 run 5): SIX identical dispatches, two escalations, three Opus
  plans, $1.63. Replans build FRESH L2/L1 instances and reword subtasks,
  so the memo lives on the RUN CONTEXT (`ctx.dispatchedScriptSignatures`,
  lazily initialised) and keys on the OUTPUT SUMMARY: a dispatch whose
  summary this run has already seen falls through to the validated LLM
  loop, which can adapt. The redundant script run costs two tool calls
  and zero LLM. Covered in `skill-direct-dispatch.test.ts`.
- **Deterministic-failure streak demotes a brittle script (#C4b).**
  `runScriptSkillDirect`'s two CONTRACT failure branches (non-zero exit,
  missing envelope) call `noteDirectFailure`, which bumps
  `_meta.json.directFailures` via `SkillRegistry.markDirectFailure`; at
  `DIRECT_DISPATCH_DEMOTE_AFTER` (2) the script is demoted to its llm
  fallback. This is DISTINCT from the trust failure counter: deterministic
  failures fall back to the validated LLM loop (which usually still
  delivers, so the run records a SUCCESS), meaning a structurally brittle
  script never escalates and the onFailed demotion path is unreachable —
  without the streak it would fail on every match forever, burning two
  tool calls + the full fallback each time. Demonstrated live (slugify
  rehearsal, 2026-07-28): the compiled reverify script's command regex
  excluded quotes, so `node index.js "Hello World"` was amputated to
  `node index.js`, four documented invocations deduped into one bare
  command, and a phantom mismatch failed a correct deliverable — then the
  L1 fallback burned the run's whole 600s budget rewriting the README and
  re-running the same script. The streak is cleared ONLY by a
  deterministic success (`clearDirectFailures`) — an LLM-loop success
  proves the recipe, not the script — plus the usual `save()` /
  `resetCounters` paths. Environmental failures (executor threw) do not
  count. The compile prompt gained a paired `INPUT VARIANCE — MANDATORY`
  block: model-authored artefacts vary in formatting between runs, a
  command's arguments are part of the command, and empty extraction must
  exit non-zero. Covered by `skill-direct-dispatch.test.ts`.
- **DELIVERABLE GATE on deterministic dispatch — the envelope is no longer
  the only check.** A compiled script cannot know which subtask it was
  matched to, and this path returns BEFORE `superviseLoop`, so no
  validator ever sees its output. MEASURED: the compiled CLI verifier,
  handed "Write a README.md documenting the CLI usage", replayed the
  manifest, printed a valid envelope, exited 0 and wrote NO README — and
  was credited a success, entrenching the script (the documented
  `document-cli-from-source` class, with no gate at all). Now, after the
  envelope parses, every file path named in the SUBTASK DESCRIPTION
  (`extractResultFilePaths` — not the RESULT, that is the claim we
  distrust) must exist, or the dispatch returns null and the validated
  LLM loop takes over. Zero tokens (local `read_file`), and NO counter
  moves: not a success, and NOT a `directFailure` either — the script is
  not broken, it was matched to the wrong kind of subtask. Deliberately
  strict (any missing path falls back): a false positive only pays for
  the LLM loop, a false negative entrenches a phantom success. The gate
  is inert when the subtask names no file, so verification subtasks keep
  their exact prior call counts. Covered by
  `tests/skill-direct-dispatch.test.ts`.
- **A compiled verifier must PRESERVE each manifest entry's recorded
  shape.** The CLI verifier rewrote every replayed entry with the
  observed stdout/stderr — including entries deliberately written
  WITHOUT them. REPRODUCED: on an HTTP harness entry
  (`{"cmd":"node test-api.js","exitCode":0}`), run 1 exits 0 and the
  manifest gains a port-bearing stdout; runs 2+ exit 1 forever, diffing a
  fresh port against a stale one. Two such failures hit
  `DIRECT_DISPATCH_DEMOTE_AFTER` and demote the project's ONLY compiled
  script. An omitted field is a SIGNAL that the value is not comparable.
  The rule now lives in three places that must stay in sync: the skill
  body's rewrite step, `manifestWriterLines` (shell AND http) and
  `manifestReaderLines`, so a recompile cannot regenerate the bug.
  NOTE: the skill body was edited DIRECTLY on disk, not through
  `SkillRegistry.save()` — save rebuilds `_meta.json` without
  `compiledGeneration`, which would break `noteDirectFailure`'s
  generation scoping and drop the 28 earned successes' provenance.
- **A `kind: script` skill with no `_fallback.md` is UNDEMOTABLE.**
  `demoteToLlm` returns null when the file is absent, and
  `resetCounters` does not change `kind` — so a broken script authored
  directly as `kind: script` (rather than reached via
  `promoteToScript`, which always writes the fallback) has no
  automatic way back to the LLM form. `scaffold-package-json` is in
  exactly that state. The pre-flight gate above is what keeps it
  harmless; if you ever author a script skill by hand, either satisfy
  the stdout envelope or drop an `_fallback.md` next to it.
- **Learned and revised skill bodies must stay in the host's TOOLSET.**
  Both `learnSkillFromRun` and the escalation revision path filter their
  output through `undeclaredToolMentions` against the host L1's declared
  tools (fail-open: skip the draft / treat as no-revision, warn). The
  distillation prompt also carries the toolset + a HARD RULE (distil what
  the run's ACTIONS demonstrate, never what the subtask text intended).
  Why: the app-task-tracker run distilled TWO skills teaching
  `validate_html` on an HTTP-bucket host that cannot declare it — the
  plan had demanded it, the run never executed it, and the recipes
  encoded the phantom; a revision invited by a diagnosis like "the UI was
  never independently verified" would do the same while `save()` also
  clears the refusal stamp. Covered in `skill-auto-creation.test.ts`.
- **Learned and revised skill bodies must GENERALISE.** Both
  `learnSkillFromRun` (distillation) and `improveSkillBody` (revision
  on escalation) carry an explicit rule: use placeholders for anything
  specific to the originating run, and describe how to DERIVE a
  task-specific value rather than what it happened to be. Without it,
  a documentation recipe learned on a file-analyzer task kept the
  literal step `run node index.js sample.txt`; a later Caesar-cipher
  CLI then shipped a README documenting an invocation that only prints
  the usage message — and passed every validator, because the artefact
  itself was fine. `when_to_use` already had a generality constraint;
  the `body` field did not, which is where the literal entered.
  Locked by tests in `skill-auto-creation.test.ts` and
  `skill-prefilter-injection.test.ts`.
- **Verification split at learn time.** `learnSkillFromRun`'s prompt asks
  for an OPTIONAL second skill under a `"verification"` key when the run
  contained a purely MECHANICAL verification sub-workflow (run the real
  invocations, compare exit codes/stdout/stderr, read files back — every
  step derivable from the workspace alone). Parsed by `parseSkillDrafts`
  (primary = top-level object, so the single-object contract is unchanged);
  guards (`isSafeSkillId`, no-overwrite) apply PER DRAFT, and a
  verification draft reusing the primary's id is dropped at parse. Both
  skills are born `kind: llm` and earn promotion independently. Rationale:
  monolithic build+verify recipes get REFUSED at promotion because the
  build half is irreducible LLM reasoning (verbatim Sonnet refusal on
  `scaffold-node-cli-tool` at 5✓: "designing bespoke CLI business logic …
  from a free-form natural-language spec … is an irreducible LLM reasoning
  step"), while the verification half alone is exactly what compiles into
  a deterministic zero-token script. The split is where script-shaped
  skills come from; without it the catalog only accumulates judgment
  recipes and the #C4 deterministic path never gets candidates. Still ONE
  Sonnet call per learning event (`maxTokens` 1600, was 800 — the split
  can double the JSON and 5-series adaptive thinking shares the cap).
- **Promotion-refusal reasons are persisted.** `markPromotionRefused`
  stores Sonnet's verbatim explanation as `promotionRefusedReason` in
  `_meta.json` (bounded by `REFUSAL_REASON_MAX_CHARS` = 500), shown by
  `skills show`. Same lifecycle as the stamp: preserved across counter
  bumps, cleared by `save()` and `resetCounters`; `readMeta` drops an
  orphaned reason whose stamp was hand-deleted. The WHY is the actionable
  part — "irreducible LLM reasoning" means the skill can never compile,
  a workflow-shape complaint might be fixed by a body revision.

- **Script-skill hardening: static scan + trust boundary (arxiv
  2604.03081 mitigations).** `scanScriptBody` (`src/skills/scriptScan.ts`)
  is a TIGHT deny-list over `kind: script` bodies — network egress
  (fetch/http/net/tls/dns/WebSocket), dynamic code (eval / new
  Function), credential probes (homedir(), .ssh/.aws/.netrc/.npmrc) —
  and deliberately NOT child_process, which the probe-manifest contract
  requires (compiled verification scripts re-run documented commands).
  BUCKET-AWARE since the first live HTTP promotion attempt: the network
  rules are LIFTED for a skill whose host L1 declares the HTTP pair
  (`hostAllowsLoopbackNetwork` — `fetch_url` / `start_node_server`),
  because probing a server it just booted IS that family's verification.
  Measured: `probe-crud-json-api-lifecycle` reached 5✓, Sonnet compiled
  it correctly, and the scan refused the result for `network:fetch` on a
  script whose every request went to loopback (zero non-loopback URLs in
  the generated body) — CLI-shaped reasoning applied to the one family
  it cannot fit, which would have blocked the HTTP bucket from EVER
  producing a compiled script. When lifted, the DESTINATION is still
  checked: a non-loopback absolute URL literal raises
  `network:external-url`, and lookalikes (`localhost.evil.com`) do not
  pass. Non-network rules are never lifted. The refusal stamp records
  `COMPILE_PROMPT_GENERATION-SCAN_GENERATION`: the scan is an INPUT to
  the refusal decision, so correcting it must expire the stamps it
  caused instead of parking a skill against a rule that no longer
  exists.
  Two enforcement points, fail-closed for the script, fail-open for the
  run: `tryPromoteSkill` refuses a flagged compile output via the
  existing generation-stamped refusal machinery (reason = the scan
  verdict; `skills reset` is the operator override after review), and
  `L2.runSubtask` QUARANTINES a flagged match (hand-authored/legacy
  scripts) — neither deterministic dispatch NOR injection, because the
  injected block instructs the L1 to run the body verbatim, so "fall
  back to the LLM loop" is NOT a mitigation; the run proceeds
  skill-less. Companion: every injected LEARNED-CONTENT block (llm
  recipes, event-recovery guidance) opens with
  `LEARNED_CONTENT_TRUST_BOUNDARY_LINES` (`events.ts`) marking the
  recipe as bounded-authority DATA — the paper's cheapest effective
  mitigation (OpenHands' direct-execution rate collapsed once repo
  content was annotated untrusted). Script blocks skip the boundary
  text on purpose (their contract is "run verbatim"; the scan is their
  gate). Covered by `tests/script-scan.test.ts`.
- **Event-driven recovery skills (#E1) — matched MID-RUN, zero-LLM
  matcher.** A skill whose frontmatter carries `trigger:` is recovery
  GUIDANCE keyed to a failure signature (validator-complaint pattern),
  not a task recipe. Motivated by CODESKILL's ablation: event-triggered
  micro-guidance carries the value (+8.3pp alone) vs task-level
  strategy (+1.7pp). Three rules keep it cheap and safe:
  (1) `matchSkill` EXCLUDES trigger skills from the task prefilter —
  Haiku must never "reuse" a recovery hint as the driving recipe.
  (2) Matching is MECHANICAL (`src/skills/events.ts`): trigger-token
  CONTAINMENT in the event text (≥ 0.45 AND ≥ 3 shared tokens) — a
  rejection is when the run is already burning, so the matcher is free;
  containment (not Jaccard) because triggers are compact and
  diagnostics long. Fired from `makeL1Hooks` on every rejection
  (`applyByScope`, all three scopes — fresh patch/branch instances can
  re-receive since injected context is lost with the old instance, but
  never twice on one instance) and on the escalation legacy-branch
  path with `extractBranchDiagnostic` as event text. Injection uses
  `== EVENT RECOVERY SKILL ==` delimiters (distinct from ACTIVE SKILL:
  event skills never call `setActiveSkill`, so the adherence/credit
  machinery does not apply; utility is tracked via `markMatched`
  alone). Kill switch: `ATOMA_EVENT_SKILLS=0`.
  (3) Learning fires POST-LOOP in `runSubtask` (`maybeLearnEventSkill`
  — the hooks never see the trace) on a RECOVERED run only: ≥1
  rejection in the trace, ultimately approved, NOT a fallback
  deliverable, and NO event skill was injected (novel event — the C3
  "we looked and found nothing" rule; an injected skill confounds the
  recovery). One Sonnet call (`learnEventSkillFromRecovery`), gated by
  the same `ATOMA_SKILL_LEARN` flag; draft requires `trigger` (parse:
  `parseEventSkillDraft`, `when_to_use` defaults to the trigger). The
  trigger must describe the failure CLASS, never the task's theme — a
  task-themed trigger never matches a future event text. `trigger` +
  `kind: script` is a structural error at parse AND save (guidance
  cannot be a script; also keeps such skills out of promotion, which
  they never reach anyway — they earn no successes). `skills stats`
  labels them `event-driven` and skips the promotion lifecycle labels.
  Covered by `tests/event-skills.test.ts`.
- **Match history + `skills stats` (utility view).** `SkillRegistry.
  markMatched` bumps `_meta.json.matches` (+`lastMatchedAt`) every time
  the skill prefilter picks a skill — at MATCH time, before the outcome,
  on both dispatch paths, no ledger event (a match is not a trust
  mutation). `skills stats` (helpers in `src/skills/stats.ts`, pure)
  renders per-skill: matches vs driven runs (successes+failures), the
  FREE-RIDE gap `matches − driven` (runs the adherence gate refused to
  credit), a one-cell lifecycle status, and same-L1 MERGE CANDIDATES by
  token-Jaccard overlap of description+when_to_use (`--sim`, default
  0.5). `matches` survives bumps and `save()` (it is compared against
  counters that survive too) but is zeroed by `resetCounters` and
  `promoteToScript` so the gap arithmetic stays within one trust era.
  AWM's measured steady state (~7 skills/scope, overlap < 0.2) is the
  calibration reference. Covered by `tests/skill-stats.test.ts`.
- **When is an event skill DEAD? When its root cause was fixed
  STRUCTURALLY.** Event skills never earn counters (they never
  `setActiveSkill`), so nothing retires them and `matches: 0` alone proves
  nothing — a recovery recipe may simply be waiting for its incident.
  The decidable criterion is different: a trigger describes a failure CLASS,
  and if that class was eliminated in the harness rather than survived by
  technique, the trigger can never usefully match again. Applied 2026-08-09,
  which dropped exactly two of ten:
  `recover-es6-import-in-commonjs-node-entry` (the ESM module-resolution leak,
  closed twice over — `ensureModuleResolutionBoundary` and then the workspace
  moving out of the repo) and `recover-tool-error-declared-total-block`
  (learned from a `bumpDeadline is not defined` mid-batch edit that existed
  for about twenty minutes — the exact "permanent skill teaching a workaround
  for a bug that died the next day" failure the rejected friction-sensor
  entry warns about).
  The other eight were KEPT because their causes are MITIGATED, not
  eliminated: the port case of run-varying stdout is handled but timestamps
  are not; renamed manifest keys are now named back by the validator but can
  still be emitted; the aggregation default covers an OMITTED field but not an
  explicit wrong `concat`. Partial is not dead.
- **Do NOT `skills reset` `write-server-route-test-harness`** (17 matches,
  16✓/2✗, `blocked(reset)`). It reads like the obvious hygiene action and is
  a trap twice over: `reset` zeroes the 16 earned successes as well as the
  failures, and the skill AUTHORS a file, which is the `probe-crud` class — a
  compiled script that prints a valid envelope while writing nothing gets
  rejected, sets `failures = 1`, and re-blocks promotion permanently. Paying
  16 successes to re-enter the same trap is the wrong trade.
- **Catalog-hygiene verbs: `skills drop` / `skills merge`.** Both are
  OPERATOR verbs (CLI-only, never autonomous) with ledger events
  (`skill-drop`, `skill-merge`; `ledger check` iterates the STORE so a
  deleted entity's stale projection is never compared). `drop` deletes
  the folder — refused when `successes > 0` unless `--force` (proven
  knowledge). `merge <keep> <absorb>` is deliberately MECHANICAL (no
  LLM): the keeper's `when_to_use` absorbs the other skill's (routing
  surface widens), keeper body/description/counters/stamps are untouched
  — trust is body-bound, so an unchanged body keeps its earned trust,
  and the merge does NOT route through `save()` (which would clear the
  refusal stamp on a body-change premise). The absorbed skill is deleted
  and its counters die with its body — summing counters earned by a
  different body is the corruption "patch resets trust" exists to
  prevent. Absorbing a skill with successes needs `--force` (or merge
  the other way).
- **Curriculum generator (`npm run curriculum`, `src/cli/curriculum.ts`).**
  Voyager's curriculum mapped onto the lifecycle counters: SELECTION is
  pure code (`selectCurriculumTargets`), GENERATION is one Sonnet-tier
  call. Four target categories, priority-ordered: script-maturation
  (kind:script below trust — each clean validated run nears zero-LLM
  dispatch), stale-refusal-retry (refusal stamp from an older compiler
  generation — one success re-attempts), promotion-push (llm skills at
  1..promote−1 clean successes — armed runs), failed-family-retry
  (burn-in CSV families with failed rows — Voyager re-proposes
  failures). Skills with `failures > 0` are SKIPPED (only `skills
  reset` moves them) as are refused-current-gen ones (more successes
  can't help). The prompt demands NOVEL small goals matching each
  target's workflow shape — replaying the original task would inflate
  trust on memorised specifics, the generalisation rule's evil twin —
  and forbids naming skills/framework in goals. Output:
  `burnin/tasks-curriculum.json` (then `npm run burnin -- <file>`);
  `--dry-run` prints targets with zero LLM calls. Provider selection
  mirrors build-app (ATOMA_LLM + cross-vendor tier-pin routing). Pure
  helpers covered by `tests/curriculum.test.ts`.

- **Agent Skills base-spec alignment + export.** The frontmatter's
  canonical key is `name:` (agentskills.io base spec — atoma's id rules
  already satisfy its constraints); `parseFrontmatter` reads `name` OR
  legacy `id` (name wins when both appear), `renderFrontmatter` writes
  `name`, so legacy stores load unchanged and migrate opportunistically
  on the next body save. Runtime identity stays `Skill.id` — the rename
  is an on-disk convention, not an API change. `when_to_use` stays a
  top-level key at home (Claude Code understands it verbatim).
  `skills export <l1> <id> [--out dir]` (`src/skills/exportSpec.ts`)
  writes a PORTABLE SKILL.md carrying ONLY `name` + `description`
  (when_to_use folded in, capped at the spec's 1024) — the sole shape
  accepted everywhere including the claude.ai upload path, which
  hard-errors on any key outside the base six. `kind: script` and event
  skills are REFUSED at export rather than mistranslated (the spec's
  executable convention is a scripts/ dir, not an envelope-contract
  body; event skills are coupled to the mid-run matcher). Counters and
  stamps never ship — trust is runtime-local. Covered by
  `tests/skill-spec-compliance.test.ts`.

- **`skills review` — the mechanical half of the cross-org review gate.**
  `assessShareability` (`src/skills/shareability.ts`, pure) answers "would a
  reviewer reject this body outright?" for every skill: leakage literals from
  the originating run (concrete input filename, absolute path, pinned port,
  external host), tool names the OWNING L1 cannot declare, the static scan on
  `kind: script` bodies (with the same loopback allowance the promotion path
  uses, via `hostAllowsLoopbackNetwork`), and TWO counter warnings.
  `trust:unmatched-credit` when `matches` outran the runs driven — worded as
  an OBSERVATION, never a cause: checked against the traces, `probe-crud`
  (gap 3) and `document-api-from-server-source` (gap 1) match their recorded
  `credit-withheld` events exactly, but the two Hydrogen gaps have none, and
  a run that died before its hook leaves identical arithmetic.
  `trust:counter-eras` when `matches` falls BELOW the runs driven, which is
  impossible within one era — measured live: `build-argv-file-cli` reads 10
  matches against 23 successes, because `matches` was added to the schema
  after those successes accrued. Silence there was a bug in the first
  revision: a reviewer reads "no warning" as "the counters agree", which was
  the opposite of the truth for three of the eight skills with a gap. Event skills return
  `not-shareable` — a trigger is matched against THIS deployment's validator
  wording, so offering one elsewhere is meaningless rather than unsafe.
  IT IS NOT THE GATE, and must never be cited as one: `docs/saas-architecture.md`
  §4.2 requires a HUMAN to read both kinds — script bodies because they are
  executed in another tenant's sandbox with no validator, llm bodies because
  they are injected into another tenant's system prompt. A clean verdict means
  a reviewer's time will not be wasted, never "approved". Same rule as R5 on
  `scanScriptBody`.
  BUILT BEFORE THERE IS A SECOND ORG on purpose: the gate cannot fire today,
  but the criterion applied today is what stops the catalog filling with
  recipes nobody judged by it — a recipe distilled, promoted and trusted for
  months is far more expensive to reject later. The current runtime snapshot
  is intentionally not committed; `npm run skills -- review` is the authority
  on its blocked / review-required / local-only counts. The detector is pinned
  by real incidents:
  `tests/skill-shareability.test.ts` drives every blocker from a real incident
  this repo met (the `node index.js sample.txt` literal, the app-task-tracker
  `validate_html`-on-an-HTTP-host distillation, the probe-crud loopback
  near-miss) — a detector that never fires proves nothing.
  ALSO SURFACED IN THE VIZ: `/api/skills/<l1>/<id>` carries the assessment and
  the Skills pane renders it, so the criterion sits where a human actually
  reads a body rather than only in a command nobody runs — the same rule as
  "viz cards surface the DECISION, not just the call". Fixing that renderer
  also routed its remaining bare strings through `t()`; two of them
  (`'Compteurs'`, `'(vide)'`) were hardcoded FRENCH in the English source, so
  the English UI had been showing French. Note what that says about the
  parity test added the same day: it proves both catalogs hold the same keys,
  never that a call site uses them.
- **Skills CLI** (`npm run skills -- ...`): `list [--l1 <name>]`,
  `show <l1> <id>`, `stats [--l1] [--sim <0..1>]`, `drop <l1> <id>
  [--force]`, `merge <l1> <keep> <absorb> [--force]`,
  `export <l1> <id> [--out <dir>]`, `review [--l1 <name>] [--db <path>]`,
  `reset <l1> <id>`.
  Works against any store via `--dir` or `ATOMA_SKILLS_DIR`. `reset`
  zeroes counters AND clears `promotionRefusedAt` — the sanctioned
  escape hatch for the two promotion dead-ends (`failures > 0` after a
  demotion; a compile refusal on an unchanged body).

## LLM interaction conventions

- All LLM calls go through `LlmClient` (`src/core/llm.ts`). Never call the Anthropic
  SDK directly from atom code.
- **Prompt caching (`cache_control: ephemeral`) is on by default** for system
  prompt and the last tool. Leave it on unless you have a measurement-backed reason.
- Model IDs live in `src/core/models.ts`: `PIN_HAIKU`
  (`claude-haiku-4-5`), `PIN_SONNET` (`claude-sonnet-5`),
  `FALLBACK_OPUS` (`claude-opus-5`). L3 resolves Opus dynamically at
  construction via `resolveLatestOpus`.
- **Per-tier model selection is PROVIDER-AGNOSTIC: `modelForTier(tier)`**
  reads `ATOMA_MODEL_L1/L2/L3` at call time (defaults = the pins above)
  and is the ONLY place tier→model policy lives — L1/L2/L3 atoms,
  validators and prefilters all draw from it (validation always rides
  the L1 tier's model). The vars are named by TIER, not by vendor model
  family, so any provider's ids work: `ATOMA_MODEL_L3=sonnet` under
  claude-cli (no-Opus plans), a qwen gradient under ollama
  (`resolveOllamaModel` honours explicit non-`claude-*` values verbatim,
  while Anthropic pins still collapse onto `defaultModel`), or future
  clients' ids as-is. An explicit `ATOMA_MODEL_L3` also SKIPS
  `resolveLatestOpus`'s network call. Covered by
  `tests/model-tiers.test.ts`.
- **The process-wide `ATOMA_LLM` selector has ONE parser:
  `resolveBaseProviderKind` in `src/run/providers.ts`.** Runner and curriculum
  both consume it, including the bare `claude` alias. Before this, curriculum's
  copy missed that alias and silently fell into the Anthropic API path, turning
  a provider typo into a dead-key error. Unknown values now fail loudly.
  `ATOMA_LLM=codex` is rejected with guidance: Codex cannot serve L1, so it is
  reachable only through L2/L3 `provider:model` tier pins. Pure tests pin every
  alias and both rejection messages.
- **Cross-VENDOR tier routing (`RoutingLlmClient`,
  `src/core/llmRouting.ts`).** A tier pin may carry a `provider:` prefix
  — `ATOMA_MODEL_L1=zai:glm-4.5-air` routes every L1 call to Z.ai while
  L2/L3 stay on the session's default provider. Parsing is deliberately
  conservative: the prefix routes ONLY when it names a CONFIGURED
  provider, otherwise the whole string is a model id for the default
  client (Ollama tags legitimately contain colons — `qwen3:8b` must not
  parse as provider "qwen3"). `buildReferencedProviders`
  (`src/run/providers.ts`) constructs only the providers actually
  referenced by tier pins: zai (Anthropic-COMPATIBLE endpoint
  `https://api.z.ai/api/anthropic`, served by the existing
  `AnthropicLlmClient` with `ZAI_API_KEY`/`ZAI_BASE_URL` — same trick
  Claude Code users employ for GLM), anthropic, ollama, claude-cli, codex.
  Observability decorators wrap the ROUTER, so calls record once and the
  recorded model id keeps its prefix — the vendor stays visible in
  traces and cost tables. `DEFAULT_PRICES` has an APPROXIMATE `/glm/i`
  row plus per-slug GPT-5.6 rows; override with a custom PriceTable for
  billing-grade numbers.
  Covered by `tests/llm-routing.test.ts`. The 5-series pins reject
  sampling params (the client omits `temperature`/`top_p` via
  `modelSupportsSamplingParams`) and run adaptive thinking by default —
  thinking counts against `max_tokens`, which is why `STRATEGY_MAX_TOKENS`
  is 8000 (was 3000: a plan call could otherwise burn the whole cap on
  thinking before emitting a token).
- **`output_config: {effort}` on plan/strategy calls.**
  `GenerationParams.effort` (`'low'|'medium'|'high'`) is sent by
  `AnthropicLlmClient` only when the caller pins it AND
  `modelSupportsEffort(model)` is true (Sonnet 4.6+/5, Opus 4.5+/5,
  Fable/Mythos — Haiku 4.5 and Sonnet ≤4.5 reject the param with a
  400). `L2.plan` and `L3.plan` pin `effort: 'medium'`: those models
  default to `'high'` (the most expensive setting) and a routing-JSON
  plan doesn't need it. Validators/prefilters run on Haiku and never
  carry it. Covered by `effort-param.test.ts`.
- **Alternative provider: Ollama (`src/core/llmOllama.ts`).** The
  `OllamaLlmClient` implements the same `LlmClient` interface and
  targets any Ollama-exposed model (local or Ollama-Cloud via a
  `:cloud` tag). Activate via env: `ATOMA_LLM=ollama` (default:
  `anthropic`). Optional `OLLAMA_BASE_URL` (default
  `http://localhost:11434`) and `OLLAMA_MODEL` (default
  `glm-5.1:cloud`). Implementation notes:
    - The request's `req.model` field is IGNORED — our atom tier
      dispatches Haiku vs Sonnet vs Opus but Ollama runs a single
      model per endpoint, so all three tiers collapse onto the
      configured `defaultModel`. Cost-discipline call-graph shape
      still holds; only per-call cost changes.
    - `cache_control` is Anthropic-specific; Ollama silently ignores
      it. `usage.cacheReadInputTokens` stays 0 — cache metrics are
      meaningless for this path.
    - Every request pins `num_ctx=32768` by default (override
      `OLLAMA_CONTEXT_LENGTH`, minimum 8192). Ollama otherwise starts even
      131K-capable models at its 4096 server default; a live hybrid run reached
      L1 with a 7520-token prompt and hard-400ed before one tool call. Atoma's
      constant system prompts make 4K structurally unusable, not merely small.
    - The declared-tools scope gate (#8a) is mirrored in the Ollama
      tool-use loop: off-scope `tool_calls` get a `role: "tool"`
      error appended and `onToolInvocation` fires with `error`, with
      the executor untouched. Safety contract is provider-neutral.
    - Tool budget exhaustion mirrors `AnthropicLlmClient`: one
      tools-disabled round-trip with a `TOOL BUDGET EXHAUSTED` user
      message to force a final text reply.
    - L3's `resolveLatestOpus` network call is SKIPPED under Ollama
      — `runTask` passes `anthropic: undefined` to
      `L3Atom.fromType`, so L3 uses the `FALLBACK_OPUS` id string
      which the Ollama client then maps to `defaultModel`.
- **A hung transport cannot outlive its deadline (two guards).** The
  run-level `AbortSignal.timeout` is ADVISORY — it cancels work that
  OBSERVES it, and a subprocess wedged on a dropped connection observes
  nothing: the SDK stream never yields a `result` and the await never
  settles, so `l3.handle` stays pending and the event loop is held open
  by the stuck handle. Found live (2026-08-06): a `build-app` process
  alive after **11 DAYS** with 2 minutes of CPU, still holding a headless
  Chrome and an esbuild service. Two layers now close it:
  (1) PER-CALL INACTIVITY DEADLINE in `ClaudeCliLlmClient.completeOnce`
  — `cliCallTimeoutMs()` (default 10 min, `ATOMA_CLI_CALL_TIMEOUT_MS`,
  invalid/zero/negative falls back to the DEFAULT so a typo cannot
  disable the guard). The clock measures SILENCE: it is rearmed on every
  stream message, so a long call is fine and only the absence of progress
  fires. On expiry it aborts the controller — which is what terminates
  the subprocess, not merely stops waiting — and throws a labelled error
  the supervise loop can escalate on. A caller-supplied abort still wins
  and is NOT relabelled. It shipped as a TOTAL-duration cap and that was
  wrong, measured: a web run doing 12 headless validations (28s each,
  plus thinking between rounds) was killed at 10 minutes while STILL
  emitting tool calls — the guard built to stop an 11-day zombie had
  started killing healthy work, the one thing a hang detector must never
  do. No executor-side rearm is needed (every tool round emits stream
  messages, and each builtin has its own sub-minute timeout). Covered by
  `llm-claude-cli-timeout.test.ts`, whose long-but-active case outlives
  the deadline on purpose.
  (2) LAST-RESORT WATCHDOG in `runTask`: at `timeoutMs + 60s`, if
  `l3.handle` still has not settled, persist the partial trace
  (`cancelled: true`) and `process.exit(1)` synchronously — awaiting
  `sandbox.cleanup()` there would re-enter the same class of hang, and
  the sandbox's process-level exit handler SIGKILLs tracked children
  anyway. The burn-in harness already group-kills its children past a
  hard timer; this brings the same guarantee to MANUALLY launched runs.
  Covered by `tests/llm-claude-cli-timeout.test.ts`, which drives a
  never-yielding stream (the exact wedged shape) and also pins that
  production spawns exactly ONE subprocess per call.
- **Alternative provider: Claude Code CLI (`src/core/llmClaudeCli.ts`).**
  `ClaudeCliLlmClient` routes every LLM call through the LOCAL Claude
  Code installation via the Claude Agent SDK — subscription auth
  (`claude /login`), NO API key. Activate via `ATOMA_LLM=claude-cli`.
  Implementation notes:
    - `req.model` maps to CLI ALIASES by tier (/haiku/→'haiku',
      /sonnet/→'sonnet', /opus/→'opus') because subscription-served
      model versions shift while aliases stay valid. Per-tier selection
      does NOT live in this client: it's the provider-agnostic
      `ATOMA_MODEL_L1/L2/L3` (see `modelForTier`), whose values arrive
      as `req.model` — e.g. `ATOMA_MODEL_L3=sonnet` is the
      no-Opus-on-this-plan escape hatch, the alias passes through
      verbatim and the L1/L2 gradient below survives.
      `ATOMA_CLAUDE_MODEL` (ALL tiers onto one model) is DEBUG-ONLY: it
      deliberately flattens the cost gradient the whole project exists
      to exploit, and the runner banner shouts when it is set.
    - Tools are bridged through an IN-PROCESS MCP server whose
      handlers call `req.executor` directly — sandbox, truncation
      (`truncateToolResultContent`), and `onToolInvocation` all
      apply. Built-ins are disabled (`tools: []`) so the model can
      ONLY use atoma's declared tools (the #8a scope gate at harness
      level); `toolAliases` maps bare names (write_file) onto MCP
      names (mcp__atoma__write_file) so prompts stay provider-neutral.
    - **Thinking parity (`cliThinkingFor`)**: haiku-tier calls get
      `thinking: {type:'disabled'}` — on the API, Haiku 4.5 thinks only
      on explicit request (never made by atoma), but the CLI defaults
      adaptive thinking ON with `maxTokens` advisory-only. Measured: an
      L3 prefilter emitted 3,017 tokens over 35.6s for a 256-token-capped
      routing decision; five Haiku prefilters = 35% of a warm run's wall
      time. Gate is the RESOLVED alias so ATOMA_CLAUDE_MODEL overrides
      keep their own tier's semantics. Sonnet/Opus keep the adaptive
      default (API parity; their plan calls are bounded by the effort pin).
    - `settingSources: []` keeps the subprocess in SDK isolation —
      no CLAUDE.md / project settings bleed into atom prompts. The
      subprocess env DROPS any exported ANTHROPIC_API_KEY so a stale
      key can't shadow the CLI's OAuth login.
    - `@anthropic-ai/claude-agent-sdk` peers on zod@^4 while atoma is
      on zod@3, and the bridge deliberately avoids the SDK's zod4-only
      `tool()` helper by registering tools on a raw `McpServer`
      (zod3-compatible) via `jsonSchemaToZodShape`. Don't switch to
      `tool()` without migrating the repo to zod 4.
      THE CONFLICT IS RESOLVED IN `package.json`, NOT IN THE OPERATOR'S
      FINGERS. It needed `npm install --legacy-peer-deps` until
      2026-08-12 — which meant the ONE command every doc and this file's
      own Commands section print, `npm install`, exited ERESOLVE for
      anyone starting from a clean checkout. A flag you must know but
      that nothing tells you is not a workaround, it is a broken
      install. The `overrides` entry pins the SDK's `zod` peer to `$zod`
      (the root's own range), which is TARGETED where the flag was
      global: `--legacy-peer-deps` waves through EVERY peer conflict in
      the tree, including the next one, unseen. Verified to change
      nothing else — the resolved tree is byte-identical to what the
      flag produced (zod 3.25.76 flat, no nested copy, SDK unmoved), and
      `npm ci` / `npm install` both succeed from a clean room.
      Note npm does NOT record this override in `package-lock.json`
      (nothing in the resolution moved), so the lockfile is no evidence
      it is there — read `package.json`.
    - Costs printed by metrics are API-price equivalents of the token
      counts; on a subscription nothing is billed per token. Each
      `complete()` spawns a CLI subprocess — runs are slower than the
      direct API (~2-5s overhead per call).
- **Project-level Claude Code settings NEVER pre-authorize shell execution.**
  `.claude/settings.json` is committed and therefore crosses the trust
  boundary to every collaborator who opens the repository. It used to carry
  `Bash(*)` followed by dozens of narrower Bash rules; the first entry made
  every later one decorative and allowed deletion, network access, secret
  reads and destructive Git without another confirmation. Even an apparently
  narrow `Bash(bash *)`, `Bash(node *)` or `Bash(python *)` is the same complete
  escape hatch. Shell preferences belong in ignored
  `.claude/settings.local.json`, never in the project file. A test rejects any
  committed `Bash(` grant and pins the local-file ignore. This applies to the
  INTERACTIVE assistant; the atoma claude-cli transport already ignores
  project settings via `settingSources: []`.
- **Codex MCP registration is local configuration too.** `.codex/config.toml`
  carries an absolute checkout path plus a command the client executes, so it
  is ignored and never committed. Codex CLI stores active registrations in
  `~/.codex/config.toml`; use `codex mcp add atoma -- node <abs>/dist/mcp/stdio.js`.
  The working operator registration uses that compiled path; verified through
  a read-only `codex exec` call that invoked `atoma_families` exactly once and
  returned `1 build` without shell/file access. Do not point it at
  `src/mcp/server.ts` — `stdio.ts` is the bootstrap that claims stdout before
  loading the application graph, while `server.ts` alone neither claims the
  protocol stream early enough nor boots a transport.
- **Alternative provider: Codex CLI on a ChatGPT subscription
  (`src/core/llmCodexCli.ts`) — TIERS 2/3 ONLY, and the restriction is
  STRUCTURAL.** Reached through a tier pin's provider prefix
  (`ATOMA_MODEL_L3=codex:gpt-5.6-sol`); auth is whatever `codex login`
  holds, and an ABSENT `OPENAI_API_KEY`/`CODEX_API_KEY` is precisely what
  makes it reuse the subscription.
  **L1 IS REFUSED BY A THROW, NOT BY CONVENTION.** Codex offers no way to
  disable its OWN built-in tools while keeping external ones
  (openai/codex#6049, open since 2025-10, PR #5001 closed, community
  contributions not accepted), so the trick that makes `ClaudeCliLlmClient`
  safe at L1 — `tools: []` plus an in-process MCP bridge, hence every side
  effect through `req.executor` — has NO equivalent here. A toolset would
  mean the model acting on the filesystem outside `ToolSandbox`: no jail,
  no #8a scope gate, no `record_probe`, no probe manifest, no
  `VizToolEvent`s, and none of the 93.5% cache_read the execute path lives
  on. `complete` therefore throws (naming a working L1 pin) rather than
  degrading silently — a wrong tier pin must fail at the first call, not
  produce an unobservable run. It costs nothing architecturally: L2/L3
  never pass `tools` or an `executor`, so their calls are pure text
  completions.
  AN EXPERIMENTAL L1 ENV HATCH EXISTED BRIEFLY AND IS DELETED. Commit
  `494e5fd` let `ATOMA_CODEX_L1_WORKSPACE` bypass the throw and switch Codex
  to `workspace-write`. That was not a cautious version of the same contract:
  it discarded ToolSandbox, credential stripping, process-group reaping,
  `record_probe`, the scope gate, output truncation and every VizToolEvent,
  then asked the model to reproduce the missing guarantees by hand. Validating
  the path more carefully cannot restore mechanisms the transport does not
  expose. The hatch was removed rather than documented as a supported mode,
  and a test sets the old env var deliberately and proves that zero subprocess
  spawns before the structural refusal.
  WHY A SUBPROCESS AND NOT `@openai/codex-sdk`: the CLI exposes MORE
  isolation than the SDK's `ThreadOptions` (`--ephemeral`,
  `--ignore-user-config`, `--ignore-rules` have no counterpart there) for
  ZERO new npm dependencies — and `@anthropic-ai/claude-agent-sdk` already
  cost the project a peer-dependency override over the zod3/zod4 split.
  `buildCodexArgs` is where the isolation lives and is what the tests pin:
  `-s read-only` (L2/L3 emit text; a plan call that can edit disk can
  corrupt what it is planning for) and `-C <empty dir outside the repo>` —
  THE load-bearing one, since Codex keeps its own shell/read tools, so the
  cwd is what bounds their reach and keeps `atoma.db`/`skills/` off the map
  (the same reasoning that moved the build workspace out of the repo).
  Each client creates one OS-temp jail for its empty cwd and instruction
  files. Those roots are tracked module-wide and removed synchronously on
  process exit; `cleanupCodexJails` also gives tests and long-lived embedders
  an explicit release point. Before this, every process left an
  `atoma-codex-*` directory behind indefinitely.
  MEASURED 2026-08-11, codex-cli 0.147.0: **ZERO parasitic tool turns** on
  a real L3 plan prompt (one `agent_message`), output already
  `parseTwoJson`-shaped, ~15s wall, and usage complete on `turn.completed`
  INCLUDING **74% cache reads** — the "no prompt caching" assumption was
  wrong. ~9.7k input tokens of irreducible harness overhead per call
  (Codex's own tool declarations — #6049 is what prevents removing them);
  `-c model_instructions_file=` carries the ATOM's system prompt and
  removes a further ~3.5k. `experimental_instructions_file` and
  `base_instructions_file` are silently IGNORED — only the first key works.
  MODEL SLUGS ARE NOT MODEL FAMILIES. A ChatGPT account serves
  `gpt-5.6-sol` / `-terra` / `-luna` / `gpt-5.5` / `gpt-5.4` /
  `gpt-5.4-mini` (read `~/.codex/models_cache.json`); bare **`gpt-5`
  hard-400s** ("not supported when using Codex with a ChatGPT account"),
  so `resolveCodexModel` rewrites it, maps Anthropic tier defaults by
  POWER, and passes an unknown slug through verbatim so a new release needs
  no code change. Effort maps straight across (Codex accepts
  low|medium|high|xhigh|max) and is the one real cost lever — `maxTokens`
  is advisory-only here, as under claude-cli.
  USAGE CONVENTIONS DISAGREE, AND THE DIFFERENCE IS BILLABLE. OpenAI counts
  `cached_input_tokens` INSIDE `input_tokens`; Anthropic's three counters
  are DISJOINT and `estimateCostUsd` is built on that. Verified rather than
  assumed: two identical calls both reported `input=9768 cached=6912`, so
  `mapCodexUsage` SUBTRACTS the cached portions (clamped at zero). This is
  NOT the forbidden subtraction that once produced negative costs — that
  one subtracted from already-disjoint counters. Reasoning tokens are added
  to output (measured 186 output / 41 reasoning, reported separately);
  ignoring them would make a high-effort plan read as nearly free.
  PRICED ON PURPOSE, even though a subscription bills nothing per token:
  unmatched models fall to 0/0/0, and "free" Codex calls would make any
  tiering comparison flattering and false — the spend has moved to another
  subscription, not vanished. Note the honest consequence: `gpt-5.6-sol` at
  $5/$30 is DEARER on output than Opus 5's $5/$25, so pinning L3 here is a
  SUBSCRIPTION saving, not an API one. Same per-call inactivity deadline as
  claude-cli (`ATOMA_CODEX_CALL_TIMEOUT_MS`, silence-measuring, rearmed by
  every JSONL event) — and its test found a real bug: a failed spawn leaves
  no pid, so a kill-only deadline killed nothing and hung forever, the
  exact 11-day-zombie shape the guard exists to remove. The deadline now
  settles the wait itself. NOT YET MEASURED: decomposition QUALITY on real
  L3 prompts across a burn-in batch — one hand-built prompt is not
  evidence. Covered by `tests/llm-codex-cli.test.ts` (38 cases).
  DO NOT CONFUSE THE TWO USES OF CODEX IN THIS REPO. The interactive
  assistant (`codex` in the repo root) DOES read this file natively —
  verified: it names it and quotes its first line with zero tool calls.
  The atoma TRANSPORT never sees it, by construction: `--ignore-user-config`
  plus an empty cwd outside the repo. That is deliberate — an atom's prompt
  is the atom's, and leaking the project's engineering record into a
  routing decision would be the `settingSources: []` bleed that the
  claude-cli transport exists to prevent. So a rule added here changes what
  the assistant knows and changes NOTHING about how atoma runs.
- **Run auth (`src/run/auth.ts`).** `makeAnthropicClient`
  builds the direct-API client from the SDK's native credential chain:
  ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN → `ant auth login` OAuth
  profile (zero-arg `new Anthropic()`, SDK ≥0.93). `ATOMA_AUTH=cli`
  drops a set ANTHROPIC_API_KEY first so a stale exported key can't
  shadow a working CLI profile (the #1 auth trap — the chain puts the
  env key first).
- **All JSON parsing from LLM output lives in `src/atoms/json.ts`**. Shared helpers:
  - `parseWith(schema, text)` — schema-validated parse of a single JSON payload.
  - `extractJson(text)` — robust JSON extraction tolerant of prose/fence wrapping.
  - `parseTwoJson(text)` — `[strategy, plan]` pair parse; handles pure arrays,
    fenced blocks, back-to-back objects, and truncation repair.
  - `parsePayloadTolerant(text)` — `{output, summary}` parse with fallback to
    wrapping the raw text when Opus/Sonnet ignores the JSON envelope in
    fallback mode. Used by `L2Atom.selfExecute` and `L3Atom.selfExecute`.
  - `repairTruncatedJson(raw)` — balances unterminated strings/brackets so we
    can salvage a mid-response cutoff.
  - `findBalancedEnd(s, start)` — string-aware bracket matcher used by the
    parsers. Do not reinvent these; extend them if a new shape appears.
- **NESTED ``` FENCES DESTROY EVIDENCE — the gate is load-bearing.** The fence
  regex is non-greedy, so it stops at the FIRST closing ``` — and an L1
  obeying the GROUND-TRUTH contract pastes shell output into `summary`, which
  routinely contains a nested ```bash block. The capture then ended
  mid-string, `repairTruncatedJson` closed it into something **schema-valid
  but amputated**, and `parseWith` returned that lossy object *without ever
  reaching* its candidate-scan fallback. Measured on run
  `2026-07-25T22-10-42`: a 162-char summary reached the validator as 39 chars
  with the `## Usage` proof gone → correct rejection → a whole wasted
  supervise cycle; a phase-1 summary was silently cut from 2620 recoverable
  chars to 308, so the next phase ran blind. Three guards now:
    1. `fencedPayloadIsBalanced` — a fence capture is only trusted when it
       holds a BALANCED payload; otherwise the fence is ignored and the brace
       walk over the full text recovers the object (backticks inside a JSON
       string are legal there). Same gate in `parseTwoJson`, whose fence
       branch `JSON.parse`s with no repair net at all.
    2. `extractJsonEx` reports `repaired: boolean`; `parseWith` holds a
       repaired-but-valid parse aside as a LAST RESORT and prefers a clean
       candidate — but only one that is strictly LARGER (`safeSize`), so a
       short example envelope quoted in prose can't displace the real payload.
    3. Do **NOT** add a "try the first balanced object" step ahead of the
       legacy first-`{`-to-last-`}` slice in `extractJsonEx`. It looks free
       and it silently defeats the prefer-the-LAST-candidate semantics: on a
       response that shows an example envelope before the real payload it
       returns the example. Guarded by
       `does NOT hijack the "prefer the LAST candidate" semantics` in
       `tests/json.test.ts` — that test exists because the fix attempt
       broke it twice.

## Testing conventions

- Unit tests are under `tests/`. They run against `MockLlmClient` (no network).
- Registry tests use `openDb(':memory:')` — fast, isolated.
- Supervision-loop logic is tested with `FakeParent`/`FakeChild` (see
  `tests/supervision.test.ts`). Don't hit real atom classes for those tests;
  they'd pull in LLM parsing and hide loop bugs.
- When adding a new mechanism, write at minimum one direct supervisor-loop test
  and one registry state-assertion test.
- **CI proves a CLEAN CHECKOUT, not the developer machine.**
  `.github/workflows/ci.yml` has two jobs. `core` ("Hermetic checks — Docker
  integration skipped") runs `npm ci` then
  `npm run check` with no registry, skills, runs or prebuilt worker image —
  this is the path that catches a hidden install flag and an import that reads
  ignored runtime data. `worker`, only after core is green, builds
  `atoma-worker:latest` from the current commit and runs the real container
  isolation suite with `CI_REQUIRE_DOCKER=1`, so a missing daemon/image is a
  FAILURE rather than six silently skipped tests. It also runs `record_probe`
  through the real worker. Main-branch runs are never cancelled mid-worker;
  pull-request supersessions may still cancel. A stale local image cannot
  satisfy this job. The jobs pin Node
  22.13 because the current lint dependency requires ≥22.13 on the 22.x line.
  `package.json#engines` carries the honest full-repo floor
  (`^20.19 || ^22.13 || >=24`) rather than the old `>=20`, which emitted
  EBADENGINE on a supported-looking Node 22.12 install. No provider credential
  is present and every LLM call in the suite is mocked.
  The dependency tree is audit-clean as of 2026-08-12. Runtime fixes came via
  MCP SDK 1.30 and patched transitive Hono/ws/fast-uri/basic-ftp releases;
  dev fixes required Vitest 4 / Vite 8 and esbuild 0.28. `tsx` still requested
  the vulnerable 0.27 line, so the root esbuild dependency plus `$esbuild`
  override keeps all three consumers on one patched binary. `npm ci`,
  `npm audit` and the full suite were rerun after the major test-runner update.

## Linting (`npm run lint`, `eslint.config.js`)

ESLint 9 flat config + typescript-eslint, **type-aware on purpose**. `tsc`
already covers what the type system can prove, so a syntax-only linter would
add ceremony and find nothing; the rules earning their place are the ones the
compiler cannot express — a promise nobody awaited, an `await` on a
non-thenable, an async callback passed where void is expected. This codebase is
almost entirely async orchestration, so that is its bug class. (Measured on the
first run: **zero** floating-promise and zero misused-promise hits. The async
discipline was already clean; the rule stays as a ratchet.)

`npm run check` = typecheck + lint + test.

CALIBRATED OFF, WITH MEASUREMENTS — do not re-enable without re-measuring:
- `require-await` — **128 hits, every one structural**: a hook or mock that
  must be `async` to satisfy an interface returning a Promise
  (`SupervisionHooks.applyByScope`, `LlmClient.complete` in the test doubles)
  while one branch happens not to await. The rule cannot see the contract.
- the `no-unsafe-*` family — LLM output is parsed as `any` and narrowed by a
  zod schema; the schema is the real guard. Making these errors would mean
  asserting types we deliberately do not trust yet.
- `restrict-template-expressions` — counters, model ids and costs are
  interpolated everywhere and the stringification is intended.
- `no-explicit-any` is a WARNING, and is NOT disabled for tests. The suite
  already carries ~40 hand-written disable comments for it, which means its
  author wanted it on with local opt-outs; switching it off silently kills 40
  deliberate annotations. CI is warning-free as of 2026-08-12: the final eight
  active warnings were SDK/framework mocks that now use `Anthropic`,
  `LlmClient` and `ModelListingClient` (with an `unknown` bridge where a
  deliberately partial SDK object is the test subject).

`reportUnusedDisableDirectives` is on, and it earns its keep: it found 45 dead
directives, 39 of which came back to life the moment `no-explicit-any` was left
enabled for tests. A disable comment for a rule that no longer fires reads as a
live caveat.

THE TRAP THIS SETUP ALREADY SPRUNG, recorded so nobody repeats it:
`only-throw-error` flags `throw raise(err)` in `src/core/llm.ts` because
`raise` returns `never`, not an Error. Removing the `throw` **breaks the
build** — TypeScript's never-returning-function control-flow analysis does not
apply to `raise` there, so a bare call leaves `response` "used before being
assigned" on three lines below. The lint rule and the type checker disagree and
the type checker wins; the site carries a disable comment explaining exactly
that. Always run `npm run typecheck && npm test` after acting on a lint
finding — `--fix` is not free.

WHAT IT FOUND ON FIRST CONTACT (three real defects, all in `src/`):
- `viz/friction.ts` stringified model-authored tool args with `String(v)`, so
  any object argument became `'[object Object]'` — collapsing N unrelated
  failures into one signature and making `distinctArgs` report 1. That column
  exists precisely to expose pseudo-recurrence, so the bug disabled the
  diagnostic it lives in. Now `argScalar`.
- `atoms/groundTruth.ts` coerced a `content-type` header of `unknown` type the
  same way; an object would have made the html sniff silently always-false.
- ~29 dead imports and two dead private helpers (`tryParseJson`, an unused
  `ext`) left over from the L2Atom extraction campaign. Note the shape that
  made them safe to remove: the compat layer re-exports via
  `export { X } from './y.js'`, which is INDEPENDENT of the `import { X }`
  above it — the import was genuinely dead and the re-export keeps working.

## The test suite is type-checked now (it never was)

`tsconfig.json` excludes `tests/` and vitest transpiles with esbuild, which
does not typecheck — so for the life of this project **nothing ever
type-checked the test suite**. When `tsconfig.all.json` first put it under the
compiler it reported **96 errors across 29 files**. All fixed, 2026-08-10, with
1042/1042 still passing and zero changes under `src/`.

`npm run typecheck` now runs BOTH projects: `tsconfig.json` (the build config —
still the one that validates rootDir and declaration emit) and
`tsconfig.all.json` (every file the repo owns). The guard is verified, not
assumed: injecting `const x: number = 'str'` into a test makes `typecheck` exit
2 while `vitest` passes it silently — which is precisely the hole that existed.

WHAT THE 96 WERE, because the shape is the lesson: two stale literal shapes
accounted for most of them. `Tool` was being hand-built as
`{name, description, parameters, execute}` when the contract has long been
`{name, description, inputSchema}` — a DECLARATION, with the executor living on
`BuiltinTool`. And `Plan` was built as `{reasoning, proposedAction,
expectedOutput}`, the pre-fan-out shape, missing the now-required `subtasks`
and `aggregation`. Both drifted for months because nothing looked, and the
tests kept passing because the code under test only reads `.name` off a tool.
**A test asserting against a shape the code no longer produces is not testing
what it claims.**

`tests/helpers/factories.ts` (`makeTool`, `makeTools`, `makePlan`) exists so the
next contract change breaks one factory instead of silently leaving thirty
tests green against a dead shape. Use it rather than hand-writing either shape.

The rest were: missing `override` modifiers, `find()`/index results used
without a null check under `noUncheckedIndexedAccess`, `BuiltinTool[]` passed
where `readonly Tool[]` was wanted (needs `.map(t => t.declaration)`), and
assignments to readonly `RunContext` fields.

TWO CLAIMS FROM THAT PASS THAT DID NOT SURVIVE CHECKING, recorded because the
second is the kind of thing that gets acted on:
- `ToolExecutor.has()` was reported as required-but-never-called dead API. It
  is called FOUR times, all in `src/atoms/groundTruth.ts` (165, 185, 481, 566),
  and they are the bucket gate for the ground-truth probe — invariant #9. Do
  not remove it.
- `AtomRegistry.remove`'s protection was reported as surprising. It is
  CLI-only and always was; see the `remove` entry under "Things that look wrong
  but aren't".

## Tools (L1 side-effects)

- `src/tools/` hosts the whole tool machinery. L1 is the only tier that
  executes tools; L2/L3 only pass declarations through as context.
- **`ToolSandbox`** (`src/tools/sandbox.ts`) — filesystem + child-process jail
  rooted at a workspace directory. All built-in tools resolve paths through it
  and refuse to escape the root. A module-level `process.on('exit')` handler
  SIGKILLs every tracked `ChildProcess` even on crash-exit paths where
  `sandbox.cleanup()` never runs (uncaught exceptions, unhandled rejections,
  hard `process.exit(code)`). Without this, failed runs left stale Python
  `http.server` children squatting common ports and every subsequent run
  burned ~5s per port on EADDRINUSE auto-retries. Do NOT register custom
  `uncaughtException` / `unhandledRejection` handlers from here — Node's
  default policy calls `exit` anyway, and swallowing errors globally hides
  real bugs (we tried it, it produced silent 42s hangs).
  - **run_shell kills its whole process GROUP (#7c).** `runShellTool`
    spawns `detached: true` (own POSIX process group) and SIGKILLs the
    group (`process.kill(-pid)`) on exit, error AND timeout — the old
    promisified-execFile path signalled only the direct child, so
    `bash -c "python3 -m http.server 0 &"` double-forked and the server
    survived as an untracked orphan (observed live: two http.servers from
    a Saturday session still squatting ports — one on 8000 — the
    following Tuesday, degrading every web run's boot sequence with
    EADDRINUSE retries). This makes the tool's declared "do NOT use for
    long-running processes" contract ENFORCEABLE: `&`-backgrounded
    grandchildren are reaped when the command ends, by design — a model
    that wants a live server must use start_static_server /
    start_node_server, whose children the sandbox tracks and reaps. The
    global exit handler also tries the negative-pid kill first for the
    crash-exit path. Covered by the #7c tests in
    `sandbox-security.test.ts`.
  - **The run_shell executable allowlist is STEERING, not a boundary.**
    `DEFAULT_SHELL_ALLOWLIST` (`src/tools/builtin.ts`) is rendered into
    the tool description, so its contents tell the model what the house
    considers normal — but it cannot contain anything: `bash`, `node -e`
    and `python3 -c` are all on it and each is a complete escape hatch
    (verified empirically: `bash -c "head …"` runs `head` fine, `curl`
    is reachable the same way). Containment lives elsewhere and is
    unchanged: the env allowlist (#7a), the scratch HOME, the workspace
    cwd, the process-GROUP SIGKILL (#7c), the 30s timeout. So the list is
    curated for FRICTION, not defence: it carries the read-only
    inspection utilities (the cat/ls class: grep, head, tail, wc, sort,
    uniq, diff, find, cut, tr, basename, dirname, printf, date, pwd,
    env) and the workspace-shaping ones that mirror what write_file /
    edit_file already do (mkdir, touch, cp, mv, chmod, sed, awk) —
    `grep` (6 rejections), `head` (5) and `chmod` (3) were the measured
    friction across archived traces. DELIBERATELY ABSENT, for coherence
    not danger: `curl`/`wget` (network reach is a DECLARED bucket
    capability — `fetch_url` is the observable path that emits trace
    events and that `hostAllowsLoopbackNetwork` keys on; an L1 without
    it should not have been sent after HTTP at all), `git` (the
    workspace sits INSIDE this repo and git discovers the nearest
    ancestor `.git` — a stray `checkout`/`clean` would hit the user's
    uncommitted work), `rm` (never in the friction data; scratch cleanup
    already goes through `node -e … rmSync`). A rejection now coaches
    the fix: a `command` carrying shell metacharacters is named as a
    shell LINE with both correct shapes, and the generic message points
    at `bash -c` for anything else and at `fetch_url` for network.
  - **Headless Chrome is a TRACKED child, not just a cleanup hook.**
    `validateHtmlTool` closed its shared browser through
    `sandbox.onCleanup` — async, and therefore only on the orderly path.
    A hard exit (burn-in group-killing a run at its wall-clock budget,
    the runner watchdog, a crash) skips it and Chrome survives with
    its helper fleet. Measured 2026-08-08: a web run killed at its 900s
    budget after 46 validations left its browser behind, and 126
    puppeteer processes (42 reparented to init, up to 22h old) had
    accumulated — enough machine load that the NEXT TWO runs blew their
    own budgets. A leak that cascades into failures, not just waste, and
    the exact class the #7c http.server reaping already closed for
    run_shell. `browser.process()` is now registered via `trackChild`,
    putting it under the same synchronous `process.on('exit')` SIGKILL as
    every other child; the graceful `browser.close()` hook stays for the
    orderly path. `trackedChildPids()` exists so the guarantee is
    testable from outside — `tests/puppeteer-orphan-reaping.test.ts`
    drives a real hard exit and was verified to FAIL without the fix.
    THAT ALONE WAS NOT ENOUGH, and the second half is the load-bearing
    one: the burn-in harness went straight to `SIGKILL` on the run's
    process group, and SIGKILL is uncatchable — no `exit` handler, no
    reaping, ever, on the path every burn-in run takes. A/B'd on the
    faithful shape (detached child + group signal): **group SIGKILL
    leaks 9 puppeteer processes, group SIGTERM leaks 0**, nine being
    exactly what the last web batch left behind. `burnin.ts` now sends
    SIGTERM, waits `KILL_GRACE_MS` (5s), and escalates to SIGKILL only
    if the run ignores it. Deliberately NOT added: a SIGTERM listener in
    the sandbox — the group signal reaches Chrome directly and it tears
    its own helpers down, the test passes with and without one, and a
    listener that `process.exit`s would cut short the very teardown the
    grace window exists to allow.
  - **Env allowlist for child processes (#7a).** `sandboxChildEnv(extra?)`
    builds the environment for every spawned child (`run_shell`,
    `start_static_server`, `start_node_server`) from a small allowlist
    (`PATH`, `HOME`, `TMPDIR`, locale, Node/npm knobs) plus caller
    extras — the parent `process.env` is NEVER spread in. `run_shell`
    executes model-authored code and `fetch_url`/`npm` grant it network
    egress, so an inherited `ANTHROPIC_API_KEY` was a one-liner
    exfiltration (and unbounded-spend) vector. `start_node_server` still
    layers the model-supplied `env` extras on top of the allowlisted
    base — those are TASK-owned config (the task's own API keys, feature
    flags), not ours. Covered end-to-end by `sandbox-hardening.test.ts`
    (a `run_shell` child reads back `unset` for a parent secret).
  - **Symlink containment (#7b).** `ToolSandbox.resolve` was purely
    lexical (`path.resolve` + `relative`), so a symlink planted INSIDE
    the workspace by `run_shell` (`ln -s /etc pwn`) passed the check and
    `read_file` followed it out of the jail — contradicting the class
    docstring. `resolve` now also realpath-resolves the deepest existing
    ancestor of the candidate and re-checks containment against a
    realpath'd `realRoot`. `realRoot` is resolved once at construction
    because common workspace parents are themselves symlinks on macOS
    (`/tmp` → `/private/tmp`); comparing against the lexical root would
    reject every legitimate path. Not-yet-created tail segments (a deep
    new file `write_file` will `mkdir -p`) are re-appended after the
    realpath so writes still validate.
- **`record_probe` — the manifest is written by the MACHINE, not transcribed
  by the model.** The probe manifest exists to replace model-authored prose
  with a machine-readable record ("free-form model-authored markdown is not a
  parseable interface; a machine-written JSON record is") — and was then
  itself written by the model, which pasted observed output into a
  `write_file`. MEASURED on the 2026-08-10 round-2 benchmark: the model
  ABRIDGES long output. Hand-replaying eight archived workspaces, six were
  perfect and two failed almost entirely, and in every failing case the
  recorded stdout was a strict PREFIX of the real one (371 chars against 2008;
  65 against 1029). A compiled verifier comparing byte-for-byte can never
  match that, so two false mismatches auto-demoted a working script one run
  after its first successful zero-token dispatch. `validateProbeManifest`
  checks structure, not completeness, so nothing noticed — and the
  intermittency (most workspaces fine) is why it looked like flakiness.
  `record_probe(command, args, note?, supersedes?)` runs the command AND writes
  the real exit code and complete output into the manifest, merging by cmd. THE
  DIVISION OF LABOUR IS THE DESIGN: the model still chooses WHICH invocations
  are evidence — auto-recording every `run_shell` would bury the record in
  `mkdir` and `ls` noise — while the machine decides what the record says.
  COMPOSED on `runShellTool` rather than reimplementing it: the process-group
  kill, the credential-stripped env and the timeout are load-bearing and must
  not exist twice. It also refuses an exit-code echo decoration mechanically
  (checking the ARGS as well as the rendered line — `bash -c "... ; echo
  EXIT=$?"` hides it inside a quoted arg, and `DECORATED_CMD_RE` is anchored
  at end-of-string, so the closing quote defeated the first version), and
  omits stdout when it embeds `LISTENING_ON_PORT` — both contracts that used
  to live only in a prompt. It now remains in the file-scribe shell scope only
  (HTTP uses auto-recorded fetch_url; web has no shell) and is NOT in any
  bucket `required` list, so capability labels are unchanged. PROVEN on the
  data that exposed the defect: re-recording the
  two failing workspaces' commands through it drops them from 4/6 and 9/10
  replay mismatches to ZERO of 16. Covered by `tests/record-probe.test.ts`,
  whose first case is a 2000-character output recorded byte-identically.
  MEASURED IN ROUND 3, AND IT EXPOSED A DEFECT THE TOOL ITSELF SHIPPED. The
  manifest came out CLEAN (14 entries, full outputs, no truncation) and the
  replay failed anyway. Cause: the first version demanded run_shell's
  {command, args} shape, so a model passing a whole line was REFUSED and worked
  around it with `bash -c "node x.js a"`. Every entry gained a wrapper, and the
  compiled verifier — which does read the manifest — derives arguments with
  `node <entry>\s*(.*)$`, capturing the wrapper's closing quote and running
  `node x.js a"`. Two false mismatches, script demoted, zero successful
  dispatches. THE TOOL WHOSE JOB IS RECORDING A COMMAND REFUSED THE SHAPE IN
  WHICH IT RECORDS IT. It now accepts `cmd` as a whole line — the shape the
  manifest stores and the one models reach for — records it bare, and adds a
  shell only when the line genuinely needs one.
  {command, args} still works. Pinned by a test that replays the exact
  extraction regex that broke.
  EXACTNESS ALSO INCLUDES SHELL EXPANSION. The first classifier recognised
  pipes and redirects but not `*`, `?`, `[]`, `~`, braces, backslash escapes
  or a leading `NAME=value`. So `node --test tests/*.test.js` executed the
  literal asterisk via direct argv while the manifest stored shell text that a
  later verifier would expand — the machine recorded the bytes faithfully for
  a DIFFERENT invocation. Both run_shell and record_probe now share one
  conservative classifier; unnecessary bash is cheap, execution/replay drift
  is not. Unterminated quotes are rejected instead of silently becoming
  different argv.
  A later docs run exposed the deletion half of the same API: an accidental
  broken grep and its corrected DIFFERENT command both remained durable, so a
  future replayer would faithfully rerun the mistake. `supersedes:"<exact old
  cmd>"` now removes that one stale shell entry only AFTER the replacement
  command ran. It cannot touch HTTP/web entries or bulk-delete history; covered
  in pure merge, local tool and real container tests.
  HTTP EVIDENCE IS NOT A SHELL PROBE. Three consecutive HTTP runs ignored the
  prompt-only rule, recorded `node server.js` (30s timeout + dead port), then
  improvised curl/node-e requests including `http.delete` and malformed
  JavaScript. A first structural rejection prevented corruption but the next
  run still spent five failed calls on it and produced no manifest. The final
  division is capability-level: `record_probe` is absent from HTTP L1
  declarations, and L1's executor wrapper forces every loopback `fetch_url`
  to `record:true` unless explicitly disabled. The underlying tool appends the
  exact ordered method/path/status/body observation. Supervisor fetches retain
  the original executor and stay read-only. This preserves bucket scope,
  records expected 400/404 responses as evidence, and removes both the model's
  choice of the wrong tool and its transcription from the HTTP shape.
  A METHOD NOTE WORTH MORE THAN THE FIX: the first diagnosis of this was WRONG
  and nearly became a feature. Grepping the first trace event whose text
  matched the error string returned the run SUMMARY, not the script, and led to
  "the compiled script parses prose instead of reading the manifest" — which
  would have justified a static guard against a non-existent problem. The
  script body is recorded verbatim by the dispatch's own
  `write_file _skill_*.mjs` event; read THAT. Note also that `demoteToLlm`
  overwrites SKILL.md from `_fallback.md`, so the failing artefact is destroyed
  on disk exactly when you want to inspect it — the trace is the only copy.
- **`InMemoryToolRegistry`** (`src/tools/registry.ts`) — maps tool name →
  executor fn. Implements `ToolExecutor` (`src/core/types.ts`), plugged into
  `RunContext.tools` and forwarded to the LLM via `LlmCompletionRequest.executor`.
- **`defaultBuiltinTools({ sandbox, logger })`** (`src/tools/builtin.ts`)
  returns: `write_file`, `edit_file`, `read_file`, `list_files`,
  `run_shell`, `record_probe`, `start_static_server`, `validate_html`,
  `fetch_url`, `start_node_server`. **`edit_file`** is a targeted str_replace edit —
  the cost-discipline counterpart to `write_file`: revision cycles used
  to re-emit ENTIRE files (full content billed as output tokens on each
  retouch — the dominant spend of long L1 tool loops), and `edit_file`
  emits only the changed span. Contract: `old_string` must match
  exactly and be unique (0/>1 matches error with a coaching message)
  unless `replace_all: true`. It is in all three bucket scopes but does
  NOT participate in bucket DETECTION (no `CAPABILITY_BUCKETS.required`
  lists it), so capability labels are unchanged; the canonical + narrow
  L1 prompts tell the model to prefer it over `write_file` for fixes.
  The web validator (`validate_html`) uses
  Puppeteer — it can simulate both mouse (`click`, `rightclick`) AND
  keyboard events (`keydown`, `keyup`, `keypress` with `holdMs`) for
  platformer-style input. The HTTP pair (`fetch_url` +
  `start_node_server`) powers the Node bucket: `fetch_url` is a
  general HTTP probe (GET + POST JSON, 10s default timeout) whose optional
  `record:true` machine-writes ordered HTTP manifest evidence, and
  `start_node_server` spawns `node <entry>` with `PORT=0` in env and
  parses a `LISTENING_ON_PORT=<N>` line from stdout to discover the
  bound port (see HTTP bucket contract above).
- **`start_static_server` boot contract (rewritten 2026-08-05).** port=0
  is resolved IN-PROCESS via a throwaway net.Server (python prints the
  assigned port on block-buffered stdout — parsing it was structurally
  unreliable: measured 100% timeout on every port=0 boot, and the
  EADDRINUSE auto-retry could never succeed). python runs with `-u`; the
  "Serving" match scans BOTH streams with accumulated buffers; a child
  that exits before serving fails FAST with the output tail (no more
  phantom ok:true with a dead URL). The port is validated as an integer in
  0..65535 BEFORE spawn. The first clean Linux CI exposed why this belongs
  to our contract rather than Python's: macOS rejects port 70000, while
  Linux Python wraps it to 4464 and serves successfully — the old
  "dead child" regression test passed locally and asserted the opposite in
  CI. Boot timers are 8s/10s and are only
  the silent-but-alive fallback — healthy boots resolve on the match
  (pyenv python takes ~5s to first output). Both server tools spawn
  DETACHED (own process group) and `cleanup()` group-kills before the
  unit SIGTERM — grandchildren (workers, double-forks) are reaped.
  `start_node_server` matches LISTENING_ON_PORT against an ACCUMULATED
  buffer with a trailing-digit guard (a marker straddling a chunk
  boundary bound fetch_url to a wrong port). `list_files` uses lstat and
  reports symlinks as their own kind (statSync followed dangling links
  and threw, killing the read-back probe on valid deliverables).
  Sandbox children get a SCRATCH HOME under the OS tmpdir (the real HOME
  is a credential store — ~/.aws, ~/.netrc, ~/.ssh were one cat away
  from model-authored code with network egress; #7a closed the env-var
  side, this closes the file side). Covered by
  `tests/static-server-boot.test.ts` + additions in
  `sandbox-security.test.ts`.
- **`validate_html` smoke contract**: the `smoke` arg is a JS EXPRESSION
  wrapped as `(() => { const __r = (YOUR_CODE); return __r })()`. Top-level
  `const` / `let` / `return` / `function` / statement-series break parsing
  — `detectSmokeStatementError` rejects them BEFORE Puppeteer and returns
  a coaching message. A separate stuck detector
  (`makeSmokeStuckTracker({ windowSize: 10, failureThreshold: 3 })`)
  short-circuits when the same normalised smoke has failed 3+ times
  within the last 10 calls — CUMULATIVE, not consecutive, because earlier
  runs saw the model interleave a sanity smoke between real retries to
  defeat a consecutive-only detector. Both shortcuts return the same
  `SMOKE_DESIGN_GUIDANCE` text as a hint.
- **`validate_html` bounds every model-supplied duration — an unbounded
  tool parameter converts a model slip straight into dead wall-clock.**
  Audit of the 208 archived calls in the last 40 runs: **3 calls (1.4%)
  consumed 831s of the 1186s total browser wall-clock**. One held a key for
  `holdMs: 270500` (4.5 min) trying to advance an in-page countdown; one
  batched 31 interactions and spent 546s inside a wedged
  `Input.dispatchMouseEvent`, failing anyway. Four guards, all measured:
  `MAX_HOLD_MS` (3s) and `MAX_WAIT_MS` (15s) clamp durations, and the
  hold clamp pushes a WARNING naming the technique that works (expose
  `window.__test.advance(ms)`, drive it from `smoke`) — a silent clamp
  turns a 273s dead end into a 3s mystery; `interactionPhaseBudgetMs()`
  (45s, `ATOMA_VALIDATE_INTERACTION_BUDGET_MS`, invalid/zero/negative
  falls back to the DEFAULT) bounds the interaction PHASE, not the count
  — a game replay legitimately needs a long sequence — and the skipped
  tail is reported as an ERROR because a truncated sequence leaves the
  page in a state the smoke was not written against; `protocolTimeout`
  is pinned to 30s at launch because Puppeteer's default is 180s, so ONE
  wedged CDP command stalls three minutes. The bounds are also stated in
  the tool DECLARATION so the model learns them up front instead of by
  hitting them. Covered by `tests/validate-html-bounds.test.ts`, each
  case verified to FAIL against the pre-fix tool.
- **Chrome's own favicon 404 must not fail a healthy page.** Chrome
  requests `/favicon.ico` on every navigation when the document declares no
  icon link; `start_static_server` has no such file, so it 404s into the
  console-error channel — and `ok` is computed from `errors.length === 0`.
  Measured: 23 of 208 calls carried it and **10 returned `ok: false` with
  it as their ONLY error — 13% of every failure the tool reported**, on
  pages that worked. (The model usually reasoned past it, "browser
  auto-fetch, not a task failure": tokens spent overriding our own false
  negative.) `isSpeculativeFaviconRequest` is deliberately NARROW —
  suppression requires same-origin AND `!document.querySelector('link[rel~="icon"]')`,
  evaluated AFTER interactions so a dynamically-installed link counts. A
  page that SHIPS `<link rel="icon">` and 404s is a real broken artefact
  and still fails. Console errors are held STRUCTURED (`{text, loc}`) until
  the end of the call so the filter decides on the source rather than
  re-parsing our own rendered `[source: …]` suffix; an error with NO source
  is always kept (absent evidence, report it).
- **Tool-use loop**: when `req.executor` is present, `AnthropicLlmClient.complete`
  runs up to `DEFAULT_MAX_TOOL_ITERATIONS` (24) rounds of tool_use →
  tool_result → LLM, with a graceful "tool budget exhausted" final
  round-trip when the cap hits. Usage is aggregated across rounds and
  reported once via `MetricsLlmClient`. Only L1 should pass `executor:` —
  grep confirms it.
- **Tool results are truncated before reaching the model.** Any single
  tool_result over `MAX_TOOL_RESULT_CHARS` (20k chars ≈ 5k tokens) gets
  head/tail elision with an explicit `[... tool output truncated ...]`
  marker (`truncateToolResultContent` in `src/core/llm.ts`). Rationale:
  `read_file` returns whole files and `run_shell` up to 2 MB — beyond
  Haiku's entire 200K window — and every byte stays resident in the
  transcript for the rest of the loop, re-billed each round. Observers
  (`onToolInvocation` → viz/trace) still receive the UNTRUNCATED result;
  only the model-facing payload is elided. Serialization is compact
  `JSON.stringify(result)` — no pretty-print indent on billed tokens.
- **Budget-exhausted finalization keeps tools declared.** The final
  tools-disabled round-trip sends `tool_choice: {type: 'none'}` instead
  of dropping `tools` — tool declarations render at position 0 of the
  prompt, so removing them would invalidate the ENTIRE prompt cache on
  the largest request of the loop. `tool_choice` changes don't touch the
  tools/system cache tiers.
- **Shared smoke-test guidance.** `SMOKE_DESIGN_GUIDANCE` (now in
  `src/atoms/prompts.ts`) teaches L1 the IIFE contract, the COST rule
  (one object smoke, see below), the `window.__test` hook pattern for
  state-heavy apps, and the smoke-loop discipline.
  The COST rule was added 2026-08-09 after a clean-machine measurement:
  a habit-tracker run made **66 validate_html calls carrying 64 distinct
  smokes, 45 of them PASSING** — one element verified per browser
  round-trip, ~9 minutes of pure page loads, $0.95 for a single-page
  widget. Nothing in the guidance said a call was expensive, and the
  existing loop-discipline rules only fire on REPEATED failures, which
  never happened (the smokes were all different). The rule tells the L1
  to return a structured OBJECT answering every question at once, with an
  explicit aggregate `ok`, and the whole object comes back in `smokeResult`.
  It shipped with "any object is truthy" semantics; a live widget then passed
  while reporting `hasStreak3Class:false`, claiming an intermediate state it
  had never observed. Now structured results require `ok === true`; an object
  without `ok` fails. Raw expected-false state is allowed when the aggregate
  compares it. This also cures the "smoke
  check failed: false" opacity — a bare boolean carries no diagnosis while an
  object comes back with its values. It is appended by BOTH `buildNarrowL1Prompt` (escalation-branch
  path) AND `createSubtaskL1` (fresh-L1-on-fanout path). Adding new L1
  creation sites? Append this block too, or new L1s will miss the
  discipline and thrash on smoke design.

## Things that look wrong but aren't

- **`DEFAULT_LIMITS.maxExecIterations` (5) is UNREACHABLE, and that is
  currently fine.** `superviseLoop` has one loop body: a RESULT rejection
  falls out of it and re-enters at `plan()`, incrementing `planIter`. So
  `execIter <= planIter <= maxPlanIterations` and the exec guard can only fire
  if `maxExecIterations < maxPlanIterations`. Effective result-retry budget is
  3. Two knock-on facts: escalations driven by repeated RESULT rejections are
  raised as `EscalationSignal('plan')` (so post-mortems mislabel the phase),
  and on run `2026-07-25T22-10-42` the retries *degraded* the artefact
  (README 1059 → 933 → 1731 bytes, a probe's evidence lost mid-cycle) — so do
  NOT raise `maxPlanIterations` to "unlock" the 5.
  **F8 — why "just re-execute without re-planning" is not a free fix:**
  `L2Atom.execute` / `L3Atom.execute` consume-and-null `pendingStrategy`, then
  silently `return this.selfExecute(...)` when it is missing. Re-executing a
  tier-2 child without an intervening `plan()` therefore collapses the
  supervision protocol into the last-resort executor (the model is now safely
  routed through L1 when tools are present; it historically ran Sonnet/Opus),
  wires `tools` + `executor` from a supervisor object, and stamps
  `viaFallback: false` — so the collapse is invisible in the trace, the
  metrics and the viz, while `onApproved` still credits a success. `L1Atom`
  *is* safe (its `execute` builds everything from the `plan` argument), but
  the loop is generic. Any attempt needs: a capability predicate
  (`supportsPlanReuse()`, false on `Atom`, true only on `L1Atom` — not a
  `tier === 1` test), an object-identity check that `applyByScope` returned
  the SAME instance (`patch`/`branch` return a fresh `L1Atom.fromType(...)`
  that never produced the plan and has lost its injected skill), a single
  plan-free retry, and continued `planIter` accounting so the worst case
  stays at 3.
- `L3Atom.fromType` is `async` while `L2Atom.fromType` is sync. Reason: L3 resolves
  the Opus model via a network call; L2 uses a pinned constant.
- `verdictSchema` in `json.ts` allows `branchName: null` at runtime (LLMs emit
  it that way), but `NegativeVerdict.branchName` is typed `string | undefined`.
  `llmVerdict` normalises `null → undefined` once at the parse boundary so
  every downstream `registry.branch(..., branchName)` call stays clean.
- `injectContext` appends to an array; `effectiveSystemPrompt` composes them at
  call time. Repeated injects stack — intended for trace accumulation during
  escalation.
- `AnthropicLlmClient.complete` has a one-shot retry **without** sampling
  params when the model 400s on `temperature`/`top_p`. Guards against brand-new
  reasoning models that reject those params. See `modelSupportsSamplingParams`
  in `src/core/models.ts` for the known-deprecated list.
- `aggregationSpecSchema.instruction` is
  `.string().nullable().optional().transform(v => v ?? undefined)` —
  Sonnet/Opus routinely emit `"instruction": null` on `mode: "concat"`
  plans and a plain `.optional()` would reject and crash the plan
  parse (observed on a branched L2 replan). Same shape as
  `verdictSchema.branchName`: accept null at the boundary, normalise
  to undefined so the TypeScript type stays `string | undefined`.
- The `Plan` interface in `src/core/types.ts` carries a
  `viaPrefilter?: boolean` flag but `planSchema` in `src/atoms/json.ts`
  does NOT list it. This is deliberate: the flag is an internal
  provenance marker set on skeletal-plan literals inside
  `L2.plan` / `L3.plan`, and `z.object()` strips unknown keys at parse
  so an LLM cannot spoof `viaPrefilter: true` in its routing JSON.
  See the note in `planSchema` for the full rationale.
- `capabilityDescription` orders HTTP before web in `CAPABILITY_BUCKETS`
  even though "specific before general" usually favours the more
  fine-grained web bucket. Reason: the Node bucket's required tools
  (`start_node_server`) are structurally incompatible with the web
  bucket, so a toolset carrying `start_node_server` genuinely belongs
  to HTTP. The canonical helpers `pickTools` their input so canonical
  web L1s never see the HTTP-only tools in the first place. NOTE: a
  toolset satisfying BOTH the http bucket AND web-build+validate (the
  kitchen-sink case — dynamic children inheriting the full executor
  set via mergeTools) no longer takes the first-match label; it gets
  the honest `general-purpose builder/orchestrator (web + HTTP +
  files)` label instead. The first-match HTTP label ASSERTED a
  specialty the atom didn't have, the domain-match rule then refused
  reuse for non-HTTP tasks, and every CLI run spawned fresh clones
  (the Ammonia/CarbonDioxide/Glucose/Sucrose/Ethanol series). The
  bucket ORDER still matters for partial overlaps (http tools +
  start_static_server but no validate_html stays HTTP). Companion
  change: `looksTaskThemed`'s length cutoff is 200 (was 140) so
  planner-authored ROLE seeds ("CLI/file project orchestrator: …",
  typically 150-190 chars) survive instead of being dropped for the
  tool-derived label; the theme patterns still catch domain-poisoned
  seeds at any length.
- `AtomRegistry.remove` (CLI `registry remove <name> [--force]`)
  deletes only the LIVE row: the version history stays and gains a
  `[removed]` tombstone row with the final state. Deliberate — the
  rollback CLI reads `atom_type_versions`, and `create` allocates
  ordinals from live ∪ history rows so a removed atom's taxonomy name
  is never re-issued to a future atom (which would inherit its identity
  in old run traces and skill namespaces). Canonical/bootstrap atoms
  and user-created cells are refused without `--force`.
- **Rollback is roll-forward-to-the-past.** `AtomRegistry.rollback(name,
  toVersion)` (CLI `registry rollback <name> --to <v>`; inspect with
  `registry history <name>`) restores an archived version's
  prompt/tools/params EXACTLY as a NEW live version: history stays
  append-only, the version counter keeps rising, and counters reset —
  "patch resets trust" applies to a rollback exactly as much as to a
  forward patch. Deliberately NOT routed through `applyMods`, whose
  params merge cannot delete a key a later version added. Description is
  not versioned (`atom_type_versions` has no column) and is kept as-is.
  Caveat surfaced by the CLI: canonical/bootstrap types are re-aligned
  by their idempotent seeder on the next run, which patches a rollback
  away if the seed differs — rollback is for DYNAMIC types, or for
  pinning a canonical during a single diagnostic run. Content-identical
  restores are a no-op (mirrors the patch guard). `listVersions` is the
  full-content accessor; `versionsOf` stays the light metadata variant.
- `Atom.toolNames(): string[]` is public while `Atom.tools: Tool[]` is
  protected. The names accessor was added specifically for cross-
  cutting concerns (ground-truth probe bucket gate, tracing) that
  need to inspect declared scope without exposing the mutable tools
  array with its executor closures.
- There are THREE canonical L1s (web, http, file-scribe) but only TWO
  canonical L2s (web, http). The file-scribe bucket deliberately has
  no L2 counterpart — the HTTP L2 Methane acts as an agnostic router
  that dispatches to the file-scribe L1 via its own prefilter when a
  file-authoring subtask appears. An L2 file-scribe could be added
  later if L3 ever needs to discriminate the bucket before delegating,
  but for current tasks the asymmetry produces happier prefilter
  matches (L3 picks Methane with high confidence seeing the
  file-scribe L1 in its REACHABLE L1 CHILDREN block).
- `L3Atom.plan` formats each L2 catalog entry as a multi-line block
  (description + REACHABLE L1 CHILDREN block on separate lines), not
  a one-line parenthetical tail. Haiku parses the multi-line structure
  correctly; earlier attempts at a parenthetical "(dispatches leaves
  to …)" tail were ignored by the model and didn't change its escalate
  rate. The verbose layout wins ~$0.12/run on tasks that genuinely
  match through L1 affinity.
- The tailing-edge partial-persist in `TraceRecorder` (300ms throttle)
  is `unref()`'d so a pending timer can't keep the process alive past
  its own business. Without this, a run that finished its l3.handle
  early but still had a buffered flush scheduled would hold the event
  loop alive until the timer fired and tore down the (already-done)
  TraceRecorder. `endRun()`'s synchronous `persist()` happens BEFORE
  we clear the timer specifically so the final state wins the race
  over any trailing-edge flush.
- **The Launch tab describes families; it does NOT start them, on purpose.**
  `GET /api/profiles` returns each `LAUNCHABLE_PROFILES` entry's
  `guidance` ({label, help, examples}) plus its npm script, and the tab
  renders a family picker, the per-family help and a command to COPY. The
  server stays a pure observer — zero `writeFileSync`, zero `child_process`,
  SQLite readonly — so the feature adds no attack surface at all.
  WHY NOT A LAUNCH BUTTON: a run can call BACK into the viz. `fetch_url` has
  no URL allowlist *by design* (`builtin.ts`: "network is intentionally
  open") and sets arbitrary request headers, and `run_shell`'s allowlist is
  documented above as STEERING, not a boundary. So the adversary is not a
  remote page, it is the run itself — and any launch token served over HTTP
  is readable by the very code it exists to gate. A real launch endpoint
  therefore needs a secret that never touches HTTP or disk (printed once in
  the viz terminal banner), plus a method check (`server.ts` never reads
  `req.method` — the house style would have shipped a GET-triggerable
  endpoint), strict `content-type`, a global Host allowlist placed BEFORE
  every branch (a per-branch check leaves the read surface open to DNS
  rebinding), an exact-Origin check with the port compared (a run's own
  served artefact is same-host), argv-array spawn with the goal LAST (a goal
  starting with `--` would be read as a flag by `parseRunnerArgs` —
  `--clean-workspace` archives the workspace), and the SIGTERM→5s→SIGKILL
  group kill (`burnin.ts`; group SIGKILL alone leaks 9 puppeteer processes).
  That is phase 2, opt-in behind `--allow-launch`, loopback-only. Roughly 80%
  of the value — knowing how to phrase a goal — needs none of it.
  ALSO NOTE: `runTask` ends in `await new Promise(() => {})` so the started
  server stays reachable; a browser-launched run has no Ctrl-C and needs the
  group kill to end at all.
  Covered by `tests/viz-launch-profiles.test.ts`, which also pins the first
  en/fr PARITY test (the rule was purely disciplinary until now) and forbids
  the guidance from naming a builtin tool — teaching a user to name tools in
  a goal would reintroduce, in the human's own words, the defect `ae63e06`
  removed from subtask descriptions.
- **`TaskProfileGuidance` is REQUIRED on a profile.** It is the second
  consumer of `TaskProfile` (the runner is the first), which is most of its
  architectural value: an interface with one consumer has nothing keeping it
  honest. Optional would let a future family ship undescribed — the exact
  defect the tab exists to prevent.
- **The viz UI is ENGLISH and i18n'd — and the claim is now partly ENFORCED,
  because it was not true.** This entry used to read "fully i18n'd — no bare
  user-facing string". A sweep on 2026-08-09 found **15 FRENCH literals
  hardcoded outside the `fr:` catalog** (`Lien`, `Atome — …`, `(vide)` ×7,
  `Chargement…` ×5), so the ENGLISH UI had been rendering French. All 15 now
  go through `t()`. Two tests hold the line, and the split between them is
  the point: the PARITY test proves both catalogs carry the same keys — it
  cannot see a call site that skips `t()` at all — while the FRENCH-LEAK test
  catches exactly the demonstrated bug, a recognisable French word in a
  literal outside the catalog, which is always wrong and needs no judgment.
  A third test then closed the gap the other two left, and its history is the
  lesson: the French word-list detector was written first and immediately
  proved its own limit — a follow-up sweep found `Appel LLM`, `dernier run`,
  `Version actuelle` and `afficher / masquer`, all French, all missed,
  because a word list is only as good as the words someone thought of. The
  replacement is STRUCTURAL: a quoted literal of two or more words sitting
  where `h()` expects a CHILD is rendered text, whatever language it is in.
  That found 14 more (10 English, 4 French) and they are fixed. Residue it
  still does NOT catch, stated so nobody reads silence as coverage:
  one-word labels, template literals, and `innerHTML` assignments. This is a
  floor, not proof. Do not restore the word "fully" without a checker that
  earns it.
  Every label goes through `t('some.key', { vars })` against the catalogs
  at the top of `ui.html`; static chrome uses `data-i18n` /
  `data-i18n-title` / `data-i18n-placeholder`, filled by
  `applyStaticI18n()` at boot. The core is ~40 lines, NOT a library, for
  a structural reason: `ui.html` is served verbatim (`cp` at build) with
  no bundler, so i18next would mean a CDN (breaking an offline localhost
  tool) or a vendored 40 KB blob. Its SURFACE is i18next-compatible
  (dotted keys, `{{var}}`, `.one` count variant, dotted namespaces) so
  swapping in the real library is a drop-in — catalogs and call sites
  unchanged. English is the SOURCE and the default: `detectLocale()
  deliberately ignores navigator.language, so a French browser gets
  English until the user opts in via the header picker (persisted in
  localStorage) or `?lang=fr`. A missing key renders as the key itself —
  loud and greppable. `fr` ships complete (157 keys, strict parity with
  `en`) which is what proves the plumbing; add a locale by dropping a
  catalog next to it and it appears in the picker. WATCH OUT: `t` is now
  a global, so a local variable named `t` shadows it — the registry
  render paths were renamed to `type`/`ty`/`tot` for exactly this
  reason.
- **"Right now" says what the call is DOING.** A bare role chip
  ("EXECUTE") told you a slot was busy and nothing else — on a
  multi-minute L1 tool loop that reads as frozen. The banner now adds a
  plain sentence per role (`now.doing.*`) and the LIVE tool activity of
  that same call: count, last tool, its identifying argument
  (path/url/command, tail-truncated at 48 chars) and how long ago. The
  correlation is EXACT, not chronological — `VizToolEvent.llmEventId`
  names the loop that spawned each tool, so a sibling branch's calls are
  never folded in (pinned by a fixture with a decoy tool on another
  llmEventId). Everything is derived from data already recorded, so it
  works on any archived trace.
- **Viz cards surface the DECISION, not just the call.** Prefilter and
  validator cards read the recorded `response` client-side and render the
  outcome inline — `→ réutilise <target>` / `↑ escalade` (+ a confidence
  chip when not high), `✓ approuvé` / `✕ rejeté` + scope, and the
  `activeSkillFollowed` adherence signal (`recette suivie` /
  `recette ignorée → crédit retenu`). Purely presentational and derived
  from data already persisted, so EVERY archived run gains them
  retroactively; `peekJson` degrades to no chip rather than guessing.
  Two guard mechanisms also emit their own skill events now
  (`op: 'quarantine'`, `op: 'credit-withheld'`) because their whole job
  is to NOT act: a statically-scanned script that was blocked, or a
  counter deliberately not bumped, used to be indistinguishable from
  "nothing matched" / "nothing happened". Event-driven recovery
  injections render as `⟳ recovery` with the matcher's containment
  score (same `op: 'inject'`, provenance read from the reasoning). The
  run summary gains a `Garde-fous` card tallying both guards, and the
  lifecycle digest counts mid-run recoveries.
- **A prefilter cache hit gets its own event (`kind: 'cache'`).** It
  REPLACES an LLM call, so with no event the timeline just shows one
  fewer call and the run reads as cheaper for no stated reason — the
  same argument that gave the trust fast-path its own event. Emitted by
  `prefilterStrategy` through the optional `ctx.recordCacheHit`
  observer (absent → the cache still serves, silently), rendered as a
  cyan `⚡ cache` card carrying the replayed decision and a
  `0 appel · $0.00` badge — deliberately the sibling look of the gold
  `⚡ direct` dispatch, so a glance separates "free because cached" from
  "free because compiled". `computeTotals` ignores the kind (a hit is
  NOT a call), a `Cache` filter chip isolates them, and the summary
  tallies them as `⚡ Routage caché`. CRITICAL: `forkBranch` must
  forward the hook like `recordTrust`/`recordSkill` — the skill
  prefilter runs inside forked contexts, so a fork that dropped it
  would lose most hits (caught by the typecheck when the field did not
  exist; pinned by a regression test). Covered by
  `tests/prefilter-cache-event.test.ts`.
- **`isRunLive` / `isIndexEntryLive` are the ONLY live predicates — the
  copies used to disagree.** A run killed hard (uncatchable SIGKILL, crash)
  keeps `endedAt` undefined FOREVER, so "live" is not `!run.endedAt`; it is
  that AND not abandoned. Polling and the events pane applied the abandoned
  rule, the header badge, the "right now" banner and the sidebar flag did
  not — so the run of `2026-08-08T18:32` rendered `⚠ Run abandoned` in its
  events and a green `● LIVE — polling every 1s` in its header at the same
  time, 11 hours after its last event, advertising a poll that had already
  stopped. A UI contradicting itself about its own behaviour is worse than
  one merely wrong. The LIST needs its own predicate because index entries
  carry no events: `VizRunIndexEntry.lastEventAt` (stamped on in-flight
  entries only, newest event by max not last-written) is what makes the
  verdict possible there, and entries predating the field fall back to
  `startedAt` — the same fallback `isAbandoned` uses for an event-less run,
  which is why the historical zombie resolves correctly without a
  migration. Reading `inFlight` raw also kept `anyInflight` true forever,
  re-rendering the run list every tick. Covered by
  `tests/trace-abandoned.test.ts`.
- **The viz "abandoned run" threshold is 12 min, not 5.** Measured on a
  live claude-cli batch: an L1 execute call sat silent for over 5 minutes
  while legitimately working (a long tool loop emits no trace event until
  it returns), so the old 5-minute rule labelled a HEALTHY run abandoned
  and stopped polling it. The threshold must exceed the longest plausible
  single call — the per-call transport deadline is 10 min, so past 12 a
  run is genuinely dead rather than slow.
- Live viz is POLLING, not SSE or WebSocket — but the poll is a DELTA and
  the render is INCREMENTAL, which is where the cost actually was. The UI
  polls `/api/runs/<id>?after=<n>` every 1s while `endedAt` is undefined
  (the server answers with the run header plus only the events past index
  n, and `eventsFrom` tells the client where the slice starts; the client
  splices it onto what it holds). Measured on a real 201-event run:
  808 KB → 29 KB per tick, −96%. Omitting `after` still serves the full
  run byte-for-byte — first load, ended runs, any other consumer are
  untouched — and a shrunken trace (`after > total`) resyncs from 0.
  `renderEvents()` then reconciles by event id: cached nodes are MOVED,
  only genuinely-new ids are built (and animated via `animateStepEntry`,
  Web Animations on the card's measured height so the push is smooth at
  any card size). `renderEvents({ rebuild: true })` forces a clean pass —
  used on run switch and filter changes, where the visible set changes
  for a user-driven reason and animating it would be noise. Upgrading
  the TRANSPORT (fs.watch + SSE) would roughly double the server surface
  for marginal latency benefit on a single-observer dev-loop tool; the
  payload and DOM-churn wins above were the part worth taking.

## Considered and rejected (do not re-propose naively)

- **HYBRID SKILLS — one recipe carrying a mechanical half (script, run by the
  harness) and a judgment half (llm), so the script stops competing with the
  recipe for a match and becomes a tool it uses.** Designed and refuted
  2026-08-11, same day; full write-up and measurements in
  `docs/hybrid-skills-design.md` §9. Two of three independent reviewers
  returned do-not-build. The decisive facts, all measured on the round-8
  traces:
  (a) **THE ARITHMETIC WAS WRONG BY 4-5×, IN THE UNIT THAT MATTERS.** The design
  assumed one LLM round-trip per `record_probe`. The model emits probes as
  PARALLEL tool_use blocks in a single assistant turn (`src/core/llm.ts`
  collects every block from one response before the next round-trip), so 120
  probes occupy **26 turns, not 120**, and the corpus already runs at 20.9
  round-trips/run — BELOW the design's own target. Evidence: probe→probe gap
  median 283 ms (n=99) against 3690 ms (n=169) for every other adjacent tool
  pair. If you count tool CALLS, you are not measuring what the model pays for.
  (b) **THE PROBES ARE EVIDENCE PRODUCTION, NOT INFORMATION INTAKE.** 96 of 120
  re-derive a value the same L1 had already read verbatim from the manifest.
  They exist because the L1's own contract demands first-hand provenance
  ("USE record_probe, DO NOT TRANSCRIBE BY HAND"), so injecting the same facts
  cannot remove them. The natural experiment already exists and already failed:
  `previousStepSummary` threads facts between sequential phases today and the
  L1 probes anyway. **The redundancy is the ground-truth discipline being
  honoured, not waste** — and the only lever on it is the record_probe
  contract, which is the #F9 fabrication hole.
  (c) **THE PRIZE IS ~$0.02-0.036/RUN** (7-12%), because probe results are ~44
  tokens each against 5.6M cache-read tokens at a 93.5% cache rate. Round 7's
  already-satisfied validator cascade cost $0.325/run — roughly ten times more
  — and was fixed in the existing verdict layer. A new skill kind touches
  ~13 files.
  (d) The safety premise ("the normal validator still judges the final result")
  is **false on the majority path**: 30 of 43 round-8 RESULT validations took
  the trust fast-path with zero LLM calls, four of six runs made none at all,
  and the guards the design removed are what covers that path.
  REVISIT only after running the cheap premise test first: hand-inject a
  `== MECHANICAL RESULTS ==` block into one L1 subtask prompt and count whether
  probes drop. One run. If they do not drop, no dispatch-path work can help.
  THE STANDING CONCLUSION this closes: five attempts, and the best remaining
  idea has a measured ceiling of ~$0.03/run. The saving comes from tiering,
  earned trust and recipe reuse. Compilation is a correct mechanism that does
  not pay on the families measured so far — stop spending rounds on it.

- **A RUNTIME friction sensor (mid-loop event-skill matching on tool
  errors + post-run distillation from repeated tool-error signatures).**
  Designed and adversarially refuted 2026-08-07. The decisive facts:
  (a) base rate — of SIX root-caused tool-friction classes to date
  (EADDRINUSE #7c, buffered python stdout, LISTENING_ON_PORT chunk
  straddle, symlink lstat, the ESM module-resolution leak, decorated
  manifest cmds), zero were learnable technique; all six were
  harness/environment defects fixed structurally. (b) the counterfactual —
  a sensor live during the ESM window would have distilled its dominant
  signature (14 events, 10+ approved runs, cross-batch: passes any
  reasonable threshold) into a PERMANENT event skill teaching a workaround
  for a bug that died the next day via `ensureModuleResolutionBoundary`;
  event skills have no decay (never `setActiveSkill`, so no counters — only
  `skills drop` removes one). (c) economics — recovered friction costs
  ~≤2k tokens/run at Haiku prices ($0 marginal on claude-cli), below any
  sensor's complexity budget. (d) match-only is dead code: existing
  triggers are born from validator-diagnosis prose and the containment
  matcher can't reach threshold against tool stderr. What was built
  instead: the offline `npm run friction` report (diagnostic stage — the
  only stage whose value the data supports) plus targeted static fixes for
  the measured residual (edit_file escaping diagnosis, validate_html
  console-error source attribution). REVISIT only if a friction signature
  recurs across two consecutive batches AND its root cause is shown to
  live INSIDE the sandbox, in artefacts the L1 can read — a cause in the
  host, repo or harness is an environment defect and gets a structural
  fix, never a learned lesson (a one-line-rule A/B test does NOT
  discriminate: "always write ESM" also fixes an environment bug in a
  controlled experiment).

- **SPOQ-style Haiku blame-triage on multi-subtask failures.** SPOQ runs
  a cheap investigator after a failed wave to name the guilty task —
  valuable THERE because their validation is wave-level. Rejected here
  (2026-08-06) because atoma validates PER SUBTASK: by the time an
  aggregate is rejected, each sub-result already carries its own verdict
  and diagnosis, so a triage call would mostly restate what the
  validator wrote. The real gap is not identifying the guilty subtask
  but CONSUMING that knowledge — replans re-run the whole plan; there is
  no partial-replay that keeps the good phases and redoes the bad one
  (and the shared sequential workspace makes that non-trivial). Revisit
  only alongside plan templating / partial replay; the bounded
  remediation-feedback contract (REMEDIATION_FEEDBACK_MAX_CHARS +
  the prompt's REMEDIATION FEEDBACK CONTRACT block) is the part of the
  SPOQ finding that pays for itself today.

- **Trust-gated restore of the L3 skeletal short-circuit.** Tempting on
  mature families (saves the ~$0.07 Opus plan), rejected 2026-08-02 for a
  structural reason: the Opus plan is what CARVES OUT the phase boundaries
  that skills match against — collapse the task into one subtask and the
  skill prefilter matches one build-ish skill for the whole thing, the
  verification phase stops existing as a subtask, and the compiled-script
  dispatch (the $0.00 path) is STARVED on exactly the families it serves.
  Net effect: pay less for planning, pay more for verification, lose the
  checkpoints. Also the proposed gate was measuring the wrong thing: L2
  trust counts well-scoped SUBTASK executions, not whole-task
  decomposition ability — the same inference error behind the monolithic
  Pong (see "Prefilter decomposable hint"). The successor idea this entry
  used to point at — PLAN TEMPLATING — was designed and refuted on
  2026-08-08; it has its own entry below.

- **PLAN TEMPLATING (memoise successful plans' structure, instantiate
  without Opus).** Designed and adversarially refuted 2026-08-08 over the
  85 archived L3 plans (237 subtasks); both passes re-measured
  independently and agree. Motivation was real: on mature families the L3
  Opus plan is the last big line item ($0.065/run ≈ 19%, and
  structurally UNCACHEABLE — 5.3% cache_read, one unique call per run,
  vs 93.6% cache_read on the execute path that dwarfs it). It is
  nevertheless the wrong build, for reasons that cannot improve with more
  data:
  (a) **The memoisable skeleton carries almost no information.**
  `aggregation.mode` is `sequential` on 83/83 analysable plans;
  `preferredChild` is uniform within a plan and EQUALS the Haiku
  prefilter's target (already free, and itself cached); phase count is 3
  on 63/83. A static rule — "n=3, sequential, children = prefilter
  target" — reproduces the whole skeleton on ~77% of runs. A keyed store
  with expiry, cap and kill switch does not beat `const n = 3`.
  (b) **The value lives in the subtask TEXT, which is irreducible.**
  Median 785 chars, 96% name at least one file path, and the majority of
  replayed path literals are foreign to the next goal (measured on a
  chronological cache simulation: 65.7% of 274 literals over 72 hits).
  That text is a CONTRACT read by three mechanisms with no validator
  downstream: the skill prefilter matches on it, it is the ONLY argv a
  compiled script receives, and it is the oracle of the deliverable gate.
  Replaying it re-creates the task-specific-literal defect one tier
  higher; regenerating it without an LLM collapses the phases into
  indistinguishable twins — which is the very failure the L3 shortcut was
  rejected for. "Phases survive, skills keep matching" is not satisfiable
  without an LLM call.
  (c) **It would put memoised content at the one point with no validator
  above it** (no L4; `L3Atom.validatePlan` judges its CHILD's plan). Every
  other memo in the repo has a downstream gate — envelope + deliverable
  gate + directFailures for compiled dispatch, the ground-truth probe for
  the trust fast-path. A stale `preferredChild` would auto-create a fresh
  L2 clone at 0 successes, disarming the trust fast-path for the whole
  run: the optimisation failing by making the run MORE expensive.
  (d) **The corpus was already stale before the design was written.**
  `ae63e06` (2026-08-08) forbids naming tools in subtask descriptions —
  and 194/237 (81.9%) of archived subtasks do exactly that. A store filled
  from this corpus would replay the defect that commit exists to kill.
  The plan prompt is the project's active correction surface (3 edits in
  30 days, 2 in 2 days), so a template store's half-life is shorter than
  its fill time.
  (e) **Precedent, measured**: the prefilter decision cache — same key
  family, ~6 chances per run against the plan's 1 — sits at 12 hits /
  490 entries = 2.4%, with 98% of entries never re-read. And
  `curriculum.ts` demands NOVEL goals by design, so exact hits are
  engineered away.
  REVISIT only if BOTH (i) the prefilter cache's exact-key hit rate
  exceeds 25% across two consecutive batches, and (ii) the L3 plan prompt
  goes unedited across that whole window. Today: 2.4% and two edits in
  two days.
  CONDITION (i) IS NOW KNOWN UNSATISFIABLE, which closes this permanently
  and for a better reason than the one above. Replaying the real key over
  all 748 archived prefilter calls found 735 DISTINCT inputs: a perfect
  cache would avoid 1.7%, so 25% is not a threshold the system can reach.
  The cause generalises straight to plan templating — both memoise
  content keyed on free-form, model-authored task text, and that text is
  unique by construction because decomposition is the production of
  distinct prose. The prefilter cache was cited here as weak PRECEDENT;
  it turns out to be a measured PROOF of the same mechanism, one tier
  down and with six chances per run instead of one. Also measured and discarded: hoisting the constant plan
  preamble under the system cache breakpoint (ephemeral cache is 5 min,
  mean run ~5 min, one plan call per run — inert or worse, 1.25× write
  multiplier); and a "cache only aggregation + phase count" variant
  (memoises a constant and a 77/23 coin flip while removing no call).
  `ATOMA_MODEL_L3=sonnet` is a sanctioned pin that buys ~$0.024/run for
  zero lines, but it degrades exactly the decomposition reasoning the
  tier exists to pay for — treat it as a reversible burn-in A/B whose
  damage would show up in results.csv (escalations, rejections), never as
  a default.
  WHERE THE DATA POINTED, AND WHY THAT READING IS NOW WITHDRAWN: this entry
  used to send the next session after the escalation tail — "4 runs of 78
  (5.1%) carry $2.88 = 10.7% of the corpus cost… the partial-replay gap the
  SPOQ entry already names". Re-measured on 2026-08-10 at 151 runs, the
  recommendation does not survive its own evidence, in three ways worth
  recording because each is a way to misread a burn-in curve.
  (a) **The lifetime figure is a RECENCY TRAP.** It now reads 43/151 (28.5%)
  carrying 38.9% of cost, which looks like the problem tripled. Split
  chronologically it is 52% → 20% → 13.7%, and 1 of the last 30. The
  escalation rate is COLLAPSING as the catalog matures — the tail is the
  learning curve being paid down, not a defect accumulating. This is exactly
  the error the friction report's `lastSeen` column was added to prevent
  ("a lifetime tally, so a fixed defect keeps topping it"), repeated in a
  different report. Any claim taken off `results.csv` needs the
  chronological split; the mean over all runs hides the trend that decides
  whether to act.
  (b) **The correlation inverts if you state it strongly.** ZERO of the 43
  escalating runs failed, against 6 of 108 non-escalating — which reads as
  "escalation prevents failure" and is not what happened. Failures have a
  median of 6 LLM calls against 15 for delivered runs: they die BEFORE the
  escalation machinery can engage. Escalation is what happens to runs that
  keep going, so conditioning on it selects survivors.
  (c) **The residual failure mode is not reasoning, it is WEDGING.** The 6
  failures are slower and quieter than healthy runs — median 555s against
  265s, on fewer calls — with one at 1283s having made ZERO LLM calls and one
  stopped by the 900s budget. That is the class the per-call inactivity
  deadline and the watchdog already target, not one partial replay would fix.
  Partial replay stays a real gap (the SPOQ entry still names it), but it is
  no longer the measured top line, and nothing should be built on the
  withdrawn numbers.

## Structural slices — status

From the 2026-08-05 architecture audit. DONE: **SkillLifecycle**
(`src/skills/lifecycle.ts` — the whole match/learn/revise/promote/
dispatch/demote engine behind a SkillLifecycleHost interface; L2Atom
keeps thin delegators + re-exports), **verdict engine**
(`src/atoms/verdict.ts` — VALIDATION_SYSTEM_PROMPT + llmVerdict), and
**structured ground-truth facts** (`GroundTruthFacts`: the probes RETURN
what they observed — missing/empty claimed files, web-probe tool
failure, self-reported mismatch — and `checkGroundTruth` decides from
those fields; it used to regex-match marker strings the probes
themselves had rendered, so a wording edit could silently disarm the
trust-fast-path override). L2Atom: 3,692 → ~1,590 lines over the
campaign.

Mirror helpers: **dispatchSubtasks is shared** —
`dispatchWithAggregation` in `src/atoms/dispatch.ts` owns the
aggregation.mode → dispatch mapping (sequential summary-threading vs
parallel Promise.all), parameterised by the per-subtask runner; alias
clearing and child resolution stay with the callers (resolution runs in
each runner's synchronous prefix — that is what keeps the parallel
branch race-free). REMAINING (needs a design pass, not urgent): the
other mirror pairs (resolve*ForSubtask + planChildAliases,
selfPlan/selfExecute, validator plumbing) — shared functions
parameterised by tier, NOT a base class.

## Deferred / explicitly out of scope

- Molecule / cell *composition* as a higher-order layer (the original
  "tissues/organs" metaphor). The current cells are top-level, not composed.
- Multi-process registry (SQLite local only).
- Streaming, OpenTelemetry, dashboards beyond the in-process metrics summary.

## Runtime isolation — the containerised tool worker

`npm run build:worker` builds `atoma-worker:latest` from existing `dist/`;
`npm run build:worker:dev` compiles source first. `ContainerToolExecutor`
(`src/tools/containerExecutor.ts`) is a drop-in `ToolExecutor` whose tools run
inside it. The seam was already there: `ToolExecutor` is two methods
(`execute`, `has`), so only the side-effecting half moves — the supervise
loop, the LLM calls, the atom registry and the skill store stay on the
control plane.

WHY THIS SHAPE. `run_shell`'s child is spawned with `cwd` and nothing more,
so in a single process every store is one filesystem walk away (reproduced:
`ls ../../atoma-build.db ../../skills` listed the registry and all three skill
namespaces). Only the workspace is mounted, so the walk finds nothing.

THREE PROPERTIES, each verified against a real container before the code was
written, and each pinned by `tests/container-isolation.test.ts`:
  - `--network none` leaves the container its OWN loopback, so
    `start_node_server` + `fetch_url` still verify an HTTP deliverable from
    inside — while `host.docker.internal` does not even resolve. That is the
    network half of invariant T1 for free, and the reason "no network" is not
    crippling here.
  - only `<workspace>:/workspace` is mounted; the stores are absent from the
    filesystem rather than merely hard to reach, so an ABSOLUTE host path
    fails too.
  - `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root user,
    memory and cpu bounds.
  NATIVE-LINUX BIND OWNERSHIP IS PART OF THE CONTRACT. Docker Desktop made the
  image's fixed uid 10001 appear able to write a host workspace owned by the
  developer; the first fresh-image Linux CI correctly returned EACCES for
  `hello.txt` and `server.js`. `docker run` now uses the control-plane
  process's non-root uid:gid (and a writable scratch HOME), so the worker can
  write the one mounted directory without becoming root. The Dockerfile USER
  remains the fallback when no host uid is available. A flag-shape test pins
  `--user`, and the fresh-image CI proves the real bind.
The negative control was run explicitly: with the parent mounted and the
network on, the same probes read `TENANT_REGISTRY_SECRET` and resolve the
host. The tests discriminate.

TRANSPORT is JSON LINES OVER STDIO (`src/tools/containerProtocol.ts`,
imported by both sides — one definition, same rule as `src/contracts/`), NOT
HTTP on a port: a port is something the run could reach, which is the whole
thing being removed. Consequence: **stdout is the protocol**, so the worker
logs to stderr and a builtin that printed to stdout would corrupt the stream.
The worker announces its own tool declarations in a hello line — the IMAGE is
the authority on what it can do, since a Chromium-less image has no business
claiming `validate_html`.
AN UNEXPECTED WORKER EXIT RESETS THE EXECUTOR. The first implementation
rejected pending calls but kept a dead `child` and resolved `readyPromise`;
the next tool call wrote to dead stdin and waited the full 120-second call
timeout. Exit now clears both so `start()` launches a fresh worker, while
explicit `stop()` rejects pending calls immediately. An injected-child test
drives exit → restart without Docker.

WIRED, OPT-IN: `--container` / `ATOMA_CONTAINER=1` selects it in `runTask`
via `src/run/toolBackend.ts`. The swap touches ONE point because the split
was already clean — verified, not assumed: `src/tools/*` imports only node
builtins, puppeteer and its siblings (no store), and nothing in
`src/atoms|run|skills` reads the workspace except through `ctx.tools`. So the
"control plane must own the stores" concern raised when the primitive landed
was already satisfied by the existing architecture.

MEASURED on a real task run both ways (`ATOMA_LLM=claude-cli`, identical
goal): **per-tool overhead +4ms** (21ms containerised vs 17ms local) and
**container boot 243ms mean over three cold starts**. Those are the two
numbers the pipe actually costs. The runs also differed 102s/$0.174/12 calls
vs 158s/$0.143/18 calls — do NOT read that as a container effect: they took
different paths (7 vs 12 tool calls) and one A/B cannot separate model
variance from anything else. Deliverable verified on the host through the
bind mount (`node index.js hello` → `olleh`), probe manifest written, and the
trace kept all 7 tool events because `onToolInvocation` fires on the control
plane.
NOT THE DEFAULT, AND THE QUESTION IS CLOSED — a burn-in batch to decide it
was CONSIDERED AND REJECTED (2026-08-09): there are only two cases and
neither is waiting on the number. Local dev is single-tenant, so the
isolation protects the operator from nobody while costing a 1.5 GB image to
maintain; a SaaS deployment containerises ALWAYS, by construction, not by
flipping a default. An hour of runs to arbitrate between two options that are
not in play is the spend this file refuses everywhere else.
The REAL risk of an opt-in second path is that it ROTS — measured twice in
this repo: `research-brief.ts` drifted away from every safety guarantee the
build path gained, and `curriculum.ts`'s copy of the provider switch stopped
matching the original. The insurance is keeping the path exercised, not
running batches: `tests/container-isolation.test.ts` covers the tool layer
against a live container, `tests/tool-backend-selection.test.ts` covers the
selection (including that a new flag is never mistaken for the goal — the
`--clean-workspace` class of bug). Worker stderr is forwarded to the host so `[tool:…]` lines still appear
live; they match none of `parseRunLog`'s markers and arrive on stderr, so the
harness is unaffected.
DEPENDENCY INSTALLATION IS THE REAL LIMIT, measured rather than assumed:
under `--network none`, `npm install` with an actual dependency fails with
`EAI_AGAIN registry.npmjs.org`; with a `package.json` carrying NO dependencies
it succeeds in ~100ms ("up to date"); with no package.json at all it fails
with ENOENT, which it does with or without a network. So the constraint is
narrow — a run cannot FETCH a dependency — and it did not bite in the first
containerised batch, which made ZERO npm calls across five tasks because the
families are zero-dependency by design (`build-zero-dep-http-json-api` at
46✓). Note the mismatch that therefore stays latent: the persisted Helium
prompt still instructs `run_shell npm install` as step 3. It is NOT worth
editing — `patch` zeroes trust counters, so changing that prompt would cost
Helium its record to fix a case that has never occurred, and the instruction
is correct in local mode where installation works. The SaaS answer is a
registry proxy reachable on an internal network rather than blanket egress.
BUILT since: opt-in proxied egress via the `egress` option on
`workerRunArgs`. The run joins a `docker network create --internal` net
instead of `none`, and `HTTP_PROXY` points at the single peer on it —
`src/tools/egressProxy.ts`, whose entire policy is
`src/tools/egressPolicy.ts`. NEVER plain `bridge`, measured: `none` blocks
control plane and internet, `bridge` REACHES both, `--internal` blocks both
while still being a network a proxy can straddle. PROVEN end to end —
`npm install leftpad` succeeds from an internal-network container while
`host.docker.internal` is unreachable directly AND refused by the proxy.
Policy is DEFAULT DENY over anchored host entries (`registry.npmjs.org`
exact, `.npmjs.org` for subdomains; the anchoring exists to refuse
`registry.npmjs.org.evil.com`), IP literals always denied (an allowlist is a
list of NAMES — a literal is a run probing the proxy's own network), and
ports 80/443 by default.
ORCHESTRATED, not just available: `--egress` (or `ATOMA_EGRESS=1`) on
`run:build` implies `--container` and brings up a PER-RUN sidecar
(`src/tools/egressSidecar.ts`) — its own `--internal` network plus its own
proxy, both named after the run and torn down with it. PER-RUN is a
correctness requirement, not tidiness: REPRODUCED that two containers sharing
one `--internal` network reach each other's servers
(`REACHED: TENANT_A_WORKSPACE_SECRET`), so a shared network hands one tenant's
workspace to the next.
SEVEN lifecycle bugs are now fixed, each invisible from the layer above:
  1. `docker run -d` returns before the process inside listens, so the run's
     first request hit a dead proxy. There is a readiness wait now — and it
     reads BOTH streams, because `docker logs` mirrors stderr separately and
     the proxy logs there (stdout is the worker's stdio protocol). Reading
     only stdout made readiness never arrive.
  2. `network rm` raced the `--rm` worker's teardown; exactly one network
     leaked per run. Retried now.
  3. The env allowlist (#7a) STRIPPED `HTTP_PROXY` before npm saw it — two of
     this repo's own safety mechanisms cancelling out. The proxy variables are
     allowlisted; no credential was added.
  4. The image carries compiled `dist/`, so a host-side fix does nothing until
     `npm run build:worker:dev`. Same staleness trap as the `edit_file` fix;
     verify with a hash, never a grep.
  5. The runner watchdog exits synchronously by design, so async
     `backend.cleanup()` never ran there and leaked the proxy/network. Active
     sidecars now live in a module registry with a synchronous process-exit
     reaper: proxy first, every container attached to the per-run network,
     then the network. The command plan is unit-tested without Docker.
  6. Timeout and seed validation happened after side effects. A bad timeout
     could start the sidecar before exiting, and a missing `--seed` archived
     the existing workspace before reporting the typo. Both are preflighted
     before workspace preparation, store opens or backend startup; real
     subprocess tests pin the ordering.
  7. Proxy variables were injected without `NO_PROXY`, and Node 22's `fetch`
     ignores `HTTP_PROXY` unless `NODE_USE_ENV_PROXY=1`. The result was split:
     loopback risked policy denial while an allowlisted external `fetch_url`
     had no route and returned `fetch failed`. Both NO_PROXY forms exempt
     localhost, env-proxy mode is explicit and allowlisted into child Node
     processes, and a real egress worker test proves loopback plus an external
     registry fetch.
Every one of them presented as "npm install failed" with an empty stderr.
TEST DISCIPLINE, learned here: the control plane must be proven denied by the
ALLOWLIST independently of the port rule. The first version of these tests
put every control-plane case on port 4111, so both rules fired and neither
was isolated — if a deployment ever puts the control plane behind 443, the
port rule stops helping and the allowlist is alone. A case now pins that.
KNOWN GAPS: the `Dockerfile` CMD must stay an ABSOLUTE path (the caller sets
`-w /workspace`, so a relative one resolves under the mount and dies with
MODULE_NOT_FOUND — cost one build cycle to find), and the image is 1.56 GB,
almost entirely Chromium.
**THE IMAGE MUST CONTAIN THE WORKER'S WHOLE IMPORT CLOSURE, AND A TEST NOW
SAYS SO.** `record_probe` landed, `builtin.ts` gained an import of
`../contracts/probeManifest.js` — the schemas that exist precisely so the
manifest has ONE definition — and the Dockerfile still copied only
`dist/tools` and `dist/core`, with `zod` (that contract's only dependency)
absent from `docker/worker-package.json`. A clean rebuild therefore produced
an image that died at startup with ERR_MODULE_NOT_FOUND. Fixed by
`COPY dist/contracts` plus the `zod` dependency; verified by running the real
image, where `record_probe` now records a command byte-identically through
those schemas.
NOTHING CAUGHT IT, AND THE REASON IS THE POINT: `container-isolation.test.ts`
drives a REAL container — right for a claim about the container — but it
SKIPS when the image is absent and PASSES against a stale one built before
the import existed. That is the same staleness trap recorded above for the
egress-proxy fix ("verify with a hash, never a grep"), arriving from the
other direction. So the insurance is STATIC and never skips:
`tests/container-image-closure.test.ts` walks the worker's real import graph
from `src/tools/worker.ts` and asserts every `src/` directory it reaches is
COPY'd and every npm package it reaches is declared, plus that shared ranges
match the root manifest (the image installs its own tree but runs the SAME
compiled `dist/`, so a drifted major would break inside the container only).
Verified to FAIL against the pre-fix Dockerfile and manifest, naming both
fixes. It drops `import type` (tsc erases it) and counts a value-syntax
import even if it binds only types — over-counting costs one COPY line,
under-counting costs a broken image.
NOTED WHILE MEASURING, deliberately NOT changed: the value closure is
`{tools, contracts}`, so `COPY dist/core` is currently DEAD — `core/types.js`
is reached only by `import type`. The closure test asserts required ⊆ copied
and tolerates the extra, because narrowing the COPY set is a separate change
with its own risk and was not what was broken. Note the copied `dist/core`
also carries modules importing `better-sqlite3` and the SDK, which the image
does not install; they are inert only because ESM resolves per import and
the worker never loads them.

## atoma as an MCP server (stdio) — `src/mcp/`

`npm run mcp:dev` (source) / `npm run mcp` (compiled release) speak MCP on
stdio: **13 tools**, two of which
mutate (`atoma_run_start`, `atoma_run_cancel`) and eleven of which are pure
readers over the persisted state (families, registry list/show, skills
list/stats/review, ledger check, runs list, one trace, the friction report,
plus run status).
Supported registration after `npm run build`:
`claude mcp add atoma -s local -- node <abs>/dist/mcp/stdio.js`;
verified `✓ Connected` by Claude Code's own client.

**WHY STDIO IS THE WHOLE SAFETY ARGUMENT, AND WHY YOU MUST NOT ADD A PORT.**
The viz Launch-tab entry above lists what a launch endpoint would need — a
secret that never touches HTTP, a global Host allowlist ahead of every branch,
an exact-Origin check with the port, the DNS-rebinding surface — and every item
exists because the viz listens on a port THE RUN ITSELF CAN REACH (`fetch_url`
has no URL allowlist by design; `run_shell`'s allowlist is STEERING, not a
boundary). The adversary is the run, not a remote page. A stdio server hands
the run no socket, which DISSOLVES that threat model instead of mitigating it —
so ~80% of the value the Launch tab deferred to "phase 2" arrives here for
free. The corollary is a rule: no HTTP transport, no debug endpoint, no metrics
port in `src/mcp/`. Any of them re-opens the exact hole and the paragraph above
stops applying.

**A RUN IS A CHILD PROCESS — four independent blockers, each verified in the
source, any one of them fatal.** (1) `runTask` NEVER SETTLES: `runner.ts` ends
its success path on `await new Promise(() => {})` so a delivered run's server
stays reachable, unconditional and present on the `--baseline` path too. (2) It
EXITS THE PROCESS on every other path — failure branch, watchdog, bad `--seed`,
bad timeout, and `makeAnthropicClient` with no credential all `process.exit`.
(3) It FLOODS STDOUT: `consoleLogger.info`/`.debug` are `console.log`/`.debug`,
hardcoded into both `ctx.logger` and the tool backend with no seam, plus ~38
direct `console.log` in the runner including the whole `--- result ---` block
with unbounded model-authored output. (4) It MUTATES PROCESS GLOBALS: writes
the three skill-lifecycle env vars, deletes `ANTHROPIC_API_KEY`, and registers
SIGINT/SIGTERM handlers per call without removing them.

**STDOUT PURITY IS STRUCTURAL, NOT DISCIPLINARY.** The SDK's only stdout write
is `JSON.stringify(msg) + '\n'` and the peer's frame reader THROWS on a
non-JSON line — stricter than atoma's own container protocol, which
deliberately drops them (`drainLines`). `claimStdoutForProtocol` therefore
captures the real `process.stdout.write` for the transport and then redirects
`process.stdout.write` to stderr, so every `console.log` in this repo and in
every dependency is neutralised rather than trusted. The claim must happen
BEFORE the application import graph: ESM evaluates static imports first, so
putting it at the top of `server.ts` was still too late for a noisy dependency.
`stdio.ts` is now the tiny bootstrap — its only static import is the quiet
claim helper, then it dynamically imports `server.ts`. A source-order test pins
claim-before-import and the real subprocess test rejects any non-JSON stdout.
Same rule already written down for the container worker.

**`spawnRun` WAS EXTENDED, NOT FORKED**, because it is the one sanctioned run
driver and its kill sequence was measured (a naive re-implementation leaks nine
browser processes per web run) — and it has no unit test, so a second copy
would rot like `research-brief.ts` and `curriculum.ts` did. Six additions, all
defaulting to today's behaviour: `cwd` (was hardcoded `process.cwd()`; an MCP
host launches with an arbitrary one and `npm run run:build` would fail as a
missing script), `npmScript` (resolved from the same `LAUNCHABLE_PROFILES`
entry the family picker reads; a second family cannot silently launch
`run:build`), `signal` (the ONLY way to cancel — the child was otherwise
unreachable, and an abort routes into the SAME SIGTERM → 5s grace → SIGKILL
sequence, so a cancelled run still closes its trace), `onChunk` (progress for a
caller who cannot see the child's stdout), `onSpawn` (the detached process-group
id, used by the MCP hard-exit backstop and lease recovery), `cleanWorkspace` (unconditional
before, which is right for measurement and surprising in an interactive host
where it ARCHIVES the deliverable just asked about). TWO SETTLE BUGS fixed
there at the same time, both of which presented as a promise that never
resolves — a hung tool call in a server, merely odd in a batch script: the
`writeFileSync(logPath, …)` inside the exit handler ran BEFORE `resolveRun`, so
a missing log dir stranded the promise; and there was no `'error'` listener at
all, so a spawn that fails outright resolved never.

**ONE `process.chdir(repoRoot())` REPLACES A CLASS OF PATH DRIFT.** `./atoma.db`,
`./runs` and `./skills` are cwd-relative and the runner resolves only the
workspace against anything. An unpinned server would silently create and mature
a BRAND NEW empty store — losing every earned counter — and its readers would
report on a different store than its runs write. Working from the repo root
makes `storeDbPath()` / `skillsDirPath()` correct verbatim, with no second copy
of the path rules (four divergent copies of that rule WAS the bug once). The
root comes from `import.meta.url` and is confirmed by `package.json`'s presence,
so `src/mcp/` and `dist/mcp/` both work.

**RUNS ARE SERIALISED AND A SECOND START IS REFUSED.** Three independent
single-tenancy facts make concurrency produce plausible-looking WRONG numbers
rather than an error: one shared workspace archived wholesale, trace attribution
by newest-mtime-since, and the machine-to-itself requirement for comparable
economics. The burn-in harness gets this free from its sequential loop; a server
has to enforce it. An in-memory `inFlight` variable is NOT enforcement across
two MCP server processes, so the authority is a singleton row in
`~/.atoma/mcp-run-lock.db`. Acquisition/recovery runs under `BEGIN IMMEDIATE`;
owner replacement and release are conditioned on a random token. This replaced
the first hard-link lock, whose read-token-then-unlink sequence had an ABA race:
two stale recoverers could let the late one unlink the early one's new lease.
The row carries server PID and detached child PGID. A dead owner with a live
group triggers SIGTERM → 5s → SIGKILL and waits for ESRCH before a
compare-and-swap takeover. Two real processes racing the same stale row are
pinned: exactly one acquires.

**CANCELLING IS A STATE, NOT A COMPLETION.** `atoma_run_cancel` sets
`status: "cancelling"` and aborts `spawnRun`; the slot and lease remain held
until the WHOLE process group is confirmed gone and the trace closes, then the
public status becomes `cancelled`. A leader `exit` is insufficient — a test
leaves a descendant in the same PGID after its leader exits, and the shared
terminator still reaps it; a second test forces the SIGKILL branch. The first
implementation set `cancelled` immediately, and
`startRun` only blocked `running`, so a new run could archive the workspace
during the old group's 5-second teardown — the test explicitly enshrined the
race as "cancelling frees the slot". Stdio EOF/close, transport `onclose`,
SIGINT, SIGTERM and SIGHUP now enter the same awaited shutdown. A 6-second
server backstop force-kills a driver promise that never settles; the
synchronous exit hook signals but deliberately LEAVES the lease row stale,
because process exit cannot confirm ESRCH — the next server does that safely.
HONEST RESIDUAL: there is an instruction-scale window between `spawn()` and
the synchronous SQLite `attachChild(PGID)`. Attachment failure is fail-closed
(the new group is terminated and the driver rejects), but an uncatchable
SIGKILL in that exact window leaves a row with no PGID and an orphan no safe
identifier can recover. Process-name scanning was rejected: it can kill an
unrelated npm run. Direct launches outside MCP also do not take this lease.

**THE PROVIDER IS PINNED, AND THE NESTED PATH WAS VERIFIED RATHER THAN
ASSUMED.** The child gets `ATOMA_LLM=claude-cli` unless the host set one,
because the Claude Code environment carries an `ANTHROPIC_API_KEY` that the
auth chain prefers FIRST (the documented "#1 auth trap") and in this project it
is dead — a run reaching the direct-API path dies in ~15s and reads as
`looksLikeConfigFailure`. The open question was whether claude-cli works at all
when atoma is itself a child of Claude Code (`ClaudeCliLlmClient` spawns
ANOTHER Claude Code, inheriting `CLAUDECODE` / `CLAUDE_CODE_SESSION_ID`).
MEASURED 2026-08-11: it does — one Haiku call from a Claude-Code-spawned child
returned in 3.0s with usage reported, and a full live run through the server
reached `[Ammonia] skill matched: build-argv-transform-cli` at 34s and
`[tool:run_shell] node reverse.js` at 66s before being cancelled. Cancellation
left ZERO leftover processes and zero leaked Chrome.

**A CANCELLED RUN READS `outcome: "error"`, AND THAT IS THE PARSER BEING
HONEST.** It prints neither completion nor failure banner, so `parseRunLog`
falls through to 'error' with null economics. The record's own `status` stays
`cancelling` until child exit, then becomes `cancelled` (authoritative) and
carries a hint saying so, or a host reports "the run errored" to a user who
cancelled on purpose. The config-failure heuristic is
SKIPPED for cancellations for the same reason: it fires on "died fast, spent
nothing", which is exactly what a cancellation looks like, and a false
misconfiguration alarm sends the reader hunting a dead API key that is not
there.

**DELIBERATELY NOT EXPOSED**, each for a stated reason: `--seed` (it `cpSync`s
an arbitrary host directory into the workspace — allowlist a root first if a
maintenance family ever needs it); `prefilterCacheClear`; raw argv or a
free-form flag string (the flag set is CLOSED and mirrors `parseRunnerArgs`,
pinned by a test that greps the runner source, and the goal always goes LAST so
it can never be read as a flag); trace EVENT PAYLOADS (megabytes of
model-authored prompts and tool results — `npm run viz` is where a human reads
those); and the burn-in CSV summary, because its row parser is private inside
`src/viz/server.ts`, a module that BINDS A PORT AT IMPORT — surfacing it means
extracting that parser to a pure module first, which is a widening of the diff
for a reader the viz already renders well.

**TWO READER PAYLOADS CARRY THEIR CAVEATS IN-BAND** because they are easy to
misread as verdicts, and this file records both misreadings happening:
`atoma_skills_review` says it is a MECHANICAL pre-screen and never a sharing
approval (§4.2 of the SaaS doc requires a human to read both kinds of body),
and `atoma_skills_stats` echoes the trust/promote thresholds in force, since
they are read at CALL time and a mid-benchmark check was already misled by
reading them without a round's env vars.

**TESTS ARE THE ANTI-ROT INSURANCE**, not a batch of live runs
(`tests/mcp-server.test.ts` + `tests/mcp-run-lock.test.ts`): the emitted flags must exist in the
runner source; a goal starting with `--` is refused (it would be discarded and
the family's DEFAULT goal would run — so `--clean-workspace <words>` would
archive the caller's workspace AND build the wrong thing); unknown and
traversal-shaped family ids are refused through `findLaunchable`; the timeout is
validated before spawning (the runner `exit(2)`s on a bad one); cancellation
keeps the slot through settlement, shutdown awaits abort, and the detached pid
reaches the lease through an INJECTED driver so no test spends quota. The lease
suite uses both same-process adversaries and a REAL second process, plus stale
owner recovery and token-safe release. `runTrace` cannot leave the runs dir; the
instructions never name a builtin tool (the ae63e06 rule, checked against
`BUILTIN_TOOL_VOCABULARY`); and one test drives a REAL subprocess to prove
stdout carries nothing but frames.

## SaaS / multi-tenancy — `docs/saas-architecture.md`

Nothing multi-tenant is BUILT (zero tenancy primitives in `src/`; the viz
server has no auth at all). But the target state — per-entity runs, globally
shared skills and atoms — constrains design work TODAY, so the formal target
lives in `docs/saas-architecture.md`. Read its **§5 Invariants** and **§7
Design rules to apply starting now** before touching skill lifecycle, atom
identity, counters or any store path. The three findings that matter most
here and now, all reproduced against the code: (1) `run_shell`'s child gets
`cwd` and no jail (`builtin.ts:338-344`) — tenant isolation is therefore not
implementable in-process. The build workspace has since MOVED OUT of the repo
(`~/.atoma/workspaces/build`, `defaultWorkspaceRoot` in
`src/run/profiles/build.ts`) so the stores are no longer two `..` hops away,
but that is blast-radius reduction, not a boundary: absolute paths still
reach everything. Pinned by `tests/workspace-outside-repo.test.ts`;
(2) `scanScriptBody` is a hygiene filter with a verified bypass
(`scriptScan.ts:95-97` checks external URLs ONLY on HTTP hosts) and must never
be cited as a security control; (3) one present-day bug FIXED while writing this (`sanitise` accepted
`..`, and an LLM-authored `verdict.branchName` reached it — reproduced writing
a SKILL.md outside the skills root; now guarded at both layers by
`isSafeAtomName` and an explicit traversal check, see
`tests/atom-name-path-escape.test.ts`), and a second, also FIXED: `branch`
allocated ordinals from live rows only where `create` UNIONs the version
history, so a post-`remove` branch resurrected the dead atom's name — and with
it its skill namespace and earned counters. Both allocators now share
`usedOrdinals`, because the DRIFT between two copies of one rule was the bug. Load-bearing conclusion: skill/atom BODIES may globalise (under
review); trust COUNTERS never do — for a `kind: script` skill, injection IS
execution (`lifecycle.ts:210-245`, which deliberately omits the trust-boundary
lines the llm branch carries).

## Plan file

The original greenfield plan (`docs/architecture-plan.md`) was removed in the
2026-08 cleanup — it predated skills, manifests, the burn-in harness and the
5-series model migration, and THIS file has long superseded it as the
reference. Recover it from git history if the genesis rationale is ever
needed. Before major refactors, this file is what you consult.

## Outward-facing docs

`README.md` is the EXECUTIVE pitch (consultancies, CTOs, decision-makers) and
`docs/how-it-works.md` the high-level technical tour it links to — components,
flows, six rendered diagrams. Both are English; keep them so. THE RULE THAT
MATTERS: every number in them must be reproducible from a repo artefact TODAY.
A 2026-08-10 audit of the previous README found 6 of 10 headline claims stale or
unsupported, including all three badges — no full run has ever cost $0.00 (the
zero applies to PHASES; cheapest run is $0.126), the "$0.22 · 138s warm run" pair
appears in no CSV row or trace, and the head-to-head-vs-Opus-direct table had no
surviving baseline artefact of any kind (the benchmark commit shipped README-only;
`runs/` is gitignored and predates nothing before 2026-08-05). They were removed
rather than softened. The trap is structural, not carelessness: the burn-in curve
keeps moving and the curriculum escalates difficulty on purpose, so a figure
pasted from a good session rots within days. Cite medians over a stated n, name
the window, and prefer a claim that regenerates with `npm run burnin`.

## The controlled benchmark (`benchmark/`) — four rounds, and what they settled

`PROTOCOL.md` pre-registers every round; `RESULT.md`, `ROUND2/3/4.md` are the
outcomes. All four start from an EMPTY registry and empty skill store.

**WHAT IS ESTABLISHED (four independent rounds).** atoma costs $0.531 / $0.536
/ $0.506 / $0.468 per run while the single-frontier-agent control arm swings
$0.82 → $1.01 → $1.68 → $1.10. The frontier is VOLATILE, not drifting, and
atoma DAMPS that variance because it exposes one frontier call in about
fifteen where the baseline is exposed end to end. Ratios 1.54× / 1.89× / 3.33×
/ 2.35×, each against its own same-day control — CROSS-round cost comparison is
invalid and the drift check exists to keep saying so. Generalisation reproduced
four times: a never-seen same-family task costs $0.35-0.55 with ZERO new
recipes learned. Deliverable correctness 19/19, 19/19, 19/19 by an executing
scorer.

**THE ZERO-TOKEN PATH WORKS ON MAINTENANCE, NOT ON BUILDS (round 5 settled
it).** Four build rounds produced ONE dispatch across 54 atoma rows
(47 primary + 7 held-out). Round 5, on a
MAINTENANCE task (a seeded CLI + README + manifest, one behaviour change, then
re-verify the rest): **10 dispatches in 8 primary runs** — 11 in 9 when the
held-out row is included — **zero contract failures, zero
demotions, $0.1509/run against a $0.7069 same-day control — 4.69×**. The split
was exactly as designed: editing source stayed on the LLM path and the compiler
REFUSED to compile it; re-running recorded invocations compiled and dispatched
free. So the mechanism was never broken — a from-scratch build decomposes into
build → record → document and never produces the re-verification phase a
compiled verifier serves.
AND IT BOUGHT PART OF THAT SAVING WITH WORK IT DID NOT DO. An independent
scorer found **7 of 9 deliverables shipping a README that contradicted its own
artefact** (`chars 36` documented, 35 produced). The compiled verifier had been
matched to "update README.md so that only the invocations whose behaviour
legitimately changed are corrected", replayed its manifest, printed a valid
envelope and wrote nothing. THE DELIVERABLE GATE COULD NOT SEE IT: it checks
that named files EXIST, and on a maintenance task every file exists already
because it was seeded. A gate designed against build tasks is inert as soon as
nothing is missing. Fixed — `subtaskMutatesFiles` + a before/after content
snapshot in `runScriptSkillDirect`, rejecting a dispatch that leaves a named
file byte-identical when the subtask used a mutating verb; a pure
re-verification subtask writes nothing by design and is deliberately NOT gated.
NOT RE-MEASURED: whether the gate converts those seven runs into correct
deliverables at some cost in dispatch rate is a round-6 question.
THE LESSON THAT GENERALISES: at 1/1 thresholds the validators are skipped
run-wide, so "delivered" proved almost nothing and the EXECUTING correctness
scorer was the only thing between a 4.69× headline and a wrong one. Never
report a cost win from a low-threshold round without scoring the artefacts.

**ROUND 6 CORRECTED ROUND 5's HEADLINE, and the correction is the finding.**
Round 5's 4.69× was measured with `TRUST=1`, i.e. with the atom-type
validators skipped run-wide, and 7 of 9 deliverables shipped a README
contradicting their own artefact. Round 6 restored `TRUST=3`, kept
`PROMOTE=1`, and added the before/after gate: correctness went to **5 of 6**,
dispatches went **10 → 1**, and the ratio settled at **2.05×**. So the honest
figure on maintenance, with deliverables that are actually right, is about
**2×** — roughly half of what round 5 advertised. It took an EXECUTING scorer
outside both arms to see that; the pipeline's own "delivered" said nothing.
`promote=1` did survive with validators on (compiled run 1, armed run 3, no
demotion) — that knob is defensible on two rounds. `trust=1` is not, and the
two must never be moved together again.
THE GATE IS CATCHING DOWNSTREAM WHAT BELONGS UPSTREAM. Its five fallbacks were
a read-only verifier matched to three README subtasks and once to the CODE
EDIT subtask. Its `when_to_use` is a correct verification clause, so phrasing
is not the cause this time: `SKILL_PREFILTER_SYSTEM_PROMPT` deliberately drops
the "no force-matching a single candidate" rule the atom prefilter carries,
and with one compiled script in the catalogue that permissiveness routes
everything to it. FIXED AT MATCH TIME (2026-08-11): `matchSkill` filters the
CATALOGUE before the prefilter sees it — a `kind: script` whose body has no
write surface (`scriptWritesFiles`) is not offered for a subtask carrying a
mutating verb (`subtaskMutatesFiles`). Filtering beats rejecting: the prefilter
can pick a different candidate and no dispatch is wasted.
THE COUNTER-ARGUMENT I RAISED WHEN PROPOSING THIS DOES NOT APPLY, and the
retraction is the part worth keeping. I said it had to be weighed against the
case the permissive prompt was written for — a one-recipe catalogue that never
matches. It does not: this is a CAPABILITY test, not a confidence one. It never
reinstates the single-candidate prohibition, and a one-recipe catalogue still
matches its recipe wherever the recipe fits. `kind: llm` recipes are untouched
(injection is guidance; the L1 writes). The write detector errs toward "writes"
deliberately — only a body with NO write API at all is filtered, because
over-filtering removes the very dispatches this protects.
FIXED (2026-08-11) — `scriptCanServeSubtask` in `src/skills/scriptTargets.ts`
replaces the any-write test with a per-DESTINATION one: resolve the path
literals reachable as the DESTINATION argument of a write API
(`path.join(cwd, 'x.json')` is the dominant shape, 9 of 10 corpus bodies), and
refuse the match only when the subtask PROVABLY TARGETS files the body never
writes. "Named" alone was too broad: `update README.md from package.json`
names an output and an input, so requiring a correct documentation generator
to overwrite package.json is a permanent false refusal. High-confidence
mutation grammar (`update X`, `X must be rewritten`) now identifies targets;
`from` / `using` / `read` / `based on` mark inputs, and ambiguity
under-extracts into OFFER per the rule below. Verified against every archived compiled body: 9 resolved, 1 opaque
(a glob), and `package-and-document-cli` correctly identified as a genuine
multi-file writer while the five verifiers resolve to `.atoma-probes.json`
alone. ALL, not ANY, over the proven TARGETS — one round-6 fallback targeted
the manifest ALONGSIDE two files the verifier can never write, so a non-empty
intersection would let it through (ALL refuses 14/14 archived gate fallbacks,
ANY 12/14).
UNPROVABLE ⇒ OFFER, always: a false refusal is permanent and costs a
zero-token dispatch AND the credit that arms maturation, while a false offer
costs two tool calls before the deliverable gate — which caught 14 of them
across rounds 6-7 without one wrong deliverable. Accepted residual, stated so
nobody "fixes" it: a write via subprocess (`sed -i`) is invisible to the scan.
Do NOT answer that by treating every spawning body as opaque — all ten corpus
bodies spawn to replay the CLI, so that rule would make the predicate inert
again, which is exactly this round's mistake.
IT APPLIES ONLY ON THE TRUSTED BRANCH, and that gate is load-bearing rather
than cautious. Simulated over rounds 6-7: filtering EVERY script match refuses
10 of 11 and takes dispatches from 1 to **ZERO** in both rounds — the three
successes that carry a script to TRUST=3 are earned on the documentation
phases this predicate refuses, so filtering them starves the counter that arms
dispatch. Restricted to trusted matches it is break-even on dispatches (1 → 1)
and removes all five gate fallbacks per round. The principle the measurement
exposed: the filter exists to save a WASTED DISPATCH, so where no dispatch is
possible there is nothing to save and refusing costs only credit.
THE TWO LAYERS HOLD OPPOSITE DISPOSITIONS ON PURPOSE — do not harmonise them.
The validator may APPROVE an unchanged file when the evidence exhibits the end
state; deterministic dispatch returns before any validator and exhibits
nothing, so an unchanged mutating-subtask file there is still a fallback.
Covered by `tests/script-write-targets.test.ts` (fixture: the real round-7
body, which WRITES the manifest and only READS the README — the exact miss).

MEASURED IN ROUND 7, AND IT IS INERT. `scriptWritesFiles` fired ZERO times
across the round: the compiled verifier contains
`fs.writeFileSync(manifestPath, …)` — it merges observations back into the
probe manifest — so the predicate calls it a writer and never filters it.
Almost every compiled verifier writes its own manifest, so the test is inert on
the whole class it was built for. Dispatches stayed at 1, gate fallbacks stayed
at 5, exactly as in round 6.
I HAD REGISTERED THIS FAILURE MODE BEFORE LAUNCHING and shipped anyway; naming
a flaw in advance is not closing it. THE RIGHT PREDICATE is not "does this body
write?" but "does it write the file the SUBTASK NAMES?" — compare the paths in
the subtask against the path literals in the body. Statically decidable, and it
leaves the deliverable gate as the last resort.
AND ROUND 7 SURFACED A BIGGER COST THAN THE ONE IT WAS CHASING. Cost rose to
1.00× the control — for the first time in seven rounds even H1 failed — driven
by 13 escalations against round 6's zero.
THE FIRST DIAGNOSIS PUBLISHED HERE WAS WRONG, and the way it was wrong is the
part to carry: it blamed "a recipe distilled in run 1 [that] demanded a format
the L1 could not produce", naming the event skill
`recover-non-json-prose-missing-evidence` — whose body does demand line
numbers. Offline replay of the traces shows that skill was **learned in run 1
and never injected once** (0 matches). It cannot have caused anything. The
diagnosis had been built by reading one validator complaint and inferring a
cause instead of checking whether the named mechanism ever ran — the same
error as round 3's, one round later.
THE REAL CAUSE is a validator semantics gap on IDEMPOTENT work: an earlier
sequential phase applied the edit, a later phase whose subtask text still said
"apply ONE minimal edit" correctly reported it done, and the validator rejected
the honest report — four more times — because the task text mandates an edit.
It was NOT short of evidence: all 8 rejections carried a ground-truth block,
and one quoted the edited line verbatim with six verified invocations. Fixed by
the QUOTED SPAN check + the ALREADY-SATISFIED rule (see the two entries in
Architecture invariants).
AND THE COST COLUMN IS READABLE AFTER ALL. The damage is confined to 2 of 6
runs ($1.09 and $1.38 against a $0.26 mean); the other four read **$0.2607/run,
2.24× the control** — reproducing round 6's 2.05× almost exactly, with the
held-out task at 1.90×. The cascade alone accounts for $0.325/run. Note the
exclusion is legitimate ONLY because the mechanism was identified, is absent
from 302 other runs, and is unrelated to the change under test; n=4 is thin and
the exclusion was decided after seeing the data.
THE ONE CLEAN RESULT: correctness 2 of 9 → 5 of 6 → 6 of 6 across rounds 5-7,
while dispatch volume went 10 → 1 → 1. The gate works; the trade is currently
priced badly.

**ROUND 8 CLOSED THE CASCADE AND CONFIRMED THE STANDING POSITION ON
COMPILATION.** All four registered conditions met: already-satisfied
rejections 5 → **0**, no run above $0.59 (round 7: $1.09 and $1.38), the
predicate fired **14 times with 0 gate fallbacks** (round 7: 0 and 5), and
correctness held at 6 of 6. Validator rejections of EVERY kind went 10 → 0,
and with them the branches and fallbacks. atoma mean $0.3132 against round 7's
$0.5854; held-out task $0.2667 with zero new recipes, the sixth consecutive
reproduction of generalisation. The control arm is n=1 for an
INFRASTRUCTURE reason, not a slowness one: the second run's LLM connection
dropped and the last-resort watchdog fired at 960s ("the transport is
wedged"), AFTER the work was done — its workspace scores 7/7. Note WHY the
whole observation was lost, because the shape will recur: the baseline is ONE
long-lived call and usage is booked on return, so the partial trace reads
1 call started / 0 completed / 20 tool events. An atoma run of the same task
makes 11-24 shorter calls and the same fault would cost one of them. A
measurement asymmetry, not a merit — the frontier deliverable was correct.
This is exactly why cost was excluded from the registered conditions in
advance.
DISPATCHES WENT 1 → **0**, and not because the predicate misfired — all 14
refusals were correct, on a manifest-only writer offered for README/source
subtasks. The compiled script reached 3✓ only at the round's end and never met
a re-verification subtask while trusted. So across rounds 5-8 the zero-token
path fired 10 / 1 / 1 / 0, and only the first of those had (broken)
deliverables behind it. **Every fix to it has been real and has made the
mechanism more correct; none has made it pay.** Treat "compilation contributes
the saving" as unsupported after four attempts, and the saving as coming from
tiering, earned trust and recipe reuse — which eight rounds do support.
THE ROUND ALSO FOUND A DEFECT IN ITS OWN FIX: of 10 QUOTED SPAN verdicts, the
4 NOT FOUNDs were ALL false positives — a diff's `OLD:` side (absent because
the edit succeeded) and the `== GROUND TRUTH ==` header (which passes the
code-shape test because it contains `=`). None caused a wrong rejection, since
a contradiction only forces a full LLM verdict and all four were approved, but
a signal whose stated design is never to fabricate a contradiction fabricated
four in nine runs. Both classes are now excluded.
AND IT CLOSED A REPRODUCIBILITY HOLE THREE ROUNDS OLD: rounds 5-7 each
reported correctness from a scorer that was never committed.
`benchmark/verify-maint.mjs` is that scorer, executing rather than reading
claims. Its workspace mapping must be VERIFIED, never assumed — an off-by-one
anchor once produced a false 83.3%; here `build.prev114` carries the held-out
semantics, which fixes the anchor.

**WHAT WAS NOT ESTABLISHED ON BUILD TASKS, after three attempts to make it
work.** The
zero-token compiled-script path has fired ONCE in 54 atoma rows
(47 primary + 7 held-out). Rounds 2-4
each fixed a real broken link — `when_to_use` phrased as unevaluable disk
state; the manifest recording TRUNCATED stdout; `record_probe` refusing a whole
command line so the model wrapped everything in `bash -c` and broke the
verifier's argument extraction — and round 4 came out with zero contract
failures, zero demotions, the compiler correctly refusing both irreducible
recipes and correctly compiling the pure verifier. It was then **never
matched**: 0 of 9 runs.
THE CAUSE IS THE DECOMPOSITION, NOT THE SKILL MACHINERY. Re-derived from the
plan responses: this family decomposes into build → RECORD → document. The
compiled verifier advertises for "re-verify that previously recorded
invocations STILL produce the same exit codes" — a re-check, which only means
something if the artefact changed after recording. That is MAINTENANCE work. A
from-scratch build never contains it. The zero-token path aims at a phase shape
these tasks do not produce, so no fourth patch of the same kind will help.
NEXT IS A CHOICE, NOT A FIX: either benchmark a maintenance family, where the
re-verification phase actually exists, or accept the scope and state in the
README that the saving comes from tiering and earned trust (which four rounds
support) rather than from compilation (which none demonstrated).

**METHOD NOTES THAT COST REAL TIME.**
- Round 3's first published diagnosis was WRONG and nearly became a feature: a
  grep for the first trace event matching the error text returned the run
  SUMMARY, not the script, and pointed at "the compiled script parses prose".
  The dispatched body is recorded verbatim by the dispatch's own
  `write_file _skill_*.mjs` event — read THAT.
- `skills stats` computes status with the CURRENT env thresholds. Reading it
  without the round's `ATOMA_PROMOTE_THRESHOLD` shows statuses for the
  defaults, which misled a mid-round check.
- Archive `runs/` and `skills/` BEFORE restoring a store, not after. Round 2's
  19 traces were destroyed by doing it in the wrong order — in the very session
  that committed round 1's traces because gitignoring them had made an earlier
  benchmark unreproducible.
- Thresholds are call-time env vars (`ATOMA_PROMOTE_THRESHOLD`,
  `ATOMA_TRUST_THRESHOLD`), so a round can be shortened without a code change;
  round 4 used 2/2 and reached first compilation at run 5 instead of 8.

## The controlled benchmark — mechanics

The head-to-head the audit found missing, built properly on 2026-08-10.
`PROTOCOL.md` is a PRE-REGISTRATION — hypothesis, primary metric and
falsification condition committed before the first run, amended only by dated
notes. `RESULT.md` is the outcome. **19 runs from an empty registry and empty
skill store**, control arm first.

RESULT: break-even at run **2**; 10 atoma runs cost **$5.31 vs $8.20**
(−35.2%); warm run $0.4945 vs $0.8198 (1.66×); **19/19 deliverables at full
marks on both arms**; on a novel same-family task the baseline paid $1.18 and
atoma $0.40 **having learned zero new recipes** (generalisation, not
memorisation — though that baseline is n=2 spanning 2.5×, so it is indicative).

WHAT IT ACTUALLY PROVED, and this is the part to carry forward: the saving came
from the **trust fast-path and recipe reuse**, NOT from compilation —
deterministic dispatch fired ZERO times (see the monolith-starves-its-sibling
entry in Skills). Mechanisms 1 and 2 carried the result alone.

THE CONTROL ARM IS ONE LINE. `--baseline` (`src/run/baseline.ts`) swaps only
the `l3.handle` call in `runTask` for a single frontier agent holding the same
nine tools. Everything that could bias a cost comparison — sandbox, budget,
price table, token accounting, cache behaviour, watchdog — is literally the
same code, not "matched". It seeds nothing and is additionally pointed at a
throwaway store, so it cannot mutate the treatment arm's state (verified: the
registry reads empty after a baseline run). Do NOT refactor it into its own
CLI; that is the `research-brief.ts` drift this repo has already paid for
twice.

TRACES ARE COMMITTED (`benchmark/traces.tar.gz`). `runs/` is gitignored, and
that is exactly why the PREVIOUS benchmark became unreproducible. Any future
benchmark must preserve its traces the same way, and must archive the store it
starts from — `~/.atoma/archive/{pre,post}-benchmark-<date>/` holds both ends
of this one.

INSTRUMENT DISCIPLINE, learned here: `verify-deliverable.mjs` EXECUTES each
artefact rather than trusting the "delivered" banner, which only means the run
finished. It was corrected twice, both times in atoma's favour, both times on
verified false negatives (`stdev` with one `d`; `Elapsed Time` for a time
span) — because the checks had been drafted from the control arm's vocabulary.
The rule that came out of it: when a check fails, READ THE ARTEFACT before
recording the failure; and when you loosen one check, loosen the whole
vocabulary including checks nobody is failing, then confirm the OTHER arm's
scores did not move. All seven control deliverables held full marks across all
three revisions of the instrument.

## Language

The user (`mgf@iotanet.net`) communicates in French. Respond in French;
keep code, comments, and commit messages in English.
