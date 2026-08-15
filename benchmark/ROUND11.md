# Round 11 — Opus control calibration, and the three-model table on one day

Run 2026-08-15, **control arm only** (`atomaRuns: 0`), same task text and seed
as rounds 5-10, control arm back at the original `claude-opus-5` pin.
[Registered as the planned continuation](PROTOCOL.md#round-10--pre-registration-2026-08-15-written-after-round-9-and-before-any-round-10-run)
before round 10 ran.

**This round tests no hypothesis.** It exists so that the comparison rounds 9
and 10 opened up rests on a single day's data instead of quoting round 8's
Opus control across five days and eight commits — precisely the cross-round
arithmetic this protocol forbids elsewhere.

**The driver's `H1 NOT SUPPORTED` line in [`driver-round11.log`](driver-round11.log)
is VACUOUS**: `analyse()` received an empty treatment series, so there was no
cumulative cost to compare. It is not a result and must not be read as one.
That was stated in the registration before this round ran.

## Result

```
control (one claude-opus-5 agent) n=3: mean $0.5104, median $0.4136
  runs: 0.722, 0.414, 0.396      all 3 at 10/10, mean 80 s, 1 LLM call each
```

Round 8 measured this same arm at **$0.8197**. Today it is **$0.5104** — a
**1.61× swing** on the same task, same code path, same subscription, four days
apart. The protocol has recorded control-arm volatility since round 2 and the
README quotes 2.1×; this is another observation of it, and it is the reason
round 9 and 10 re-ran their treatment arms on the same day rather than reusing
round 8's.

## The table this exists for — all figures 2026-08-15, one code path

The atoma column pools the twelve primary-task runs of rounds 9 and 10 (two
independent series, each from an empty registry and empty skill store).

| control arm | n | mean | median | correct | mean ÷ atoma |
|---|---|---|---|---|---|
| **Opus direct** | 3 | $0.5104 | $0.4136 | 3/3 | **1.78×** |
| **Sonnet direct** | 3 | $0.3012 | $0.2219 | 3/3 | **1.05×** |
| **Haiku direct** | 6 | $0.1032 | $0.1066 | 6/6 | **0.36×** |
| atoma (pooled) | 12 | $0.2865 | $0.2625 | 13/14 | — |
| atoma, warm (excl. cold starts) | 10 | $0.2650 | — | — | — |

Against atoma's warm mean the ratios are 1.93× / 1.14× / 0.39×.

## What the table says

1. **atoma's published advantage is a function of the control model, and
   collapses across the range.** 1.78× against Opus, 1.05× against Sonnet —
   statistically indistinguishable from parity at these sample sizes — and a
   2.8× *loss* against Haiku. The README's `1.0–3.6× vs frontier direct` badge
   is true and is measured against Opus only; it now carries that qualification.

2. **Every control deliverable was correct, at every price point.** 12 of 12,
   across three models, first try, unsupervised. atoma was 13 of 14. The
   assumption underneath the whole architecture — that the cheap model needs
   supervision to be right — did not reproduce on this task in any arm.

3. **The one structural fact that survives intact** is the one the README's
   line-item table states: atoma pays the frontier model once per task rather
   than once per step. That is visible in every trace (exactly 1 Opus call per
   run against 8-21 Haiku calls) and it is real. Round 11 shows what it is
   worth in money — about $0.22 a run against Opus-direct on this task — and
   rounds 9 and 10 show that a user who simply picks a cheaper model captures
   most or all of it without any of the machinery.

4. **Volatility cuts against reading any single ratio too hard.** The Opus
   control alone has now been measured at $0.82, $1.68, $0.58 and $0.51 on this
   protocol. n=3 today.

## Threats to validity

- **No treatment arm ran in this round**, so the ratios in the table pair a
  round-11 control against rounds 9-10 treatment arms. All three were measured
  on 2026-08-15 on one checkout, within 70 minutes of each other, which is what
  the round was for — but they are not interleaved, and a machine-state drift
  inside that window would not be visible.
- Pooling two atoma series assumes they are replications of the same quantity.
  They differ ($0.3101 and $0.2628) by about the within-series spread, which is
  consistent with that assumption but does not prove it.
- One task, one family. Rounds 9-11 change the control model; they do not
  broaden the workload, and the correctness conclusion in ROUND10.md is bounded
  by that.

---

## Driver output, verbatim

```
== PRE-REGISTERED RESULT ==

provider : claude-cli
control  : one claude-opus-5 agent, plain tool loop, self-certifying
treatment: atoma, L1=claude-haiku-4-5-20251001 L2=claude-sonnet-5 L3=claude-opus-5

baseline (frontier direct) n=3: mean $0.5104, median $0.4136
  runs: 0.722, 0.414, 0.396
atoma n=0: mean —, mean excluding run 1 —

H1 NOT SUPPORTED within the runs performed: cumulative atoma cost never fell below the baseline.
cumulative delta after 0 runs: — (positive = atoma cheaper in total)
trend across the atoma series: first half — → second half —
```

`atoma n=0` is the whole point: there is no treatment series in this round, so
every line below it is empty and the H1 verdict is vacuous.
