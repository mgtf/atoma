# Production runs over the README use cases — 2026-09-26

Seven runs on production (`atoma.run`, revision `476caea`), one per use case the
README advertises, launched over the MCP by an organisation member, one at a
time. Every tier ran on the member's own ChatGPT account (`own:openai`): L1
`gpt-5.6-luna`, L2 `gpt-5.6-terra`, L3 `gpt-5.6-sol`, except the comparison
rerun. Costs are the platform's own estimate for a subscription (`costUsd`),
not an invoice.

## The runs

| Run | Use case | Project | Outcome | Duration | Cost |
|---|---|---|---|---|---|
| R1 `754dd4d8` | Data: CSV→JSON CLI, 7 approved review criteria | csv-json-cli | delivered, published (created) | 471 s | $0.098 |
| R2 `c4c270f9` | Retail: the README's sales-dashboard example, verbatim, drafted checklist | sales-dashboard | delivered, published | 679 s | $0.114 |
| R3 `6a979b8d` | Logistics: shipment status server + page, 7 HTTP + 2 review criteria | shipment-status | delivered | 331 s | $0.087 |
| R4 `134d916a` | Agencies: project estimator, 7 review criteria incl. two widths | project-estimator | delivered | 292 s | $0.038 |
| R5 `5a5f1e27` | SaaS: continuation of partial `cc922a60` | saas-validation | partial (refused after one remediation) | 840 s | $0.176 |
| R6 `7bc86c1f` | Comparison rerun of R1 on L1 `gpt-5.6-terra` | csv-json-cli | delivered, not published (by contract) | 333 s | $0.612 |
| R7 `80d1af73` | Data: technical documentation of R1's CLI, continuation | csv-json-cli | delivered, published (extended on R1's commit) | 528 s | $0.110 |

What held, read from the traces rather than the banners:

- R1's final `npm test` is a host-observed `record_probe` (exit 0, 3/3 tests).
- R3's seven HTTP criteria are all `covered` by host-observed `fetch_url`
  requests to the server the run started (`?status=delayed` returned only the
  five delayed shipments; `?status=lost` answered 400).
- Continuation seeds from the right run: R5 from the partial `cc922a60` and
  handed its landing reason; R7 from R1, not from the rerun R6, and published
  as `extended` on R1's commit with `csv2json.mjs` byte-identical.
- The rerun R6 carries `rerunOf`, its immutable `modelOverrides`, source `run`,
  and did not publish. Same criteria, same starting workspace: 29 % faster than
  R1 at 6.2× the cost.
- R2's preview opened as a static preview on the previews domain.

## Incidents

Collected during the session and designed once afterwards (cooling-off rule).

**I1 — parallel project creation over MCP.** Several concurrent
`atoma_project_create` calls failed on production on 2026-09-25; the same calls
made one at a time succeeded, and four concurrent tool calls on one session
over the real host and SDK succeed locally. Not reproduced; not fixed.

**I2 — the post-run analyst refuses the next run.** Three `atoma_run_start`
calls were answered 409 because the resident analyst held the machine-global
run slot for a post-mortem (12:01, 12:15, 13:12 UTC): after every run, a member
chaining runs waits about three minutes. Holding the slot for maintenance is
the documented resource trade on the 4 GB host (`src/supervisor/AGENTS.md`),
so it is unchanged. What was wrong is the message: the lease's own text, with
the holder's run id, the host pid and its start time, reached the tenant
verbatim. Fixed: the member reads why and when to retry (`tenantBusyMessage`),
the host log keeps the detail.
*Proposal for the owner, not built:* let a product run PREEMPT the analyst —
abort its session (the session runner already terminates the process group on
timeout; an abort signal would reuse that path), give the analysed run back its
single attempt, then take the slot. The two would still never run together.

**I3 — a run start without task augmentation is cut after five minutes.**
Claude Code aborts a call that sends "no response or progress for 300s"; every
run start past five minutes was cut that way while the run carried on. The
SDK's automatic polling for `taskSupport: 'optional'` is silent. Fixed: a
caller that sent a `progressToken` hears `notifications/progress` with the
run's status line at once and every 30 s (`requestHeartbeat`).

**I4 — Codex tool arguments fail on whole-page writes.** `argumentsJson` is
JSON inside a JSON string. R2 lost eight consecutive whole-page `write_file`
actions (12:22 → 12:28), about 8.5 of its 11 minutes, then shipped the page
minified onto ONE line: the customer received a 6.3 KB single-line
`index.html`, with no sample CSV and no README. R1 lost one. The observation
said only "must encode a JSON object" and the trace kept `args: {}`, so nobody
could say why. Already noted in four runs on 2026-09-24 and left open. Fixed
without repairing anything (the transport contract forbids it): the observation
names the parser's message, the length, the escaped characters around the
position and a raw control character when that is what stands there; the
protocol states the double encoding with one worked multi-line write.

**I5 — a width criterion accepted without a layout at that width.** R4's
approved criterion "no horizontal overflow at 375 and 1280 pixels wide" was
accepted while both browser observations were laid out at 800×600. The
observation line has carried the viewport since yesterday's review; the cheap
acceptor did not compare. Fixed as a fact, not a gate: the delivery review
reads one mechanical line naming the sizes each document was laid out at
(`observedLayoutsBlock`). No criterion text is parsed. A host-owned layout
probe per named width remains a design question.

**I6 — the static-web molecule was never taught the README port rule.** The
root acceptor refuses a README holding this run's loopback port whatever
molecule wrote it; only the HTTP and full-stack molecules were told to write
`<port>`. The static-web molecule wrote its measured URL into the README in
`cc922a60` and again in R5's first pass, after being handed the first refusal.
Fixed: its canonical prompt and the web branch prompt carry the same rule. The
canonical bootstrap re-aligns the stored prompt on the next boot, which resets
that molecule's trust streak.

**I7 — a false refusal from a dropped assertion.** R5's second pass asserted
`height >= 44` for every control inside `checks.controlsVisible` at each width
(`ok: true`), and the acceptor refused "the probes do not verify the required
44px touch targets". The line a validator reads rendered the smoke result and
never the smoke expression. Fixed: the line carries the expression, bounded to
its head. R5 stays `partial` on the record; its work seeds the next run.

## Observations, not fixed

- **O1** — review criteria get one prose verdict, never one per criterion; a
  person who approved seven criteria cannot see which ones the acceptor judged
  met. A design question for the checklist contract.
- **O2** — R2's drafted item "provides filters" was accepted on a smoke that
  never applied a filter (the code, read from the trace, does wire them).
- **O3** — R2's single-line page is I4's customer-visible cost.
- **O4** — R7 published five scratch probe files (`probe-*.csv`,
  `probe-schema.json`) into the customer's repository.
