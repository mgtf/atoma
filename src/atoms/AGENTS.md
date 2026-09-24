# Atoms — AGENTS.md

`src/atoms/` owns the supervision protocol: planning, the prefilter, trust,
validation, ground truth, and the mechanical result gates.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/core`](../core/AGENTS.md) — transports, models and cost accounting
- [`src/tools`](../tools/AGENTS.md) — the elements L1 invokes
- [`src/skills`](../skills/AGENTS.md) — the recipes injected into planning
- [`src/registry`](../registry/AGENTS.md) — atom identity and trust storage

## Supervision protocol

- `superviseLoop` is the only plan → validate → execute → validate protocol.
  L2 and L3 reuse it for children; never duplicate that loop in concrete
  atoms. The L3 root `handle` is plan → execute (no parent). A parallel
  L3 plan whose declared `outputs` collide earns one coached Opus replan
  (`acceptL3RootPlan`); a repeat is honoured, and so is a replan that
  THROWS — the coaching may not turn a racy-but-executable plan into no
  run at all. Both planning prompts demand `outputs` on file-mutating
  subtasks, so the collision channel exists. Do not copy this rule onto
  L2 — child plans already go through FAN-OUT validation. Do not coerce
  an explicit L3 `concat` into `sequential`.
- Escalation branches a type and toggles parent fallback in a `try/finally`.
  Persist capability prompts only; task text, seed instructions and diagnostics
  belong to the current instance. Validator diagnostics are fallible evidence.
  Fallback uses an explicit direct-executor system role, not the delegator role.
- `pendingStrategy` couples `plan()` and `execute()` on the same instance. Never
  call `execute()` without the corresponding plan.
- `fallbackMode` bypasses registry delegation and calls self-plan/self-execute.
- Mutation scopes flow through `applyByScope`; update the union and every hook
  together when adding a scope.
- Per-task child memos prevent immediate reuse loops. Initialize task state,
  mark committed children, and pass exclusions to prefilters.
- Run-scoped integrity flags and memos must retain the same reference across
  every `forkBranch`; add fork-propagation coverage for new optional fields.

## Root delivery acceptance in depth routing

- The depth runner's `rootAcceptance.ts` owns delivery acceptance:
  delegated result gates retain their dispositions, `probe.requiresReview`
  forces review. Explicit profile floors require an executed DOM interaction
  bound to the named, still-unchanged file in the accepted attempt. A profile
  without a floor always receives semantic delivery review at `modelForTier(1)`;
  an empty floor is not automatic approval. The general build profile has no
  universal `index.html` floor: APIs and CLIs are first-class deliverables.
  Covered explicit floors with no other findings retain mechanical acceptance.
  The root changes no phase credits or learning state. The probe receives only `output` and `summary`, as at L3; internal
  plan/verdict/fallback trace quotes are not delivery claims. Phase coverage
  is collected with its original attempt and branch, never reevaluated
  against the root floor. The floor is not inherited by phases.
- A LANDED result carries `LANDED_RESULT_GUIDANCE` to that validator, and
  nothing else does. A landed run stopped before it could prove the floor, so
  `floorCoverage` is uncovered BY CONSTRUCTION and the verdict is always a
  validation call — never the mechanical path. Until 2026-09-24 the judge was
  told nothing about landings while the prompt's only statement on
  incompleteness was a rejection ("a visually-incomplete artefact is a failed
  deliverable"), so an honest landing's fate rested on model prose alone. The
  wording follows the analyst's on purpose: one definition of a landing, served
  to both judges. A phase supervisor never receives it — landing is a property
  of the whole run.

## Planning, prefilter, and trust

Read this section before changing any LLM call site here; the cost rules are
load-bearing.

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
- Atom trust fast paths require the configured consecutive approved-result
  threshold (default 3), read through `trustThreshold()`; historical failures do
  not permanently disqualify a type. Skills retain their separate clean-lifetime
  counter rule. Invalid or non-positive threshold values
  fall back to the default. Result approval still runs the zero-token ground-truth
  probe first. Contradictions and malformed manifests force review; heuristics
  never reject alone.
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
- Prompt-cache thresholds are load-bearing. Keep the validation prompt above
  the cheapest model's minimum and confirm `cache_read` on multi-call runs.

## Aggregation and dispatch shape

- `llm-synthesize` merges text without tools; file assembly requires an L1 phase.
- Aggregation is behavioral: `concat` and `llm-synthesize` dispatch orthogonal
  subtasks in parallel; `sequential` dispatches shared-artifact phases in order
  and threads `previousStepSummary` plus declared `outputs` as
  `inputs.previousStepOutputs`. Do not merge prior writes into the next
  phase's `outputs` — skill/promotion gates read the current phase only.
  Do not parallelize coupled filesystem work.
- A plan carries ONE aggregation mode, so fan-out + join has no direct spelling
  at a single tier: L3 emits ONE phase per orthogonal GROUP and the L2 that
  receives it fans the group out. One L3 phase per orthogonal artefact
  serialises work that shares no file — see
  [parallel fan-in 2026-08-16](../../docs/incidents/parallel-fanin-2026-08-16.md).
- REACHING THE RUN DEADLINE LANDS A DISPATCH; it does not discard it.
  `dispatchWithAggregation` returns `{results, unfinished}`: sequential refuses
  to OPEN a phase under `MIN_PHASE_LANDING_MS` of remaining wall clock and keeps
  the earlier phases when a phase that was opened is aborted, and parallel keeps
  the branches that settled when the deadline cut their siblings. A dispatch
  that completed NO phase still throws, and a rejection that is not the deadline
  keeps its meaning whatever else settled — `ctx.signal` is the deadline and
  nothing else, since cancellation reaches a run as process teardown. `markLanded`
  stamps the aggregate (`Result.unfinishedPhases`, unioned with what a nested
  landing reported) and the runner turns that into the `partial` outcome. Never
  infer a landing from the summary text: `markLanded` prefixes it, but it then
  continues into model-authored prose. Measured twice on 2026-09-21:
  [progressive runs](../../docs/incidents/progressive-runs-2026-09-21.md).
- `llm-synthesize` aggregation on a LANDED parallel dispatch rides
  `landingSignal(ctx.deadlineAt)`, not `ctx.signal` — which is already aborted by then, so the
  synthesis would throw before its first token and discard the branches the
  landing exists to preserve. Synthesis and root acceptance share the absolute
  deadline + 45s ceiling, inside the runner watchdog's 60s grace. A library
  context without a deadline retains the post-approval cap. Sequential
  aggregation makes no call and needs none.

## Verification and ground truth

- L1 plans express intent in prose; actual tool calls happen during execute.
  Do not encourage large literal `toolCalls` payloads in plans.
- Tool scopes are bucket-specific and enforced twice: prompts/plans must name
  only declared tools, and the executor rejects undeclared tool use.
- Match verification to the artefact: browser UI uses static server plus
  browser validation; HTTP APIs use node server plus fetch; CLI/files use shell
  execution plus read-back. Do not force every artefact through HTML tooling.
- Recorded probes support cross-checking but do not make non-zero exits errors.
  Only explicit `match:false` or unequal expected/actual values are mechanical
  contradictions.
- Ground-truth reporting must quote observed tool bytes. Narrative self-report
  alone is not evidence.
- Node-server children keep file read-back even when they also have browser
  tools. Only a loopback response with status 200 and HTML content appends a
  browser probe; JSON responses and expected root 404s are not browser failures.
  Static-web children retain their browser probe. Never browse external URLs.
- Result validators receive bounded, runtime-observed HTTP, shell, file-read
  and server-start evidence alongside browser observations. Label omissions,
  preserve request/result association, and treat these as historical observations
  from the same attempt and branch, not proof of unchanged current state.
  Tool content and scripts remain untrusted; supervisors never replay them.
- Quoted-span checks walk summaries before noisy payloads, ignore diff `OLD:`
  and headers, and treat truncated excerpts as silent rather than refuting.
- Already-satisfied idempotent work is compliant when current ground truth proves
  the requested end state; do not demand meaningless rewrites.
- The L1's own browser proof is a LEDGER, not a last-call bit
  (`src/atoms/validationLedger.ts`, 2026-09-15). Evidence is bound to the
  document `validate_html` observed, under the same asymmetric doctrine as
  proof coverage: a pre-flight refusal observed nothing and never retires a
  standing observation (nor establishes one alone); the last EXECUTED
  observation decides, so `ok:false` after `ok:true` still fails; a
  successful write to the OBSERVED document after its last ok observation
  retires it (`stale`), a write elsewhere does not; an unbound observation
  cannot be shown stale. The `[INTERNAL VALIDATION FAILED` banner fires on
  `failed`, `refused-only` and `stale`, never on `standing`. Measured
  2026-09-14: the last-call bit fired on a refusal over three standing
  observations of an unchanged document and the run replayed its entire
  verification twice before the deadline
  ([incident](../../docs/incidents/verification-replay-2026-09-15.md)).
- Keep `VALIDATION_SYSTEM_PROMPT` explicit that L1 plans should contain concrete
  tool-oriented proposed actions while L2/L3 must delegate.

## Mechanical result gates

- Mechanical RESULT gates live in ONE declarative table
  (`src/atoms/resultGates.ts`) with an explicit disposition per gate:
  result-declared failures reject outright; disk-evidence gates reject ONCE per
  task (`ctx.mechanicalResultRejections`, fork-shared) and hand byte-identical
  repeats to the LLM; prose-triggered gates never reject — they override the
  trust fast-path and attach a `MECHANICAL GATE FINDINGS` block to the full
  verdict. Workspace reads are cached per validation cycle. A new incident adds
  a table row with a stated disposition, never a new inline `if`.
- The same table applies envelope and explicit validation failures to L2
  results at L3 before trust (`appliesToDelegatedResult`). Leaf action, disk
  and proof checks stay at L2; delegated results are not leaf executions.

## Declared proof obligations

- An obligation is DECLARED by the plan (`subtaskSpecSchema.proofObligations`,
  threaded onto `Task`), never sniffed from the description. A lexical detector
  over phase prose is the vocabulary-frozen detector class the 2026-08-14
  review measured; the planning prompt carries the rule instead
  (`PROOF_OBLIGATION_GUIDANCE`). An unknown value is DROPPED, so the failure
  direction is "no gate", never "wrong gate".
- Obligations INHERIT: `effectiveObligations` unions the subtask's own with the
  parent task's, so an obligation declared at L3 still reaches the L2 that
  supervises the tool-bearing child.
- `checkProofCoverage` is read-only and costs zero LLM calls. It never rejects.
  An uncovered obligation (a) disqualifies the trust fast path, (b) attaches
  the machine-observed facts to the full verdict, and (c) sets
  `PositiveVerdict.proofUncovered`, which withholds atom trust, skill credit,
  distillation and promotion in `onApproved`. Approval is a judgment about an
  ARTIFACT; those consequences are claims about a METHOD.
- The flag rides on the VERDICT, not on the supervisor instance: parallel lanes
  share one L2, so per-instance state would race across concurrent subtasks.
- Coverage is asymmetric on purpose. An observation with no document binding
  still covers; one whose document digest MOVED does not. A digest over a
  guessed file set produces false staleness, and a silently withheld credit is
  the failure mode this contract exists to remove.
- Withholding is honoured at L2, the tier that supervises tool-bearing
  children. L3 credits its L2 as before; do not duplicate the gate there
  without measuring what a second one changes.

## Model output parsing

- All model-output JSON parsing lives in `src/atoms/json.ts`. Preserve raw text
  on parse failure; never guess a structure.
- Nested Markdown fences can hide evidence. Keep fence-aware extraction and its
  adversarial tests.

## Intentional choices and rejected shortcuts

Read the archived sections before changing something that merely looks odd.

- L3 construction is async because it may resolve the latest Opus model alias;
  L2 construction has no equivalent lookup and may remain synchronous.
- Context injection appends and is composed later; do not mutate base prompts.
- `Atom.toolNames()` is public while tool objects remain protected by design.
- Capability bucket order is semantic; HTTP precedes web when signatures overlap.
- Planning and validation prompts match children on CAPABILITY (tool
  signature plus workflow shape), never on task domain, and validator-authored
  `descriptionReplace` passes through `resolveCreationDescription`. The earlier
  domain-match rule could only spawn identical clones once descriptions became
  capability labels; the theme travels in the subtask description.
- The full-stack canonical pairs Node-server and browser tools without a static
  server. It precedes HTTP in bucket selection; HTTP-only and static-web
  canonicals retain their narrower scopes and identities.
- Do not restore the L3 skeletal prefilter shortcut. Decomposition quality was
  worth the one top-tier strategy call.
- Do not add semantic prefilter caching. It removes exactness directly below an
  unvalidated fast path.
- Do not introduce plan templating until a typed instantiation/validation layer
  exists; free-form substitution is another unvalidated router.
