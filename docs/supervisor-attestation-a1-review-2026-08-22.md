# Supervisor-held proof attestation (A1) — design review, 2026-08-22

Status: **design review, revision 2. One contract proposed, reviewed against
the nine boundaries in the evidence inventory. No code accepted, no code
written.**

Revision 2 corrects one factually wrong claim in revision 1 (§6 asserted that
a withheld consequence has no visible surface; for skill credit one already
exists), resolves three of the four attacks revision 1 left standing, and
adds the acceptance controls in §7. What did not change: the contract's
shape, its dispositions, and the fact that nothing here is accepted.

This review answers the reserved A1 direction recorded in
[`docs/incidents/supervisor-attestation-evidence-2026-08-22.md`](incidents/supervisor-attestation-evidence-2026-08-22.md),
after the cooling-off period the root [`AGENTS.md`](../AGENTS.md) requires.
The inventory's nine facts are the acceptance criteria; §5 works through them
one at a time and states where the proposal fails.

The one inventory item that was not a design question — the web-probe
discriminant taught in one vocabulary and read in another — was closed
separately in `3ee624d` and is out of scope below.

## 1. The proposal in one paragraph

Introduce **one** contract: a run-scoped, machine-written, append-only
**attestation log** of transport-observed tool observations, written at the
tool-executor seam (the only place that sees a raw tool result), addressed by
branch and tool event, and read by the supervisor at verdict time. A witness
gains an explicit **observer**: `transport-observed` (attestation-backed) or
`model-declared` (today's `output.probes`). A plan subtask may declare a
**proof obligation** alongside its existing `outputs`. An obligation that no
transport-observed attestation covers does **not** reject the deliverable —
it forces validator review and, decisively, **withholds the method-level
consequences of approval**: atom trust success, skill credit, distillation
and promotion.

The contract's thesis is a separation the codebase does not yet make:
approving a RESULT is a judgment about an **artifact**; conferring trust and
distilling a skill is a claim about a **method**. Only the second needs
machine-observed proof, and only the second caused the measured damage.

## 2. This mechanism already exists once

The proposal is not a new concept. It is the second instance of one already
in production, and reviewing it as a generalisation rather than an invention
is the point of this section.

[`L1Atom`](../src/atoms/L1Atom.ts) derives `activeScriptSkillExecuted` from
its tool loop: a `run_shell` invocation that actually ran a scratch file the
skill wrote, observed at the transport, not claimed in prose. `L2Atom` turns
the negative of that into `activeScriptSkillIgnored` and overrides the
validator on **both** result paths — the trust fast path and the full verdict
— with `{ ...verdict, activeSkillFollowed: false }`
([`L2Atom.ts`](../src/atoms/L2Atom.ts), the `validateResult` tail). A model
narration cannot argue with it.

So the repository already holds that (a) a transport-observed boolean may
outrank a validator's judgment, (b) the thing it gates is **skill credit**,
not approval, and (c) the seam is where tools are invoked. A1 generalises
exactly that: from one boolean about one skill to a typed, addressed record
about any attestable observation.

It also inherits that precedent's known weakness, which the generalisation
must fix rather than copy: `activeScriptSkillExecuted` is derived from the
**LLM tool-loop callback**, which supervisor-owned probes invoked through
`ctx.tools.execute` never enter. The callback is a narrower seam than the
contract needs.

## 3. The contract

### 3.1 A typed observation at the tool boundary

`validate_html` returns `ok`, `interactionLog`, `smokeResult`, warnings and
error lists, but its declared type is `unknown` and `interactionLog` exists
only in tool-description prose; the local, worker and container executors
forward the value without parsing it. The contract declares the browser
observation as a schema in [`src/contracts`](../src/contracts/AGENTS.md) —
one schema, one home, per that subsystem's rule — carrying at minimum:

- the **requested** interactions, and the **executed** interaction log, as
  two separate fields (inventory fact 1: these are different facts);
- whether the `smokeDrivesOwnState()` filter stripped the requested
  interactions, as a first-class boolean rather than a warning string;
- the smoke expression and its result;
- console errors and failed requests;
- a content digest of the artifact source the observation was taken against
  (scoped in §5.4).

The filter itself is **not** changed. It exists to preserve one coherent
state-transition path, and removing it is a tool behaviour change with its
own review. The contract only makes its effect legible and non-covering.

### 3.2 The attestation log, written at the fork's tools wrapper

`forkBranch` already wraps `ctx.llm` per branch so every completion carries
its `branchId`, while `ctx.tools` is forwarded **by reference** — one
executor shared by every branch, parallel lanes included. The contract adds
the symmetric wrapper: `forkBranch` wraps `ctx.tools` per branch, and every
call through it appends `{ eventId, branchId, actor, tool, argumentsDigest,
observation, artifactDigest }` to one shared append-only log.

Three consequences, each load-bearing:

- **No ambient "current actor".** Identity comes from the wrapper the fork
  created. Ambient state would race the moment two lanes run concurrently,
  and lanes do run concurrently (`parallel-fanin-2026-08-16`).
- **Supervisor probes are covered.** They go through `ctx.tools.execute`, so
  a wrapper at the executor catches them where the tool-loop callback does
  not.
- **It is not a new store.** The log is run-scoped memory, shared by
  reference across forks. `src/core/stores.ts` remains the one product
  store; the viz trace remains the durable record. Cross-run proof reuse is
  therefore **out of scope by construction**, which matches the inventory's
  note that run accounting has no proof-reuse signal.

**One seam, two consumers, two failure policies.** The wrapper feeds the
attestation log (correctness: a write failure degrades the observation to
unattested, and never fails the tool call — a disk fault must not kill a run,
and must not silently look like proof either) and, separately, the viz trace
(observability: fail-open, swallowed, unchanged). They cannot disagree about
what happened, because they observe the same call at the same point; only
what their own failure means differs.

**Observability dividend, worth naming because it is free.** `VizToolEvent`
is emitted only from the `onToolInvocation` observer on an LLM request
([`recordingLlm.ts`](../src/viz/recordingLlm.ts)). Supervisor probes bypass
it, so today **no supervisor action appears in the trace at all** — not the
file read-back, not the manifest read, not the clean-load `validate_html`.
Their only trace is the prose the supervisor pasted into its own prompt, and
the GPU client does not render `userContent`. The same wrapper closes that
blind spot as a side effect. This is a reason the seam is right, not a reason
to promote the trace to a gate (§8).

### 3.3 Witnesses gain an observer

`Witness` today has one variant, `recorded-probe`, built by
`witnessesFromPayload()` from `output.probes` — model-authored, and in
practice shell-only, since the extractor requires a `cmd`. The contract makes
`Witness` a discriminated union on **who observed it**:

- `transport-observed` — carries the attestation event id; produced only by
  the wrapper;
- `model-declared` — today's shape, unchanged in content and honestly
  labelled.

`record_probe` and `fetch_url` already write their manifest entries
themselves and map to the first variant; the web manifest, written by the
model after `validate_html` returns, maps to the second until its writer
moves into the tool. Nothing is retro-labelled (inventory fact 9: one trust
label over three different ownerships would be false).

### 3.4 One obligation, declared in the plan

An obligation is declared by the planner in the subtask, beside the `outputs`
field the planning prompts already demand on file-mutating subtasks. No new
LLM call: the plan call is already paid for, and the plan schema is already
where a phase states what it will produce.

This is deliberate, and it is the rule the cooling-off clause exists to
enforce. A mechanical detector over the task description — "the word *click*
implies a DOM obligation" — is precisely the vocabulary-frozen detector the
2026-08-14 review measured as a primary source of drift. Obligations are
**declared**, not sniffed.

The vocabulary is **closed, with exactly one member**:

- `dom-interaction` — covered only by an attestation whose **executed**
  interaction log is non-empty, on an artifact digest that still matches.

Revision 1 offered this as a defensible first cut while calling general
coverage the largest open question. Revision 2 makes it the definition. The
reason is that no wider version survived review: coverage is a semantic match
between a claim and an observation, and every generalisation of it is either
brittle (a mechanical vocabulary) or another paid, spoofable model call. One
member is mechanical, unambiguous, and refuses to generalise before it is
measured. A second member is a new review with its own evidence.

No obligation declared → today's behaviour, unchanged. That containment is
what keeps the contract from freezing skill learning system-wide.

### 3.5 Coverage decides consequences, not approval

At verdict time the supervisor holds, for the phase's branch, the set of
attestations and the declared obligation. Dispositions, stated once:

| Coverage | Verdict | Trust success | Skill credit | Distillation / promotion |
|---|---|---|---|---|
| covered | unchanged | yes | yes | yes |
| uncovered | forced review, never auto-reject | withheld | withheld | withheld |
| no obligation declared | unchanged | unchanged | unchanged | unchanged |

The verdict shape gains an optional list of attestation ids the approval
rests on — absent for work with no obligations.

**A withheld consequence must be visible, and mostly already is.** The skill
side has its surface: `VizSkillEvent` carries the op `credit-withheld`,
introduced for exactly this failure mode — its own comment says the only
other trace is "a counter that did not move, which reads identically to
*nothing happened*". A1's withholding reuses that op rather than inventing a
second one. The **trust** side has no equivalent, so the contract adds one:
a `RunStatSignal` member and its counter in
[`runStats.ts`](../src/contracts/runStats.ts), beside `escalations`,
`promotions` and `deterministicPhases`, counting uncovered obligations per
run. That is also the accounting signal the inventory noted was missing, and
it is what makes a withheld run distinguishable from a quiet one in the CSV.

## 4. What this contract deliberately does not do

- It does not let the supervisor **author** interactions. Inventing clicks to
  test a deliverable is the rejected shortcut: it false-positive-fails
  working artifacts, and the read-only verification invariant exists for it.
- It does not **replay** attested interactions either. Replaying a
  machine-observed selector set against a matching digest is defensible and
  is the obvious second increment, but it is a new supervisor execution path
  and belongs in its own review.
- It does not promote the viz trace to a correctness boundary. The trace stays
  fail-open observability (§3.2).
- It does not widen the on-disk manifest checker, whose discriminator a
  compiled script dispatches on.
- It does not touch the negative paths. Rejection, escalation and script
  demotion keep their current semantics.

## 5. Adversarial review against the nine boundaries

1. **Requested vs executed are different facts, already observable.** Passes,
   and cheaply: the contract adds retention, not probe cost. No extra tool
   call, no extra model call. *Residual:* the two fields must survive the
   worker and container protocols, which today forward `unknown`. That is
   real work in [`src/tools`](../src/tools/AGENTS.md), not a formality.
2. **A model-authored manifest is replay intent, not proof.** Passes only
   because §3.3 refuses to relabel it. *Residual:* until the web manifest's
   writer moves into `validate_html`, the strongest **on-disk** web record
   stays model-authored. Moving that writer is necessary — and, examined
   honestly, **not sufficient**: an empty executed-interaction list on disk
   is not malformed, so nothing today would read it as a failure. Evidence
   preservation and evidence consequence are two changes, and only the
   second closes the incident.
3. **The strongest web observation is trace-owned and fail-open.** Passes:
   the executor wrapper, not the recorder, is the seam, and it catches the
   supervisor's own probes. Revision 1 left "two observers could disagree
   silently" open; §3.2 resolves it — one observation point, two consumers,
   and only their failure policies differ.
4. **No witness binds an observation to an artifact revision.** Addressed by
   `artifactDigest` plus staleness, now with a **stated scope** rather than
   an open question: the digest covers the **single declared artifact file**
   the observation names — the same `file` the web manifest entry already
   carries — and nothing else. Import trees, assets and generated bundles are
   explicitly **not** covered, so a deliverable whose behaviour depends on a
   sibling module can go stale without the digest noticing. That is a known
   under-detection, chosen over the alternative: a digest over a guessed file
   set produces **false** staleness, which withholds credit silently, and
   silence is the failure mode this whole contract exists to remove. Widening
   the scope requires the served file set to become a declared output first.
5. **Evidence is neither phase-addressed nor claim-mapped.** Passes, and
   dodges a trap: because attestations live in the run-scoped log rather than
   in `Result`, N>1 aggregation dropping `toolCallResults` and flattening
   `evidence` no longer loses them. The `Result` carries references only.
6. **Clean-load ground truth is conservative and cannot be reinterpreted.**
   Passes by refusing to reinterpret it (§4). The clean-load probe keeps its
   current meaning and its current cost.
7. **Approval inherits trust, credit, learning, promotion.** This is the
   contract's whole point and its largest blast radius.
   `activeSkillFollowed: undefined` deliberately keeps credit enabled today;
   obligation-scoped withholding changes that default only where a plan
   declared an obligation. Revision 1 called the visibility of a withheld
   consequence unresolved; §3.5 resolves it — `credit-withheld` for the skill
   side, a new run-stat counter for the trust side.
8. **Run-scoped state must cross real fork construction.** The contract is
   built on the fork wrapper, so this is not an afterthought — but
   `forkBranch` carries a documented field-enumeration hazard: it once
   dropped `requireObservedToolAction`, whose tests never forked, and the
   fabricated-work gate was inert on every production run while green in CI.
   Any A1 implementation needs fork-propagation coverage through **nested**
   forks before it is believed, and its tests must fork.
9. **Shell, HTTP and web manifests have different ownership.** Passes: the
   observer is per-record, and the existing machine writers are recognised
   rather than re-implemented. Manifest merge semantics stay in
   [`probeManifest.ts`](../src/contracts/probeManifest.ts).

## 6. What still stands after revision 2

- **The obligation is only as good as the planner.** A planner that declares
  no obligation on a task whose whole point is DOM behaviour restores
  today's silence, and the counter task's phase description *did* name
  clicking. Declared obligations move the failure from a detector's
  vocabulary to a planner's diligence. That is a better failure — visible in
  the plan, reviewable, and cheap to audit after the fact — but it is not a
  proof, and no version of this contract makes it one. This is the one
  attack revision 2 does not answer.
- **Blast radius.** Tools, contracts, core context, atoms, skills and
  accounting all change together. The inventory said so; the review confirms
  it and has no smaller coherent version. A partial landing that ships the
  observation without the consequence preserves evidence and changes no
  outcome; one that ships the consequence without fork coverage repeats a
  measured inert-gate incident.

## 7. Acceptance controls

The contract is a behavioural claim, so it needs a pre-registered test, per
the benchmark discipline in the root [`AGENTS.md`](../AGENTS.md): both arms
on the same day and the same code path, thresholds recorded with the results.

Two task shapes from the cold session are the controls, and they are already
known to separate — that is the whole content of the evidence record. Their
original traces were archived out of the tree with the store and skills, so
these are **new armed runs**, not a replay:

- **negative control (`web-counter` shape)** — a task whose verification
  names real button clicks, on an artifact whose smoke drives its own state
  through `window.__*` hooks. Pre-registered expectation: the deliverable is
  still **approved** (it works), the `dom-interaction` obligation is
  **uncovered**, no skill is distilled, no atom trust success is recorded,
  and the run stats carry one uncovered obligation.
- **positive control (`web-stopwatch` shape)** — same family, with Puppeteer
  clicks that actually execute. Pre-registered expectation: approved,
  covered, distillation and credit proceed exactly as today, and the run
  stats carry zero uncovered obligations.

A run that approves the negative control **and** distils a skill from it is
the contract failing, not the model misbehaving. A positive control that
stops earning credit is the false-staleness failure of §5.4 and is a stop
condition for the increment.

Both controls must run under the burn-in rules: the machine to itself, no
fan-out competing for the same subscription quota, traces and starting store
archived before the batch.

## 8. Alternatives considered and rejected here

- **Make the viz trace the correctness boundary.** Cheapest by far — the
  untruncated result already lands there. Rejected: recording failures are
  swallowed by design, and a fail-open observability path becoming a gate is
  a silent-approval mechanism, not a proof one. §3.2 keeps the trace and the
  attestation on one seam precisely so this stays unnecessary.
- **Have the supervisor drive its own interactions.** Rejected in §4:
  supervisor-authored interactions are the measured false-rejection shortcut.
- **Fail `validate_html` when the interaction filter strips a requested
  list.** Tempting and small. Rejected: it makes a tool-level judgment about
  a task-level question, and it would fail runs whose smoke legitimately
  drives its own state with no user-input claim at all.
- **A mechanical claim detector over the task description.** Rejected in
  §3.4 — the vocabulary-frozen detector class, measured.
- **A general obligation vocabulary.** Rejected in §3.4: nothing wider than
  one member survived review. Deferred, not refused.
- **A new SQLite store for attestations.** Rejected: `src/core/stores.ts` is
  the one product store, and nothing here needs cross-run persistence.

## 9. If this is accepted, the first increment

One reviewed commit, in this order, or none:

1. the typed browser observation in `src/contracts`, carried faithfully
   through the local, worker and container executors;
2. the per-branch tools wrapper in `forkBranch` and the shared append-only
   log, with fork-propagation tests that fork **and nest**;
3. the `Witness` observer union, with the existing machine writers mapped and
   nothing relabelled;
4. `dom-interaction` declared in the plan schema beside `outputs`;
5. the withholding disposition of §3.5, with `credit-withheld` reused for the
   skill side and the new run-stat counter for the trust side;
6. the two armed controls of §7, results recorded with their thresholds.

What must **not** be in it: supervisor-authored or replayed interactions, any
change to the interaction filter, any change to the negative paths, any
manifest-checker widening, a second obligation, and any obligation the plan
did not declare.
