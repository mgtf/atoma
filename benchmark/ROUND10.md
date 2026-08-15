# Round 10 — H10 refuted: a single Haiku agent is 2.5× cheaper than atoma AND scored higher

Run 2026-08-15, maintenance task, `PROMOTE=1` / `TRUST=3`, same task text, same
seed, same treatment-arm scale as rounds 6-9.
[Registered before the run](PROTOCOL.md#round-10--pre-registration-2026-08-15-written-after-round-9-and-before-any-round-10-run).

The control arm is **one `claude-haiku-4-5-20251001` agent** — the very model
atoma runs at L1. The registration said so explicitly: on price atoma cannot
win against the model it runs underneath its own supervisor, so cost was not
the hypothesis. **H10 was a correctness hypothesis**, and it is the one that
failed.

## Verdict: H10 refuted

| | control (Haiku direct) | atoma |
|---|---|---|
| deliverables at full marks | **6 of 6 (100%)** | **6 of 7 (85.7%)** |
| mean cost | **$0.1032** | $0.2628 |
| median cost | $0.1066 | — |
| warm mean (runs 2-6) | — | $0.2403 |
| mean wall clock | **78 s** | 196 s |
| LLM calls per run | 1 | 9-23 |

The registered refutation condition was `fullMarkRate(control) ≥
fullMarkRate(atoma)`. It is met, and with it the meaning registered in advance:

> **on this task, at this difficulty, atoma's supervision buys nothing that a
> $1/$5 model does not already deliver on its own, and its cost is pure
> overhead.**

That is the most damaging result this protocol has produced, and it is
published here with the prominence a confirmation would have received.

## The single failing deliverable, inspected before being recorded

The standing rule since 2026-08-10 is that a failing check is inspected before
the failure is entered, because an instrument that penalises correct work is
measuring itself. Round 9's inspection favoured nobody; this one had the
opportunity to exonerate atoma and did not.

atoma run 4 (`build.prev217`) scored **9/10**, failing `manifest-matches-live`
on two entries it had added itself:

```json
{ "cmd": "node wclite.js --chars test_with_newlines.txt", "exitCode": 0, "stdout": "11\n" }
{ "cmd": "node wclite.js test_with_newlines.txt",         "exitCode": 0, "stdout": "lines 2\nwords 2\nchars 11\n" }
```

`test_with_newlines.txt` is a fixture the run created to demonstrate the new
behaviour, recorded probes against, and then **deleted**. Replayed today:

```
$ node wclite.js --chars test_with_newlines.txt
wclite: cannot read file: test_with_newlines.txt
exit 2                       # the manifest records exit 0, stdout "11"
```

This is a genuine defect, not an instrument artefact. In this repository the
probe manifest is the AUTHORITY that compiled verification consults, and two
entries that can never replay are exactly the manifest analogue of the stale
README that produced round 5's 2-of-9. Any future re-verification of this
workspace fails on them.

**The uncomfortable shape of it: atoma was penalised for doing more.** The
control arm's six deliverables are byte-identical in structure — the five
seeded entries plus one `--chars sample.txt` probe, no temporary fixtures, all
replaying. atoma's seven vary between 5 and 10 entries; the run that recorded
the most evidence is the run that broke the artefact by cleaning up after
itself. Doing more is not a defence: the instruction was to update the manifest
*only for what legitimately changed*, and an entry pointing at a deleted file
is not a legitimate change.

Full per-check output: [`results-round10-scores.json`](results-round10-scores.json).

## The secondary observation, which found nothing to observe

Registered: whether the control arm's failures are *silent* — self-certified as
complete while the scorer finds them broken. That is the specific defect
supervision exists to prevent, and it is what rounds 1-8 implicitly assumed a
cheap unsupervised agent would produce.

**The control arm had no failures at all.** Six for six, first try, at $0.103
and 78 seconds a run. There was nothing silent to catch.

## What this round actually establishes, and what it does not

**It establishes** that on a well-specified, small, single-file maintenance
edit with a seeded manifest and README, a modern cheap model does the whole job
correctly and unsupervised, six times out of six. Any architecture whose value
proposition is "the cheap model needs supervision to be correct" has to answer
this measurement on this task.

**It does not establish** that supervision never pays — it establishes that
this task cannot tell. That distinction has to be handled carefully, because
"the task was too easy" is exactly the kind of explanation that gets invented
after an unwelcome result. So, stated precisely:

- It was **not** foreseen in the registration. The registration named the
  refutation and its meaning, but expected the cheap arm to fail some of the
  time. It did not fail once.
- The honest response is a HARDER task family, **registered in advance with a
  falsification condition**, and re-run on both arms — not a reinterpretation
  of round 10. Until such a round exists, this repository's evidence is that
  supervision's correctness benefit on maintenance work is **unmeasured**, and
  the rounds that reported "cheap arm ships broken work" measured Opus-era
  assumptions, not this control.
- Round 5 is the counter-example worth remembering: seven of nine deliverables
  wrong, caught only by an executing scorer. That was ATOMA's arm, not a
  control's.

## Economics, reported as registered

atoma mean **$0.2628** against the control's **$0.1032** — atoma is **2.55×
more expensive**, cumulative delta **−$0.9575** after six runs. The trend
inside the atoma series is downward as usual ($0.3049 → $0.2207) and the warm
mean is $0.2403, still 2.3× the control. There is no N at which this breaks
even; the control is not merely cheaper, it is cheaper than atoma's own
asymptote, because atoma pays one Opus decomposition call per run that the
control never makes.

Held-out task: **$0.2502, zero new recipes learned** — generalisation
reproduced for the eighth consecutive round. The mechanism works; it is the
comparison that has changed.

`det = 0` on every run of this round as well, and one promotion on run 2 that
never dispatched — the **sixth consecutive round** in which compilation
contributed nothing.

## Threats to validity

- **One task, and this round's whole result turns on it.** See above; the fix
  is a harder registered family, not a reading of this one.
- Six control runs is the strongest control estimate this protocol has taken,
  and it is unanimous (6/6), so the correctness conclusion does not rest on a
  thin sample. The COST conclusion rests on six runs spanning 2.4×
  ($0.0597-$0.1420), which is the usual volatility.
- The scorer is the same 10-check instrument applied identically to both arms,
  and its mapping was computed from an anchor recorded before the round
  (`--first-archive 207`).
- Wall clock carries the usual `claude-cli` subprocess bias against the arm
  making more calls; it is reported, not registered.

---

## Driver output, verbatim

```
== PRE-REGISTERED RESULT ==

provider : claude-cli
control  : one claude-haiku-4-5-20251001 agent, plain tool loop, self-certifying
treatment: atoma, L1=claude-haiku-4-5-20251001 L2=claude-sonnet-5 L3=claude-opus-5

baseline (frontier direct) n=6: mean $0.1032, median $0.1066
  runs: 0.142, 0.060, 0.089, 0.073, 0.124, 0.131
atoma n=6: mean $0.2628, mean excluding run 1 $0.2403
  runs: 0.375, 0.315, 0.225, 0.264, 0.211, 0.187

H1 NOT SUPPORTED within the runs performed: cumulative atoma cost never fell below the baseline.
cumulative delta after 6 runs: $-0.9575 (positive = atoma cheaper in total)
trend across the atoma series: first half $0.3049 → second half $0.2207

-- held-out task (novel, same family): memorisation control --
  baseline n=0: mean —
  atoma    n=1: mean $0.2502
  If atoma is cheap here too, the learning generalised to the family.
  If it is back at baseline cost, it had memorised the primary task.
```

The `H1 NOT SUPPORTED` line is the driver computing the cost metric it always
computes; for round 10 that outcome was registered as expected and is not the
hypothesis. H10 was decided by the scorer.
