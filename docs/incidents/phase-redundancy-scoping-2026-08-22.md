# Phase redundancy — scoping record, 2026-08-22

Status: **scoping complete, design pending operator approval**. This is the
evidence corpus the fix must be designed against, per the COOLING-OFF
contract: collected across the 2026-08-21 batch-6 runs and the failed
web-countdown run, verified against the code on 2026-08-22 by a five-reader
sweep (verdicts, traces, planning code, skills, repo state). Analyst
verdicts under `supervisor/verdicts/` are the primary sources; digests under
`supervisor/work/<runId>/` carry the event-level refs.

## The behaviour

The tier-3 plan ends with a phase dedicated to verifying what earlier phases
already verified. Measured across all six delivered batch-6 runs:

| run | task | phases | later-phase cost | later phase actually did |
|---|---|---|---|---|
| `…4466355e` | cli-inicheck | 3 | ~14% | re-EXECUTED 4 documented invocations via `record_probe` (mildest form; also mutated `.atoma-probes.json` during a "read-only" phase) |
| `…c71ac97d` | cli-jsonpick | 3 | ~23% | re-executed 6 documented invocations via `run_shell`, no writes |
| `…811b766e` | web-counter | 2 | **~54%** | fresh `start_static_server` on a NEW port, 13 `validate_html` runs of which 11 failed on the molecule's own smoke-authoring errors |
| `…0ed4faf4` | web-stopwatch | 2 | ~37% | fresh server on a new port, 5 failing smokes (one killed at 30s), then **edited the deliverable** during "verification" |
| `…dc2783db` | http-kv | 2 | ~28% | second `start_node_server` (new port/pid), 10 `fetch_url` probes; phase-1 server never torn down |
| `…cf5ec323` | http-healthz | 2 | ~31% | second server (new port/pid), re-ran the same 3 probes phase 1 had recorded; dropped the /unknown→404 case phase 1 had covered |

Five of six plans LABEL the later phase "read-only"; none was a read-only
re-read of recorded evidence. All six phase-2 molecules stated in their own
plans that the work was already verified, and re-executed anyway — e.g.
http-healthz: "The previousStepSummary shows pinger.js was already built and
verified with all routes working. However, I need to follow the current
task"; web-counter (starkest): "The previousStepSummary already contains the
proof that the implementation is correct, but I must re-validate it
following the ACTIVE SKILL recipe". The tier-3 Opus plan itself costs
$0.065–0.079 (~20–25% of each run), so plan + redundant phase together are
the majority of spend on the smallest tasks.

The finding was reached independently by two analyses of different runs,
carried as an observation by a third, and reproduced across two analyst
model generations (sonnet-4-6 alias and pinned sonnet-5) on the same run.

## Where the shape comes from (four distinct origins)

1. **cli: the task text mandates it.** `burnin/tasks-default.json` cli goals
   say verbatim "As a FINAL SEPARATE PHASE, re-verify the finished
   deliverable…". Not a product defect; the benchmark tests this shape. Any
   change here is a benchmark-comparability decision, not a fix.
2. **web/http: the L3 strategy prompt prescribes it.**
   `src/atoms/L3Atom.ts:445-447`: "browser-rendered artefact … A separate
   final validation phase is the norm here." Sequential is sold as the mode
   where "phases need to verify each other's work" (410-411), monophase
   plans are penalised for "skipping the value of phase-by-phase smoke
   validation" (439-440), and the validator pushes the same shape
   (`src/atoms/verdict.ts:281-282`: prefer sequential for build → extend →
   smoke). Note subtasks do NOT inherit task constraints
   (`L3Atom.ts:736-742` copies description/inputs/outputs only), so this
   pressure acts exactly where the shape is born.
3. **Structural root: proof does not travel.** Sequential dispatch threads
   only a NARRATIVE summary (`previousStepSummary`) plus paths
   (`src/atoms/dispatch.ts:28-56`), while the evidence contract
   (`src/atoms/capability.ts:683-696`, `GROUND_TRUTH_EVIDENCE_LINES`)
   makes narrative claims inadmissible. A phase-2 molecule that KNOWS the
   work is verified cannot cite that knowledge as admissible proof;
   re-executing is the rational strategy under the contract. Nothing threads
   the structured proof (`.atoma-probes.json` entries, witnesses) forward as
   a fact its validator would accept. The anti-re-verification rule already
   EXISTS for documentation phases (`L3Atom.ts:499-501`: "point it at the
   recorded probes and let it re-run only what is not recorded yet") — but
   not for verification phases; and `src/atoms/prompts.ts:314-316` even
   normalises "re-running recorded probes" as an expected phase genre.
4. **Execution amplifiers.** There is no L1 template for "verify without
   rebuilding": a verification subtask routed to the web bucket receives a
   build-shaped prompt (write → serve on an OS-assigned port → validate,
   `src/atoms/L2Atom.ts:176-189`); `routeCrossBucketVerification`
   (`L3Atom.ts:152-181`) mechanically doubles verification subtasks. And the
   seed (`src/run/profiles/build.ts:53`) requires the FINAL output to carry
   fresh proof ("which probe ran and its result") and a LIVE served URL,
   while the plan prompt says the final phase carries the deliverable — so
   the final re-boot is partly CONTRACTUAL. Any remedy must distinguish
   re-boot-to-deliver-a-live-URL (contract) from re-boot-to-re-prove
   (waste). Skills do not cause the shape (matching/injection is strictly
   L2→L1, after the plan is fixed; no recipe prescribes a re-verification
   phase) but they entrench execution inside it — the converged cli
   catalogue mirrors the seed-produced phases one-to-one, and a build recipe
   was injected even into a verify phase.

## Candidate remedy sites (scoped, not designed)

- `src/atoms/L3Atom.ts:445-447, 410-411, 439-440` — reword the plan-strategy
  prompt: condition "a separate final validation phase" on missing proof;
  extend the documentation-phase precedent (499-506) to verification phases.
  Plan prompt is NOT persisted → no trust reset; exact precedent measured
  effective on 2026-08-16.
- `src/run/profiles/build.ts:53, 75-79` — seed and call-time constraints:
  state that proof already recorded during construction satisfies the final
  evidence obligation. Editing the persisted seed zeroes Meristem's trust
  counters — acceptable at prototype stage (operator decision 2026-08-22:
  platform data is disposable).
- `src/atoms/dispatch.ts:28-56` — thread structured proof (probe-manifest
  entries / witnesses) beside `previousStepSummary`, keeping prior outputs
  out of the current phase's `outputs` (skills gates read the current phase
  only, dispatch.ts:51-55).
- `src/atoms/groundTruth.ts:718-780` + `src/atoms/verdict.ts:196-263` — let
  validation accept well-formed recorded-probe entries as proof for a claim
  whose files no later phase re-mutated.
- `src/atoms/l3RootPlan.ts` — the one-shot coached-replan mechanism already
  exists for output collisions; a "final phase is pure re-verification"
  detection could earn one coached replan, killing the shape before any
  execution cost. Held in reserve.
- `src/atoms/L2Atom.ts:176-189` — a verify-shaped variant of the web bucket
  L1 sequence (reuse the live URL from the previous phase — the rule already
  exists at `prompts.ts:169-171` — instead of re-serving). Secondary.

## Constraints a design must satisfy (from the owning files)

- Already-satisfied idempotent work is COMPLIANT (`atoms/AGENTS.md:111-112`);
  a remedy must not start rejecting verify-then-no-op phases.
- One aggregation mode per plan; never merge prior writes into the next
  phase's `outputs`; do not coerce explicit L3 `concat` into `sequential`.
- No plan templating without a typed instantiation/validation layer; do not
  restore the L3 skeletal prefilter shortcut.
- Verification is read-only; supervisors never replay model-authored shell
  commands.
- Result-gate doctrine: new incidents are table rows with explicit
  dispositions; prose-triggered gates never reject (the $2.03
  byte-identical-rejection cascade is the precedent).
- "Ground-truth reporting must quote observed tool bytes" stays: telling
  late phases to trust `previousStepSummary` on faith contradicts the
  contract head-on — thread admissible proof instead of weakening the bar.
- Sequential inter-step dependencies are EXPECTED (`verdict.ts:259-263`);
  a validator-side hardening must not requalify legitimate chaining.
- Shared system prompts are cached constants; prompt growth has real cost.
- The probe manifest is the interface of compiled reverify scripts; a remedy
  must not break the skills maintenance-verification pipeline.
- Relocation is not removal: pushing verification "into the build phase"
  reproduced the measured 2026-08-16 failure (build phase 103s→506s, 5×
  cost).
- Regression tests must exercise the production path (real L3 plan →
  sequential dispatch → validation), mocked LLMs, tracked files.

## Risks the design must answer

1. **The late phase catches phase-1 lies.** Precedents: a fabricated README
   claim approved by three validators (`groundTruth.ts:700-704`); a
   verifier replaying old probes credited work never done
   (`prompts.ts:289-294`). Accepting prior proof must be gated on "no
   declared output overlaps the proven files since".
2. **Recorded probes go stale** the moment a later phase mutates the
   workspace; prior-proof acceptance is only sound for un-re-mutated claims
   (current-ground-truth rule).
3. **Skills credit gates**: a verification phase turned cheap no-op
   accumulates successes toward the trust fast-path (3, zero failures) and
   can be distilled into a junk skill; the 2026-08-16 trust-33/0 precedent
   approved the plan that invited a 567s re-verification loop.
4. A naive prose gate that rejects recreates the $2.03 cascade.
5. Removing the final re-boot breaks the seed's live-URL delivery contract;
   distinguish re-prove (waste) from deliver (contract).
6. Cross-batch measurement validity: land the fix as one commit, measure on
   a reset store (operator-approved), compare structural signals (LLM call
   count, phase counts) rather than cost (±30% single-run noise).

## Measurement plan

Reset store/skills/runs (operator decision 2026-08-22), then re-run the six
default tasks cold and compare against batch 1 of 2026-08-21 (also cold: 98
LLM calls, $2.2552, phases per run as tabled above). Success: web/http runs
lose the redundant phase or its cost collapses to reads; cli runs keep their
seed-mandated phase; delivery stays 6/6; LLM call count drops.
