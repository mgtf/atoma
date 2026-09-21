# Cross-organisation read audit — W11

Implemented and regression-tested in CI at `4788dfd` on 2026-09-20.
This implements decision 1 in [the SaaS plan](saas-architecture.md).
The platform-admin role remains the authority; this introduces no temporary
grant and no change to organisation-bound writes.

## Polling and receipt policy

The recorded one-second polling risk is still present in
[the live run hook](../src/viz/client/use-runs.ts): an active trace is fetched
once per second. This is a source cadence, not a new production measurement.
One event per poll would generate 86,400 rows per day for one continuous
reader/organisation pair, exceeding the existing 50,000-row journal ceiling.

One committed `admin.cross_org_read` receipt therefore covers the next hour
for the same administrator principal and target organisation, across all five
HTTP/MCP surfaces. Continuous reads produce about 24 receipts per day per pair
instead of 86,400. This is a record of access during a window, not a log of
every fetched project, trace, page or request count. The first surface is
recorded as context; it does not limit what the receipt groups. A different
administrator or organisation receives its own receipt. The first read after
the hour expires records another. A future-dated receipt after clock rollback
cannot suppress a current read. Existing journal retention and row caps remain
in force; if a receipt is evicted, the next read records another.

Every request still checks the current viewer's role. The receipt is never
used as permission. Reads in the viewer's active organisation, the public
commons, and operator benchmark files do not constitute cross-org reads.

## Persistence and failure

`PlatformEventLog.recordCrossOrgRead` uses the existing product journal, with
an index on principal, organisation and time for this kind. A polling hit is
an indexed read. On a miss, an immediate transaction repeats that read and
inserts the receipt; another connection cannot pass the same missing-receipt
check concurrently. Restarting a server reuses committed receipts rather than
forgetting an in-memory suppression cache.

The common persistence path supplies one insert implementation. Subscribers
are invoked only after the audit transaction commits. Ordinary platform event
append remains fail-open; this strict read-audit entry point throws when the
journal cannot acknowledge persistence. `ProjectService.auditRead` maps that
failure to HTTP 503 or an MCP refusal before foreign payload bytes are returned.
An absent audit dependency also refuses foreign reads; own-org reads remain
available. The sink acknowledges synchronously, so a void or asynchronous
fire-and-forget implementation cannot silently certify the audit.

## Surfaces and audience

| Read | Audit placement |
|---|---|
| All projects | Before projecting each foreign organisation's project data |
| Project runs / run status | After resolving the owning organisation, before reading its run payloads |
| All run traces index | Before reading and summarising each foreign trace |
| One HTTP trace | During trace ownership resolution, before opening its bytes |
| One MCP project trace | After selecting the run, before opening its bytes |

`admin.cross_org_read` has security severity and targets the organisation's
owners through the existing notification router and tray. Push delivery still
requires a subscription; it is not an email guarantee. The actor is excluded
by the router's existing self-notification rule. Copy uses the server's English
fallback and contains no project names, trace prose, tokens or credentials.
The journal records the administrator principal and target organisation IDs.

The two explicit changes to the service contract are the synchronous
`CrossOrgReadSink` dependency and the shared `ProjectService.auditRead` seam.
The MCP and trace routes reuse it. Domain code never acquires the event store
or calls notification delivery directly.

## Executed verification

- `tests/cross-org-read-audit.test.ts`: all surface names share the durable
  receipt, reopen and expiry, separate principals/organisations, role checks,
  failed insertion, notification after commit, and owner-only audience.
- `tests/viz-auth-gate.test.ts`: real server/login and SQLite, each of the four
  HTTP paths independently journaled, repeat coalescing, 503 on journal failure,
  and loss of access after revocation.
- `tests/mcp-http.test.ts`: foreign trace read through the real MCP transport
  writes the target organisation's audit receipt.

These regression checks passed in [CI at `4788dfd`](https://github.com/mgtf/atoma/actions/runs/35478666242),
alongside TypeScript, lint and documentation checks. W13/W14 hosted acceptance
remains separate; see the [receipt](saas-acceptance-2026-09-20.md).
