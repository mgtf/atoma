# Production MCP audit and isolated artifact checks — 2026-09-14

The authenticated production MCP became available after OAuth reconnection.
This continues the [local recovery exercise](recovery-live-2026-09-14.md).
The initial read observed no live project/operator run, no analyst in flight
or queued, and an armed sentinel with no consecutive failures.

## Coverage and reproducible observations

The [observation rows](production-audit-2026-09-14/observations.json) retain
IDs, timestamps, final project/publication dispositions, trace totals and
verdict classifications from the MCP readers. Recalculate with:

```bash
python3 docs/incidents/production-audit-2026-09-14/recalculate.py
```

| Observation | Value and denominator |
|---|---|
| Project requests, September 7–12 | 15 across two projects |
| Final project state | 7 delivered, 7 failed, 1 cancelled |
| Publication | All 7 delivered rows report published |
| Trace coverage | 13/15; two rejected configurations never started and return no trace |
| Trace calls/events | 298 calls, 1,406 projected events |
| Known trace cost | 25.9603138 USD; two costs unknown, never imputed as zero |
| Known cost of non-delivered projects | 13.8535054 USD, 53.36% of known trace cost |
| Median known trace cost | 1.5683004 USD, n=13 |
| Project elapsed time | 11,237.819 s total; median 827.106 s, n=13 |
| Verdict coverage | 13/15; two disagree with final project state |
| Observed first LLM tier | L3 in all 13 traces; no short-first denominator established |
| Filesystem seed provenance | Unknown in these projections; do not infer it from goal prose |

These are descriptive subscription API-list cost estimates, not invoices or a
controlled benchmark. The two projects are not a representative product sample.
Historical default-zero deepening counters do not establish routing intent.
An L3 first event alone does not prove which depth option was requested.

MCP projects/runs and traces are separate reads, not an atomic snapshot. Trace
readers omit model payloads and expose bounded metadata; all 13 returned
`nextOffset: null` at limit 1000. Source revision, launch logs, primary SQLite,
project Git bases and full trace payload coverage remain incomplete. All 13
matching verdicts were retrieved, including their model-authored findings.
This collection cannot replace the six-tier backup or a production restore drill.
Raw MCP projections are retained locally; the committed rows omit goals,
account names, host paths, artifact contents and model-authored prose.

## Reconciliation findings

`1ab9c4d3` has a delivered analyst classification but failed project
finalization on an excluded artifact path. Its project cost is absent; the
trace recovers 1.8659222 USD. The current project contract already preserves
spend on host finalization failure. This read does not rewrite historical rows.

`39f2fbfd` also has a delivered verdict classification but a failed project
row: trace eligibility refused failed/cancelled/degraded evidence. The analyst
reports repeated upstream DNS failures and an incomplete fallback accepted by
trust. That is a review lead, not proof that the project published bad output:
the final project row is failed and has no publication.

The analyst's `record_probe` availability observation is consistent with the
intentional HTTP capability scope: it is not a reason to add that tool back.
The npm update notice classified as a security incident is model assessment,
not evidence that an update ran or that this host was compromised.

## Duration defect, reproduced and corrected

Every public project row returned `durationS: null`, including finished runs
with both timestamps. `publicRun` hardcoded that value. It now derives elapsed
project seconds at the shared HTTP/MCP boundary without reading trace bodies,
writing the database or conflating project time with trace execution time.
Missing endpoints and reversed intervals remain null; a zero interval is zero.

The production ProjectStore/service regression first failed for delivered,
failed and zero-duration cancelled cases. After the correction, seven duration
cases and the existing service/MCP tests passed (41 tests in the focused run).
This source correction has not been deployed to production by this audit.

## Independent checks of the published artifact

The latest published revision `8fda88b6ff491aa31e7a3a667dc072cb889fc232` was
copied into a local worker with no external network, under the global lease.
Windows checkout line endings were normalized and every one of the six files
matched its production manifest SHA-256 before the final test pass. The earlier
CRLF pass is retained locally and is not the byte-identity evidence.

The [test result](production-audit-2026-09-14/published-artifact-check.json)
records three passing original Node tests, HTTP 200 for `/health`, `/` and
`/app.js`, and seven real Chromium pointer scenarios: initial disabled export,
successful Blob contents, pending-request disablement and replacement, HTTP
502, transport failure, unreadable JSON, and successful recovery. API responses
were intercepted and deterministic. This proves client behavior against those
responses; it does not test current production egress or external availability.
The [browser harness](production-audit-2026-09-14/browser-check.cjs.gz) and
[worker harness](production-audit-2026-09-14/check-published.mjs.gz) preserve
the exact dated diagnostic source, with its local paths, compressed as evidence.
Workers were drained before further source checks. No production artifact,
publication, model setting or trust counter was changed.

## Next live batch

The offline recovery review also reproduced admission of `orgs/D:escape`,
`orgs/file:stream` and `orgs/.. /escape` without extracting them. These POSIX
spellings can change Windows path interpretation. Recovery now refuses colon
components and trailing-dot/space aliases before allocating the destination,
on every platform; three checksum-valid archive regressions exercise refusal.
All three failed against the prior script on Linux (where these spellings
stay ordinary files), then all nine recovery tests passed on Linux and native
Windows after the correction. The admission-only reproduction extracted nothing.

The local seeded counter's verification retry failure remains open. The
production verdicts provide older evidence of expensive verification replays,
but metadata-only trace reads cannot establish a new remediation contract.
Review the full evidence and intermediate-assertion workflow before another
paid batch. This session runs deterministic regressions and independent
artifact checks; it does not add a same-session validator, weaken proof, or
spend more model quota to retry an unchanged failure.

## Final verification

The final source passed documentation checks, both TypeScript configurations,
lint and the full suite: 4,040 passed, 10 skipped, across 319 passing test files
and one skipped file (`--maxWorkers=2`). The recovery suite also passed all
nine cases on native Windows. Build, dependency audit (zero vulnerabilities),
compiled MCP/viz and auth/OAuth smokes, and the compiled CLI help smokes
passed in the release verification chain. No paid model call was made by this
validation session.
