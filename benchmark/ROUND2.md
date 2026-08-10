# Round 2 — does the `when_to_use` fix reach compilation?

Run 2026-08-10, hypothesis and falsification condition
[registered before the first run](PROTOCOL.md#round-2--pre-registration-2026-08-10-written-before-any-round-2-run).
19 runs from an empty registry and empty skill store. Data:
[`results-round2.csv`](results-round2.csv), scores in
`results-round2-scores.json`.

## Verdict: H2 is supported by the letter, and only partly by the spirit

The registered bar was *at least one compilation AND at least one run with
`det > 0` within 14 atoma runs*. Both happened.

| | round 1 | round 2 |
|---|---|---|
| Compilations | **0** in 19 runs | **1** (run 5) |
| Runs with a zero-LLM phase | **0** | **1** (run 10) |
| Compile refusals | 2 | 1 |
| Deliverable correctness | 19/19 | **19/19** |

The full lifecycle executed unattended inside a single benchmark, which had
never been observed end to end before:

| run | event |
|---|---|
| 5 | recipe compiles, `llm → script`, counters reset |
| 6-8 | three clean validated runs — trust earned |
| 9 | dispatch attempted → contract failure → fell back to the validated loop |
| 10 | **dispatch succeeded — `det=1`, zero LLM calls, $0.1913 / 7 calls** |
| 11 | contract failure |
| 12 | second contract failure → **automatic demotion back to `llm`** |

**Zero failed deliverables across all twelve.** Every run still shipped through
the validated loop while the system quarantined its own broken optimisation.
Run 10 is the cheapest run recorded in either round.

## Where the attribution breaks down

**The recipe that compiled is not one of the two the fix targeted.** It is
`document-cli-with-verified-examples` — a documentation recipe — which drew
**11 matches**. The two verification recipes, both reformulated by the fix and
both now phrased as "Task asks to re-check that…", ended at **0 and 2 matches**
out of 16 runs.

So text-evaluable phrasing is **necessary but not sufficient**. Something else
governs whether a verification recipe is matched, and the most likely candidate
is visible in the data: the plan for this task decomposes into *build* and
*document*, and rarely produces a standalone re-verification phase at all.
There is little demand to match. The `under-matched(when_to_use?)` flag fires
on both, correctly, and its question mark is now doing real work — the phrasing
is no longer the obvious answer.

A second contributor, surfaced by the merge detector: the two verification
recipes overlap at **0.52** — near-duplicates competing for whatever few
verification subtasks exist, splitting an already thin vote.

## Economics: unchanged, and the headline number is a trap

| | round 1 | round 2 |
|---|---|---|
| atoma mean per run | $0.5314 | **$0.5358** |
| atoma warm mean | $0.4945 | $0.5199 |
| control arm mean | $0.8198 (n=5) | **$1.0140 (n=3)** |
| apparent saving | −35.2% | −47.2% |

**The apparent improvement from 35% to 47% is entirely baseline drift.** atoma's
own cost is flat between rounds; the control arm rose 23.7%. Round 2 ran on a
different day against a subscription-served model that can shift behind its
alias, and the drift check registered in advance is what caught it. Quoting
−47% against round 1's −35% would be exactly the error that check exists to
prevent.

The honest economic reading: **one zero-token dispatch in fourteen runs did not
move the mean.** The compiled path armed, fired once, and was withdrawn.

## Generalisation reproduces exactly

| held-out task (`logdigest`) | round 1 | round 2 |
|---|---|---|
| atoma mean | $0.3961 | **$0.4007** |
| new recipes learned | 0 | **0** |
| correctness | 8/8 × 2 | 8/8 × 2 |

On a task it has never seen, atoma reuses what it learned instead of learning
again — twice now, from independent empty-store starts, within 1.2% of each
other. This is the most reproducible result either round produced.

## The next defect, characterised

The demotion at run 12 was not the safety net misfiring. The compiled verifier
replays the probe manifest byte-for-byte, and **the manifest records truncated
stdout**.

Measured by hand-replaying manifests from the archived workspaces:

| workspace | entries | mismatches | of which truncation |
|---|---|---|---|
| `build.prev44` | 6 | 4 | **3** (65 vs 1029 chars, 58 vs 456, 43 vs 365) |
| `build.prev50` | 10 | 9 | recorded 371 chars against an actual 2008 |
| six others | 8-12 each | **0** | — |

In every truncation case the recorded stdout is a **strict prefix** of the real
output — the writer abridged a long output instead of pasting it verbatim, as
the contract requires. The compiled reader then compares byte-for-byte and
cannot ever match. `validateProbeManifest` checks structure, not completeness,
and has no way to know the real output was five times longer.

This is a different defect from the one this round tested, and it is now the
binding constraint on the zero-token path: the recipe compiles, arms, and is
then demoted by false mismatches. **Not fixed here** — it needs a design
decision between teaching the writer harder, recording a length or hash
alongside stdout so truncation is detectable, and making the reader treat
"recorded is a strict prefix of actual" as a truncated record rather than a
failure. Each has a cost, and guessing is what this file exists to avoid.

## Threats to validity

- **Baseline drift of 23.7%**, registered in advance as the main risk and
  realised. Round-to-round *cost* comparison is not trustworthy; the
  within-round H2 measures (did it compile, did `det` fire) are unaffected.
- Control arm n=3 in this round, against round 1's n=5, with overlapping
  ranges — the drift estimate is itself weak.
- One task family, atoma's best case, as in round 1.
- `det` fired once. A single event is an existence proof, not a rate.
