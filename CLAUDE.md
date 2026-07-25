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
- **Happy path tier-by-tier.** L2 happy path (mature L1 child, prefilter
  matches with `!decomposable`) is 100% Haiku — prefilter picks, trust fast-
  path skips validators, L1 does the work. **L3 always pays for one Opus
  call** because the L3 prefilter shortcut is intentionally gone (see
  "Prefilter decomposable hint" above). So a mature-type L3 run is 1 Opus
  (plan) + N Haiku (prefilters + validators short-circuited by trust) +
  L1 tool loop on Haiku. New-type encounters add Sonnet for the L2 plan
  step or Opus for the L3 plan step.
- **Strategy/plan output cap.** L2/L3 `plan()` on the non-fallback path pin
  `maxTokens: STRATEGY_MAX_TOKENS` (3000) regardless of the atom type's own
  configured ceiling. The response is a routing JSON pair + a list of
  subtasks with descriptions. Sized for Opus PHASED plans with 3-5 phases
  of detailed instructions; the previous 1500-token cap was set when L3
  emitted skeletal 1-subtask plans, and silently truncated multi-phase
  plans on stack tasks (SSR app with SQLite + external API + UI), producing
  unparseable JSON that crashed `planSchema`. As defence in depth,
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
  tools via `patch + addTools` on hit, or create otherwise.
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
  `prefilterStrategy` from `cost.ts`, so the confidence guard
  (low → escalate) and the decomposable hint apply uniformly.
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
  accidental re-promotion until the operator manually resets the
  counters in `_meta.json`. Gated by `ATOMA_SKILL_PROMOTE` env var:
  ON by default in `build-app.ts` (toggle with `--no-promote-skills`),
  OFF in the lib so unit-test runs don't make stray Sonnet calls.
  Marginal cost is ~1 Sonnet call (~$0.01) per promotion event.
  `_fallback.md` is INTENTIONALLY left in place after demotion so a
  future re-promotion (post-counter-reset) can compare against the
  historical body.

- **`kind: 'script'` skills execute via tool-loop, not server-side
  invocation.** `skillContextBlock` injects an active-skill block
  whose body tells the L1 to: (1) extract CLI args from the subtask
  description, (2) `write_file _skill_<id>.<ext>` with the script
  body verbatim, (3) `run_shell <interpreter> _skill_<id>.<ext>
  [args...]`, (4) return the stdout. The L1 is still in the loop —
  but for ONE LLM round-trip + 2 tool calls regardless of script
  length, vs the N-round LLM tool-loop a `kind: llm` recipe drives.
  The script's stdout MUST be a single JSON line of shape
  `{"output": ..., "summary": "<one sentence with embedded == GROUND
  TRUTH == block>"}`; `compileSkillToScript`'s prompt enforces this.

## LLM interaction conventions

- All LLM calls go through `LlmClient` (`src/core/llm.ts`). Never call the Anthropic
  SDK directly from atom code.
- **Prompt caching (`cache_control: ephemeral`) is on by default** for system
  prompt and the last tool. Leave it on unless you have a measurement-backed reason.
- Model IDs live in `src/core/models.ts`: `PIN_HAIKU`, `PIN_SONNET`, `FALLBACK_OPUS`.
  L3 resolves Opus dynamically at construction via `resolveLatestOpus`.
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

## Deferred / explicitly out of scope

- Molecule / cell *composition* as a higher-order layer (the original
  "tissues/organs" metaphor). The current cells are top-level, not composed.
- Multi-process registry (SQLite local only).
- Streaming, OpenTelemetry, dashboards beyond the in-process metrics summary.
- Rollback CLI for registry versions (the DB keeps `atom_type_versions` rows,
  just no CLI to restore from them yet).

## Plan file

The approved plan lives at
`docs/architecture-plan.md`.
Reference it before major refactors.

## Language

The user (`mateo@enoxsolutions.com`) communicates in French. Respond in French;
keep code, comments, and commit messages in English.
