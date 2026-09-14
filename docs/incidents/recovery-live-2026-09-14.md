# Local live runs and recovery evidence — 2026-09-14

Two real local operator runs were authorised to exercise the current build.
They used isolated state, one machine-global lease, the existing worker image,
and a 300-second deadline per run. No production project was changed. The
production MCP returned HTTP 401 without an authenticated connector, so this
session did not collect or analyse the production corpus.

## Results, with the failure retained

| Case | Entry | Runner outcome | Duration | LLM calls | Estimated USD |
|---|---|---|---:|---:|---:|
| Single-file counter | Default short, L2 | delivered | 68.612 s | 6 | 0.1397622 |
| Add reset, seeded from the counter | Existing L3 seed path | failed, deadline | 300 s | 30 | 0.4228554 |

These are subscription API-list equivalents, not per-token charges or invoices.
The two different tasks and changing learned state do not establish a causal
cost comparison, a short-first saving, or a platform delivery rate.

The preserved [evidence JSON](recovery-live-2026-09-14/evidence.json) names
the code revision, image ID, times, costs, artifact hashes and independent
probe results. The full traces are compressed without rewriting:
[fresh](recovery-live-2026-09-14/fresh.trace.json.gz) and
[seeded](recovery-live-2026-09-14/seeded.trace.json.gz). Decompress with Python's
`gzip` module, verify the uncompressed SHA-256 from `evidence.json`, then read
`totals`, `durationMs` and `events` to reproduce the table. The generic test
artifacts are [fresh.html.gz](recovery-live-2026-09-14/fresh.html.gz) and
[seeded.html.gz](recovery-live-2026-09-14/seeded.html.gz); their uncompressed bytes match the artifact hashes. No customer data is included.

## Why the seeded run expired

The initial modification produced the final 2,825-byte HTML file. Browser
smokes demonstrated transitions 0 → 3 → 0 → 1. Subsequent work repeatedly
attempted an interactions array that incremented several times and reset
before the final smoke inspected state. The existing erased-intermediate-state
preflight rejected four such calls. There were seven L1 `validate_html`
events in total, including three successful calls; supervisor probes are a
separate channel and are not counted as additional L1 tool events here.

L3 had requested selector interactions rather than test hooks. The valid
self-driving smokes had empty transport interaction logs; a later three-click
probe had genuine interaction evidence but the reset sequence was again
refused. The resulting retries and unfinished verification exhausted the run.
The trace also contains an earlier plan rejection and learned recovery events.

This is a verification-workflow failure, not demonstrated broken counter code.
It is not evidence that the existing internal-validation-failed gate wrongly
accepted a failed check: the child did report failed/unfinished verification.
Neither does a successful smoke erase the later failed calls or the deadline.
The runner outcome remains failed in every reported result.

The existing tool contract documents why erased-state checks exist. No new
gate, heuristic, trust exception or weakening of proof requirements was designed
from this live session. Before another paid batch, review the interaction/assertion
workflow against the earlier incidents and this complete trace. In particular,
the acceptance contract must define how intermediate assertions and observable
user interactions coexist; merely asking the model to retry has a measured cost.

## Independent probe and harness correction

An operator-owned probe loaded copies of both final files in the worker browser.
It captured the initial DOM value, invoked three increment button clicks,
captured the value before reset and, for the seeded file, invoked reset and
captured the final value. Both returned `ok: true`, no browser errors, and
respectively 0 → 3 and 0 → 3 → 0. These clicks occur inside a smoke IIFE;
they are functional DOM evidence, not a claim of populated transport interaction
logs or the complete user-acceptance contract being implemented.

The first independent harness attempt returned `{verified: true}` without the
tool's required `ok` field. That correctly failed the harness assertion despite
the counter check succeeding. The correction added `ok: true` while retaining
the same throwing assertions, then rechecked the existing artifact. The first
paid run was not repeated. This harness error is separate from the model's
later reset-verification retries.

The [postcheck harness](recovery-live-2026-09-14/postcheck.mjs.gz) preserves the
exact local paths used for the session (gzip-compressed source); it is dated evidence, not a portable
product command. The live state and snapshots remain under
`/tmp/atoma-live-recovery-aa8hid` on this machine. The repo archives above
preserve the run evidence even if that temporary directory later disappears.

A subsequent [pointer-check harness](recovery-live-2026-09-14/pointer-check.mjs.gz)
used Puppeteer's `page.click` inside the isolated worker, with assertions
interleaved between clicks. It passed all four cases: original/restored ×
fresh/seeded. The fresh case reached 3; the seeded case reached 3, reset to 0,
then incremented to 1. This is independent pointer-interaction evidence, not
retroactive credit or delivery for the timed-out run. Both restored HTML files
were also byte-identical to their originals. Results are in `pointerChecks`
of the evidence JSON.

## Recovery exercise

After both runs stopped, the operator archived their final workspaces under
the exercise's archive tier, then invoked the production backup writer. All six
tiers were captured. A separate invocation of
[`restore-drill.py`](../../scripts/restore-drill.py) restored the snapshot into
a previously absent directory, verified every digest and SQLite integrity,
and started no services. Its report is embedded in `evidence.json`.

This sample contains operator runs: its project table is absent and its project
and supervisor tiers are empty. The real ProjectStore/file correspondence is
covered by synthetic regression tests, not by claiming these are tenant runs.
The local extraction's recorded time is not a production recovery-time objective.
No restored service was given live credentials, and the original host paths in
the copied database were not rewritten.

## Source verification

The updated source passed documentation checks, both TypeScript configurations,
lint, and the complete Vitest suite: 4,030 passed, 10 skipped (319 test files
passed, one skipped), with `--maxWorkers=2`. The recovery tests themselves ran
and passed; their six cases include incomplete supervisor coverage. No paid run
or browser exercise ran alongside that full suite. All diagnostic workers were
drained. This is not a claim that the production deployment or pending
acceptance-storage design has been validated.
