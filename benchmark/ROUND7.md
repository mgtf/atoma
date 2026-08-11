# Round 7 — the filter never fired, and a bad recipe cost more than the gate saved

Run 2026-08-11, maintenance task, `PROMOTE=1` / `TRUST=3`, same scale as
round 6 so the two compare directly.
[Registered before the run](PROTOCOL.md#round-7--pre-registration-2026-08-11-written-before-any-round-7-run).

## Verdict: H7 refuted on all three conditions

| | round 5 | round 6 | round 7 | H7 target |
|---|---|---|---|---|
| Zero-token dispatches | 10 | 1 | **1** | ≥ 5 |
| Gate fallbacks | 0 | 5 | **5** | 0–1 |
| Deliverables correct | 2 of 9 | 5 of 6 | **6 of 6** | ≥ 5 of 6 |
| Ratio vs same-day control | 4.69× | 2.05× | **1.00×** | — |
| Escalations | — | 0 | **13** | — |

Control arms were within 1% of each other ($0.5836 vs $0.5779), so the two
rounds really are comparable — which makes the result unambiguous.

## The fix was inert, for the reason registered before the run

**`scriptWritesFiles` fired zero times across the whole round.** The compiled
verifier contains `fs.writeFileSync(manifestPath, …)` — it merges its
observations back into the probe manifest — so the predicate classifies it as
a writer and never filters it out.

The pre-registration named this exact failure mode: *"volume could recover
while correctness drops, because `scriptWritesFiles` errs toward 'writes' and
a read-only script could still slip through."* Naming it in advance did not
make it acceptable: **I shipped a fix whose plausible flaw I had already
identified and had not closed.** Almost every compiled verifier writes its own
manifest, so the predicate is inert on the whole class it was built for.

**The right predicate is not "does this body write?" but "does it write the
file the subtask names?"** — comparing the paths named in the subtask against
the path literals in the script body. Statically decidable, and it leaves the
deliverable gate in place as the last resort.

## The result I cannot explain, and will not dress up

Cost rose to **$0.5854 per run — 1.00× the control**. For the first time in
seven rounds even H1 failed: cumulative atoma cost never dropped below the
baseline.

The proximate cause is 13 escalations against round 6's zero, including two
runs at 43 LLM calls.

> **Correction (offline trace analysis, 2026-08-11).** The paragraph that stood
> here blamed a badly-distilled recipe that "demanded a structured format the
> L1 then failed to produce". **That diagnosis is wrong**, and it was built the
> same way round 3's was: by reading one validator complaint and inferring a
> cause instead of checking whether the named mechanism ever ran. The recipe it
> accused — the event skill `recover-non-json-prose-missing-evidence`, whose
> body does demand line numbers and old/new text — was **learned in run 1 and
> never injected once** (0 matches across the round). It cannot have caused
> anything. The real cause is below.

### The real cause: already-satisfied work read as non-compliance

The cost is concentrated in **two of the six runs** — $1.0919 and $1.3776
against a $0.26 mean for the other four. Those two carry 10 of the round's
rejections, all three branches and both fallbacks. Their dominant rejection
motif, verbatim:

> *[3]* "Child claims line 20 'already correctly' excludes trailing newlines… No edit was applied"
> *[4]* "child claims no edit is needed because line 24 already excludes trailing newlines"
> *[5]* "Child claims 'no edit needed'… However, **the task presupposes an edit is required**"
> *[6]* "Child reports no edit was needed, contradicting the task's mandate"

**An earlier phase had already applied the edit.** A later phase, whose subtask
text still read *"apply ONE minimal edit to wclite.js"*, correctly found the
work done and said so — and the validator rejected the honest report four more
times because the subtask text mandates an edit. Under `sequential` aggregation
the workspace is shared, so this is structural: the subtask description is a
snapshot of intent written before any phase ran, and the validator reads it as
the contract.

The validator was **not** short of evidence. All 8 rejections carried a
ground-truth block, and the one behind rejection [4] quoted the file itself:

```
Line 24 of wclite.js:
const chars = text.replace(/\n+$/, '').length;
… All 6 documented invocations verified … --chars sample.txt → exit 0, 35
```

That is the edit, applied, with the correct post-edit output. It was rejected
anyway. One rejection also reasons that a shell probe running the file from
disk "may reflect a transient in-memory state" — not a judgment call but a
factual error about what `node wclite.js` does.

`VALIDATION_SYSTEM_PROMPT` has **no rule covering work that is already
satisfied** (no match for already-done / no-op / idempotent anywhere in
`verdict.ts`). Absent one, honest convergence is indistinguishable from evasion
and the task text wins.

### How rare, measured

Across **302 archived runs** in seven corpora — including the 121-run main
corpus with 58 rejections — this rejection class appears **5 times, all in
round 7, in 2 runs**. Rounds 4, 5 and 6 recorded zero rejections of any kind.
So it is not "maintenance always does this": it is plan variance, and it is
rare and expensive rather than common and cheap.

### What it does to the numbers

Excluding the two affected runs, round 7 reads **$0.2607 per run, 2.24× the
control** — reproducing round 6's 2.05× almost exactly, with the held-out
generalisation task at 1.90×. The cascade alone accounts for **$0.325 per run**,
which is the entire distance between 1.00× and 2.24×.

That is a stronger statement than "not interpretable": the round's economics
are interpretable once a *named, rare, unrelated* mechanism is accounted for.
It does not rehabilitate H7 — dispatches still stayed at 1 and the filter still
never fired — but the cost column is no longer noise.

## What is actually established

**6 of 6 deliverables correct** — the best of the maintenance rounds, and
confirmation that the deliverable gate does its job. Correctness has now gone
2 of 9 → 5 of 6 → 6 of 6 across rounds 5-7 while dispatch volume went
10 → 1 → 1. The trade is real and it is currently priced badly.

## Next, in order

1. **An already-satisfied verdict rule.** The validator must be able to approve
   a phase whose work is already done — but only when the child EXHIBITS the
   end state (quotes the line, shows the probe), never on assertion alone. That
   distinction is exactly what separated the two cases here, and the evidence
   needed to draw it already reaches the validator. Worth $0.325 per run on
   this family, in the one prompt that is constant and cached.
   The wording has to be tight: this same prompt is what catches fabricated
   deliverables, and "already done" is precisely what a lazy child would claim.
2. **Fix the predicate**: named-path comparison instead of any-write detection.
   Unchanged in substance, demoted in priority — it is worth about $0.10 per
   run against the cascade's $0.325.
3. Only then re-run.

Deliberately NOT proposed: a plan-side rule against assigning one mutation to
two phases. It treats a symptom of plan variance, the plan prompt is this
project's most-edited surface, and it does nothing when variance produces the
shape anyway. The verdict rule is the safety net regardless of plan quality.

## Threats to validity

- Six atoma runs, one task, one compiled recipe.
- The 2.24× figure comes from excluding two of six runs. That is legitimate
  only because the excluded mechanism was identified, is absent from 302 other
  runs, and is unrelated to the change under test — but n=4 is thin, and the
  exclusion was decided after seeing the data.
- The correctness scorer is bespoke to this task.
- Three hypotheses were refuted during this analysis before the fourth held
  (a fragile-evidence recipe, a self-referential trigger loop, a missing
  evidence block). The first two failed on "the mechanism never ran"; the third
  on reading `e.prompt` where the field is `e.userContent`. Each was checked
  against the traces rather than argued, which is the only reason the fourth is
  worth anything.
