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
- Trust fast paths require the configured success threshold (default 3) and zero
  failures. Read it through `trustThreshold()`; invalid or non-positive values
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
- Browser and non-browser ground-truth probes are normally exclusive by bucket.
  A loopback HTTP server that actually returns HTML keeps the file probe and
  appends a browser probe; never replace read-back evidence or browse external URLs.
- Quoted-span checks walk summaries before noisy payloads, ignore diff `OLD:`
  and headers, and treat truncated excerpts as silent rather than refuting.
- Already-satisfied idempotent work is compliant when current ground truth proves
  the requested end state; do not demand meaningless rewrites.
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
