# Continuing a run that did not finish — design, 2026-09-24

Status: storeys 1 and 2 BUILT on 2026-09-24 — a refusal lands as `partial`
(`e0afcf9`), and the landing reasons ride the epilogue to the next run
(`923bbab`). Storey 3 remains a question, unbuilt. The body below is the design
as written before either commit. Written against four runs measured on
2026-09-23 and 2026-09-24, after root delivery acceptance was restored to
project runs ([progressive runs](incidents/progressive-runs-2026-09-21.md)).
It asks one question — what should happen when a run does not deliver — and
argues that the answer is not a bigger budget.

The operator raised it in these terms: *"ne faut-il pas augmenter le plafond
total de 30 min ? Des clients pourraient avoir des choses complexes à
produire… Ou alors stopper le run avant le timeout et relancer automatiquement
un autre run pour continuer le travail ?"*

## The four runs

Same project, same family, same pins. The first three ran with one pass; the
fourth ran with the in-run remediation landed that day.

| run | goal | passes | wall | cost USD | outcome |
|---|---|---:|---:|---:|---|
| `69f6f608` | flags, ~9 verifiable behaviours | 1 | 298 s | 0.0391 | refused by root acceptance |
| `671da856` | same, plus "verify every route" | 1 | 436 s | 0.0746 | refused, FEWER named gaps |
| `85ae2d4e` | bookmarks, 6 behaviours, in memory | 1 | 337 s | 0.0574 | **delivered and published** |
| `6ab0ae3b` | flags again, with remediation | 3 | 1803 s | 0.4195 | budget exhausted, nothing kept |

Two things are settled by this table and neither is a matter of opinion.

**The barrier is calibrated.** `85ae2d4e` passed it with the same machinery
that refused the other two. It is not a wall: it passes work that is honestly
verifiable in one pass and refuses work that is not.

**One pass does not cover nine behaviours.** 5 LLM calls for the first two
runs, 7 for the one that delivered. The refusals named exactly what had not
been probed, and `671da856` — the same goal, told to verify everything — came
back with a strictly shorter list of gaps. The molecule converges; it runs out
of room.

## What the fourth run proves, against its author's expectation

`6ab0ae3b` was launched to show that handing the refusal back would close the
loop. It did the opposite, and the numbers are the argument:

```
rootRemediations: 1   deepenings: 1   escalations: 2
32 calls · 0.4195 USD · 1802.9 s · failed · nothing published, nothing kept
```

Ten times the cost and six times the wall clock of `69f6f608`, for the same
delivered artefact: none. The trace shows why — the first pass took **ten
minutes** (two cycles, eleven probes, two `EADDRINUSE` recoveries), root
acceptance refused at t+10 min, the remediation pass opened with a different
molecule, a deepening followed, and the deadline arrived.

The in-run remediation is not wrong in principle. It was given **the wrong
threshold**: it reuses `outOfPhaseBudget`, which refuses to open work with
less than `MIN_PHASE_LANDING_MS` (60 seconds) left. A remediation is not a
phase; it is a full supervise loop, and this one needed ten minutes. The guard
let a second pass start with twenty minutes left — enough to begin it, not
enough to finish it and a deepening too.

## Why raising the ceiling is not the answer

`6ab0ae3b` did not run out of work to do. It ran for thirty minutes **without
converging**, and at two hours it would have run for two hours. The budget is
not what stopped it from delivering; it is what bounded the loss at 0.42 USD
instead of 1.70. The same conclusion was already reached on 2026-09-22 and
written down: *"a bigger budget only moves the cliff"*
([progressive runs](incidents/progressive-runs-2026-09-21.md)).

The real defect of `6ab0ae3b` is not that it had too little time. It is that
**it left nothing behind**. `flags.mjs` was written, the server started,
eleven routes probed, two port collisions recovered — and all of it is
unreachable, because a `failed` run seeds nothing. The next run in that
project will start from `85ae2d4e`'s bookmarks workspace as if the thirty
minutes had not happened.

A ceiling is the right tool against a loop that does not converge. It is the
wrong tool against work that needs more than one run. Those are different
problems and they want different mechanisms.

## What already exists, verified

Half of "stop and continue" shipped on 2026-09-22 and is load-bearing today:

- A run that reaches its budget with phases already accepted LANDS on them:
  `dispatchWithAggregation` returns `{results, unfinished}`, `markLanded`
  stamps the aggregate, and the outcome is `partial`
  ([src/atoms/dispatch.ts](../src/atoms/dispatch.ts), [src/run](../src/run/AGENTS.md)).
- `partial` is a terminal project-run status that **never publishes**
  (`if (this.publisher && !landed)`, `src/projects/coordinator.ts`). The
  customer's repository is the one surface where an incomplete artefact set
  would stop being distinguishable from a finished one.
- **A landed workspace seeds the next run.** `previousSeedRun` accepts
  `delivered` and `partial`, most recent first, and its own comment states the
  point: without it "the partial status would be a nicer label on the same
  loss".

Two facts about `failed` complete the picture, and both were checked in the
code rather than assumed:

- **The bytes are still there.** A run's workspace lives at its own
  `hostPaths.workspacePath` and is removed only by age retention
  (`src/projects/retention.ts`), not by failure. `previousSeedRun` skips it on
  the STATUS FILTER at its first line, not for want of a directory.
- **Nothing records why it stopped, in a form the next run can use.** The root
  refusal — which names each unverified behaviour — reaches the run row as an
  error string and goes no further.

## What a landed result actually meets at the root — measured 2026-09-24

Root acceptance reached project runs on 2026-09-23; landing shipped on
2026-09-22 and had never been exercised under depth routing, because depth
routing was not running on the path that lands. Two characterisation tests now
put them together (`tests/depth-routing.test.ts`), and they correct a
suspicion this document's author held an hour earlier:

- **`partial` is NOT mechanically unreachable.** A landed result carries
  `unfinishedPhases` through root acceptance intact when the verdict approves.
  The typed field survives, so every reader downstream still calls the run
  `partial` rather than a delivery. The worry that restoring root acceptance
  had silently killed landing is WRONG as stated.
- **But a landing is now decided by a judgement, where it used to be decided by
  nothing.** A landed run stopped before it could prove the delivery floor, so
  `floorCoverage` is `uncovered`, `review` is true, and the outcome is a
  `validation-call` — every time. That is a landed run's ordinary shape, not an
  edge case.
- **And the validator is not told what a landing is.** Everything it learns
  about one comes from the executor's own summary, which begins `INCOMPLETE —`.
  Run the same acceptance over an ordinary result and the words `landed`,
  `unfinishedPhases` and `deadline landed` appear nowhere: the host never names
  the concept.
- **The one thing it IS told about incompleteness points at rejection.** The
  verdict prompt carries `a visually-incomplete artefact is a failed
  deliverable, not a passing one`. The sentence is scoped to visual artefacts
  and does not decide a landed run by itself, but it is the only statement the
  host makes on the subject, and it is a refusal.

So the risk is not that landing is broken. It is that **a landed run's fate now
rests on a validator that has been given one hint, and the hint says no** —
and when it says no, `RootAcceptanceError` becomes `failed`, and the phases
that genuinely completed seed nothing. The second test pins exactly that.

This adds a requirement to storey 1 that was not visible before: whatever makes
a refusal land must also TELL the acceptor what a landing is. Otherwise the
storey fixes the refused run and leaves the landed one to a coin toss.

## The proposal, in three storeys

Each storey is useful without the one above it, and each is separately
refusable.

### 1. A root refusal LANDS instead of failing

A run whose delivery is refused finishes `partial`, keeps its workspace, and
carries the acceptor's reasons as run state rather than as an error string.

It publishes nothing — that is already true of every `partial` — so this
cannot ship unverified work to a customer. What it changes is that the work
survives and is visible: the client sees a run that got this far, and this is
what is still unproven.

Cost: small. The bytes are already on disk and `previousSeedRun` already
accepts `partial`. What must change is where the refusal is turned into an
outcome — today `RootAcceptanceError` is thrown out of `runDepthTask` and the
runner's catch path records `failed`.

Open question this storey must answer: a refused run has NO accepted phase, so
`Result.unfinishedPhases` — the typed field that separates a landing from a
delivery — is empty. Either a refusal becomes a second, named reason for
`partial`, or the contract that "a dispatch that completed no phase never
lands" has to be restated. This is the one piece of the design that is not
obvious, and it should not be hand-waved: the 2026-09-22 rule exists precisely
so that a landing cannot report zero phases and look like a delivery.

### 2. The NEXT run is the remediation

A project run already starts from the previous workspace. Give it the previous
refusal too, and the second run is the second pass — with its own full budget.

This is the same mechanism as the in-run remediation landed on 2026-09-23
(`rootAcceptanceRefusal` in the task's `inputs`), moved one level out. The
difference is decisive: an in-run remediation competes with the budget of the
run it is inside, which is exactly how `6ab0ae3b` died. A between-run
remediation is carried by the next run's budget, and the ceiling goes back to
meaning what it should — the bound of ONE run, not the bound of a piece of
work.

### 3. Chaining runs automatically — NOT proposed here

The third storey is to relaunch without the customer asking. It is deliberately
left as a question, because it spends a customer's quota with nobody at the
keyboard, and the difference between "three runs of honest progress" and
"three runs of the same failure" is exactly what none of the four runs above
can yet predict. If it is built, it needs a bound in runs AND in cumulative
cost per goal, and explicit consent — not a default.

Storeys 1 and 2 already give the customer the behaviour they want: relaunch,
and it continues. That is worth measuring before anything relaunches itself.

## What this says about the 2026-09-23 remediation

It was built at the wrong granularity, by its own author, and `6ab0ae3b` is
the measurement that says so. It is not necessarily to be removed: when the
remaining wall clock comfortably exceeds the pass already spent, remediating in
place saves a round trip. But its threshold must be **the duration of the pass
already taken**, not sixty seconds — and once storeys 1 and 2 exist, it is an
optimisation, not the mechanism.

That correction is one line of policy. It is deliberately not made in this
document, and not on the day of the incident
([cooling-off](../AGENTS.md#safe-working-rules)).

## Open questions, for the operator

1. **SETTLED, 2026-09-24: the production ceiling is 30 minutes, by host
   configuration.** `/home/atoma/config/atoma.env` carries
   `ATOMA_PROJECT_TIMEOUT_MS=1800000`, and that is exactly the name
   `projectRunTimeoutMs` reads (`PROJECT_RUN_TIMEOUT_ENV`), so it overrides the
   sixty-minute `DEFAULT_PROJECT_RUN_TIMEOUT_MS`. **The 30 → 60 raise recorded
   on 2026-09-22 has never taken effect in production**, which is why
   `6ab0ae3b` died at 1802.9 s.

   The recommendation of this document is to LEAVE IT AT THIRTY. Everything
   above argues that the ceiling is not the lever: `6ab0ae3b` did not run out
   of work, it failed to converge, and a higher ceiling would only have bought
   a larger loss. A ceiling's job here is to bound what an unconverged run can
   spend; the storeys below are what let a long piece of work finish. Raising
   it is a decision that should follow a measurement showing runs that
   CONVERGE and are cut off — and none of the four runs is that.
2. **Storey 3**: in scope, or is "the client relaunches and it continues"
   enough for this iteration?
3. **Storey 1's typed shape**: is a refusal a new reason for `partial`, or does
   `partial` stay reserved for a deadline landing and a refusal get its own
   terminal status? The first is smaller; the second keeps "landed on budget"
   meaning one thing.

## Not addressed here

- The `build` profile's hard-coded proof floor (`dom-interaction` on
  `index.html`) does not follow the deliverable's nature, so an HTTP service is
  measured against a page it never had to produce. It is conformant — see
  `src/atoms/AGENTS.md` — and making the floor follow the goal would mean
  sniffing the goal. It is a separate `mechanism_candidate`.
- `EADDRINUSE` on a re-launched server appeared in three of the four runs. A
  server left listening across cycles is its own defect and does not belong to
  this design.
- The tool-argument refusal (`argumentsJson must encode a JSON object`)
  appeared in four runs across two days. Also separate, also real.
