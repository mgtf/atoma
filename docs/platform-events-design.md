# Platform events and notification routing — design

Status: **proposed, not implemented** (planned 2026-08-21, open questions below
still unanswered). Companion to the web-push base landed the same day
(`src/viz/push/`, `onRunFinished` hook on `ProjectRunCoordinator`).

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
| `org.member_joined` (invitation consumed) | `completeLogin` with invitation | ✅ owners | P1 |
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
| `run.finished` failed (any org — org runs mutate the shared registry) | already emitted | ❌ audit only by default, optional threshold | P1 |
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
current `run.finished` path is re-plumbed through this single pipeline: the
coordinator's `onRunFinished` hook **stays as is** (a clean domain contract);
server.ts adapts it into an event emission — one delivery path instead of
two. Two light touch-ups along the way: expose
`createdOrganisation`/`invitationConsumed` on `LoginOutcome`, and emit
`run.cancelled` at the service layer (`coordinator.cancel` does not know the
principal).

## Admin audit surface

- **API**: `GET /api/admin/events?after=<seq>&limit=&kind=&orgId=&severity=`
  — admin-only, inside the existing `/api/admin/*` block, cursor-paged on
  descending `seq`, `limit` clamped to ≤ 200 (the MCP precedent), response
  `{ events, nextAfter }`.
- **UI**: a new "Journal" section in the GL Admin tab
  (`renderer/views/admin.ts`, same `createScrollPane`, activation ids
  `admin.events.*`, severity filter chips in P2), strings in the en/fr i18n
  catalogs.

## Explicitly out of scope

No second store file; `lifecycle_events` untouched; no HTTP on the MCP
control plane; no email/SMTP (channels stay Web Push + journal — email is a
later phase if ever); no per-principal notification preferences in the base
(sensible defaults per kind, mute is phase 2); local operator runs (ungated
CLI/MCP) stay out of scope.

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

## Open questions (to settle before implementing)

1. **Admin push on org run failures**: audit-only by default seems right — is
   a push wanted, possibly thresholded (e.g. ≥3 failures/24h)?
2. **`org.member_joined`**: push to owners, or audit only?
3. **Retention**: 90 days / 50,000 rows acceptable?
4. **Push language**: the server does not know the browser locale — stay
   English everywhere?
5. **Admin journal scope**: `platform_events` only, or also a read-only view
   of the product ledger (skill promotions/demotions) in the same tab —
   separate read, never a table merge?
