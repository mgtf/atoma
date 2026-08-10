# Cost-amortisation benchmark — pre-registration

> **Status: registered, not yet run.** This document is committed BEFORE the
> first run. Its hypothesis, primary metric and falsification condition are
> fixed at that commit and are not to be edited once data exists — amend by
> appending a dated note instead.

## Why this exists

A 2026-08-10 audit of the project's README found its flagship claim —
"atoma beats frontier-direct 1.5–4.7×" — **unsupported**: the commit that
introduced the table shipped no data, no baseline harness existed anywhere in
the repository, the tasks themselves were not stored, and the traces had been
gitignored. Neither arm was replayable. Three other headline numbers were
stale or unreproducible for related reasons.

The claim may well be true. The point of this protocol is that after it runs,
the answer — whichever way it goes — will be reproducible from artefacts in
the repository.

## Hypothesis

**H1.** Running the same task repeatedly, the cumulative cost of *N* atoma
runs falls below *N* × the mean cost of a single frontier agent on that same
task, for some *N* ≤ 10.

Rationale: atoma pays tuition on the first run (it must decompose, verify and
distil a recipe) and is expected to recover it on later runs as validators are
skipped by earned trust and mechanical phases compile to zero-token scripts.

## Primary metric

**N\*** — the smallest run index at which cumulative atoma cost first drops
below cumulative baseline cost.

```
N* = min { N : Σ(atoma₁..ₙ) < N × mean(baseline) }
```

Computed by `analyse()` in `src/cli/benchmark.ts`, which is pure and unit
tested. `N* = null` means H1 was not supported within the runs performed.

## Secondary observations (reported, not used to decide H1)

- Per-run cost trend across the atoma series (first half vs second half).
- Mean atoma cost excluding run 1 (steady-state, once tuition is paid).
- Wall-clock and LLM-call counts on both arms.
- Deterministic (zero-LLM) phases, escalations, recipes learned, compilations.
- **Held-out task**: a novel task in the same family, run on both arms after
  the primary series. This is the memorisation control — if atoma is only
  cheap on the task it has repeated, the learning did not generalise.

## Falsification

H1 is **refuted** if either:

1. no *N* ≤ 10 satisfies the inequality; or
2. the atoma per-run cost shows no downward movement across the series
   (second-half mean ≥ first-half mean).

A refutation is published as-is, in the README, with the same prominence a
confirmation would get.

## Design

| | |
|---|---|
| Control arm | one frontier agent, same nine tools, same sandbox, same run budget, plain tool-use loop, self-certifying |
| Treatment arm | the full atoma pipeline, default settings, learning and compilation ON |
| Shared | `--baseline` swaps **one line** of `runTask`; sandbox, tools, budget, prompt cache, token accounting and price table are the same code, not merely matched |
| Starting state | **empty registry and empty skill store** — as after `git clone`. Prior state is archived, not deleted |
| Per run | freshly archived workspace, so no run inherits its predecessor's deliverable |
| Isolation | the control arm is pointed at a throwaway store; it also skips seeding, so it cannot mutate the treatment arm's state |
| Order | control arm first, then treatment, then the held-out pair |
| Provider | `claude-cli` (subscription). The API key in `.env` is dead — verified 401 |

## Known threats to validity

Stated in advance so they cannot be discovered later as excuses.

1. **Wall-clock is biased against atoma.** On this transport every LLM call
   spawns a subprocess costing 2–5s. atoma makes ~14 calls per run, the
   baseline makes 1. That is roughly 40s of handicap per run which would
   largely vanish on the direct API. Call counts are recorded so the bias is
   visible. **Cost, the primary metric, is unaffected** — both arms count
   tokens through the same formula.
2. **Costs are API-price equivalents.** On a subscription nothing is billed
   per token. The comparison between arms is valid because both are priced by
   the same table; the absolute dollar figures are not invoices.
3. **One family.** The chosen task is a CLI-plus-documentation job, which is
   the family where atoma currently owns every compiled script — that is, its
   best case. This is a test of the amortisation *mechanism* where the
   mechanism can operate, not a claim about all work. The web family, where
   the compiler refuses browser-validation recipes by design, cannot reach
   zero cost today and is out of scope.
4. **Frontier cost is high-variance.** Hence n=5 on the control arm rather
   than a single measurement.
5. **Repetition measures reuse plus memorisation.** The held-out task is what
   separates them; without it the result would be attackable and it is
   reported alongside the primary metric, not as an optional extra.
6. **Small n.** With 5 and 10 runs this is an indication with a stated method,
   not a statistically powered study. No significance test is claimed.
7. **There is a fixed per-call token tax, and it also penalises atoma.**
   Measured during the harness smoke test: a *trivial* baseline run (write one
   file, read it back) reported 47k cached-input tokens for its single call.
   That is the transport's own per-call context, not the task's. atoma pays it
   ~14 times per run against the baseline's once. It is charged at the cached
   rate and atoma's extra calls land mostly on the cheapest tier, so the
   effect is bounded — but it is a transport artefact, not an architectural
   property, and it moves the comparison *against* atoma. Per-call counts and
   cached-token volumes are recorded per run so the size of this tax is
   visible in the results rather than buried in the totals.

## Reproducing

```bash
ATOMA_LLM=claude-cli npm run benchmark -- --dry-run   # protocol, spends nothing
ATOMA_LLM=claude-cli npm run benchmark                # ~2h, machine to itself
```

Artefacts: `benchmark/results.csv` (one row per run), `benchmark/logs/`
(full stdout per run), `benchmark/RESULT.md` (computed metrics), and a full
JSON trace per run under `runs/`.

The machine must be otherwise idle — this repository has measured twice that
a loaded machine distorts run durations badly enough to invalidate rows.

---

## Amendment — 2026-08-10, after 2 control runs, before any treatment run

**Added: mechanical correctness scoring of every deliverable.**
`benchmark/verify-deliverable.mjs` executes each artefact against the numbered
requirements in `experiment.json` — runs the CLI, checks exit codes, parses
`--format json`, verifies a quoted comma stays one field, confirms the README
documents the flags — and emits a score.

Why it was added mid-protocol: the harness records "delivered" when a run
prints its completion banner, which says the run finished, not that the thing
works. Comparing the cost of a working CLI against the cost of a broken one
would be worse than not measuring. This matters most for the control arm,
which self-certifies: nothing in its path checks the deliverable
independently.

This does not change H1, the primary metric or the falsification condition. It
adds a **gate**: a run whose deliverable scores below the other arm's is
reported, and a cost advantage bought by shipping less is not a cost
advantage. The scorer is identical for both arms and was written before any
treatment run existed.

First measurement, control arm run 1: **10/10**. The baseline is expensive and
correct, so the treatment arm has to be cheaper *and* correct to support H1.

## Amendment — 2026-08-10, after control run 5 and treatment run 2

**Corrected a false negative in the correctness checker.** Check C2 required a
standard deviation and accepted only the spellings `stddev`, `std_dev` and
`standard`. Treatment run 2 printed `stdev: 8.16` — one `d` — and was scored
9/10 for a requirement it had in fact met. The regex now accepts the common
spellings.

Recorded prominently because **the correction favours the treatment arm**,
which is the direction in which a change to a measuring instrument deserves
the most scrutiny. Two facts limit it: the miss was a demonstrable spelling
gap, verifiable by running the artefact (its output is quoted in the commit);
and re-scoring every control deliverable with the corrected checker left all
five unchanged at 10/10, so the fix did not lift the baseline's ceiling or
narrow the gap by inflating one side.

Standing rule this establishes for the rest of the protocol: when a check
fails, the artefact is inspected before the failure is recorded. An instrument
that penalises a correct deliverable for its choice of abbreviation is
measuring the instrument.

## Amendment — 2026-08-10, after all 19 runs, before the write-up

**Broadened the wording vocabulary of four checks.** Treatment run 18 was
scored 7/8 for failing "reports a time span" while printing
`Elapsed Time: 180.00 seconds` — a correct span (10:00:00 → 10:03:00), missed
because the regex accepted only span/duration/first/last/range.

This is the SECOND correction in the same direction, which is itself worth
recording: both false negatives were on treatment deliverables, because the
control arm happened to use the conventional vocabulary the checks were
drafted from. Loosening a check only where one arm trips is how an instrument
drifts. So rather than patch the failing check alone, the vocabulary of FOUR
checks was broadened at once — distinct/unique/cardinality,
missing/null/empty/blank, template/pattern/signature, and the time-span set —
including checks that were not failing for anyone.

Re-scored afterwards: **all seven control deliverables unchanged at full
marks** across all three revisions of the instrument, so no loosening has ever
lifted the control arm's score or narrowed the gap by inflating one side.

Final correctness: **19/19 deliverables at full marks on both arms.**
