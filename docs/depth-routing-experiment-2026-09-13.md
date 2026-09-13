# Supervision depth as a routed decision — bounded experimental contract, 2026-09-13

Status: **design accepted for implementation on 2026-09-13; not yet an
executable protocol.** The seven decisions of §13 are closed and are not
reopened by implementation. The pre-registration (§8) is written last and
freezes the version of the code that was actually verified. Normative rules
move into the owning `AGENTS.md` files as the increments of §14 land, per
the COOLING-OFF rule in the root `AGENTS.md`; this document stays the
reasoning behind them. It designs the experiment on DEPTH ALONE. Model
routing per operation and the definition of what trust certifies are named
as later steps (§11) and are out of scope here.

Revision 6, 2026-09-14. Revision 2 absorbed six structural corrections from a
line-by-line confrontation with the code, marked `[r2]`. Revision 3 closed
when credit is decided and what the root proof observes on the Node family,
applied three targeted corrections and recorded six owner decisions, marked
`[r3]`. Revision 4 closes the seventh decision — how a browser observation is
bound to the document actually served — and adds the implementation order
(§14); its changes are marked `[r4]`. Revision 5 records two false bindings
the owner reproduced against increment 1 with a real browser, a redirect
and a port reuse, and the two rules they tightened, marked `[r5]`. Revision 6
records the runtime review: root-only floor, delivery-only probe payload,
attempt-scoped rejection memos, the full topology difference and explicit
common skill settings, marked `[r6]`. Historical numbers are cited with
their source file so a reader can re-verify them. None was re-measured for
this document.

## 0. Vocabulary, first

This repository has been bitten by one word carrying two meanings
([offer review](platform-skill-offer-review-2026-08-23.md) §0). Five terms,
one meaning each:

- **Escalation** is TAKEN. In `superviseLoop` (`src/core/supervisor.ts`) an
  `EscalationSignal` branches a child type and, when no branch remains,
  toggles parent fallback; `runStats.escalations` counts it. This document
  never uses the word for a change of topology.
- **Deepening** is the word used here for moving a run from the short
  topology to the deep one. It is a decision about the run's SHAPE, taken at
  one enumerated point, recorded with its reason.
- **Remediation** is a correction inside the current topology, under the
  dispositions that exist today. Nothing in this document adds or removes a
  remediation `[r2]`.
- **Acceptance** is the verdict on an executed result by an actor that did
  not execute it. The **acceptor** is that actor.
- **Attempt** is one execution of one topology inside a run. A run without
  deepening has one attempt; a run with deepening has two, and the second
  is the **accepted attempt** if it delivers.

## 1. The decision, in the owner's terms

> Garder les rangs comme contrat d'autorité, choisir les modèles selon
> l'opération, adapter la profondeur à la tâche, sous des obligations de
> preuve déclarées avant le choix de profondeur et un accepteur toujours
> distinct de l'exécutant.

| Dimension | Meaning | In this experiment |
|---|---|---|
| Authority | who may hold elements, delegate, accept — the rank taxonomy | unchanged |
| Model capability | which model serves an operation | fixed; pins identical in both arms |
| Supervision depth | how many ranks of decomposition and control a task receives | THE variable |

Why depth alone, and why obligations come first: if depth were routed while
proof obligations stayed attached to the plan, a short path would be cheaper
partly because it declared less to prove. The experiment would then measure
an economy of verification, not of orchestration. §2 and §5 exist to close
that. What the pilot measures, stated plainly: two topologies under one new,
common acceptance policy.

## 2. Invariants the experiment must preserve

- **I1 — Acceptance is distinct from execution.** Every executed result
  receives an acceptance from an actor that did not execute it, under the
  requirements in force for that task. Stated on responsibility, not on
  identity. `[r2]` Arm A does NOT satisfy this today: when every L2 has
  escalated, `superviseLoop` lets the L3 self-execute and returns that
  result with `viaFallback: true` and no acceptance above it
  (`src/core/supervisor.ts`, the fallback return). Both arms receive the
  same final acceptance (§3.3).
- **I2 — Obligations are a floor declared before depth.** The task profile
  declares proof obligations, each bound to a deliverable, before any
  topology decision. Planning may ADD obligations and never removes
  inherited ones (`effectiveObligations` already unions downward). The
  floor is read at the final acceptance under both topologies; how
  plan-added obligations reach it is §5.
- **I3 — Declared is not executed.** For every obligation in force, the
  final acceptance carries a coverage record — covered or uncovered, with
  the observation references — computed under the scope rule of §5 and
  with the consequences of §3.4. A run whose final acceptance carries no
  coverage record for an in-force obligation is a defect, not a quiet run.
- **I4 — Fallback is not acceptance.** An actor in `fallbackMode` has
  executed itself; supervisor provenance does not make it independent. Its
  result is accepted by the actor above it, and at the top of the run by the
  final acceptance. `[r2]` No rank refuses fallback; what happens at the
  entry rank's fallback moment in arm B is §4.
- **I5 — Provenance of every decision.** The topology chosen at entry, the
  deepening if any, the identity and rank of every acceptor, the attempt
  each event belongs to, and the observations each acceptance rested on are
  trace events: attributable, never inferred from prose.
- **I6 — No new judgment component and no new detector.** No learned
  router, no model asked whether a task needs decomposition, no rule that
  infers a capability from a path or a phrase. The topology is fixed by arm;
  the one deepening condition of §4 is an event the loop already emits. The
  trajectory-drift score stays journal-only.

## 3. The two topologies, and what they share

### 3.1 Deep — arm A

`startTask` → L3 tissue strategy call → L2 cells → L1 molecules. L3 accepts
L2 results as today; L2 accepts L1 results as today; L3 fallback
self-execution remains possible. Plus the final acceptance of §3.3. `[r2]`
Arm A is therefore today's path PLUS a common final acceptance, and is not
identical to the historical benchmark rows. The pre-registration says so.

### 3.2 Short-first — arm B

1. **Entry at L2.** The runner constructs the entry cell from the profile's
   canonical catalog for the deliverable class, selected mechanically with
   no model call. The catalog already carries a full-stack canonical whose
   bucket unites server, API and browser tools
   (`src/atoms/capability.ts`, `full-stack-build+probe`), so the registered
   family does not intrinsically need several cells `[r2]`. The L2 plans as
   today: its prefilter may collapse to one L1 or fall through to a
   multi-subtask sequential plan, so per-phase checkpoints exist below L2.
   What is removed is the L3 phase layer: its prefilter and strategy call,
   its validation of L2 plans and its supervision of L2 results. There is no
   parent to validate the entry L2's plan in the short topology. L2 still
   validates L1 plans and results as today. `[r6]`
2. **Final acceptance** of the L2's result, §3.3.
3. **Deepening, exactly once at most**, at the one point of §4. The run then
   continues as arm A on the same goal, under §6, WITH arm A's own
   fallbacks: the deep attempt's L3 may still self-execute, and that result
   goes to the final acceptance like any other `[r3]`. "One deepening" bounds
   the number of topology changes, not the number of fallbacks.

**Expected effect, to quantify in the pilot.** The topology change removes
more than one strategy call: the entire L3 supervision layer above the entry
cell is absent until deepening. Actual savings depend on L3 prefilter,
strategy and validator calls, trust skips, retries, and the extra work paid
when short deepens. Count those calls and their cost by role in both arms;
the common root acceptance remains in both. `[r6]` The
engineering record priced the removed L3 shortcut at about $0.10 per run
([record](incidents/engineering-record-2026-08-14.md), "Prefilter
decomposable hint"), and round 10 attributed the control's lead over atoma's
warm asymptote to that one call ([ROUND10](../benchmark/ROUND10.md)). That
historical number is context, not an estimate of the whole intervention.
The registered decision criterion is the total cost per scorer-verified
result (§8), including failures and deepenings.

### 3.3 The final acceptance, common to both arms `[r2]`

The run's final result — the L3's aggregation or fallback in arm A, the
entry cell's result in arm B — receives one acceptance by the run root,
trace actor at tier 3 with role `root-acceptor`, which owns no plan,
creates no atom type and moves no counter. It runs, in order:

1. the mechanical RESULT gates in their DELEGATED set, with the dispositions
   the table already states (`reject`, `reject-once`, `requires-review`);
2. the zero-token ground-truth probe on `{ output, summary }`, as at L3;
   internal plan/verdict/fallback traces are not delivery claims and must
   never become quoted spans to check against disk `[r6]`;
3. root coverage over the profile floor, under §5.

If nothing requires review, the result is accepted with basis `mechanical`.
A review is triggered by a `requires-review` gate, by the probe's
`requiresReview` — which covers BOTH a contradiction and a malformed
manifest, exactly as `L3.validateResult` reads it today `[r3]` — or by an
uncovered floor obligation. The review is ONE validation call on the
L1-tier selector, with the findings attached; it decides delivery and
nothing else (§3.4). There is no trust fast path at the root: the L3 type's
counters are consulted by nobody today and the entry cell's counters would
make the two arms asymmetric.

**Rejection at the root ends the run as failed, in both arms** (decision 1,
§13). There is no plan to modify at the root, so no remediation loop exists
there. `[r3]` The root acceptor is an instrument with its own false
positives and false negatives; its agreement with the executing scorer is a
measurement of the pilot (§8), never an assumption of it.

### 3.4 Two levels of proof, two consequences `[r3]`

Revision 2 promised that an uncovered obligation at the root would withhold
credit "as today". It cannot: the L2's `onApproved` hook records the child's
success, credits the skill, distills and arms promotion the moment a phase
result is approved (`src/atoms/L2Atom.ts`, `onApproved`), long before any
final acceptance exists. For this pilot the rule is the simple one:

- **The phase check keeps its effects on credit.** L2 accepting an L1 result
  evaluates coverage over its branch; an uncovered obligation withholds
  atom trust, skill credit, distillation and promotion for that phase, as
  today. Nothing here changes.
- **The root check decides delivery and journals coverage.** It has no
  retroactive effect on phase credits: a root-uncovered floor obligation
  triggers the review of §3.3 and appears in the `acceptance` event; it
  neither withdraws a success already recorded nor blocks one still to
  come.
- **Deferring every credit to the final acceptance is a different change**,
  to the learning cycle, and is out of scope (§11).

## 4. The one deepening condition, and what is not one `[r2]`

Arm B deepens at exactly one observable point: the entry cell's
`superviseLoop` reaches the fallback moment. That is the `catch` of an
`EscalationSignal` after `branchOnEscalation` returned no replacement or the
one-shot branch has already been spent — the line that today calls
`parent.setFallbackMode(true)`. In arm B, at the entry rank, that call is
replaced by the deepening; the `escalated` trace entry the loop already
emits is the evidence. Below the entry rank, everywhere in arm A, and in
the deep attempt that follows a deepening, fallback behaves as today `[r3]`.

Everything else keeps today's disposition in BOTH arms:

| Signal | Disposition, unchanged in both arms |
|---|---|
| `proofUncovered` on an approved phase result | approval stands, phase credit withheld, no re-execution |
| mechanical RESULT gates | per the table: `reject`, `reject-once`, `requires-review` |
| plan or exec iteration limits | `EscalationSignal`, branch once, then fallback — or the deepening, at the entry rank of arm B only |
| tool budget at L1 | as today |
| trajectory-drift score | journal only |

Deferred, with the reason:

- **"Declared `outputs` span several capability buckets."** `outputs` are
  paths; inferring capabilities from them would be a new detector (I6), and
  the full-stack bucket removes the premise for the registered family.
- **"No capable child reachable"** as a separate predicate. It has no
  executable definition today; the fallback moment is the observable event
  that subsumes it.

## 5. What the root proof observes, on which deliverable `[r2]` `[r3]`

`checkProofCoverage` reads the attestation log for the CURRENT branch
(`ctx.attestations.forBranch(ctx.currentBranchId)`,
`src/atoms/proofCoverage.ts`). Called from the root it would see nothing
from the descendants; widened to every branch it would let an interaction on
one page cover another. The rule relates obligation, deliverable, branch and
attempt — and, for the Node family, it depends on a binding the tool does
not guarantee today.

### 5.1 The scope rule

- **Phase level is unchanged.** L2 accepting an L1 result evaluates coverage
  over its own branch, with today's asymmetry: an observation with no
  document binding covers, one whose document digest moved does not.
  The runner writes the profile floor only to `Task.proofFloor`; it never
  unions it into inherited `proofObligations`. A server-writing phase with
  no plan-declared DOM obligation keeps its normal approval credits even
  if root DOM coverage is absent. `[r6]`
- **Root level is path-bound and attempt-bound.** The profile floor is a set
  of `{ obligation, deliverable }` pairs, the deliverable being a workspace
  path. At the final acceptance an obligation is covered iff the ACCEPTED
  ATTEMPT's attestation log, across all its branches, holds an executed
  observation of that obligation's kind whose document binding is that
  deliverable and whose digest still matches the file at acceptance time.
  An observation without document binding does not cover at the root: the
  multi-branch scope is what makes the phase-level leniency abusable.
  Records of an abandoned attempt never cover.
- **Plan-added obligations do not climb.** `effectiveObligations` unions a
  parent's obligations onto its children; nothing collects a subtask's
  declarations upward. For this pilot the root evaluates the profile floor
  ONLY. Obligations a plan adds keep their phase-level evaluation and
  credit consequences, and their phase coverage records are copied into
  the `acceptance` event as `phaseCoverage` for the reader — collected, not
  re-evaluated. Binding a plan-added obligation to its phase's declared
  `outputs` is the later candidate, not built here.

### 5.2 The binding is established on the response the browser loaded `[r3]` `[r4]`

Three facts about today's tools, each verified in `src/tools/builtin.ts`:

- `observedDocumentFor` takes the URL's pathname, maps a trailing `/` to
  `index.html`, resolves it inside the sandbox and digests that file BEFORE
  the page opens. It checks only that the host is loopback; its comment says
  it is silent for a Node server, the code is not.
- `NodeServerEntries` already records, per tool set, the port and the ENTRY
  FILE `start_node_server` spawned. That says which file was the server. It
  says nothing about which HTML the server returned, and nothing about
  whether the port still belongs to that process.
- `validate_html` already captures the main-frame response body after
  `page.goto` (`navigation.text()`, kept as `pageRevision`). The bytes the
  browser actually received are therefore available at observation time.

A constraint in the goal says what the agent must produce; it proves
nothing about what it served. A binding proven on the reference solution
proves nothing about the deliverables generated during the pilot. Knowing
the server's origin does not tell which document it served: a Node server
our tool launched may serve another file, or generated HTML. Hence the
contract, decision 7:

1. **Origin known and still valid for the attempt.** The FINAL response
   URL's port was bound by `start_static_server` or `start_node_server` of
   THIS tool set — one tool set per sandbox, one sandbox per attempt (§6),
   so a former attempt's port attribution cannot survive — and the recorded
   process HOLDS the listening socket at observation time, asked of the
   kernel (`/proc` on Linux, `lsof` on darwin, fail closed elsewhere).
   `[r5]` A live process is not proof: a server that closed its listener and
   stayed alive while a stranger bound the port was reproduced as a false
   binding. A dead process, a process that no longer listens, or a port
   nobody in this tool set bound, is an unknown origin.
2. **Binding established on the loaded response — the FINAL one.** `[r5]`
   The response after every redirect names the document and the port; a
   registered server answering `302` toward a stranger serving the root
   file's bytes was reproduced as a false binding when the requested URL
   was used. The main-frame response body the browser received is compared
   byte for byte to the file the FINAL URL designates, read at that
   instant; the `/` → `index.html` mapping is a DESIGNATION, no longer a
   proof. Equal bytes bind the observation to `{ path, sha256 }`, the digest
   being of those bytes. This attests a content correspondence at that
   instant. It does not attest the application's dependency chain, scripts
   included.
3. **No demonstrated binding, no declared binding.** The observation stays —
   interactions, smoke, requests — with no `document`. Root coverage is not
   established and follows the review already planned (§3.3). A pre-flight
   refusal never loads a page and is therefore attested and never bound,
   which changes today's "digest resolved before the page opens" behaviour.
4. **Same behaviour in both arms, verified before the pilot** (§8).

Consequences on the family: a server that templates its HTML is unbound; a
server that serves `public/index.html` at `/` while an unchanged
`index.html` sits at the workspace root is unbound, because the bytes
differ — this is the decisive negative case; a server that serves the root
`index.html` verbatim is bound. The goal still requires `index.html` at the
workspace root served at `/`: that makes the binding achievable, it proves
nothing. The browser-observation lines of `src/tools/AGENTS.md`, which today
state that a Node server yields no document, change with this rule — one
rule, one home.

### 5.3 What this needs

An attempt tag on `AttestationRecord` and on trace events, a reader over an
attempt's records, and the floor's pair shape defined once in
`src/contracts/` (one schema per shape). The obligation vocabulary itself
stays at its one member.

The four scope cases and the three binding cases are §10 tests: proof at a
descendant branch covers; proof at a sibling deliverable does not; a proof
whose document was mutated afterwards does not; a proof from the abandoned
attempt does not; a verbatim-served root `index.html` binds; another page
served while the root file is unchanged does not; a stale origin does not.

## 6. What a deepening carries, and what it must not `[r2]` `[r3]`

- **One run, one deadline, one cost.** Both attempts share the run's
  `deadlineAt`; there is no run-level cost ceiling today, so the deadline is
  the global budget and the summed cost is the run's cost. Iteration limits
  are per `superviseLoop` and therefore per attempt by construction. The
  short attempt's spend is never discounted.
- **Mechanical coaching resets with the workspace.** The plan and result
  `reject-once` memos are fresh for each attempt, shared across all branches
  and replans within that attempt. A first-attempt rejection cannot consume
  the deep attempt's coaching for the same goal and same envelope. `[r6]`
- **Stop, archive, rebuild, then fresh** (decision 3). Every branch of the
  first attempt and every process it started are stopped and awaited; the
  workspace is archived through the mechanism every run already uses at
  start (`prepareWorkspace(root, clean)`, `src/run/profile.ts`); the
  sandbox is constructed anew, because `ToolSandbox` realpath-resolves its
  root at construction (`src/tools/sandbox.ts`) and an instance built over
  the archived directory would point every tool at the archive; then the
  deep attempt starts clean. Corrected rationale `[r2]`: promotion is decided
  by `resolveSkillPromotion` from the `--seed` argument and the environment,
  not from workspace state (`src/run/runner.ts`), so continuing in place
  would not flip promotion. Fresh is retained because a deep attempt over a
  half-built workspace is a maintenance-shaped run on a state neither arm A
  nor the family registers.
- **One lifecycle policy for both arms and attempts.** `--depth` preserves
  the runner's normal resolution of learning, promotion and direct dispatch
  at launch. It does not add `--no-promote-skills` or `--no-direct-skills`
  to attempt 2. In particular, `ATOMA_SKILL_PROMOTE=1` would enable promotion
  throughout either arm; refusing `--seed` does not override that variable.
  The pilot fixes explicit common settings in §8 instead of relying on
  defaults or changing the learning cycle on deepening. `[r6]`
- **Evidence separated by attempt.** Trace events and attestation records
  carry the attempt id. The abandoned attempt's evidence stays in the run
  trace for the reader; the final acceptance reads only the accepted attempt
  (§5). Nothing from the abandoned attempt's workspace or prose enters the
  L3 prompt (R2, [saas-architecture](saas-architecture.md#engineering-rules-to-apply-now)).
- **Trust and skills earned inside the abandoned attempt stand within the
  run, and never reach a later pair** (decision 4). Each L1 result the entry
  cell accepted was an I1-compliant acceptance, and distillation is
  performed by the L2 per accepted phase (`learnSkillFromRun`,
  `src/atoms/L2Atom.ts`), so it has already happened when the fallback
  moment arrives; rolling counters back would need a transactional undo the
  registry does not have. The abandoned attempt distills nothing further.
  The second half is not a separate option: §8's snapshot restore per pair
  already guarantees that nothing learned in one pair is injected into the
  next.
- **Counters.** `runStats` gains `deepenings`, defaulted like
  `uncoveredObligations` so archived epilogues still parse.

## 7. Trace and provenance

Two event kinds join the recorder's schema (`src/viz/trace.ts`) and its
client projection, and every event gains an `attempt` field. Both kinds are
emitted under BOTH arms.

- `topology` — `{ at: 'entry' | 'deepening', mode: 'short' | 'deep',
  reason: 'arm' | 'fallback-moment', attempt }`.
- `acceptance` — `{ acceptor: { name, tier, role }, executor: { name, tier,
  viaFallback }, gates: [{ id, disposition }], probe: { requiresReview,
  contradiction }, floorCoverage: [{ kind, deliverable, status: 'covered' |
  'uncovered', observationRefs }], phaseCoverage: [...], basis:
  'mechanical' | 'validation-call', attempt }` `[r3]`. Emitted for the final
  result.

A kind the timeline cannot render is a blocking defect for the experiment,
because the traces are the evidence.

## 8. Pre-registration — a pilot, stated as one `[r2]` `[r3]`

To be written before any run, with the discipline of
[`benchmark/PROTOCOL.md`](../benchmark/PROTOCOL.md).

- **What the pilot can conclude.** Eight paired goals can show a
  difference worth a registered follow-up and can produce mechanisms from
  traces. They cannot establish that depth buys or costs correctness. Every
  result is published paired, per goal and per sub-family, and the write-up
  names the follow-up that would carry a causal claim.
- **H-depth.** On the registered family, arm B's full-mark rate by the
  executing scorer is greater than or equal to arm A's, AND arm B's cost per
  verified result is lower than arm A's.
- **Cost per verified result**, defined: the sum of the cost of ALL runs of
  the arm, failures and deepened runs included, divided by the number of
  results the scorer validated, per arm and per sub-family. The harness's
  `costsOf` filters rows on `delivered` (`src/cli/benchmark.ts`); for this
  experiment it is replaced by a scorer-joined computation.
- **Refutation.** A lower full-mark rate on the pilot is a finding that
  motivates the follow-up, published with a confirmation's prominence. A
  cost per verified result that is not lower means deepenings eat the
  saving; the deepening rate is then the finding.
- **Secondary, reported not decided.** Wall clock; LLM calls; validator
  calls; deepening rate; `uncoveredObligations`; root acceptances by basis
  and by trigger; unbound observations per arm (§5.2); and the
  disagreement between the root acceptor and the scorer in both directions
  `[r3]`.
- **Family.** A Node HTTP server plus a served browser page, the shape of
  the [2026-09-07 incident](incidents/notes-app-browser-phase-2026-09-07.md),
  under the §5.2 constraint that `index.html` sits at the workspace root
  and is served at `/`. It makes the one obligation member,
  `dom-interaction`, applicable and bindable; and it is where the deep path
  reported success over a regressed workspace three times. Two
  sub-families: **coupled**, server and page share one API contract;
  **orthogonal**, two unrelated static pages. Registered expectation: arm B
  wins on coupled, arm A on orthogonal. A reversal is a finding.
- **Order.** Counterbalanced within each pair: A then B on odd goals, B
  then A on even goals. Same day, one run at a time per the quota rule.
- **Scale** (decision 6). Four goals per sub-family, one run per goal per
  arm — eight pairs — plus one held-out pair.
- **Models.** Identical pins in both arms, recorded with the results.
- **Skill lifecycle, fixed for this pilot.** Explicitly set
  `ATOMA_SKILL_LEARN=1`, `ATOMA_SKILL_DIRECT=1`, `ATOMA_SKILL_PROMOTE=0` for
  both arms and every attempt. Learning, phase credit and use of existing
  compiled skills remain available; no new compilation is armed during a
  measured run. Record the resolved settings and their sources. The paired
  harness must reject a configuration or disabling CLI flag that changes
  this policy before any run. These values also enter the final
  pre-registration; ordinary `--depth` invocations alone do not enforce
  them. `[r6]`
- **Stores** (decision 5). Each PAIR restarts both arms from the same frozen
  snapshot, so the pilot measures depth without learning drift. Primary: a
  WARM store, matured beforehand on distinct goals of the same family, with
  its preparation procedure and its content — atom types, counters, skills
  and their meta — recorded in the registration. Secondary, decided in
  advance and run only if the primary completes: the same pairs from a COLD
  snapshot. The harness already isolates an arm through `ATOMA_DB_PATH` and
  `ATOMA_SKILLS_DIR`; arm B needs the same, plus snapshot restore per pair.
- **Pre-round validation, five directions.** The scorer, as round 12 did:
  an empty workspace fails; the reference solution passes; server-only
  passes the API checks and fails the page; a page backed by a fake API
  fails — the notes-app run-3 shape, and the reason the scorer must drive
  the real server. And the binding, three cases under the real Node server
  and the real browser `[r4]`: POSITIVE — the reference solution serving the
  root `index.html` verbatim yields an observation bound to it with the
  file's digest; DECISIVE NEGATIVE — an `index.html` present and unchanged
  at the workspace root while the server returns another page yields an
  UNBOUND observation, even though `start_node_server` launched the server;
  STALE ORIGIN — a port recorded in this tool set whose process has exited
  yields an unbound observation. These controls must run through BOTH
  `--depth deep` and `--depth short` against the frozen reference with the
  real server and browser, recording the attestation and root `acceptance`
  coverage. A tool-only or mocked-observation unit test cannot discharge
  this prerequisite. Any failed direction blocks the round. `[r6]`
- **Timeout.** Thirty minutes per run, the current project default.

## 9. Code touchpoints — coherence, not implementation

| Concern | Where | What must hold |
|---|---|---|
| Final acceptance, both arms | `src/run/runner.ts` around `handle`; `src/core/supervisor.ts` `validateResult` | the run's final result passes §3.3 before the run is labelled; the L3 fallback return no longer bypasses acceptance; no counter moves at the root |
| Entry point, arm B | `src/run/runner.ts`, L3 construction | constructs the entry cell instead of an L3; the profile selects it mechanically |
| Deepening, arm B | `src/core/supervisor.ts`, the fallback moment; `src/atoms/L2Atom.ts` `fallbackMode` | at the entry rank of the FIRST attempt, the fallback call becomes the deepening; everywhere else, unchanged |
| Attempt teardown and rebuild | `src/run/runner.ts`; `src/tools/sandbox.ts` | branches and processes stopped and awaited; workspace archived; a new `ToolSandbox` for attempt 2 |
| Profile floor | `src/run/profile.ts` `TaskProfile`, shape in `src/contracts/` | `{ obligation, deliverable }` pairs; `buildTask` threads them onto the root Task |
| Root coverage | `src/atoms/proofCoverage.ts`, `src/contracts/attestation.ts`, `src/core/attestation.ts` | attempt tag on records; an attempt-scoped reader; the §5.1 path-bound rule; phase-level rule and phase credit untouched |
| Document binding | `src/tools/builtin.ts` `observedDocumentFor`, the two server tools, `src/tools/AGENTS.md` browser-observation lines | origin registry per tool set with liveness; binding on byte equality between the loaded response and the designated file; pre-flight refusals unbound; the three §8 cases as integration tests |
| Delegated-result gates | `src/atoms/resultGates.ts` | the DELEGATED set runs at the root with its existing dispositions |
| Counters | `src/contracts/runStats.ts` | `deepenings`, defaulted |
| Trace | `src/viz/trace.ts` and the client projection | `topology`, `acceptance`, `attempt` |
| Harness | `src/cli/benchmark.ts` | a second atoma arm with isolated stores, snapshot restore per pair, scorer-joined cost |

## 10. Tests that cross tiers

The 2026-08-23 lesson stands: a gate that crosses tiers needs a test that
crosses them ([decided, not built](decided-not-built-2026-08-23.md), facts).
Each test runs the production path with mocked providers unless stated.

1. Arm A, every L2 escalates, L3 self-executes: the result reaches the
   final acceptance; the `acceptance` event names the L3 as executor with
   `viaFallback`; rejection fails the run. (I1, I4)
2. Arm B, entry cell reaches the fallback moment in attempt 1: no L2
   self-execution; a `topology` deepening event with reason
   `fallback-moment`; branches and processes of attempt 1 are stopped and
   awaited, the workspace archived, a new sandbox built; attempt 2 runs as
   arm A INCLUDING its fallbacks, and an L3 fallback in attempt 2 goes to
   the final acceptance; one run, one trace, summed cost. `[r3]` (§3.2, §4,
   §6)
3. Root coverage, proof at a descendant branch of the accepted attempt,
   document unchanged: covered. (§5.1)
4. Root coverage, executed interaction on a sibling deliverable only: not
   covered; the `acceptance` event names the deliverable. (§5.1)
5. Root coverage, interaction executed then the document mutated: not
   covered. (§5.1)
6. Root coverage, the only valid interaction belongs to the abandoned
   attempt: not covered. (§5.1)
7. Two levels, one uncovered obligation `[r3]`:
   7a. phase level — L2 approves with `proofUncovered`; `onApproved`
       records no success, credits no skill, distills nothing; the phase
       coverage record is present;
   7b. root level — the floor obligation is uncovered; the review call is
       made and decides delivery; the `acceptance` event carries the record;
       no counter, skill or promotion state changes as a consequence. Run
       a non-browser phase through each real runner entry, with and without
       a matched skill: its trust, credit or distillation precedes root
       rejection and remains earned; `uncoveredObligations` stays zero when
       the plan declared none. `[r6]` (§3.4)
8. Planner adds an obligation: the effective set is the union downward; the
   root evaluates the floor only and copies the phase records into
   `phaseCoverage`; planner output omitting an inherited one does not
   remove it. (I2, §5.1)
9. Root acceptance with no findings makes no model call and moves no
   counter; with a `requires-review` gate, or a probe whose
   `requiresReview` comes from a malformed manifest, it makes exactly one.
   Internal trace quotes cause no probe contradiction or LLM call; the same
   false quote in the delivery summary still forces review. `[r6]` (§3.3)
10. Binding, integration, real Node server and real browser, also the
    pre-round validation `[r4]`:
    10a. positive — the server returns the root `index.html` byte for byte;
         the observation is bound to it with the file's digest;
    10b. decisive negative — `index.html` present and unchanged at the root
         while the server returns another page; the observation is UNBOUND
         although `start_node_server` launched the server; the root records
         the floor obligation as uncovered;
    10c. stale origin — the port is recorded in this tool set and its
         process has exited; the observation is unbound;
    10d. redirect `[r5]` — our registered server answers `302` toward a
         stranger returning the root file's bytes; the observation is
         unbound, and a same-origin redirect binds to the FINAL path's file;
    10e. port reuse `[r5]` — our registered server closes its listener and
         stays alive while a stranger binds the same port with the same
         bytes; the observation is unbound. (§5.2)
11. Arm A regression: the existing suite passes; the new event kinds and
    the `attempt` field alter no ordering assumption in the trace readers.

## 11. Out of scope, deferred by decision

- **Model routing per operation.** Later; pins are fixed here.
- **What trust certifies:** an atom type alone, or an execution
  configuration including model and method. `atom + model` is a candidate
  key, not a definition. §8 keeps trust states comparable by snapshot
  restore, so no migration is needed for the pilot.
- **Deferring phase credits to the final acceptance** `[r3]` — a change to
  the learning cycle, not to depth.
- **Binding plan-added obligations to their phase's `outputs`** `[r3]` — the
  candidate for a later revision if `phaseCoverage` shows they matter.
- **A router that chooses topology at entry.** Arm B's fixed short-first
  plus §4 is the router's first version; its data comes from this pilot.
- **The cross-bucket deepening condition** and a standalone "no capable
  child" predicate (§4).
- **Remediation at the root** (decision 1).
- **A second obligation member.** The attestation module states that a
  second member is its own review.
- **Shadow mode.** It shows what a router would have chosen and what
  happened under the topology actually executed, never the counterfactual.
  Useful to audit decisions and stratify a sample; not a measurement.

## 12. Prior rejections this must answer

- **The L3 skeletal prefilter shortcut** — `src/atoms/AGENTS.md`,
  intentional choices, and the record's "Prefilter decomposable hint".
  Rejected because a Haiku prefilter replaced the L3 plan with a
  one-subtask plan and a Pong build was delegated whole to one L1 with no
  per-phase smoke checkpoint. Arm B differs in four ways, each verifiable in
  the trace: the topology is an explicit recorded decision, not a prefilter
  side effect; obligations are declared before it and evaluated at the
  final acceptance under §5; the L2's own decomposition and phases remain;
  a final acceptance distinct from the executor exists in both arms. If the
  pilot shows Pong-shaped monoliths under arm B, that refutes arm B. It is
  not a reason to weaken §2 or §5.
- **Plan templating** — not reintroduced. Arm B instantiates no plan; the L2
  plans.
- **Cooling-off** — no incident is live. This design collects the rounds
  10–12 mechanism, the notes-app incident and the Pong rejection, and lands
  once.

## 13. Decisions recorded, and what remains `[r3]`

Decided by the owner on 2026-09-13, on revision 2:

1. **Root rejection fails the run.** No remediation at the root for this
   pilot.
2. **Exactly one deepening.** With two topologies, a higher cap would need
   another recovery policy to be defined first.
3. **Archive, then a new workspace**, after stopping and awaiting every
   branch and its processes, then rebuilding the sandbox.
4. **Credits earned in the abandoned attempt stand within the run and are
   never re-injected into later pairs.** The frozen snapshot already imposes
   the second half; these were never two competing options.
5. **Warm primary snapshot**, its preparation and content recorded; cold is
   a secondary experiment decided in advance.
6. **Eight pairs plus the held-out pair.** They match the question asked;
   the burn-in's six tasks would mainly buy historical continuity.

Decided by the owner on 2026-09-13, on revision 3 `[r4]`:

7. **Harden the binding, under the four rules of §5.2.** Origin known and
   still valid for the attempt; binding established on the response the
   browser actually loaded, compared to the designated file at that
   instant; no demonstrated binding, no declared binding; identical in both
   arms and verified before the pilot with the three cases of §8. The
   `NodeServerEntries` registry is reused for the origin's entry file and
   is not itself proof of the document served.

With this decision the design is precise enough to move to implementation
and to the validation of the instrument. The pre-registration then freezes
the version that was actually verified. The seven decisions are not
reopened by implementation.

## 14. Implementation order `[r4]`

Each increment keeps both arms coherent on its own, lands with its tests,
and moves its normative lines into the owning `AGENTS.md`. The instrument
comes first because it is the lock on the proof semantics and is useful
independently of depth.

1. **Instrument — the binding** (§5.2). Origin registry per tool set with
   liveness for both server tools; binding on byte equality between the
   loaded response and the designated file; pre-flight refusals unbound;
   the three integration cases of §10.10; the browser-observation lines of
   `src/tools/AGENTS.md`. Touches `src/tools` only.
2. **Attempt and provenance** (§6, §7). The `attempt` tag on attestation
   records and trace events, an attempt-scoped reader, the `topology` and
   `acceptance` event kinds and their client projection. Touches
   `src/contracts`, `src/core/attestation.ts`, `src/viz`.
3. **Final acceptance in both arms** (§3.3, §3.4, §5.1). The root acceptor
   after the L3 `handle` and on the L3 fallback return; the profile floor
   as `{ obligation, deliverable }` pairs; the path-bound, attempt-bound
   root coverage; tests 1, 3 to 9. Touches `src/run`, `src/core`,
   `src/atoms`, `src/contracts`.
4. **Arm B** (§3.2, §4, §6). Entry at L2 from the profile's canonical cell;
   the deepening at the fallback moment of the first attempt; stop, archive,
   rebuild; the `deepenings` counter; test 2. Touches `src/run`,
   `src/core/supervisor.ts`, `src/atoms/L2Atom.ts`.
5. **Harness, scorer, registration** (§8). The second atoma arm with
   isolated stores and snapshot restore per pair; the scorer-joined cost;
   the executing scorer and the five-direction validation on the reference
   solution; the warm snapshot's preparation; then the pre-registration,
   written against the verified build.

## 15. Runtime implementation, 2026-09-13

Increments 2–4 are implemented behind the explicit build-runner option
`--depth deep` or `--depth short`. The ordinary runner path remains the
existing default. Both experimental arms use the same root delivery
acceptance, model pins, tool declarations and deadline. The build profile
owns the `index.html` floor and writes it into the root Task before routing.

The short entry uses the canonical full-stack cell and its existing planning
and dispatch protocol. A mutualized peer occupies the same entry role: its
fallback moment deepens too. The first attempt is cancelled and drained;
`ToolSandbox.drain()` confirms process exit before the workspace is archived
and a fresh backend constructed. Failure to establish quiescence fails the
run. The initial backend implementation is local only: the container backend
has no confirmed-exit operation yet, so both experimental arms refuse
`--container` at launch rather than promise an unverified transition.

The trace contains topology and final-acceptance events, attempt tags and the
attestation records their references name. `phaseCoverage` retains the
collected records of both attempts, with their attempt ids; only root floor
coverage is limited to the accepted attempt. The GPU timeline displays the
new events and attempt labels.

Executable regression evidence is in `tests/depth-routing.test.ts`,
`tests/depth-runner.test.ts`, `tests/depth-trace.test.ts` and the extended
`tests/proof-attestation.test.ts`. The runner test uses the actual L3/L2/L1
classes and local tools with a mocked provider. It launches a Node server
that ignores SIGTERM, verifies it is gone before attempt 2, verifies the
archived files and fresh tool backend, forces the full L3 fallback, then
checks root rejection, one trace and cumulative accounting.

This is runtime implementation evidence, not a cost or quality result.
Increment 5 remains: the eight goals plus held-out pair, independent scorer
and reference controls, frozen warm snapshot, paired harness, and final
pre-registration against the verified build. No paid pilot has been run.

Validation on the local macOS host: `release:check` passed (4,004 tests passed,
7 skipped, zero audit vulnerabilities, compiled release smokes passed).
Two further regressions for peer fallback and cancellation during acceptance
passed in the focused depth suite, with both TypeScript configurations and
lint. `viz:smoke` passed on WebGPU and WebGL, and a rendered fixture containing
both topology events and final acceptance was visually inspected. The worker
image was not rebuilt; the experimental entry remains local-only.

## 16. Runtime review corrections, 2026-09-14 `[r6]`

Two implementation defects could have biased the experiment before any
measurement. The runner had copied the root floor into inherited phase
obligations, withholding credit on approved non-browser phases. The root
probe had walked the entire Result, turning quotes inside internal traces
into current-file claims and charging the resulting spurious review to the
arm with those traces. The runner now writes only `proofFloor`; the root
probe receives only `output` and `summary`. The validator still receives
`producedBy`, so direct fallback provenance is preserved.

Seven added regression cases cover these corrections and the memo decision
of §6. Four enter the real runner, in each arm with either a matched skill
or a novel phase, write a server file without browser observations, and
assert trust plus skill credit or distillation before root rejection. Two
probe an internal trace quote at the root and contrast it with the same
false quote in the delivered summary. One exercises the existing
`reject-once` result gate across forks and attempts, together with plan-memo
sharing. The previous assertion of memo identity across attempts is removed.

The common lifecycle settings of §8 are a measurement requirement, not new
runner defaults. Reference controls through both `--depth` entries remain
part of increment 5 and have not been run against a frozen reference here.
The earlier tool/browser tests do not substitute for those controls.

Validation after the corrections on the local macOS host: `release:check`
passed with 4,013 tests passed and 7 skipped, both TypeScript configurations,
lint, documentation checks, zero audit vulnerabilities, build and compiled
release smokes. `git diff --check` passed. No paid experiment was run.
