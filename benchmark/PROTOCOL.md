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

---

## ROUND 2 — pre-registration, 2026-08-10, written before any round-2 run

Round 1 found that deterministic dispatch never engaged: the compilable
recipes' `when_to_use` described DISK STATE, which the prefilter cannot
evaluate because it only sees the subtask text. They drew 2 matches in 19 runs
against their siblings' 14-15 and ended one success short of compiling. The
distillation prompt was fixed to forbid that phrasing. Round 2 tests whether
the fix does anything.

**H2 — the fix raises the match rate enough to reach compilation.** Starting
again from an empty registry and empty skill store, on the SAME primary task,
at least one recipe compiles to `kind: script` and at least one run records a
deterministic phase (`det > 0`) within 14 atoma runs.

Round 1's comparison values, fixed here so they cannot be reinterpreted later:
`det = 0` across all 19 runs; compilable recipes at 2 matches each; build
siblings at 14 and 15; both casualties ending at `promotion-in-1`.

**Secondary, and the more informative measure:** the match count of the
verification recipes relative to their busiest sibling. Round 1 was a ratio of
about 1:7. If the phrasing rule works, that ratio narrows even in runs where
compilation does not quite land.

**H2 is refuted if** no recipe compiles within 14 runs AND the verification
recipes' match ratio is no better than round 1's ~1:7. Publishing a refutation
matters more here than in round 1: it would mean the diagnosis was wrong, and
the diagnosis is what the fix was built on.

**Scale.** 3 baseline (a drift check only — the frontier arm does not learn and
was measured at n=5 in round 1; three runs are enough to catch gross model or
machine drift that would confound a round-to-round comparison), 14 atoma
(round 1 ended one success short at 10, so the extra four give compilation room
to land or to visibly fail to), 2 held-out atoma (generalisation still holds?).
No held-out baseline: round 1 measured it at n=2 with a 2.5× spread, and
re-measuring a weak estimate adds nothing.

**Output.** `benchmark/results-round2.csv`, via the new `--out` flag. Round 1's
`results.csv` is left untouched — it is the record `RESULT.md` cites, and the
two rounds are compared against each other rather than pooled.

**Confounder acknowledged in advance.** Round 2 runs on a different day against
a subscription-served model that can shift behind its alias. The 3 baseline
runs are the only guard, and they are a weak one. If round 2's baseline mean
departs sharply from round 1's $0.8198, the round-to-round atoma comparison is
not trustworthy and the report must say so rather than attribute the difference
to the fix.

---

## ROUND 3 — pre-registration, 2026-08-10, written before any round-3 run

Round 2 reached compilation and one zero-LLM dispatch, then the compiled script
took two contract failures and auto-demoted. The cause was characterised after
the fact: the probe manifest recorded TRUNCATED stdout (a strict prefix of the
real output), so a byte-for-byte replay could never match. Two fixes shipped
since:

- `record_probe` — a builtin that runs a command AND writes its real exit code
  and complete output into the manifest, so the record is machine-written
  rather than transcribed by the model. Proven offline: re-recording the two
  failing round-2 workspaces drops them from 4/6 and 9/10 replay mismatches to
  0 of 16.
- `edit_file` now REFUSES `.atoma-probes.json`, naming `record_probe` instead.
  31 of the 50 `edit_file` failures across 122 archived traces were that one
  file.

**H3 — a compiled script now SURVIVES instead of demoting.** From an empty
registry and empty skill store, on the same primary task, within 14 atoma runs:
at least one recipe compiles, AND the resulting script records **two or more
successful deterministic dispatches**, AND is **not demoted**.

Round 2's values, fixed here so they cannot be reinterpreted afterwards: one
compilation (run 5), one successful dispatch (run 10), two contract failures
(runs 9 and 11), demotion at run 12. Deterministic phases: 1 across 19 runs.

**Secondary, and the direct test of `record_probe`:** the number of
`edit_file` failures on `.atoma-probes.json`, which should be ZERO by
construction, and the number of dispatch contract failures
(`dispatch_fallbacks`), which round 2 recorded at 3.

**H3 is refuted if** the compiled script demotes again, or never reaches two
successful dispatches, within 14 runs. That would mean the truncation was not
the binding constraint — the offline proof would still stand, and the real
cause would be something the archived workspaces do not show.

**Scale.** 3 baseline (drift check only), 14 atoma, 2 held-out atoma. Output:
`benchmark/results-round3.csv`.

**Same confounder as round 2**, and now with a measured precedent: round 2's
control arm ran 23.7% above round 1's. Cross-round *cost* comparison stays
untrustworthy; H3 is a within-round question and is unaffected.

---

## ROUND 4 — pre-registration, 2026-08-11, written before any round-4 run

Round 3 refuted H3, and the cause was a defect `record_probe` itself shipped:
it refused a whole command line, the model worked around it with `bash -c`, and
the compiled verifier's argument extraction then captured the wrapper's closing
quote. Fixed since — `record_probe` accepts `cmd` as a full line and records it
bare. Round 4 asks the same question against the fixed tool.

**H4 — a compiled script survives dispatch.** From an empty registry and empty
skill store, on the same primary task: at least one recipe compiles, and the
resulting script records **two or more successful deterministic dispatches**
without being demoted.

Round 3's values, fixed here: compiled at run 5, armed at run 8, ZERO
successful dispatches, two contract failures, demoted at run 10.

**DELIBERATE DEVIATION — thresholds lowered to 2.** `ATOMA_PROMOTE_THRESHOLD=2`
and `ATOMA_TRUST_THRESHOLD=2` (defaults are 3 and 3), set per-run via the
existing call-time env hooks, no code change. Rationale: rounds 2 and 3 spent
eight of fourteen runs merely REACHING the first dispatch attempt, leaving too
little room to observe what this experiment is actually about — whether
dispatch is stable. At 2/2 the first attempt should land around run 5, giving
four or five dispatch opportunities instead of one or two.

**What this deviation costs, stated up front.** Less evidence before trusting:
a script arms on two clean runs rather than three. That makes round 4 a test of
DISPATCH STABILITY, not of the lifecycle's calibration, and its run-index
timings are NOT comparable with rounds 1-3. The demotion rule is unchanged (two
contract failures), so the safety net is exactly as tight as before.

**H4 is refuted if** the script demotes again, or never reaches two successful
dispatches. A third consecutive refutation would mean the zero-token path has a
cause none of the three fixes has touched, and the honest move would be to stop
patching and re-derive it from the traces.

**Scale.** 2 baseline (drift check, and weaker than before at n=2 — the
insulation result already has three rounds behind it), 9 atoma, 1 held-out.
Output: `benchmark/results-round4.csv`.

---

## ROUND 5 — pre-registration, 2026-08-11, written before any round-5 run

Rounds 1-4 all used from-scratch BUILD tasks. Round 4 established why the
zero-token path never fires there: those tasks decompose into
build → record → document, and a compiled verifier serves a RE-VERIFICATION
phase, which only exists when an artefact changed after it was recorded. That
is maintenance work. Four rounds measured the absence of a phase; this one
supplies it.

**H5 — where the re-verification phase exists, the zero-token path fires and
holds.** From an empty registry and empty skill store, on a MAINTENANCE task:
a verification recipe compiles, and the resulting script records **two or more
successful deterministic dispatches** without being demoted.

Round 4's values, fixed here: 1 compilation, 0 dispatches, 0 contract failures,
0 demotions, and the compiled verifier matched 0 times in 9 runs.

**WHAT MAKES IT A MAINTENANCE TASK.** A new `--seed` flag copies
`benchmark/seeds/wclite` into each run's freshly-cleaned workspace: a working
CLI, a README documenting five invocations, and a `.atoma-probes.json`
recording what each produced. The goal asks for ONE small behaviour change and
then a re-verification of everything else against those records. Without the
seed the task would degrade into the build shape already measured four times.

**THE OBVIOUS OBJECTION, stated rather than waited for.** This task contains a
re-verification phase by construction, and a verification recipe is exactly
what should match it — am I engineering the result? Partly, and deliberately:
the finding under test is *"the phase does not exist in build tasks"*, so the
test is whether the machinery works **when it does exist**. What is NOT
engineered is the recipe (the store starts empty, so it is distilled from
run 1), whether the compiler accepts it, whether the prefilter re-matches it,
or whether dispatch survives. Those four are the hypothesis.

**Thresholds at 1/1** (`ATOMA_PROMOTE_THRESHOLD=1`, `ATOMA_TRUST_THRESHOLD=1`),
continuing round 4's deviation and going one further, so a dispatch can happen
by run 3 in an 8-run arm. Cost, stated up front: a recipe compiles on ONE
success and a script arms on ONE, so this measures dispatch STABILITY with
almost no evidence behind the promotion — and the trust threshold also governs
the atom-type fast-path, so validators are skipped after a single success
across the whole run. A "delivered" outcome is correspondingly weaker evidence;
the executing correctness scorer is the real gate. The demotion rule is
unchanged at two contract failures.

**H5 is refuted if** no verification recipe compiles, or the compiled script
fails to reach two successful dispatches. A refutation here would be the
strongest negative result of the series: it would mean the zero-token path does
not work even on the phase shape it was designed for.

**Scale.** 2 baseline (reference only, n=2), 8 atoma, 1 second maintenance task
as the generalisation control. Output: `benchmark/results-round5.csv`.

---

## ROUND 6 — pre-registration, 2026-08-11, written before any round-6 run

Round 5 got the zero-token path working on maintenance (10 dispatches, 0
failures, 4.69×) and simultaneously shipped 7 of 9 deliverables with a README
contradicting its own artefact. Two things follow, and round 5 cannot separate
them because both knobs moved together.

**THE KNOBS ARE SEPARATE AND THIS ROUND SEPARATES THEM.**
`ATOMA_PROMOTE_THRESHOLD=1` makes a recipe compile after one success — round 5
suggests that is fine, since the resulting script produced ten clean
dispatches. `ATOMA_TRUST_THRESHOLD=1` ALSO skips the atom-type validators
run-wide after one success, and that is the plausible reason nothing caught the
stale README: a RESULT validator runs the zero-token ground-truth probe, which
re-reads claimed files. Round 6 keeps **PROMOTE=1** and restores **TRUST=3**.

**H6, three parts, all within-round:**
1. **The gate fix works.** Deliverable correctness returns to 9/9 on the
   independent scorer, against round 5's 7 of 9 with a stale README.
2. **`promote=1` survives with validators on.** At least one recipe compiles
   and the script reaches two or more successful dispatches without demotion.
3. **The fix does not simply kill dispatch.** Deterministic phases stay above
   zero. If correctness returns only because every dispatch now falls back, the
   gate is too strict and that is a refutation of the fix, not a success.

Part 3 is the one worth stating loudly: the cheapest way to pass part 1 is to
never dispatch, and that would be the wrong answer.

**Not a default change yet.** One round and one compiled recipe is anecdote by
this project's own rule. If round 6 reproduces round 5's dispatch behaviour
with validators on and correctness restored, that is two rounds and the case
for lowering the shipped default becomes arguable — on the PROMOTE threshold
only, never on TRUST.

**Scale.** 2 baseline (drift), 6 atoma, 1 held-out — deliberately short.
Maintenance runs are ~180s, so this is roughly 35 minutes. With promote=1,
compilation should land by run 2, leaving four runs of dispatch to observe.
Output: `benchmark/results-round6.csv`.

---

## ROUND 7 — pre-registration, 2026-08-11, written before any round-7 run

Round 6 restored correctness (2 of 9 → 5 of 6) by gating dispatches that left a
named file untouched, and paid for it in volume: dispatches 10 → 1, ratio
4.69× → 2.05×. Every one of the five gate catches was the same shape — a
read-only compiled verifier matched to a subtask that had to WRITE. The fix
since: `matchSkill` filters the catalogue, so a `kind: script` with no write
surface is never offered for a subtask carrying a mutating verb.

**H7 — filtering upstream recovers the volume without giving back the
correctness.** Same maintenance task, same thresholds (`PROMOTE=1`,
`TRUST=3`), three conditions:

1. **Dispatches recover: ≥ 5** (round 6: 1; round 5: 10).
2. **Correctness holds: ≥ 5 of 6** on the independent scorer (round 6: 5 of 6;
   round 5: 2 of 9).
3. **Gate fallbacks fall to 0 or 1** (round 6: 5). This is the direct test of
   the filter: a catch that still happens is a write-subtask the filter failed
   to keep away from a read-only script.

**H7 is refuted if** dispatches stay at round 6's level — the filter would then
not be the binding constraint — or if correctness drops back, which would mean
volume was recovered by letting the wrong dispatches through again.

**The failure mode to watch, since it is the one the filter could introduce:**
dispatches could recover while correctness drops, if the write detector is so
generous that read-only scripts still slip through. `scriptWritesFiles` errs
toward "writes" by design, so this is the plausible way the fix goes wrong.

**Scale.** 2 baseline, 6 atoma, 1 held-out — same as round 6 so the two are
directly comparable. Output: `benchmark/results-round7.csv`.

## ROUND 8 — pre-registration, 2026-08-11, written before any round-8 run

Round 7 refuted H7 on all three conditions, and the post-mortem found the
reason was not the filter. Two separate defects, both now fixed:

- **The filter never ran.** `scriptWritesFiles` asked "does this body write?"
  and every compiled verifier writes its own probe manifest, so it fired ZERO
  times. Replaced by `scriptCanServeSubtask`, a per-DESTINATION test, applied
  only on the TRUSTED branch (simulation: filtering every match takes
  dispatches from 1 to zero, because the successes that arm dispatch are
  earned on the documentation phases the predicate refuses).
- **A validator semantics gap paid for the whole cost column.** An earlier
  sequential phase applied the edit; a later phase reported it done and was
  rejected four more times because its subtask text says "apply ONE minimal
  edit". Two of six runs, $0.325/run. Fixed by the QUOTED SPAN check in the
  read-back probe plus the ALREADY-SATISFIED rule.

**H8 — with the cascade closed and the predicate live, the maintenance
family reads its true economics, and the dispatch path is no worse.** Same
task, same thresholds (`PROMOTE=1`, `TRUST=3`), four conditions:

1. **Zero already-satisfied rejections.** The count of validator rejections
   whose reasoning turns on the child reporting work already done. Round 7: 5,
   across 2 runs. This is the primary metric — it is the mechanism under test.
2. **No cascade run.** No atoma run above **$0.90**. Round 7's two affected
   runs cost $1.09 and $1.38 against a $0.26 mean for the rest; the threshold
   sits well above the healthy spread and well below both.
3. **The predicate actually fires: ≥ 3 refusals**, and **gate fallbacks ≤ 1**
   (round 7: 0 and 5). Registered because "it fired zero times" is exactly how
   the previous fix failed, and a fix that cannot be observed is not a fix.
4. **Correctness holds: ≥ 5 of 6** on the independent executing scorer
   (round 7: 6 of 6).

**H8 is refuted if** condition 1 or 4 fails. Conditions 2 and 3 are
diagnostic: 2 failing without 1 failing means the cascade has another cause I
have not found, and 3 failing means the predicate is still mis-placed rather
than wrong.

**Cost is NOT a registered condition, deliberately.** The control arm has
swung $0.82 → $1.68 across rounds on a subscription-served model, and round
7's own conclusion was that a single mechanism moved the mean by $0.325. A
ratio computed on 6 runs cannot separate the fix from that. It is reported.

**The failure mode to watch, since it is the one THIS fix could introduce:**
correctness dropping while everything else improves. The already-satisfied
rule tells the validator that a completed end state is compliant even when
the subtask is phrased as an instruction to produce it — which is exactly
what a child that skipped its work would claim. The rule demands supervisor
evidence (a QUOTED SPAN FOUND line) rather than the child's own quote, and an
adversarial pass was run against a fabricated payload before shipping, but
the honest test is the scorer. **A correctness drop refutes the fix outright,
whatever the cost column says** — that is the lesson round 5 taught at the
price of seven wrong deliverables.

**Also observed, not decided on:** how often `QUOTED SPAN … — FOUND` appears
in the traces at all. If it never appears, condition 1 passing would be luck
rather than mechanism.

**Scale.** 2 baseline, 6 atoma, 1 held-out — same as rounds 6 and 7 so all
three compare directly. Output: `benchmark/results-round8.csv`.
