# Result preview — consolidated design

> Internal design record · Atoma · 2026-08-28
>
> Status: **consolidated design, not implemented.** This document supersedes
> and replaces three same-day drafts (`docs/sandbox-cl.md`, `docs/sandbox-co.md`,
> `docs/sandbox-gr.md`), deleted at consolidation; their arbitration is recorded
> in [`docs/deployment-docker-launcher-2026-08-28.md`](deployment-docker-launcher-2026-08-28.md),
> which also fixes the deployment shape this design builds on (SaaS on Linux,
> atoma shipped as Docker images, a single in-house **launcher** as the only
> holder of Docker API access). Normative rules stay in the `AGENTS.md` files
> until an implementation lands; link this file from *Historical evidence* at
> approval time. Code anchors are as of 2026-08-28 and may drift.

## 1. Name and product definition

The feature is **result preview**: an authenticated organisation member opens
the application produced by a delivered project run inside an isolated iframe
in the visualizer, and *uses* it — navigation, forms, same-origin fetch,
WebSockets, ephemeral server-side state.

"Sandbox" is not this feature's name: it stays the word of
[`ToolSandbox`](../src/tools/sandbox.ts), which is in-process L1 tool
confinement, **not an isolation boundary**
([F1](saas-architecture.md#3-prerequisite-f1-the-sandbox-is-not-an-isolation-boundary)).
The iframe `sandbox` attribute is a browser mechanism, not the product name.
UI copy (English, `en.json` only): *Preview*.

## 2. Scope (v1)

- **Deliverables supported:** static HTML applications (SPA included) and
  Node.js HTTP applications serving frontend and/or API on one port. CLI and
  other deliverables report a bounded "no preview" reason.
- **Eligibility:** project runs with `status = 'delivered'` only. No preview
  of runs in flight (L1 is writing the workspace), none of failed/cancelled
  runs in v1, none of the operator corpus (CLI/MCP/ungated viz) — the shared
  build workspace is archived by the next run and is structurally
  un-previewable without a snapshot contract (deferred, §21).
- **Roles:** `org:member+` may start, heartbeat, restart, stop; `org:viewer`
  may read status but never triggers code execution; `org:admin|owner` approve
  egress. Platform-admin cross-org reads never grant cross-org execution.
- **Lifecycle:** on demand; stopped after 15 minutes without a trusted UI
  heartbeat; hard stop 2 hours after readiness. State is ephemeral: restart
  begins again from the immutable materialised copy.
- The preview **never reuses the build run's server process** (destroyed by
  `ToolSandbox` cleanup at run end) and **never mutates the delivered
  workspace** (it is the durable deliverable and the seed of the next run,
  `previousDeliveredWorkspace`).

## 3. Grounding facts (measured, with anchors)

- The durable deliverable is the per-run project workspace
  `orgs/<orgId>/projects/<projectId>/runs/<runId>/workspace/`
  (`projectRunHostLayout()`, `src/projects/coordinator.ts:867`), never
  deleted; `hostPaths` are persisted but never serialised to the browser
  (`projectRunPublicSchema`, `src/contracts/projects.ts:281`).
- **The artifact manifest is not runnable.** Measured on a real run: 3 files
  declared of 12 present — `package.json`, `start.sh` and data files sit
  outside the manifest (`buildArtifactManifest`,
  `src/projects/artifacts.ts:307`). A usable preview serves/copies the
  **workspace**, not the manifest (decision D2).
- App kind is machine-readable: `.atoma-probes.json`
  (`validateProbeManifest`, `src/contracts/probeManifest.ts:286`)
  discriminates `web` / `http` / `shell`; the file is excluded from
  publication (`.atoma-*`, `artifacts.ts:151`) and is projected as typed API
  fields, never exposed raw.
- Deliverable servers already obey a start contract: bind
  `process.env.PORT`, emit the literal `LISTENING_ON_PORT=<N>` marker on
  stdout (`start_node_server`, `src/tools/builtin.ts`).
- The session cookie is `HttpOnly` + `SameSite=Lax` and **host-only** (no
  `Domain` attribute, `serializeCookie`, `src/auth/sessions.ts:37`); on a
  separate registrable preview domain it is never sent, by three independent
  layers.
- Reusable isolation discipline: worker containers run `--network none`,
  single mount, `--cap-drop ALL`, `no-new-privileges`, non-root uid:gid,
  bounded resources (`workerRunArgs()`, `src/tools/containerExecutor.ts:28`);
  the per-run egress sidecar uses `--internal` networks with
  `gateway_mode_ipv4/ipv6=isolated` (Docker Engine 28 fail-closed),
  default-deny proxy, bounded teardown and a hard-exit registry
  (`src/tools/egressSidecar.ts:284`). Never a second mount, never
  `--privileged`, never the Docker socket, control plane unreachable from
  run networks (release smoke).

## 4. Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Execution substrate | All containers are created by the **launcher** (single Docker API holder, typed narrow interface — see the deployment record). The preview service never shells out to Docker and the web container never mounts the socket. |
| D2 | Source of bytes | **Filtered immutable copy of the delivered workspace** (D2 detail §5). The declared-artifact cumulative bundle + captured dependency layer of the `co` draft is a deferred hardening (§21): it contradicts the measured manifest gap today and requires exhaustive run-side declaration first. |
| D3 | Isolation runtime | **gVisor `runsc` required** for Node previews in production; no silent fallback to `runc`. Dev profile in §15. |
| D4 | Browser origin | **Separate registrable domain** (`https://<generationHost>.<preview-domain>`), one origin per preview *generation*; wildcard TLS terminated by a trusted proxy (Caddy or equivalent) in front of the Atoma-owned gateway. Public-suffix-aware boot check refuses a configuration where preview and visualizer share a registrable domain. |
| D5 | Access | **One-time 256-bit claim** minted by an authenticated API call, delivered in the URL fragment, exchanged by a gateway bootstrap page for a `__Host-…; HttpOnly; Secure; SameSite=None; Partitioned` cookie. No reusable or shareable preview URL. |
| D6 | Liveness | **Trusted UI heartbeat** from the authenticated parent (every 30 s while the surface is visible). Application traffic, polling, SSE and WebSockets never count as activity — abandoned code cannot keep itself alive. Idle 15 min, hard 2 h. |
| D7 | Start command | Allowlist of exactly one form: **`node <entry>`**. Never `npm start`, never a shell, never a model-authored command replayed. Entry resolution in §6. |
| D8 | App port | Fixed internal `PORT=8080`; readiness = literal `LISTENING_ON_PORT=8080` marker on stdout within 60 s; a marker naming another port is a refusal ("server did not honour PORT"). |
| D9 | Node image | Minimal pinned-by-digest image (`ATOMA_PREVIEW_IMAGE`), same Node major as the build worker; contains no browser, LLM SDK, store, source tree or tool executor. The ingress relay runs from the worker image (`dist/tools` is already packaged). |
| D10 | Egress | Deny by default. The run may *request* exact HTTPS hostnames; only an org admin/owner *approves* them per project. Effective policy = intersection(requested by this run, currently approved). DNS resolved by the trusted sidecar with per-address checks (closes DNS rebinding). |
| D11 | Preview is not a run | It never takes the MCP run lease, never touches the registry/skills/ledger; its pressure is bounded by its own quotas (§11). |
| D12 | UI | GPU client only; the MUI fallback stays frozen. Temporary DOM plane + iframe, never a second Pixi/WebGPU context. |

## 5. Bytes: the materialised copy

Policy (`src/preview/policy.ts`, sharing helpers with
`src/projects/artifacts.ts` — extract/export `secretLike` and the
`resolveWorkspaceFile`/`secureReadWorkspaceFile` pair rather than duplicating
the path jail; publication behaviour stays byte-identical):

- **Static path:** no container. The gateway serves the workspace copy
  read-only. Path rules: percent-decode, `normalizeArtifactPath`, refuse
  traversal/symlinks/special files, `/` and directories resolve to
  `index.html`, no listings, 10 MiB per file (413), bounded reads.
  Exclusions: `.git`, `.atoma*`, `secretLike`. (`node_modules` static serving
  deferred — publication symmetry, reopen on a real case.)
- **Server path:** the launcher mounts a **filtered ephemeral copy**
  (`materializePreviewWorkspace`): walk with lstat, skip symlinks/special
  files, exclusions `.git`/`.atoma*`/`secretLike`, **`node_modules`
  included** (executing needs it; publishing does not), caps
  `ATOMA_PREVIEW_COPY_MAX_BYTES` (512 MiB) and 50 000 files. The copy is
  mounted read-write so the app can write its sqlite/json state — on the
  copy, deleted at teardown; the original workspace is never touched
  (isolation test proves it).
- **No `npm install` at open time**: a missing `node_modules` with a failing
  require yields `failed` with a bounded stderr excerpt (400 bytes). The
  install path is deferred with the declared-bundle extension.

## 6. Classification and entry

- Classification reads `.atoma-probes.json` (bounded 256 KiB): an `http`
  entry ⇒ `node`; else `web` ⇒ `static`; else no preview. Fallback without a
  manifest: `index.html` present ⇒ `static`.
- **Node entry is machine-observed, never model prose**: v1 includes the
  small run-side change where `start_node_server`/`record_probe` stamp an
  optional `entry` field on `http` probe entries (the schema is
  `.passthrough()`, addition compatible). Secondary fallbacks:
  `package.json.main` if a regular in-tree file, then `server.js` →
  `index.js` → `app.js`. Nothing is ever read from `result.output`, README
  text or trace prose, and no `run_shell` is replayed.
- Classification and the resolved entry are computed at delivery time and
  persisted as a bounded **preview descriptor** (§12), so unavailability has
  a stable reason and no per-request filesystem probing occurs.

## 7. Runtime architecture

```text
Browser
  -> https://<generationHost>.<ATOMA_PREVIEW_DOMAIN>   (wildcard TLS proxy)
  -> preview gateway (Atoma-owned: claims, headers, routing, static files)
  -> per-preview ingress relay ──► app container (runsc)
         │                          network atoma-preview-net-<id>
         └── attached to both:      (--internal, gateway_mode isolated)
             publishable net + internal net
  optional egress sidecar = the only container with an uplink

Atoma web container -> typed API -> launcher (sole Docker API holder)
```

- **Per-preview objects, labelled** `dev.atoma.owner=preview`,
  `dev.atoma.preview=<id>`: internal network (exact egress-sidecar flags),
  app container, ingress relay, optional egress sidecar, ephemeral copy.
- **App container** (created by the launcher): pinned image, `--runtime=runsc`,
  non-root uid:gid, read-only root fs, `--cap-drop ALL`,
  `no-new-privileges`, 0.5 CPU, 512 MiB memory (swap = memory), 64 pids,
  `nofile=1024`, tmpfs `/tmp` 64 MiB and `/data` 128 MiB
  (`ATOMA_DATA_DIR=/data` for mutable demo state; build-run guidance adopts
  the same convention), log rotation 1 MiB, env exactly
  `PORT, HOST, NODE_ENV, HOME, ATOMA_DATA_DIR` — never a spread of the
  parent environment. Single mount: the filtered copy.
- **Ingress relay** (worker image, plain `node:http` like `egressProxy.js`):
  forwards HTTP/1.1 and WebSocket upgrades to the fixed upstream only;
  refuses `CONNECT` (405) and absolute request-targets (400) — it is not a
  proxy, so an app reaching it from the internal network can only reach
  itself; 16 KiB header cap, socket timeout aligned on the TTL, no content
  logging. It is the one component attached to both networks.
- **Readiness:** `LISTENING_ON_PORT=8080` marker within 60 s, then one
  gateway-to-app probe must succeed before any route or claim is exposed.
  Timeout or early exit ⇒ full teardown, `failed`, bounded error.
- **Teardown order:** route/grants → relay → app → egress sidecar → networks
  → ephemeral copy; idempotent, bounded retries (reuse the sidecar's
  helpers — export `removeNetwork`, `quiet`, the sync runners and
  `egressObjectId` from `egressSidecar.ts` instead of copying them). Exit
  registry mirrors `EgressExitRegistry`; boot reconciliation removes every
  labelled orphan and purges orphan copy directories.
- Invariants inherited untouched: control plane unreachable from preview
  networks; one network per preview, never shared (two tenants on a shared
  `--internal` network can read each other); loopback never proxied; never
  `--privileged`, never the Docker socket, never a second mount.

## 8. Origin, claims, iframe and gateway policy

**Origins.** Control plane `https://app.<domain>`; previews
`https://<generationHost>.<preview-domain>` — a distinct registrable domain,
one origin per generation. `Restart` increments the generation and mints a
new origin, so stale service workers, storage and caches can never control a
new generation.

**Claim flow.**

1. Authenticated `open` returns a 256-bit one-time token bound to
   principal/session, org, run, generation and exact host; stored hashed;
   30 s expiry.
2. The URL carries the raw token after `#` — absent from request lines,
   logs, referrers.
3. A gateway-owned bootstrap page posts the fragment to the same preview
   origin; the gateway consumes it and sets
   `__Host-AtomaPreview; HttpOnly; Secure; SameSite=None; Partitioned; Path=/`,
   then replaces the URL with `/`.
4. The grant lasts 5 minutes, renewed only by the authenticated parent's
   heartbeat. Third-party-cookie rejection falls back to a freshly claimed
   top-level tab. Logout, membership loss, stop, restart, idle and hard
   expiry revoke grants. Unknown host, expired claim and wrong-org access
   all return the same generic 404.

**Iframe.**
`sandbox="allow-scripts allow-forms allow-same-origin"` — acceptable only
because every generation is a separate cross-site origin carrying no Atoma
cookie; `referrerpolicy="no-referrer"`; no popups, top navigation,
downloads, fullscreen, pointer lock, camera/microphone/geolocation, payment
or clipboard in v1. The `src` is validated against a strict allowlist of the
preview URL shape (twin of `repository-link.ts`); "Open in new tab" requests
a fresh claim (`noopener,noreferrer`), never copies a stale bearer.

**Gateway-enforced response policy** (application-controlled headers are
stripped/replaced; an app cannot weaken it):

- `Content-Security-Policy`: `frame-ancestors` = exact visualizer origin;
  `default-src`/`connect-src`/scripts/styles/images/fonts/media = `'self'`
  plus the effective approved HTTPS hosts; `frame-src 'none'`,
  `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`;
- restrictive `Permissions-Policy`; `Referrer-Policy: no-referrer`;
  `X-Content-Type-Options: nosniff`; `Cache-Control: no-store`;
  `Cross-Origin-Resource-Policy: same-origin`;
- the grant cookie, client IP, incoming `X-Forwarded-*` and Atoma referrer
  are never forwarded to the generated server; the reserved `/.atoma/*`
  namespace is intercepted; external redirects are refused; oversized
  headers/bodies refused.

The CSP host allowlist is a browser resource policy, **not** a remote-browser
boundary: generated JavaScript runs on the member's machine, and an approved
hostile domain could observe what the member types. The permanent warning in
the chrome states this plainly.

## 9. Egress approvals

- Requested hosts: lower-case exact ASCII DNS names, unique, ≤16, HTTPS
  port 443 only; IP literals, localhost, private suffixes, wildcards and
  metadata destinations refused before persistence. The model requests;
  only an org admin/owner approves, per project.
- Unapproved requested hosts stay blocked and visible in the UI; they do not
  prevent a no-egress preview from starting. Changing approvals stops active
  previews for the project so the next generation gets a coherent CSP and
  sidecar policy.
- The sidecar denies control plane, host gateway, other previews, RFC1918,
  loopback, link-local, CGNAT, multicast and metadata ranges, and pins each
  resolved A/AAAA address before connecting.

## 10. Lifecycle

States, closed and monotonic within a generation:

```text
stopped -> starting -> ready -> stopping -> stopped
                    \-> failed -> stopped on next explicit open
```

- `GET` never changes state; concurrent `open` calls reuse the same
  `starting`/`ready` generation (compare-and-set in the store, §12).
- `Reload` reloads the iframe within the generation; `Restart` revokes
  grants and routes first, tears down, then starts exactly one new
  generation from a fresh copy; `Stop` removes runtime and routes, never
  the delivered workspace.
- WebSockets are drained briefly at stop; every cleanup step is idempotent
  and crash-safe (SIGTERM, SIGKILL, launcher restart, network-removal race).
  On gateway/launcher restart all grants and hosts fail closed; users reopen
  explicitly.

## 11. Quotas

- one current instance per run; two active Node previews per org; four
  globally (`ATOMA_PREVIEW_MAX_PER_ORG`, `ATOMA_PREVIEW_MAX_GLOBAL`);
- five start/restart operations per principal per minute;
- refusal = `429` + bounded `Retry-After`; never evict another user's
  preview, no hidden queue;
- static previews consume no Node quota but their grants/heartbeats expire
  under the same rules.

## 12. Persisted state

All in the existing product SQLite store (`src/core/stores.ts`) — no second
product database. Shapes defined once in `src/contracts/preview.ts`
(`.strict()`, parsed examples at load).

- **`project_run_preview_descriptors`** — one immutable row per delivered
  run, written at delivery: org/project/run identity,
  `available | unavailable`, kind (`static | node`), resolved entry, bounded
  unavailability reason, requested hosts, created-at. No host path in any
  public projection. Runs delivered before this contract exists report
  `legacy-run`; no backfill (cheap today — product data is disposable at
  this stage).
- **`project_run_preview_instances`** — at most one per run: state,
  monotonic generation, internal runtime identity, start/ready/activity/
  expiry timestamps, bounded error code and last-stop reason;
  compare-and-set transitions.
- **`project_preview_egress`** — exact approved hostnames per project, the
  approving principal, timestamp.

Platform events (`src/contracts/platformEvents.ts`): `preview.started`
(info), `preview.stopped` (info), `preview.failed` (warning); `PUSH_ROUTES`
→ `null` (journal-only). Detail carries identity, kind, generation and a
stable reason — **never** a token, grant, URL, host path, app output or
container log.

## 13. API surface and public projection

Routes nested under the gated project hierarchy in the visualizer server,
same org-binding as `cancel`/`publish` (writes bound to the viewer's ACTIVE
org, admins included), exact same-origin required on mutations:

- `GET  …/runs/:runId/preview` — status only (`org:viewer+`), never
  allocates compute or grants.
- `POST …/runs/:runId/preview/open` — idempotent start/reuse; `202` +
  retry delay while starting, `200` + fresh one-time claim when ready.
- `POST …/preview/heartbeat` · `POST …/preview/restart` ·
  `POST …/preview/stop` — `org:member+`.
- `GET|PUT /api/projects/:projectId/preview-egress` — `org:admin|owner`;
  PUT replaces the approved subset with hosts previously requested by a
  delivered run of this project.

Response conventions: `404` unknown/wrongly-nested/cross-org (indistinguishable
from absence); `409` not delivered or unavailable; `429` quota with
`Retry-After`; `503` feature/launcher/image/runsc/gateway unavailable.
Bounded public error codes only — never raw Docker output, logs, paths,
tokens or upstream bodies.

The browser receives an explicit `PreviewSummary` (availability, kind,
state, generation, requested/allowed/blocked hosts, expiries, bounded
reason/error code) — never descriptors, manifests, runtime IDs, launch
hosts or capability material. The project-run public schema becomes an
explicit allowlist of intended fields (today's broad projection can leak
internal manifest fields).

## 14. GPU client, accessibility, i18n

- **Control:** a measured Preview hit target on the run summary card
  (Runs view and Projects run row), separate from the trace target, with
  its own `recordHitTarget` (the full-card toggle hitArea must not swallow
  it). States: idle / starting / ready / failed / stopped; ineligible runs
  show a bounded reason, not a button that fails after the click.
- **Surface:** a temporary full-screen DOM plane over the canvas
  (`DomBridge` + `panel()` view-frame pattern — transparent wrapper, frame
  drawn by the view, no new `.gpu-panel-skin`; extend
  `tests/viz-overlay-stack.test.ts`). Never a second GPU context; suspend or
  hide the scene camera plane while previewing. Host chrome (project/run
  identity, untrusted-app warning, Back/Reload/Restart/Open-in-tab/Stop)
  stays outside the iframe and cannot be covered by generated content. The
  iframe mounts only in `ready`.
- **Accessibility:** named region; localised iframe title with project/run
  context; focus the toolbar on entry, restore to the originating control on
  exit; hidden product tree `inert`; state transitions announced via
  `aria-live="polite"`; Preview and Trace mirrored in the semantic bridge;
  overlay veiling/`inert` preserved when Atoma menus are open.
- **Data:** React Query hooks (`usePreviewStatus`, short polling during
  `starting` only), types inferred from `src/contracts/preview.ts`. Tokens
  never enter persisted state or logs. Preview URLs are cross-origin, so
  they bypass the service worker and the Vite proxy by construction.
- **i18n:** English strings in `en.json` only; the pipeline translates.
  MUI fallback untouched. Member guide gains one topic: a preview is
  ephemeral review evidence, not a deployment.

## 15. Configuration, doctor, and the development profile

Disabled by default; enabling requires every precondition at boot — no
partial insecure mode in production.

```
ATOMA_PREVIEW=1
ATOMA_PREVIEW_DOMAIN=<separate registrable domain>
ATOMA_PREVIEW_GATEWAY_HOST / _PORT
ATOMA_PREVIEW_IMAGE=atoma-preview@sha256:<digest>
ATOMA_PREVIEW_RUNTIME=runsc
ATOMA_PREVIEW_MAX_GLOBAL=4        ATOMA_PREVIEW_MAX_PER_ORG=2
ATOMA_PREVIEW_IDLE_MS=900000      ATOMA_PREVIEW_HARD_MS=7200000
ATOMA_PREVIEW_COPY_MAX_BYTES=536870912
```

Production preconditions: visualizer auth gate on; HTTPS public origin;
distinct registrable preview domain with wildcard DNS/TLS; Docker
Engine 28+; installed runsc; pinned image present; launcher reachable.
`doctor --preview` verifies each one, inspects a real test container from
the host to confirm `.HostConfig.Runtime === "runsc"` (never trusting a
claim from inside the container), and runs an adversarial network/read-only
smoke. Quota-free.

**Development profile (stated here so nobody discovers it at doctor time):**
the feature's real isolation tests require a Linux host or VM with runsc —
macOS/Docker Desktop cannot run them. Local macOS development covers
contracts, policy, gateway, service and client tests (process-level, mocked
seams). A `runc` runtime is permitted **only** with an explicit
`ATOMA_PREVIEW_ALLOW_RUNC_DEV=1` that refuses to boot when the auth gate is
enabled — a loud dev-only escape hatch, never a production fallback.

## 16. Observability

Metrics contain no user code, hostname capability, token, app log, trace
prose or filesystem path. Measure: copy/preparation outcomes and bytes by
kind; start attempts and outcomes by bounded reason; readiness latency;
active gauges (static/node); stops by cause (idle, hard, manual, restart,
crash, logout, policy change); session duration; quota refusals; egress
allow/deny counts per project and hostname (no path or payload); orphans
found/removed at reconciliation. Bounded log retention for operator
diagnosis only; no browser endpoint for raw app logs in v1.

## 17. Failure modes (user-visible)

- legacy run → unavailable, suggest a new run;
- no probe manifest / unresolvable entry → `not-runnable`, run stays
  delivered;
- copy over limits → `copy-limit`; missing `node_modules` at require time →
  `failed` + bounded stderr;
- requested host unapproved → starts with the host blocked, visible in the
  network panel;
- launcher/image/runsc/gateway unavailable → `503`, no fallback runtime;
- capacity → `429` + retry guidance, never evict someone else;
- readiness timeout/crash → routes and grants removed first, full cleanup,
  bounded error, explicit retry;
- third-party cookies blocked → freshly claimed top-level tab;
- idle expiry → `Expired` + reopen action; hard expiry stops regardless of
  activity; gateway/launcher restart → everything fails closed, reopen
  explicitly.

## 18. Considered and rejected

| Idea | Why not |
|---|---|
| WebContainers / Nodebox (browser Node) | Commercial licence / Sustainable-Use licence, invasive COOP/COEP on the host client, incomplete Node semantics. |
| Managed sandbox vendors (E2B, Daytona, CodeSandbox SDK, Modal/Fly/Vercel) | Copy the patterns, not the dependency; the narrow runtime interface keeps them possible later. |
| Serving the artifact manifest as the file allowlist | Measured incomplete (3/12); relative assets outside it break the app. |
| Generated HTML on the visualizer origin | Session cookie + `/api/*` exposure; the origin is the asset. |
| Reusing `ToolSandbox` as the jail | F1: not an isolation boundary. |
| Replaying `run_shell` / model-authored commands | Verification is read-only; entry comes from observed tool args only. |
| Keeping the build run's server alive | Violates the sandbox cleanup contract. |
| Live preview of a run in flight | Races L1 on the same workspace and ports. |
| A public Node port (even loopback outside the relay) | The isolate is reachable only through the preview origin. |
| Loopback port-per-preview origins | Cookies ignore ports: previews would share a cookie jar. |
| Token in the hostname or query | History/log exposure; the fragment claim keeps it off the wire. |
| Second Pixi/WebGPU context; any MUI feature | One-canvas contract; frozen fallback. |
| CLI/terminal in the preview | An execution surface, not visualisation; contradicts L1-only tools. |

## 19. Tests and acceptance

All under `tests/`, mocked LLMs, no paid calls; every regression test
crosses the real boundary that failed.

1. **Contracts/store** — strict descriptor parsing; invalid entry/host/
   wildcard/IP/oversize; store migration; CAS instance transitions and
   monotonic generation under concurrent open/restart; public projection
   contains no path/manifest/hash/runtime-id/host/token; `legacy-run`
   without filesystem guessing.
2. **Policy/copy** — exclusions (`.env`, keys, `.git`, `.atoma*`;
   `node_modules` servable=no/copyable=yes), traversal, NUL/backslash
   variants, real symlink fixtures, TOCTOU mutation, size/count caps, MIME;
   publication byte-identical after helper extraction.
3. **Service/authz** — IDOR and wrong nesting; viewer read-only; member
   lifecycle; admin egress; platform-admin cross-org read but active-org
   writes; missing/foreign Origin; GET side-effect-free; idempotent
   concurrency; exact 404/409/429/503 dispositions.
4. **Gateway/claims** — entropy, hashing, one-time use, 30 s expiry, exact
   binding; raw token absent from logs/state; reserved cookie/path
   unoverridable; generic 404 on wrong host/grant; revocation on logout/
   membership/stop/restart/expiry; exact header policy; hostile upstream
   CSP/X-Frame-Options/Set-Cookie neutralised; redirect/oversize refusals;
   streaming and WebSocket proxying; relay refuses `CONNECT` and absolute
   targets.
5. **Real isolation** (Linux + runsc, `describeDocker`-style skip) — static
   and Node fixtures end-to-end; loopback-bound app reachable via relay;
   `/data` writable then empty after restart; original workspace intact
   after app writes; mounts read-only where declared; no credentials or
   control-plane paths in env/fs; app cannot reach visualizer, host,
   Docker socket, metadata, private ranges or a sibling preview; approved
   host succeeds while lookalike/unapproved/IP/port/rebound fail; resource
   limits; host-side `runsc` inspection; cleanup across readiness failure,
   stop, SIGTERM, SIGKILL, launcher crash, network race; no labelled object
   survives the release smoke.
6. **Browser/GPU** (real machine, not in `release:check`) — generated app
   cannot read the parent or its cookies; blocked capabilities stay
   blocked; approved fetch works, others fail; chrome stays above the app;
   new generation escapes old service workers/storage; cookie-blocked
   fallback works; focus/inert behaviour; the real Pixi hit target opens
   the surface and Back/Reload/Restart/Open/Stop are exercised through
   observable outcomes.

Verification commands: `docs:check`, `typecheck`, `lint`, `test`, `check`,
`build`, `release:check` (release-path change ⇒ worker build/isolation
too), the preview isolation smoke, `viz:smoke` on a real machine,
`git diff --check`.

## 20. Implementation sequence

Phase 0 is shared infrastructure and gates the rest (see the deployment
record): the launcher contract and the migration of run-container creation
behind it.

1. **P0 — Launcher**: typed contract in `src/contracts/`, launcher service,
   `src/tools` container code behind the seam, run path unchanged
   behaviourally.
2. **P1 — Contracts + policy + descriptor**: `src/contracts/preview.ts`,
   platform-event kinds, `secretLike`/`secureRead` extraction, copy policy,
   delivery-time descriptor + store tables, run-side `entry` stamping
   (tests 1–2).
3. **P2 — Runtime**: app container profile, ingress relay
   (`src/tools/previewIngress.ts`), per-preview networks, readiness,
   teardown/exit registry/boot reconciliation (test 5 seams; image-closure
   test sees the new import).
4. **P3 — Gateway + claims**: static serving, claim bootstrap, header
   policy, routing, TTLs and sweeper (test 4).
5. **P4 — API + GPU client**: gated routes, public projection, hooks,
   control, DOM plane, a11y, `en.json` (tests 3, 6; overlay-stack test
   extended).
6. **P5 — Ops + release**: doctor `--preview`, env docs, images in the
   release contract + compose reference, isolation smoke in release
   acceptance, `src/preview/AGENTS.md` + sibling `CLAUDE.md` + root map
   entry, `docs:check` green, links from *Historical evidence*.

## 21. Non-goals (v1) and deferred extensions

Out of v1: preview of runs in flight; failed/cancelled runs; the operator
corpus (requires a per-trace workspace snapshot contract first); persistent
server state; public/shareable URLs; arbitrary launch commands, installs,
builds or Dockerfiles at open time; multiple services/ports; non-Node
runtimes; remote streamed browser; IDE/terminal/source mutation; production
hosting guarantees; weakening the publication policy.

Deferred, each behind its own decision and threat review: the
declared-artifact cumulative bundle + captured dependency layer (supersedes
the workspace copy once run-side declaration is exhaustive); `npm install`
at open time behind the egress sidecar; SPA fallback driven by a declared
signal; static `node_modules` serving; operator workspace snapshots; a
managed-vendor or Kubernetes `PreviewRuntime` backend; multi-service
descriptors; checkpointed state; a shared artifact-deletion contract for
publication and preview.
