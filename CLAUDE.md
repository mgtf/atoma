# CLAUDE.md

Project-level notes for Claude Code. Read this before making changes.

## What this is

`atoma` is a TypeScript framework for three-tier LLM agent orchestration. Every atom
is an LLM-backed agent. See `README.md` for the external pitch.

## Commands

```bash
npm install
npm run typecheck                     # tsc --noEmit (strict mode)
npm test                              # vitest run — all mocked, no API key needed
npm run build                         # emits to dist/
npm run example:research "<topic>"    # live, requires ANTHROPIC_API_KEY
npm run example:build "<goal>"        # live build-an-app example

npm run registry -- list              # inspect persisted atom types + counters
npm run registry -- list --tier 2
npm run registry -- show Hydrogen
npm run registry -- top --by failure  # sort by failures; also success|ratio
npm run registry -- history Hydrogen  # archived versions: prompt head, tools, who/when/why
npm run registry -- rollback Hydrogen --to 2   # restore v2 content as a NEW live version
npm run registry -- remove Glucose --db ./atoma-build.db  # delete dynamic-creation debris
npm run registry -- --db ./atoma-build.db list   # override DB path

npm run skills -- list                # all skills: kind, counters, refusal stamps

npm run burnin                        # batch tasks through the REAL pipeline; appends
                                      # per-run economics to burnin/results.csv
npm run burnin -- tasks.json --family cli --out custom.csv --timeout 900000
npm run skills -- list --l1 Helium
npm run skills -- show Helium scaffold-node-ssr-sqlite-api
npm run skills -- reset Helium scaffold-node-ssr-sqlite-api  # zero counters + clear refusal
```

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
  `checkGroundTruth` returns `{block, contradiction}`; `contradiction` is set
  only on HARD evidence (claimed path MISSING or EMPTY; web URL unreachable)
  — never on console errors or `ok: false`, which are judgment calls that
  would make the fast-path fire false alarms on working deliverables. On a
  contradiction the supervisor logs an OVERRIDDEN warning and falls through
  to a full `llmVerdict`, passing the already-computed block via
  `groundTruthBlock` so the probe does not run twice. It never rejects on its
  own: a path-extraction heuristic must not fail a run by itself. When the
  RESULT names no files the probe returns `''` and makes no tool calls at
  all, so trusted subtasks returning plain summaries stay exactly as cheap
  as before. Covered by `tests/trust-fastpath-groundtruth.test.ts`, whose
  first case asserts ZERO LLM calls — that is the cost-discipline guard. Counters live on `atom_types`; they are bumped by the
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
- Validation params are pinned to `{ temperature: 0, maxTokens: 2048 }`
  (`VALIDATION_PARAMS`, `src/atoms/L2Atom.ts`), prefilter params to
  `{ temperature: 0, maxTokens: 256 }`. Raise either only if you see truncated
  outputs in practice — a Verdict / Prefilter is a small JSON object. (This
  bullet said 512 for months; the code has been 2048 since verdicts started
  carrying reasoning long enough to act on.)
- L3/L2 never pass `tools` or an `executor` on their own LLM calls. Only L1 gets
  tool declarations and a tool loop; that's the whole point of the tier split.
  Grep `executor:` to confirm it only appears in `L1Atom.execute`.
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
  plan with empty `expectedOutput` and `concat` aggregation rather than
  taking the whole run down. Fallback/self-exec paths keep the atom's
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

## Observability

- **`InMemoryMetrics` + `MetricsLlmClient`** (`src/core/metrics.ts`) wrap any
  `LlmClient` and record per-call usage. Both examples wrap the Anthropic
  client and print `metrics.formatSummary()` at the end of a run. Use this as
  the ground truth for "did the cost discipline work?" — Opus/Sonnet calls
  should be a single-digit count on any mature-type happy path.
- Cost estimates come from `DEFAULT_PRICES` (approximate USD per M tokens per
  Claude family). Override with a custom `PriceTable` when needed.
- **Registry CLI** (`npm run registry -- ...`): inspect counters, drill into
  any type including version history, sort by success/failure/ratio. Works
  against any SQLite DB via `--db` or `ATOMA_DB_PATH`.
- **Burn-in harness** (`npm run burnin`, `src/cli/burnin.ts`): runs a task
  batch through the real `example:build` path (one clean workspace per task,
  child spawned in its own process group and group-killed after
  `✓ build finished` — delivered runs that started a server idle on purpose)
  and appends per-run economics to `burnin/results.csv`: cost, duration,
  calls per model tier, deterministic phases, escalations, learned skills,
  trace filename. Every batch extends the cost-decay curve AND matures the
  skill/trust counters — the harness IS usage. Task file:
  `burnin/tasks-default.json` (`{tasks: [{id, family, goal}]}`); logs under
  `burnin/logs/` (gitignored), CSV committed. Rendered by the viz's
  **Burn-in** tab (`/api/burnin` reads the CSV, override with
  `ATOMA_BURNIN_CSV`): per-family stat cards, an SVG cost-per-run scatter in
  batch order (x axis = experience), and a row table where clicking opens
  the run's full trace in the Runs view. Parsing/summary helpers are pure
  and exported — covered by `tests/burnin.test.ts` on real log excerpts.
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
- **Canonical bootstrap in `examples/build-app.ts`.** On every run we
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
  `build-app.ts` applies the same conditional-refresh pattern to the
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
  sink caller (build-app.ts passes all 8 tools) still produces a
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
- **Ground-truth probe is a WEB-bucket invariant, not universal.**
  `probeGroundTruth` (in `L2Atom.ts`, invoked from `llmVerdict` on
  RESULT verdicts) only fires when BOTH (a) `ctx.tools` has
  `validate_html` AND (b) the CHILD atom declares `validate_html` in
  its own `toolNames()`. The child gate was added after an HTTP-
  bucket Helium returned `"http://localhost:59375/"` and the probe
  ran Puppeteer against a JSON API, got "errors", rejected a valid
  result, cascade. `Atom.toolNames()` is the public accessor to the
  declared tool names (the full tools array stays protected). Fix #9.
- **Two ground-truth probes, MUTUALLY EXCLUSIVE by bucket.**
  `probeGroundTruth` dispatches: a child declaring `validate_html` gets
  the web load-and-look probe; every other file-producing child gets
  `probeFilesGroundTruth` — the supervisor-side READ-BACK probe (#F9).
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
  override path: `ATOMA_SKILLS_DIR` env var (default `./skills`).

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

- **Trust counters per skill (#C2a).** `onApproved` and `onFailed`
  hooks bump `_meta.json.successes` / `_meta.json.failures` on the
  matched skill in addition to the existing atom-type counters. A
  skill earns trust independently of its host atom; the same atom
  type can host multiple skills with very different trust profiles.

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

- **Auto-creation (#C3).** ON by default in `npm run example:build`.
  Pass `--no-learn-skills` (or set `ATOMA_SKILL_LEARN=0`) to disable
  for a single run. The lib (`L2Atom.onApproved`) still reads
  `ATOMA_SKILL_LEARN === '1'` at hook time — `build-app.ts` writes
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
  Costs one Sonnet call per learning event; off by default
  precisely so projects don't pay for it on every run.

- **Skill-prefilter fires when at least one skill exists.**
  `matchSkill` short-circuits without an LLM call when the registry
  returns 0 skills for the L1, but it still sets
  `skillMatchAttempted = true` — so a novel run on a skill-less L1
  is correctly recognised as a learning opportunity. Tests that
  drive the skill-prefilter LLM slot must pre-seed at least one
  scarecrow skill so the slot actually fires.

- **Promotion llm→script (#C2c).** When a `kind: 'llm'` skill crosses
  `TRUST_PROMOTE_THRESHOLD_SUCCESSES` (5) with zero recorded failures,
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
  ON by default in `build-app.ts` (toggle with `--no-promote-skills`),
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
      promotion needs 5/0): `L2.runSubtask` short-circuits into
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
      in `build-app.ts`); default ON.
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
  and `parseScriptEnvelope` in `L2Atom.ts` is the strict parse the
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
- **A `kind: script` skill with no `_fallback.md` is UNDEMOTABLE.**
  `demoteToLlm` returns null when the file is absent, and
  `resetCounters` does not change `kind` — so a broken script authored
  directly as `kind: script` (rather than reached via
  `promoteToScript`, which always writes the fallback) has no
  automatic way back to the LLM form. `scaffold-package-json` is in
  exactly that state. The pre-flight gate above is what keeps it
  harmless; if you ever author a script skill by hand, either satisfy
  the stdout envelope or drop an `_fallback.md` next to it.
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

- **Skills CLI** (`npm run skills -- ...`): `list [--l1 <name>]`,
  `show <l1> <id>`, `reset <l1> <id>`. Works against any store via
  `--dir` or `ATOMA_SKILLS_DIR`. `reset` zeroes counters AND clears
  `promotionRefusedAt` — the sanctioned escape hatch for the two
  promotion dead-ends (`failures > 0` after a demotion; a compile
  refusal on an unchanged body).

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
  `tests/model-tiers.test.ts`. The 5-series pins reject
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
    - The declared-tools scope gate (#8a) is mirrored in the Ollama
      tool-use loop: off-scope `tool_calls` get a `role: "tool"`
      error appended and `onToolInvocation` fires with `error`, with
      the executor untouched. Safety contract is provider-neutral.
    - Tool budget exhaustion mirrors `AnthropicLlmClient`: one
      tools-disabled round-trip with a `TOOL BUDGET EXHAUSTED` user
      message to force a final text reply.
    - L3's `resolveLatestOpus` network call is SKIPPED under Ollama
      — `build-app.ts` passes `anthropic: undefined` to
      `L3Atom.fromType`, so L3 uses the `FALLBACK_OPUS` id string
      which the Ollama client then maps to `defaultModel`.
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
      to exploit, and the build-app banner shouts when it is set.
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
      on zod@3 — installed with `--legacy-peer-deps`, and the bridge
      deliberately avoids the SDK's zod4-only `tool()` helper by
      registering tools on a raw `McpServer` (zod3-compatible) via
      `jsonSchemaToZodShape`. Don't switch to `tool()` without
      migrating the repo to zod 4.
    - Costs printed by metrics are API-price equivalents of the token
      counts; on a subscription nothing is billed per token. Each
      `complete()` spawns a CLI subprocess — runs are slower than the
      direct API (~2-5s overhead per call).
- **Example auth (`src/examples/auth.ts`).** `makeAnthropicClient`
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
- **`InMemoryToolRegistry`** (`src/tools/registry.ts`) — maps tool name →
  executor fn. Implements `ToolExecutor` (`src/core/types.ts`), plugged into
  `RunContext.tools` and forwarded to the LLM via `LlmCompletionRequest.executor`.
- **`defaultBuiltinTools({ sandbox, logger })`** (`src/tools/builtin.ts`)
  returns: `write_file`, `edit_file`, `read_file`, `list_files`,
  `run_shell`, `start_static_server`, `validate_html`, `fetch_url`,
  `start_node_server`. **`edit_file`** is a targeted str_replace edit —
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
  general HTTP probe (GET + POST JSON, 10s default timeout), and
  `start_node_server` spawns `node <entry>` with `PORT=0` in env and
  parses a `LISTENING_ON_PORT=<N>` line from stdout to discover the
  bound port (see HTTP bucket contract above).
- **`start_static_server`** auto-retries on port=0 when a caller-specified
  port is busy (logs `⚠ port N busy — retrying on OS-assigned port`). Initial
  boot-timeout is 3s, retry boot-timeout is 5s — cold-start Python can take
  >1.5s on macOS and a too-tight cap produced spurious failures.
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
- **Shared smoke-test guidance.** `SMOKE_DESIGN_GUIDANCE` in
  `src/atoms/L2Atom.ts` teaches L1 the IIFE contract, the
  `window.__test` hook pattern for state-heavy apps, and the smoke-loop
  discipline. It is appended by BOTH `buildNarrowL1Prompt` (escalation-branch
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
  tier-2 child without an intervening `plan()` therefore collapses the tier
  (Sonnet at L2, **Opus with a 40-iteration tool loop** at L3), wires `tools`
  + `executor` above tier 1 in violation of the tier split, and stamps
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
- Live viz is POLLING, not SSE or WebSocket. The UI polls
  `/api/runs/<id>` every 1s while `endedAt` is undefined, and
  `/api/runs` every 2s to detect newly-started runs. Adding fs.watch
  + SSE would roughly double the server surface for marginal latency
  benefit on a single-observer dev-loop tool — not worth it.

## Considered and rejected (do not re-propose naively)

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
  Pong (see "Prefilter decomposable hint"). If plan cost ever matters at
  scale, the right shape is PLAN TEMPLATING: memoise the structure of
  successful plans per (trusted L2 × task shape) and instantiate without
  Opus — phases survive, skills keep matching, dispatch keeps firing.

## Deferred / explicitly out of scope

- Molecule / cell *composition* as a higher-order layer (the original
  "tissues/organs" metaphor). The current cells are top-level, not composed.
- Multi-process registry (SQLite local only).
- Streaming, OpenTelemetry, dashboards beyond the in-process metrics summary.

## Plan file

The original greenfield plan (`docs/architecture-plan.md`) was removed in the
2026-08 cleanup — it predated skills, manifests, the burn-in harness and the
5-series model migration, and THIS file has long superseded it as the
reference. Recover it from git history if the genesis rationale is ever
needed. Before major refactors, this file is what you consult.

## Language

The user (`mateo@enoxsolutions.com`) communicates in French. Respond in French;
keep code, comments, and commit messages in English.
