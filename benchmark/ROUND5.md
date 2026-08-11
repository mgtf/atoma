# Round 5 — the zero-token path works, and buys part of its saving with unfinished work

Run 2026-08-11 on a **maintenance** task, hypothesis
[registered before the first run](PROTOCOL.md#round-5--pre-registration-2026-08-11-written-before-any-round-5-run).
11 runs from an empty registry and empty skill store, thresholds at 1/1. Data:
[`results-round5.csv`](results-round5.csv).

## Verdict: H5 supported — and a real defect found underneath it

The bar was *at least one verification recipe compiles, and the resulting
script records two or more successful deterministic dispatches without being
demoted*. Met at run 3.

| | rounds 1-4 (build tasks) | round 5 (maintenance) |
|---|---|---|
| Successful zero-LLM dispatches | **1 in 52 runs** | **10 in 8 runs** |
| Dispatch contract failures | 5 | **0** |
| Demotions | 2 | **0** |
| Cost per run, steady state | $0.47–0.54 | **$0.1509** |
| Ratio vs same-day control ($0.7069) | 1.5–3.3× | **4.69×** |

Round 4's diagnosis is confirmed as directly as it could be: the zero-token
path was never broken. It targets a **re-verification** phase, and
from-scratch builds decompose into build → record → document, which contains
no such phase. Given a task that does, it fires at run 2 and holds.

The pipeline split the work exactly as designed:

| recipe | form | matches | outcome |
|---|---|---|---|
| `targeted-cli-behavior-tweak` | llm | 5 | **compile refused** — irreducible |
| `regression-recheck-after-fix` | **script** | **6 / 6✓** | **`zero-llm-dispatch`** |
| `recheck-invocations-against-probe-manifest` | script | 0 | never matched (split vote) |

Editing source stays on the LLM path and the compiler correctly refuses it.
Re-running recorded invocations compiles and dispatches at zero cost.

## The defect the correctness scorer caught

`--chars` was changed correctly in all 9 deliverables, and every other
documented behaviour was preserved. But an **independent scorer**, run outside
both arms, found **7 of 9 READMEs still asserting `chars 36` about a CLI that
now prints 35**.

| run | deterministic phases | README |
|---|---|---|
| 1 | 0 | up to date |
| 2 | 1 | up to date |
| 3-9 | 1-2 | **stale** |

The compiled script was matched to a subtask that reads, verbatim:

> *"Using the verdicts from the previous phase, **update README.md** so that
> only the invocations whose behaviour legitimately changed are corrected"*

It is a verifier. It replayed the manifest, printed a valid envelope, exited 0
— and wrote nothing. **The deliverable gate did not catch it because the gate
checks that named files EXIST, and on a maintenance task every file exists
already: it was seeded.** The gate was designed against build tasks, where an
absent file is what proves the work was skipped. When everything pre-exists it
is inert by construction.

So part of the 4.69× advantage was bought by not doing the documentation
update. The saving is real; it is not all free.

**Fixed** (`subtaskMutatesFiles` + a before/after snapshot in
`runScriptSkillDirect`): when a subtask uses a mutating verb — update,
rewrite, fix, correct, amend… — the gate now snapshots each named file before
the script runs and rejects the dispatch if the file is byte-identical
afterwards. A pure re-verification subtask, which legitimately writes nothing,
is deliberately not gated: rejecting those would send healthy dispatches back
to the LLM loop. Three tests cover the three cases.

**Not re-measured.** The fix landed after the round; whether it converts those
seven runs into correct deliverables at some cost in dispatch rate is the
question a round 6 would answer.

## Generalisation

A second, different maintenance task: **$0.1842, one deterministic dispatch,
zero new recipes learned**. The compiled verifier transferred to a task it had
never seen — the fifth consecutive round where a novel same-family task needs
no new learning.

## Threats to validity

- **The task contains a verification phase by construction.** That is the
  point — rounds 1-4 established that build tasks do not — but it means round 5
  tests the machinery, not the frequency of the opportunity. How often real
  work is maintenance-shaped is unmeasured.
- **Thresholds at 1/1** mean a recipe compiled on one success and a script
  armed on one, and the trust threshold also skips atom-type validators
  run-wide. A "delivered" outcome is weak evidence here; the correctness
  scorer is the real gate, and it is what found the stale-README defect.
- Control arm n=2 ($0.9245, $0.4894 — a 1.9× internal spread).
- Eight runs on one maintenance task.
