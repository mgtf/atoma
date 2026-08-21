# Platform events and notification routing — design

Status: **implemented 2026-08-21**. Companion to the web-push base landed the
same day (`src/viz/push/`, `onRunFinished` hook on `ProjectRunCoordinator`).
The active rules extracted from this document live in AGENTS.md under
"Contracts and storage"; this file is the reasoning behind them.

The five questions that gated implementation were settled by the operator on
2026-08-21; each decision is folded into the sections below and restated in
[Settled decisions](#settled-decisions).

## Problem

Today exactly one thing sends a notification: a project run reaching a
terminal state (`delivered` / `failed` / `cancelled`), emitted from the
`finally` of `ProjectRunCoordinator.finish` via the `onRunFinished` hook and
pushed to the requesting principal only. Everything else is silent, and the
survey behind this design found three blind spots:

- **A GitHub publication failure is invisible.** The publisher's throw is
  swallowed by the coordinator (its catch only transitions runs still in
  `running`); the only trace is the `error` column on `project_publications`.
  Nobody learns the repository was never created.
- **Security rejections are not journaled anywhere**: invalid webhook
  signatures (401), login rate-limit trips (429),
  `TooManyPendingOauthStatesError`. No structured log exists.
- `completeLogin` does not tell its caller **whether an organisation was just
  created** or an invitation consumed (`LoginOutcome` only carries
  `createdPrincipal`), so the two highest-value admin signals cannot be
  emitted without a small store change.

Two goals, one layer: (1) route real notifications to the right audiences,
(2) give the platform admin an auditable journal of what happens on the
platform.

## Event → audience → channel matrix

Naming convention: `domain.action`. "Push" means a Web Push notification;
**every** event is always journaled in the audit layer — push is additive.

### Clients (the acting member)

| Event | Anchor | Push | Priority |
|---|---|---|---|
| `run.finished` (delivered/failed/cancelled) | `coordinator.finish` (existing) | ✅ requester — **already live** | P0 done |
| `publication.published` (repo created + commit pushed) | `publisher.publish` success | ✅ requester — the real end of the value ("your repo is ready") | P1 |
| `publication.failed` | `publisher.publish` catch (`src/projects/publisher.ts` ~L284) | ✅ requester (action: retry) | **P0** |

### Organisation owners (`role = org:owner`)

| Event | Anchor | Push | Priority |
|---|---|---|---|
| `org.member_joined` (invitation consumed) | `completeLogin` with invitation | ✅ owners **and the platform admin** (decision 2) | P1 |
| `publication.failed` | as above | ✅ owners (in addition to the requester) | P0 |
| `github.installation_status` (suspended/deleted) | webhook (`src/github/webhook.ts` `installationMutation`) | ✅ owners — the publication pipeline just broke | P1 |
| `project.created`, `run.started`, `run.cancelled`, `github.installation_linked` | `ProjectService.*`, `completeGitHubSetup` | ❌ audit only (noise) | P1–P2 |

### Platform admin

| Event | Anchor | Push | Priority |
|---|---|---|---|
| `org.created` (first login without invitation) | `completeLogin` new-principal path (`src/auth/store.ts` ~L649) | ✅ — THE SaaS signal | **P0** |
| `server.recovered` (runs/publications reconciled at boot) | `reconcileInterrupted` call in `src/viz/server.ts` | ✅ — a prior crash happened | **P0** |
| `admin.granted` / `admin.revoked` | `AuthStore.grant/revokePlatformAdmin` (CLI) | ✅ other admins (security) | **P0** |
| `auth.state_flood` (`TooManyPendingOauthStatesError`) | server.ts login + github authorize paths | ✅ (attack signal) | P1 |
| `org.member_joined` (any org) | `completeLogin` with invitation | ✅ (decision 2) | P1 |
| `run.finished` failed (any org — org runs mutate the shared registry) | already emitted | ❌ audit only (decision 1) | P1 |
| `webhook.rejected` (invalid signature), `auth.rate_limited`, `invitation.created`, `push.subscribed/unsubscribed` | github/http.ts, webhook.ts, server.ts, CLI | ❌ audit only | P1–P2 |

**Anti-noise rules**: never notify the actor of their own administrative
action; `run.finished` keeps pushing to the requester only; the admin push
list stays short and curated — everything else lives in the audit journal.

## The events layer: yes, and separate from the ledger

The existing ledger (`lifecycle_events`, `src/core/ledger.ts`) is a
product-internal journal: atom-type and skill trust counters, consumed by
`ledger check` and MCP, with an order-sensitive projection over `seq`.
Injecting control-plane events (who, which org, which security surface) into
it would pollute its entity/kind schema and its counter checks. Instead: a
**new table group on the ONE product store** (same pattern as the projects,
github and push groups, joined via `openStoreHandle`):

```sql
CREATE TABLE IF NOT EXISTS platform_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,   -- ordering, like lifecycle_events
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,                       -- closed enum from the contract
  severity   TEXT NOT NULL,                       -- info | warning | error | security
  actor_type TEXT NOT NULL,                       -- principal | system | cli | webhook
  actor_id   TEXT,                                -- principalId when actor_type = principal
  org_id TEXT, project_id TEXT, run_id TEXT,
  summary    TEXT NOT NULL,                       -- bounded (<=200), English, zero secrets
  detail     TEXT                                 -- bounded JSON (<=2000), shape per kind
);
```

- **Contract**: `src/contracts/platformEvents.ts` — zod schema, closed `kind`
  enum, `EXAMPLE_*` constants parsed at module load (the
  `scriptEnvelope`/`probeManifest` convention, pinned by
  `tests/contracts.test.ts`).
- **Store + bus**: `src/platform/events.ts` — `PlatformEventLog` with a
  **fail-open** append (the `appendLedger`/`warnOnce` model: a failed event
  never breaks a request or a run) plus a minimal in-process bus (`append`
  then fan-out to subscribers). The auth CLI, a separate process, **writes
  its row directly** into the same store (WAL): audited, but never pushed —
  only the viz server pushes.
- **Retention**: swept in the server's existing 5-minute timer — cut by age
  (90 days, `ATOMA_EVENTS_RETENTION_DAYS`) **and** by row cap (50,000, the
  `NOT IN (SELECT … ORDER BY seq DESC LIMIT ?)` pattern already used by
  `prefilter_cache` and `push_subscriptions`). `npm run backup` already
  covers the store, so the audit is backed up.
- **Payloads**: same rules as pushes — bounded, never trace prose, never an
  invitation token (not even hashed).

## Notification routing

A `NotificationRouter` (`src/viz/push/router.ts`, server-only) subscribes to
the bus: `kind` → audience rule → principals (owners resolved via
`auth_memberships`, admins via `auth_platform_admins`) → `PushNotifier`,
which gains a generic `notifyPrincipals(principalIds, notification)`. The
audience table is typed `Record<PlatformEventKind, AudienceRule>` so adding a
kind cannot compile until its routing is decided. The current `run.finished`
path is re-plumbed through this single pipeline: the coordinator's
`onRunFinished` hook **stays as is** (a clean domain contract); server.ts
adapts it into an event emission — one delivery path instead of two. Two
light touch-ups along the way: expose
`createdOrganisation`/`invitationConsumed` on `LoginOutcome`, and emit
`run.cancelled` at the service layer (`coordinator.cancel` does not know the
principal).

**Severity is a property of the kind**, not a per-call-site argument: one
`Record<PlatformEventKind, PlatformEventSeverity>` table in the contract, so
the same kind can never be journaled at two severities. It is still stored on
the row, so a reader can filter without importing the map and history stays
honest if the map later changes.

### Localised push copy (decision 3)

The server cannot infer a browser's language, so the browser tells it once: a
`locale` column on `push_subscriptions`, sent at subscribe time. Rendering
uses a server-side frozen copy map (`PUSH_COPY`, the `AUTH_COPY` /
`GITHUB_COPY` precedent) with `en` and `fr`, not the client i18n catalog —
that module is a `.tsx` carrying a React provider and must not be imported
into the server. An unknown or absent locale falls back to `en`.

## Admin audit surface

- **API**: `GET /api/admin/events?before=<seq>&limit=&kind=&orgId=&severity=`
  — admin-only, inside the existing `/api/admin/*` block, cursor-paged
  newest-first (`before` is an exclusive `seq`, matching the newest-first
  runs timeline), `limit` clamped to ≤ 200 (the MCP precedent), response
  `{ events, nextBefore }`.
- **API**: `GET /api/admin/ledger?limit=` — admin-only read of the product
  ledger's tail (decision 4), a **separate query over `lifecycle_events`**.
  The two tables are never joined or merged; they answer two different
  questions and only share a tab.
- **UI**: a new "Journal" section in the GL Admin tab
  (`renderer/views/admin.ts`, same `createScrollPane`, activation ids
  `admin.events.*`, severity filter chips in P2) followed by a compact
  product-ledger tail, strings in the en/fr i18n catalogs.
- Readers **tolerate unknown kinds**: an event row whose `kind` this build
  does not know is rendered raw rather than dropped. Blinding the audit
  surface is worse than showing an unfamiliar label, and the same rule
  already governs the ledger's unparseable `detail`.

## Explicitly out of scope

No second store file; `lifecycle_events` untouched; no HTTP on the MCP
control plane; no email/SMTP (channels stay Web Push + journal — email is a
later phase if ever); no per-principal notification preferences in the base
(sensible defaults per kind, mute is phase 2); local operator runs (ungated
CLI/MCP) stay out of scope.

## Implementation status (2026-08-21)

Landed and verified in isolation (typecheck plus the full suite against a
worktree holding only these commits, so none of it depends on concurrent
work in the same checkout):

- **Phase 1 — foundation.** `src/contracts/platformEvents.ts`,
  `src/platform/events.ts`, tests.
- **Phase 2 — emissions.** Every site in the matrix above, including the
  three that previously had no witness at all, plus the `LoginOutcome`
  flags and `eventLabel`.
- **Phase 3 — routing.** `PUSH_ROUTES`, `NotificationRouter`,
  `notifyPrincipals`, per-subscription locale, `run.finished` re-plumbed
  through the journal.
- **Phase 4a — audit API.** `/api/admin/events` and `/api/admin/ledger`,
  with a process-level test that reads back a row the operator CLI wrote
  from a different process.
- **Phase 4b — the Admin Journal.** Two stacked sections in the Admin tab:
  the platform journal (newest first, severity-coloured) and the catalogue
  ledger's tail, as two separate reads sharing a tab. Authored in an
  isolated worktree and merged back, because a concurrent session was
  rewriting the same GL modules for the account menu.
- **Phase 5 — AGENTS.md contract.**

Nothing outstanding. The plan is fully implemented.

## Sequencing (one commit per phase)

1. **Foundation**: contract + `PlatformEventLog` (append/list/sweep/cap) +
   bus + tests. No emissions yet.
2. **Emissions**: `LoginOutcome` flags, login/orgs, invitations (API + CLI),
   grant/revoke admin, projects/runs, publisher (published/**failed** —
   emitted inside `publish()` so `retryPublication` is covered too), webhook,
   `reconcileInterrupted`, push subscribe/unsubscribe. Tests per surface.
3. **Push router**: owner/admin audiences, `notifyPrincipals`, `run.finished`
   re-plumbed. Audience-resolution tests.
4. **Admin audit**: API + GL UI + i18n + tests (non-admin 403, pagination).
5. **AGENTS.md**: the contract bullet.

## Settled decisions

Answered by the operator on 2026-08-21; these are the contract now, not
preferences.

1. **Admin push on org run failures: audit only.** Every failure is journaled
   and visible in the Admin tab; none of them pushes. The admin push list
   stays short — and therefore credible: `org.created`, `org.member_joined`,
   `server.recovered`, `admin.granted`, `admin.revoked`, `auth.state_flood`.
   No sliding failure counter is built.
2. **`org.member_joined`: push to the org's owners AND the platform admin.**
   An admission is a security-relevant fact for the owner and a growth signal
   for the operator; neither should have to poll the UI for it.
3. **Push language: stored per subscription.** See
   [Localised push copy](#localised-push-copy-decision-3). English-only was
   rejected: the operator reads French, and the locale is known for free at
   subscribe time.
4. **Admin journal: `platform_events` plus a read-only product-ledger tail**
   in the same tab, as two separate queries. The tables are never merged —
   `lifecycle_events` keeps its counter-checking semantics and its own
   `ledger check` consumer.
5. **Retention: 90 days AND a 50,000-row cap** (`ATOMA_EVENTS_RETENTION_DAYS`
   overrides the age half), swept from the server's existing 5-minute timer.
   Settled by default rather than asked — it matches the existing
   `prefilter_cache` and `push_subscriptions` caps and is adjustable without
   a migration.
