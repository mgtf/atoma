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
runs at 43 LLM calls. The validators were rejecting results as *"non-JSON prose
lacking line numbers, old/new text, or probe results **despite explicit skill
steps requiring them**"*, which triggered three atom branches
(Methane → Ammonia, CarbonDioxide → Sucrose, Sucrose → Ethanol).

So a recipe distilled in run 1 demanded a structured format the L1 then failed
to produce, and the validator enforced it. **A badly-distilled recipe can cost
more than the compiled path saves** — a mechanism this series had not shown
before, and one that has nothing to do with the filter (which never ran).

What this means for the numbers: **round 7's economics are not interpretable.**
A factor able to double the cost of a round, unrelated to the change under
test, makes the cost column noise. The correctness column is still readable,
and it is the round's one clean result.

## What is actually established

**6 of 6 deliverables correct** — the best of the maintenance rounds, and
confirmation that the deliverable gate does its job. Correctness has now gone
2 of 9 → 5 of 6 → 6 of 6 across rounds 5-7 while dispatch volume went
10 → 1 → 1. The trade is real and it is currently priced badly.

## Next, in order

1. **Fix the predicate**: named-path comparison instead of any-write detection.
2. **Understand the escalation cascade** before measuring anything else. A
   distilled recipe that sets a format the L1 cannot meet is a self-inflicted
   cost, and until it is understood every future round's cost column is
   suspect.
3. Only then re-run. Two rounds have now been spent on a mechanism worth about
   $0.10 per run; the escalation cascade cost $0.30 per run in a single round.

## Threats to validity

- Six atoma runs, one task, one compiled recipe.
- The escalation cascade is unattributed. It could be model variance of a size
  not previously seen, or a property of what run 1 happened to distil.
- The correctness scorer is bespoke to this task.
