# Round 12 — H12 refuted on a task built to be able to fail it, and the failure has a mechanism

Run 2026-08-16, the new `tabstat` maintenance family, `PROMOTE=1` / `TRUST=3`.
Control arm = one `claude-haiku-4-5-20251001` agent, identical to round 10, so
**the two rounds differ only in task difficulty**.
[Registered before the run](PROTOCOL.md#round-12--pre-registration-2026-08-16-written-before-any-round-12-run).

## Verdict: H12 refuted

| | control (Haiku direct) | atoma |
|---|---|---|
| deliverables at full marks | **6 of 6 (100%)** | **5 of 7 (71%)** |
| mean cost | **$0.2495** | $0.4881 (warm $0.4700) |
| mean wall clock | **176 s** | 450 s |
| LLM calls per run | 1 | 13-23 |

H12 said atoma's full-mark rate would be *strictly greater* than the control's.
It is lower, so **H12 is refuted**, and the registration named what that means:
a second refutation on a harder task would mean the correctness case for
supervision is not merely unmeasured but **absent at this scale of work**.

The task did get harder for both arms — the control's mean cost rose 2.4×
($0.1032 → $0.2495) and atoma's 1.9× ($0.2628 → $0.4881) against round 10. It
also did what it was built to do: it produced failures. They were just all on
the treatment arm.

## The two failures, inspected before being recorded

The standing rule since 2026-08-10 is that a failing check is read against the
artefact first. That mattered here, because one of the two failures came from
the prose clause I had flagged in advance as the delicate one. Both survive
inspection.

**atoma run 3 (`build.prev232`) — 13/14.** Code correct, manifest correct and
replaying, README prose correctly rewritten — and **all seven recorded
invocation blocks in the README still showing `mean 13.00` and `min 0`**. The
same workspace documents 16.25 in its machine record and 13.00 in its human one.

**atoma run 4 (`build.prev233`) — 13/14.** The mirror image: every recorded
block updated to 16.25, and the prose paragraph left **verbatim from the seed** —
"`sum`, `mean`, `min` and `max` read every row, an empty cell counting as zero"
— now flatly contradicting the code above it. Not a false positive: the check
looks for the seed's own sentence, and this is that sentence, unedited.

**Between them, atoma updated each half of the README and never both.** The code
was right in 6 of 6 atoma runs and every manifest replayed in 6 of 6. Only the
human-readable record failed, and it failed in two complementary ways.

## The mechanism, from run 3's trace

This is the round's most valuable output, and the first thing in rounds 9-12
that is about SUPERVISION rather than about which model you picked.

Run 3 decomposed into three sequential phases — implement, re-verify the
manifest, update the README — with this reasoning: *"all three phases mutate the
same workspace … each step depends on the previous state"*. Correct so far. Then:

- **Phase 2** re-recorded every probe *after* the edit and compared the new
  recordings against themselves, concluding: **"Zero changed entries; all 26
  invocations remain unchanged."**
- **Phase 3**'s subtask was *"edit ONLY the documented invocations whose output
  legitimately changed **per the previous phase's change list**"* — a list that
  was now empty — and it reported doing exactly that: *"targeted prose edits …
  without restructuring the file or modifying any command/output blocks."*

Phase 3 was **correct with respect to its input and wrong with respect to the
world**. The determination of "what legitimately changed" was made *after* the
change, against a record the same phase had just rewritten, so it could only
ever return nothing. Every validator in the chain saw a phase that did what its
subtask said.

The single-agent control never has this failure available to it: it holds the
edit, the re-verification and the documentation in one context and rewrites the
file once.

**Stated as what it is:** one trace, one run. Run 4 is a different failure of
the same file rather than a second instance of this chain. But it is a concrete,
addressable defect — the change list must be computed *before* the edit, or
against a preserved pre-edit record — and it is the kind of finding this
benchmark was supposed to produce and had not until now.

## What the harder task did and did not change

**It discriminated.** Round 10's task could not: every deliverable of every arm
scored full marks. This one separated the arms by two deliverables and produced
a diagnosable mechanism. The instrument was validated in four directions before
the round (untouched seed 6/14, reference fix 14/14, stale manifest 13/14,
over-updated `count` 8/14), so its ability to fail was established before it was
used.

**It did not reverse the direction.** The prediction underneath the architecture
— cheap model unsupervised gets it wrong, supervision catches it — is now
refuted twice, on an easy task and on a harder one, in the same direction. The
control arm has produced **12 correct deliverables out of 12** across rounds 10
and 12 on this family of work.

**Nobody over-updated.** The registered secondary question was which direction
each arm fails in. `count` was never "fixed", no manifest went stale, and the
`units-unchanged-stats-preserved` check never fired. The trap built for
over-eager editing caught nothing; both real defects were under-updates of the
README.

## Economics and the rest, reported

atoma is **1.96× the control's cost** and 2.6× its wall clock (with the usual
`claude-cli` per-call spawn bias against the arm making 13-23 calls). There is
no N at which this breaks even: the control is cheaper than atoma's warm mean.

**Held-out task: 9/9, $0.3529 — but two new recipes learned.** Rounds 5-11 all
reported a held-out run needing *zero* new recipes; this is the first that did
not. Generalisation still delivered a correct artefact, but on this harder
family the learned recipes did not transfer for free, and that is a weaker
result than the eight rounds before it.

`det = 0` on all seven atoma runs, with one promotion on run 2 that never
dispatched — the **seventh consecutive round** in which the compiled zero-token
path contributed nothing.

## Threats to validity, including one about this scorer

- **The manifest replay is bounded at the first 16 entries** for runtime, and
  atoma runs added between 2 and 15 probes of their own (run 3 reached 26). A
  stale entry past position 16 would have been invisible. **Checked
  explicitly after the round with an unbounded replay across all thirteen
  workspaces: no stale entry hides beyond the bound**, so no score here depends
  on it. The bound remains a known limitation of the instrument.
- One task family still, and one difficulty step. "Harder" here means three
  files, eleven invocations, three clauses and a selective-update requirement —
  not a different kind of work.
- Six control runs, unanimous; seven atoma runs, two failures. The correctness
  gap rests on those two.
- The causal chain in run 3 is read from one trace. It is offered as a
  diagnosis, not as a measured frequency.

---

## Driver output, verbatim

```
== PRE-REGISTERED RESULT ==

provider : claude-cli
control  : one claude-haiku-4-5-20251001 agent, plain tool loop, self-certifying
treatment: atoma, L1=claude-haiku-4-5-20251001 L2=claude-sonnet-5 L3=claude-opus-5

baseline (frontier direct) n=6: mean $0.2495, median $0.2581
  runs: 0.319, 0.261, 0.184, 0.261, 0.216, 0.255
atoma n=6: mean $0.4881, mean excluding run 1 $0.4700
  runs: 0.579, 0.469, 0.690, 0.396, 0.370, 0.426

H1 NOT SUPPORTED within the runs performed: cumulative atoma cost never fell below the baseline.
cumulative delta after 6 runs: $-1.4317 (positive = atoma cheaper in total)
trend across the atoma series: first half $0.5791 → second half $0.3971

-- held-out task (novel, same family): memorisation control --
  baseline n=0: mean —
  atoma    n=1: mean $0.3529
```

Cost was reported and not registered for this round; H12 was decided by the
scorer. Per-check output: [`results-round12-scores.json`](results-round12-scores.json).
