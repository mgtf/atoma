# Round 9 — H9 refuted on cost: against a single Sonnet agent, tiering breaks even at N\* ≈ 11, not ≤ 6

Run 2026-08-15, maintenance task, `PROMOTE=1` / `TRUST=3` — same task text, same
seed, same thresholds and same treatment-arm scale as rounds 6-8.
[Registered before the run](PROTOCOL.md#rounds-9-10--pre-registration-2026-08-15-written-before-any-round-9-run).

**The one change: the control arm is one `claude-sonnet-5` agent instead of one
Opus agent**, through the `ATOMA_BASELINE_MODEL` pin added for this round. The
treatment arm keeps its default gradient (`L1=haiku`, `L2=sonnet`, `L3=opus`)
and is unchanged in every respect.

## Verdict: H9 refuted — condition 1 fails, condition 2 holds

| condition | target | round 9 | |
|---|---|---|---|
| 1. cost | `N* ≤ 6` | **no break-even in 6 runs** (deficit $0.0538) | ✗ |
| 2. correctness | atoma full-mark rate ≥ control's | **10/10 on every deliverable, both arms** | ✓ |

Both conditions were required, so **H9 is refuted**, and this is the refutation
the pre-registration named as the likely one — recorded there before the data
existed, with the projected control cost (~$0.49) and the reasoning that one
cold start could swallow a thin margin. The observed control mean was $0.3012,
cheaper still than projected, and that is exactly what happened.

## The number that matters

```
control (one Sonnet agent) n=3:  mean $0.3012   median $0.2219
atoma                     n=6:  mean $0.3101   warm mean (runs 2-6) $0.2897
cumulative after 6 runs:        atoma $1.8608  vs control-equivalent $1.8072
```

atoma's steady state **is** cheaper than the control arm — by $0.0115 a run,
3.8%. It is simply not cheap enough to repay a $0.4122 cold start inside six
runs. Extrapolating at the observed warm rate, the deficit of $0.0538 closes
after about five more runs: **N\* ≈ 11**, which fails not only H9's registered
`≤ 6` but also H1's original `≤ 10`.

**The mean flatters atoma here, and the median is the honest check.** The
control's mean is dragged up by its own first run ($0.4667 against $0.2149 and
$0.2219 after it). Against the control **median** of $0.2219, atoma's warm mean
of $0.2897 never wins at all — there is no N at which it breaks even. The
registered metric uses the mean, so the mean is what decides; the median is
reported because choosing whichever of the two looks better is the failure mode
this protocol exists to prevent.

## What this does and does not say about the project

**It does not overturn rounds 1-8.** Those measured a real and reproducible
result against an Opus-direct control, and nothing here contradicts them.

**It does qualify what they measured.** The published ratios — the README's
`1.0–3.6× over 8 rounds` badge and its $0.820-vs-$0.313 table — are ratios
against *Opus-direct*, and a reader is entitled to read them as "atoma versus a
frontier agent" without noticing that the choice of frontier model is doing a
large part of the work. On this task, swapping the control arm to Sonnet moves
the ratio from **2.62× to 0.97×**. That is the single most important sentence in
this round, and the README needs to carry it.

**The mechanism the project claims is still visible and still real.** atoma
spends exactly **one Opus call per run** (the decomposition) and puts 8-16 Haiku
calls under it; the control spends its whole budget at Sonnet rates in one call.
The cheap-model architecture works as described. What round 9 shows is that its
*advantage* is measured against whatever the reader would otherwise have run,
and against a competent mid-tier agent on a task this size the advantage is
roughly nil.

## Where run 3's $0.4714 went, and the fifth consecutive null result

Run 3 is the round's most expensive run — dearer even than the cold start — and
the reason the series never catches up. Its log names the cause:

- `reverify-cli-recorded-invocations` reached 3✓/0✗ and **compiled to a
  5845-char script**;
- `fix-single-metric-edge-case` was offered and **correctly refused** — "requires
  semantic code understanding … cannot be derived deterministically from argv
  alone", which is the predicate working as designed;
- that run also took 2 Sonnet calls and 1 validator refusal against the series'
  usual 0.

And then: **`det = 0` on runs 3, 4, 5, 6 and the held-out run.** The compiled
script never dispatched once. Compilation cost a measurable amount on run 3 and
returned nothing, for the **fifth consecutive round** (rounds 5-8 went 10 firings
with broken deliverables, then 1, 1, 0). The standing position in ROUND8.md —
"every fix has been real and none has made it pay" — survives round 9 intact and
is now the clearest single lead for where the money is.

## Generalisation, reproduced for the seventh round

Held-out task (novel, same family): **$0.2214 with zero new recipes learned** —
below the control arm's own mean on the *trained* task. Whatever atoma learned
in six runs transferred, which is the memorisation control passing again.

## Correctness: 10 of 10 deliverables at full marks, both arms

Scored by [`verify-maint.mjs`](verify-maint.mjs) (10 checks, executes the CLI and
replays every manifest entry) via the new
[`score-round.mjs`](score-round.mjs), whose run→workspace mapping is **computed
from an anchor recorded before the round** (`--first-archive 197`) rather than
reconstructed afterwards — the off-by-one that produced a false 83.3% in round 8.
Full per-check output: [`results-round9-scores.json`](results-round9-scores.json).

The scorer was validated before use by re-scoring round 8's archives, still
present on this machine: it reproduces **8 of that round's 9 deliverables at
10/10** — a figure ROUND8.md declined to claim because it could not be
regenerated — and refuses the ninth as `UNMAPPED` rather than mis-scoring it,
that run's live workspace having been overwritten since.

Both arms shipped correct work on every single run. **Nothing in this round was
bought by shipping less, on either side.**

## Wall clock

Control mean **66s** (1 LLM call), atoma mean **217s** (9-19 calls) — 3.3×, with
the transport bias stated in the protocol: every call on `claude-cli` pays a 2-5s
subprocess spawn, so this penalises the arm making fifteen calls and would
largely vanish on the direct API. Cost, the registered metric, is unaffected.

## Threats to validity

- **n=3 on the control arm, spanning 2.2×** ($0.2149 to $0.4667). The registered
  metric divides by its mean, and that mean rests on three observations of a
  quantity known to be volatile. A control arm that had happened to draw three
  cheap runs would have refuted H9 harder; three expensive ones would have
  supported it. This is the round's weakest joint and it was registered as such.
- One task, one family, six atoma runs, one compiled script.
- `N* ≈ 11` is an extrapolation from a 5-run warm mean, not a measurement. It is
  offered as a magnitude, not a result; the measured result is "no break-even
  within 6".
- Cross-round comparison with rounds 6-8 is deliberately not made on cost: this
  round re-measured its own treatment arm on the same day and code path for
  exactly that reason.

---

## Driver output, verbatim

Unmodified output of `analyse()` / `formatAnalysis()`, as written by the driver
before this narrative was added. Also in
[`driver-round9.log`](driver-round9.log) and
[`results-round9.csv`](results-round9.csv).

```
== PRE-REGISTERED RESULT ==

provider : claude-cli
control  : one claude-sonnet-5 agent, plain tool loop, self-certifying
treatment: atoma, L1=claude-haiku-4-5-20251001 L2=claude-sonnet-5 L3=claude-opus-5

baseline (frontier direct) n=3: mean $0.3012, median $0.2219
  runs: 0.467, 0.215, 0.222
atoma n=6: mean $0.3101, mean excluding run 1 $0.2897
  runs: 0.412, 0.250, 0.471, 0.261, 0.157, 0.309

H1 NOT SUPPORTED within the runs performed: cumulative atoma cost never fell below the baseline.
cumulative delta after 6 runs: $-0.0538 (positive = atoma cheaper in total)
trend across the atoma series: first half $0.3779 → second half $0.2424

-- held-out task (novel, same family): memorisation control --
  baseline n=0: mean —
  atoma    n=1: mean $0.2214
  If atoma is cheap here too, the learning generalised to the family.
  If it is back at baseline cost, it had memorised the primary task.
```

Note that `formatAnalysis` prints its own line as "H1 NOT SUPPORTED": the driver
computes the pre-registered metric and is deliberately ignorant of which round's
hypothesis it is serving. For round 9 that line reads on H9's condition 1.
