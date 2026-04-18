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
  and refuse to escape the root.
- **`InMemoryToolRegistry`** (`src/tools/registry.ts`) — maps tool name →
  executor fn. Implements `ToolExecutor` (`src/core/types.ts`), plugged into
  `RunContext.tools` and forwarded to the LLM via `LlmCompletionRequest.executor`.
- **`defaultBuiltinTools({ sandbox, logger })`** (`src/tools/builtin.ts`)
  returns: `write_file`, `read_file`, `list_files`, `run_shell`,
  `start_static_server`, `validate_html`. The validator uses Puppeteer — it
  can simulate both mouse (`click`, `rightclick`) AND keyboard events
  (`keydown`, `keyup`, `keypress` with `holdMs`) for platformer-style input.
- **Tool-use loop**: when `req.executor` is present, `AnthropicLlmClient.complete`
  runs up to `MAX_TOOL_ITERATIONS=12` rounds of tool_use → tool_result → LLM.
  Usage is aggregated across rounds and reported once via `MetricsLlmClient`.
  Only L1 should pass `executor:` — grep confirms it.

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
