# Supervisor-held proof attestation (A1) — design review, 2026-08-22

Status: **design review. One contract proposed, reviewed against the nine
boundaries in the evidence inventory. No code accepted, no code written.**

This review answers the reserved A1 direction recorded in
[`docs/incidents/supervisor-attestation-evidence-2026-08-22.md`](incidents/supervisor-attestation-evidence-2026-08-22.md),
after the cooling-off period the root [`AGENTS.md`](../AGENTS.md) requires.
The inventory's nine facts are the acceptance criteria for anything proposed
here; §5 works through them one at a time and states where the proposal
fails.

The one defect the inventory listed that was *not* a design question — the
web-probe discriminant taught in one vocabulary and read in another — was
closed separately in `3ee624d` and is out of scope below.

## 1. The proposal in one paragraph

Introduce **one** contract: a run-scoped, machine-written, append-only
**attestation log** of transport-observed tool observations, written at the
tool-executor seam (the only place that sees a raw tool result), addressed by
branch and tool event, and read by the supervisor at verdict time. A witness
gains an explicit **observer**: `transport-observed` (attestation-backed) or
`model-declared` (today's `output.probes`). A plan subtask may declare
**proof obligations** alongside its existing `outputs`. An obligation that no
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
- a content digest of the artifact source the observation was taken against.

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

Attestation-write failures degrade the observation to unattested. They never
fail the tool call: a disk or serialisation fault must not kill a run, and it
must not silently look like proof either.

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

### 3.4 Proof obligations live in the plan, not in a detector

An obligation is declared by the planner in the subtask, beside the `outputs`
field the planning prompts already demand on file-mutating subtasks. No new
LLM call: the plan call is already paid for, and the plan schema is already
the place where a phase states what it will produce.

This is deliberate, and it is the rule the cooling-off clause exists to
enforce. A mechanical detector over the task description — "the word *click*
implies a DOM obligation" — is precisely the vocabulary-frozen detector the
2026-08-14 review measured as a primary source of drift. Obligations are
**declared**, not sniffed.

No obligation declared → today's behaviour, unchanged. That containment is
what keeps the contract from freezing skill learning system-wide.

### 3.5 Coverage decides consequences, not approval

At verdict time the supervisor holds, for the phase's branch, the set of
attestations and the set of declared obligations. An obligation is **covered**
when a transport-observed attestation in that branch satisfies it and its
`artifactDigest` still matches the artifact on disk (inventory fact 4: a
later `write_file` or `edit_file` makes an earlier observation stale, and
today nothing relates the two).

Dispositions, stated once:

| Coverage | Verdict | Trust success | Skill credit | Distillation / promotion |
|---|---|---|---|---|
| covered | unchanged | yes | yes | yes |
| uncovered | forced review, never auto-reject | withheld | withheld | withheld |
| no obligation declared | unchanged | unchanged | unchanged | unchanged |

The verdict shape gains an optional list of attestation ids the approval
rests on — absent for work with no obligations.

## 4. What this contract deliberately does not do

- It does not let the supervisor **author** interactions. Inventing clicks to
  test a deliverable is the rejected shortcut: it false-positive-fails
  working artifacts, and the read-only verification invariant exists for it.
- It does not **replay** attested interactions either. Replaying a
  machine-observed selector set against a matching digest is defensible and
  is the obvious second increment, but it is a new supervisor execution path
  and belongs in its own review.
- It does not promote the viz trace to a correctness boundary. The trace stays
  fail-open observability.
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
   supervisor's own probes. *Residual:* two observers of the same tool call
   now exist (trace and attestation). They must not be allowed to disagree
   silently; the review has no answer yet for what a divergence means.
4. **No witness binds an observation to an artifact revision.** Addressed by
   `artifactDigest` plus staleness. *Residual, and the weakest point in the
   contract:* "the artifact the observation depended on" is decidable for a
   single-file web build and ill-defined for a served tree with imports.
   A digest over the wrong file set produces false staleness, which is a
   silent withholding of skill credit — cheap to miss, since nothing fails
   loudly. This needs a stated scope: single declared entry file first.
5. **Evidence is neither phase-addressed nor claim-mapped.** Passes, and
   dodges a trap: because attestations live in the run-scoped log rather than
   in `Result`, N>1 aggregation dropping `toolCallResults` and flattening
   `evidence` no longer loses them. The `Result` carries references only.
6. **Clean-load ground truth is conservative and cannot be reinterpreted.**
   Passes by refusing to reinterpret it (§4). The clean-load probe keeps its
   current meaning and its current cost.
7. **Approval inherits trust, credit, learning, promotion.** This is the
   contract's whole point, and its largest blast radius. `activeSkillFollowed:
   undefined` deliberately keeps credit enabled today; obligation-scoped
   withholding changes that default only where a plan declared an obligation.
   *Residual:* the withheld-credit path must be **attributable and visible**,
   or a skill that quietly stops earning credit is indistinguishable from one
   nobody matched. Run accounting has no attestation or invalidation signal
   today, so the contract is incomplete without one.
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

## 6. Attacks that survive

- **The obligation is only as good as the planner.** A planner that declares
  no obligation on a task whose whole point is DOM behaviour restores
  today's silence, and the counter task's phase description *did* name
  clicking. Declared obligations move the failure from a detector's
  vocabulary to a planner's diligence. That is a better failure — visible in
  the plan, reviewable — but it is not a proof.
- **Withheld credit is a silent outcome.** Every other mechanical
  disposition in this codebase surfaces as validator-visible text. A
  withheld consequence has no natural surface, and §5.7 has no design for
  one yet.
- **Coverage is a judgment wearing a mechanical costume.** "This attestation
  satisfies that obligation" is a semantic match. Made mechanical it is
  brittle; made model-authored it is another paid call and another thing to
  spoof. The review does not resolve this, and it is the single largest open
  question. A defensible first cut is a **closed obligation vocabulary** with
  exactly one member — `dom-interaction`, covered only by a non-empty
  executed interaction log on an unstale digest — which is mechanical,
  unambiguous, and refuses to generalise until measured.
- **Blast radius.** Tools, contracts, core context, atoms, skills and
  accounting all change together. The inventory said so; the review confirms
  it and does not have a smaller coherent version. A partial landing that
  ships the observation without the consequence preserves evidence and
  changes no outcome; one that ships the consequence without fork coverage
  repeats a measured inert-gate incident.

## 7. Alternatives considered and rejected here

- **Make the viz trace the correctness boundary.** Cheapest by far — the
  untruncated result already lands there. Rejected: recording failures are
  swallowed by design, and a fail-open observability path becoming a gate is
  a silent-approval mechanism, not a proof one.
- **Have the supervisor drive its own interactions.** Rejected in §4:
  supervisor-authored interactions are the measured false-rejection shortcut.
- **Fail `validate_html` when the interaction filter strips a requested
  list.** Tempting and small. Rejected: it makes a tool-level judgment about
  a task-level question, and it would fail runs whose smoke legitimately
  drives its own state with no user-input claim at all.
- **A mechanical claim detector over the task description.** Rejected in
  §3.4 — the vocabulary-frozen detector class, measured.
- **A new SQLite store for attestations.** Rejected: `src/core/stores.ts` is
  the one product store, and nothing here needs cross-run persistence.

## 8. If this is accepted, the first increment

One reviewed commit, in this order, or none:

1. the typed browser observation in `src/contracts`, carried faithfully
   through the local, worker and container executors;
2. the per-branch tools wrapper in `forkBranch` and the shared append-only
   log, with fork-propagation tests that fork **and nest**;
3. the `Witness` observer union, with the existing machine writers mapped and
   nothing relabelled;
4. the single-member obligation vocabulary (`dom-interaction`) declared in
   the plan schema beside `outputs`;
5. the withholding disposition of §3.5, plus the accounting signal §5.7 says
   it cannot ship without.

What must **not** be in it: supervisor-authored or replayed interactions, any
change to the interaction filter, any change to the negative paths, any
manifest-checker widening, and any obligation the plan did not declare.
