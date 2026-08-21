# Platform events — AGENTS.md

`src/platform/` owns the control-plane audit journal, the one source of
notifications.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
This file is the whole platform-events contract.

Neighbours:

- [`src/contracts`](../contracts/AGENTS.md) — the closed kind vocabulary
- [`src/viz`](../viz/AGENTS.md) — the routes and push delivery
- [`src/projects`](../projects/AGENTS.md) — an emitting domain
- [`src/github`](../github/AGENTS.md) — an emitting domain

## Contract

- PLATFORM EVENTS are the control-plane audit journal (`platform_events`,
  gated deployments only) and the ONE source of notifications. Emitters
  journal a fact; `PUSH_ROUTES` decides who hears about it. Nothing may
  call the notifier directly — that is what keeps every push attributable.
  - `src/contracts/platformEvents.ts` owns the closed kind vocabulary.
    Severity is derived from the kind in one exhaustive
    `Record<PlatformEventKind, …>`, so one kind can never be journaled at
    two severities, and `PUSH_ROUTES` is exhaustive too: a new kind does
    not compile until its severity AND its audience are stated. `null`
    means journal-only, which is the answer for most kinds — a short push
    list is a credible one.
  - `PlatformEventLog.append` is FAIL-OPEN like the ledger, but louder:
    each distinct failure reason warns once on one compacted line, with
    the reason set bounded. Every untrusted string entering a `summary`
    goes through `eventLabel` — the log drops what it cannot store, so an
    unbounded display name would silently lose the audit row.
  - `summary` is operator-facing English; `detail` is the machine-readable
    payload push copy renders from. Never a token (not even hashed), never
    a credential, never model-authored prose.
  - Domain modules (`src/projects/`, `src/github/`) take an injected
    `PlatformEventSink`, never a store: the dependency arrow points from
    the server at the domain, and an absent sink means "no journal".
  - The operator CLI writes its rows from its own process — audited,
    notifying nobody — so operator power changing hands survives in the
    journal with no server running.
  - Readers TOLERATE foreign rows: an unknown kind or a torn `detail`
    renders raw rather than blinding the page around it. Retention cuts by
    age (`ATOMA_EVENTS_RETENTION_DAYS`, 90d) AND by a 50k row cap, swept
    from the viz server's existing 5-minute timer.
  - `/api/admin/events` and `/api/admin/ledger` are platform-admin only,
    beside the registry and skill surfaces. They are two SEPARATE reads:
    `lifecycle_events` keeps its counter-checking semantics and its own
    `ledger check` consumer, and the two tables are never joined.
  - Design record and the five settled decisions:
    [platform events](../../docs/platform-events-design.md).
