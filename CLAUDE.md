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
npm run registry -- --db ./atoma-build.db list   # override DB path
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
  optional `decomposable: boolean`. On `reuse + !decomposable` the
  skeletal-plan short-circuit fires as before (happy path, 0 Sonnet).
  On `reuse + decomposable` L2/L3.plan FALL THROUGH to the full
  supervisor plan call, with the prefilter target preserved as a
  `== PREFILTER HINT ==` section in the userContent so Sonnet/Opus can
  set `preferredChild: <target>` on each leaf subtask. Prompt tells
  Haiku to set `true` only when the task clearly enumerates multiple
  orthogonal artefacts (`package.json + index.js + tests`, not "build
  a chess puzzle"). A decomposable short-circuit collapse is the
  failure mode we want to avoid on multi-artefact builds.
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
  `failures === 0`. Counters live on `atom_types`; they are bumped by the
  supervise loop's `onApproved` / `onFailed` hooks that L2 and L3 wire to
  `registry.recordSuccess` / `registry.recordFailure`.
- **Patch resets trust.** `AtomRegistry.patch` zeroes `successes` and
  `failures` along with bumping the version — a changed type has to earn trust
  again. `branch` creates a new type that starts at zero.
- **`VALIDATION_SYSTEM_PROMPT` is the ONE system prompt used by every verdict
  call in the whole system.** Deliberately constant so prompt caching
  short-circuits the input bill on repeat validations. Do not inline a custom
  system prompt into a verdict call. Same rule applies to
  `PREFILTER_SYSTEM_PROMPT`.
- Validation params are pinned to `{ temperature: 0, maxTokens: 512 }`, prefilter
  params to `{ temperature: 0, maxTokens: 256 }`. Raise either only if you see
  truncated outputs in practice — a Verdict / Prefilter is a tiny JSON object.
- L3/L2 never pass `tools` or an `executor` on their own LLM calls. Only L1 gets
  tool declarations and a tool loop; that's the whole point of the tier split.
  Grep `executor:` to confirm it only appears in `L1Atom.execute`.
- **Happy path on a mature type is now 100% Haiku:** prefilter picks the child,
  trust fast-path skips both validators, L1 does the real work on Haiku with
  its tool loop. The only time Sonnet or Opus runs is the first few encounters
  with a type, or when the catalog has no clear match and a new type must be
  designed.
- **Strategy/plan output cap.** L2/L3 `plan()` on the non-fallback path pin
  `maxTokens: STRATEGY_MAX_TOKENS` (1500) regardless of the atom type's own
  configured ceiling. The response is a routing JSON pair; padding the ceiling
  just invites rambling. Fallback/self-exec paths keep the atom's full
  `maxTokens` because they may produce real content.
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
- **Web visualiser** (`src/viz/`, `npm run viz`): records every LLM call
  (prompt + response + usage + tier/atom routing) and every registry
  mutation (`create` / `patch` / `branch` / counter bumps) during a run,
  then serves a self-contained HTML UI on http://127.0.0.1:4111. Wired into
  both examples via `RecordingLlmClient` (wraps any `LlmClient`) and
  `RecordingRegistry` (subclasses `AtomRegistry`) — both observers only,
  zero effect on runtime behaviour. Runs are persisted as JSON under
  `./runs/` (override with `ATOMA_RUNS_DIR`). `npm run viz:demo` generates
  a mocked run with no API key so the UI always has something to render.
  Role inference in `recordingLlm.ts` keys off the stable `VALIDATION_SYSTEM_PROMPT`
  and `PREFILTER_SYSTEM_PROMPT` markers plus the `You are atom "X" (tier N)`
  preamble — keep those markers stable or update `classify()` accordingly.

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
  call four idempotent seeders from `src/atoms/capability.ts`:
  `ensureCanonicalL1` / `ensureCanonicalL2` (web build bucket,
  marked `bootstrap-canonical`) and `ensureCanonicalHttpL1` /
  `ensureCanonicalHttpL2` (Node HTTP server bucket, marked
  `bootstrap-canonical-http`). Each pair seeds a domain-neutral
  L1 + L2 so L3.prefilter / L2.prefilter has an obvious reusable
  target on day one for both recipe families. Without the HTTP
  canonicals the first Node/REST run had no L1 in its bucket and
  force-matched the web canonical, which is the Methane-picks-
  Hydrogen failure the #3/#4/#5 fix series was written for. Helpers
  look up existing entries by `createdBy` marker, refresh tools via
  `patch + addTools` on hit, or create otherwise.
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

## LLM interaction conventions

- All LLM calls go through `LlmClient` (`src/core/llm.ts`). Never call the Anthropic
  SDK directly from atom code.
- **Prompt caching (`cache_control: ephemeral`) is on by default** for system
  prompt and the last tool. Leave it on unless you have a measurement-backed reason.
- Model IDs live in `src/core/models.ts`: `PIN_HAIKU`, `PIN_SONNET`, `FALLBACK_OPUS`.
  L3 resolves Opus dynamically at construction via `resolveLatestOpus`.
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
- **`InMemoryToolRegistry`** (`src/tools/registry.ts`) — maps tool name →
  executor fn. Implements `ToolExecutor` (`src/core/types.ts`), plugged into
  `RunContext.tools` and forwarded to the LLM via `LlmCompletionRequest.executor`.
- **`defaultBuiltinTools({ sandbox, logger })`** (`src/tools/builtin.ts`)
  returns: `write_file`, `read_file`, `list_files`, `run_shell`,
  `start_static_server`, `validate_html`, `fetch_url`,
  `start_node_server`. The web validator (`validate_html`) uses
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
- **Shared smoke-test guidance.** `SMOKE_DESIGN_GUIDANCE` in
  `src/atoms/L2Atom.ts` teaches L1 the IIFE contract, the
  `window.__test` hook pattern for state-heavy apps, and the smoke-loop
  discipline. It is appended by BOTH `buildNarrowL1Prompt` (escalation-branch
  path) AND `createSubtaskL1` (fresh-L1-on-fanout path). Adding new L1
  creation sites? Append this block too, or new L1s will miss the
  discipline and thrash on smoke design.

## Things that look wrong but aren't

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
  to HTTP. Putting HTTP first means a dynamically-created L1 inheriting
  the kitchen-sink toolset from Methane gets the HTTP label, not the
  web one. The canonical helpers `pickTools` their input so canonical
  web L1s never see the HTTP-only tools in the first place — order
  only matters for dynamically created atoms.
- `Atom.toolNames(): string[]` is public while `Atom.tools: Tool[]` is
  protected. The names accessor was added specifically for cross-
  cutting concerns (ground-truth probe bucket gate, tracing) that
  need to inspect declared scope without exposing the mutable tools
  array with its executor closures.

## Deferred / explicitly out of scope

- Molecule / cell *composition* as a higher-order layer (the original
  "tissues/organs" metaphor). The current cells are top-level, not composed.
- Multi-process registry (SQLite local only).
- Streaming, OpenTelemetry, dashboards beyond the in-process metrics summary.
- Rollback CLI for registry versions (the DB keeps `atom_type_versions` rows,
  just no CLI to restore from them yet).

## Plan file

The approved plan lives at
`/Users/mgtf/.claude/plans/j-aimerais-d-finir-une-entit-purrfect-dragon.md`.
Reference it before major refactors.

## Language

The user (`mateo@enoxsolutions.com`) communicates in French. Respond in French;
keep code, comments, and commit messages in English.
