# Round 3 — does a compiled script survive now?

Run 2026-08-10/11, hypothesis
[registered before the first run](PROTOCOL.md#round-3--pre-registration-2026-08-10-written-before-any-round-3-run).
19 runs from an empty registry and empty skill store. Data:
[`results-round3.csv`](results-round3.csv), scores in
`results-round3-scores.json`.

## Verdict: H3 is REFUTED

The bar was *at least one compilation, two or more successful deterministic
dispatches, and no demotion, within 14 atoma runs*. The script compiled, armed,
and then demoted **without a single successful dispatch** — worse on that axis
than round 2.

| | round 1 | round 2 | round 3 |
|---|---|---|---|
| Compilations | 0 | 1 | **2** |
| Successful zero-LLM dispatches | 0 | 1 | **0** |
| Dispatch contract failures | 0 | 3 | 2 |
| Demotions | 0 | 1 | **1** (run 10) |
| Deliverable correctness | 19/19 | 19/19 | **19/19** |

## Why — and the cause is one I introduced

`record_probe` did what it was built for. The manifest from the failing run is
**clean**: 14 entries, full outputs, no truncation anywhere. The replay failed
regardless.

The script actually dispatched was recovered from the trace (the dispatch
writes it to disk with `write_file _skill_*.mjs`, so the trace holds the exact
body). It **does read the manifest** — `fs.existsSync(manifestPath)`,
`JSON.parse(fs.readFileSync(manifestPath))`. It then re-derives each
invocation's arguments from the recorded command with a regex:

```js
const m = e.cmd.match(new RegExp('node\\s+' + entryEscaped + '\\s*(.*)$'));
```

Every entry in that manifest reads `bash -c "node csvstat.js sample.csv"`, so
`(.*)$` captures `sample.csv"` — **with the wrapper's closing quote**. The
script then runs a command that is not the one recorded, gets a different
result, and reports a mismatch. That stray quote is visible verbatim in the
failure: `Re-verification MISMATCH for documented invocation
"node csvstat.js sample.csv""`.

**And the `bash -c` wrapper exists only because `record_probe` refuses a full
command line.** Composing it on `run_shell` inherited a rejection of shell
LINES, so a model passing `node csvstat.js sample.csv` as one string is turned
away and works around it with `bash -c "..."` — even though the manifest stores
`cmd` as a single string. The tool whose job is recording a command refused the
shape in which it records it. The duplicate entries seen earlier in the round
(`node X` beside `bash -c "node X"`, with diverging outputs) were the same
cause.

So round 3 did not find a new layer of the system. **It found a defect I
shipped between rounds**, and the round measured it faithfully.

> **A correction, recorded rather than quietly fixed.** An earlier revision of
> this document stated that the compiled script "parses prose from the README
> instead of replaying the manifest". That was wrong. It came from grepping the
> first trace event whose text matched the error string — which was the run
> summary, not the script — and it would have justified building a static guard
> against a problem that does not exist. The body above was then read directly
> from the `write_file` that dispatched it.

## The result that did survive, measured three times

The frontier control arm **doubled in cost** between rounds — a natural
experiment nobody planned:

| | control arm | atoma | ratio |
|---|---|---|---|
| round 1 | $0.8198 | $0.5314 | 1.54× |
| round 2 | $1.0140 (+23.7%) | $0.5358 | 1.89× |
| round 3 | **$1.6847 (+105.5%)** | **$0.5061** | **3.33×** |

atoma's own cost did not move: $0.531, $0.536, $0.506 across three independent
empty-store starts. The reason is structural — atoma exposes **one frontier
call in about fifteen**, the rest running on the cheap tier, while a
single-agent baseline is exposed end to end. Frontier drift passes straight
through the control arm and barely touches atoma.

This is a stronger and better-evidenced claim than the amortisation thesis this
benchmark set out to test, and it was not the hypothesis: it fell out of a
confounder the protocol registered in advance and the drift check caught.
**Cross-round cost comparison remains invalid** — what is valid is that each
round's within-round ratio was measured against its own same-day control.

Generalisation also reproduced a third time: **$0.3961 / $0.4007 / $0.3518** on
a never-seen task, zero new recipes learned every time.

## What to fix next, and why it is different from the last two

**`record_probe` must accept a full command line** — the shape the manifest
stores and the shape the model reaches for — and record it verbatim, wrapping
in `bash -c` only for execution and only when the line genuinely needs a shell.
The recorded `cmd` must be the bare, replayable command. That removes the
wrapper, the stray-quote extraction, and the duplicate entries in one change.

Second, smaller: `demoteToLlm` destroys the compiled body, so the artefact that
failed cannot be inspected afterwards. It was only recoverable here because the
compile call's response is in the run trace.

## Threats to validity

- Control-arm drift of +105.5% since round 1, registered in advance. It makes
  cross-round cost comparison invalid and is *why* the insulation result is
  measurable at all.
- Control arm n=3, and the drift estimate is itself weak.
- One task family, atoma's best case, as in every round.
- H3's refutation is a single compiled script over 14 runs. It shows this
  script did not survive, not that none can.
