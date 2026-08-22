# Visualizer — AGENTS.md

`src/viz/` owns the trace projection, the gated HTTP surfaces and web push,
plus the GPU product client and its frozen MUI fallback.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
Traces are immutable evidence: project them, never rewrite them.

Neighbours:

- [`src/auth`](../auth/AGENTS.md) — identities, organisations, the admin flag
- [`src/projects`](../projects/AGENTS.md) — org-scoped run storage
- [`src/platform`](../platform/AGENTS.md) — the journal push reads from
- [`src/core`](../core/AGENTS.md) — the trace shapes it projects

## Commands

Visualizer. The GPU client is the product UI (`npm run viz`); MUI is the frozen
fallback. `viz:smoke` is in `release:check`. `viz:smoke:gc` and the mark-turn
film are not: they need a real Chrome and, for GC, a real WebGPU adapter.
`npm run viz`, `doctor:dev` and `auth:dev` fill unset keys from checkout `.env`
so a local GitHub-gated visualizer does not need a shell export. Compiled
`viz:serve` does not load `.env`: production injects the process environment.

```bash
npm run viz
npm run viz:mui
npm run viz:serve
npm run viz:demo
npm run viz:smoke
npm run viz:smoke:gc
npm run viz:mark-turn
npm run viz:mark-turn -- --degree 47
npm run viz:mark-turn -- --pointer
npm run viz:mark-turn:analyze
```

## Trace projection and the GPU client

- Viz projects immutable traces at the typed boundary. Do not mutate raw trace
  prose to display current taxonomy.
- The GPU client (`src/viz/client-gl/`) is the product UI. The MUI client
  (`src/viz/client/`) is FROZEN as a fallback (`ATOMA_VIZ_UI=mui`,
  `npm run viz:mui`): fix breakage, add nothing. Modules under `client/` that
  the GL client imports (types, run-utils, search, timeline-layout,
  structured-detail, i18n, data-api, pwa) are shared library code and stay live.
- `gpu-renderer.ts` holds the stateful renderer class only. Pure chip layout,
  event copy, shaders, motion, and the scroll pane live under
  `client-gl/renderer/`; views are free functions over the exported
  `RendererCtx` (a Pick over the class) in `renderer/views/`. New view code
  goes there, never back into the class.
- Scrollable GPU content goes through `createScrollPane` (bounded + masked);
  the wheel handler FAILS CLOSED on `scrollMax`, so a view that never declares
  its max does not scroll. Cull by skipping draws, not by stopping the layout
  cursor. Detail panes report `detailBounds`/`detailScrollMax`.
- `prefersReducedMotion()` (`renderer/motion.ts`) is the only reduced-motion
  source in the GL client. Every animation system consults it and JUMPS to its
  final state — exit effects are skipped entirely, never left running.
- The GPU client uses one Pixi context (WebGPU with WebGL fallback). Do not add
  a second context for a tiny widget. Smoke tests assert exactly one canvas and
  both backends.
- Keep GPU animation state out of React/Zustand hot paths. Use mutable samples
  read once per frame; do not rebuild the scene for pointer motion.
- A Pixi filter that OUTLIVES one `render()` must never sit `enabled = false`
  across a GC window without `buffer.autoGarbageCollect = false` on its uniform
  buffer. Pixi skips disabled filters, so the buffer stops being touched, ages
  out and is destroyed, while `BindGroupSystem._hash` keeps serving a cached
  bind group that points at it — every later `queue.submit` is then a
  validation error, permanently. Today only the pointer-light filter has that
  lifetime; per-card filters are rebuilt each render and are safe.
- Pixi 8.19.0 WebGPU GC also unloads in-use static uniform buffers (global
  uniforms, batcher UBOs) whose values have not changed, with the same
  destroyed-buffer submit (pixijs#12080). The engine fix (pixijs#12147) is
  not in a release. Until it is, WebGPU init sets `renderer.gc.enabled =
  false`. Do not re-enable GC on WebGPU without that Pixi release; keep the
  pointer-light pin either way. Scene resources are destroyed explicitly in
  `render()`. WebGL GC may stay on.
- GPU lifetime defects are invisible to `tests/` (mocked, no device) and to the
  WebGL fallback (no bind groups). They are covered by `npm run viz:smoke:gc`,
  which needs real Chrome plus a real WebGPU adapter and therefore stays OUT of
  `release:check`; it skips loudly rather than reporting "cannot observe" as
  "verified", and fails if its preconditions never arm. `?atomaDiag=1` exposes
  the read-only renderer handle those smokes need; it is inert otherwise.
- `isRunLive` / `isIndexEntryLive` are the only live predicates. The abandoned
  threshold exceeds plausible LLM/tool activity (currently 12 minutes).
- Runs rails remain aligned to viewport projection. Never apply scene parallax
  to causal timeline geometry.
- `runStatus` is the ONE definition of what happened to a run, and every
  surface that labels one uses it. Cancellation is not failure: a cancelled
  run records an error message by design, so `cancelled` wins over `error`.
- The runs timeline reads NEWEST FIRST and is framed by two bookend rows
  (run ended / run started) that carry the verdict. Bookends are view rows:
  the view publishes `rowOffset` on the timeline viewport and overlays add it,
  or they drift by exactly one row. Ordering lives in `buildTimelineLayout`
  (`newestFirst`) so cards, rails and connectors share one row space;
  `firstRow`/`lastRow` are the DISPLAY range while fork/join connectors keep
  causal rows.
- A branch rail spans its SUBTREE (`subtreeFirstRow`/`subtreeLastRow`): a
  parent is still alive while its children run, and a rail drawn over its own
  events alone leaves child branches visually detached.
- Pixi objects draw local geometry at local origin, then position the object.
  Avoid double-offset hit targets.
- The brand mark is a single Pixi crystal using teal/amber/violet faces, dynamic
  relighting, reduced-motion support, and no overlapping R3F logo.
- The UI is English and catalog-backed; add strings to i18n catalogs rather than
  hardcoding. Tests enforce representative parity, not every incidental string.
- PWA/service-worker registration is production-only. `/api/*`, `/auth/*`,
  `/webhooks/*`, and every response marked `Cache-Control: no-store` stay
  outside the cache so live data, identity state and GitHub deliveries cannot
  be hidden by an offline shell.
- Do not name a root client module `api.ts`; Vite's `/api` proxy can intercept it.
- There is NO Launch tab in the GPU client. A tab that could only DESCRIBE how
  to phrase a goal, beside a Projects tab that actually starts runs, split one
  job over two places; the family guidance (`/api/profiles`, with a
  `launch.help.<id>` catalog override per family) renders inside the project
  run form, on the same condition as the prompt textarea it describes, and its
  examples fill that prompt. `/api/profiles` stays a READER: it is ungated, so
  it must never gain launch power — browser launches live on the authenticated
  project routes, where a session the run does not hold is the boundary. The
  shell path for an instance with no organisations is the `launch` docs theme.
  The FROZEN MUI fallback keeps its own Launch tab: it has no Projects view to
  fold the guidance into, and it is a fallback, not where product decisions get
  expressed.

## Server and gated surfaces

- Operator source launchers (`npm run viz`, `doctor:dev`, `auth:dev`) fill
  unset keys from checkout `.env`. Do not load `.env` inside `src/viz/server.ts`:
  process-level tests spawn it from the repository cwd with a cleaned env.
- Behind the gate the instance-global operator surfaces (`/api/registries`,
  `/api/registry/:id`, `/api/skills/*`, `/api/burnin`) answer ONLY the platform
  admin (403 otherwise) — org runs mutate the shared registry, so an invitation
  must not read operator-level state (review 2026-08-20 §2.2). The admin also
  reads every organisation's projects and run traces, and manages organisations
  through `/api/admin/organisations` and `/api/admin/invitations` (same-origin
  POST). Writes (create project, start/cancel runs) stay bound to the viewer's
  ACTIVE organisation for admins too. `visibleViews` is the one nav definition:
  gated members get org surfaces only; the ungated developer path is unchanged.
  True per-org registry scoping would need org-attributed registry rows — a
  schema project, not a route guard.

## Web push

- Web push notifications exist only behind the viz auth gate. The VAPID
  keypair is generated once and persisted in the product store
  (`push_vapid_keys`); rotating it orphans every browser subscription.
  `ATOMA_VIZ_VAPID_SUBJECT` optionally overrides the JWT subject (default:
  the public origin). Subscriptions (`push_subscriptions`) are
  principal-scoped self-service rows behind same-origin `/api/push/*`
  POSTs; a 404/410 from the push service prunes the row.
  `src/viz/push/webpush.ts` is the ONE RFC 8291/8292 implementation
  (node:crypto only — no web-push dependency), pinned by the RFC 8291
  Appendix A known-answer test. Payloads are bounded and secret-free
  (status title, bounded excerpt, same-origin path — never trace prose).
  The browser permission ask lives in the FIRST LIVE RUN
  (`shouldOfferPushPrompt`), never in the login or signup flow — login
  stays zero-friction; the run is where the value shows. The subscriber's
  language rides the subscription (`locale` column, captured at subscribe
  time) because a push is generated from an event with no request left to
  read a header off; rendering uses the server-side frozen `PUSH_COPY`
  map in `src/viz/push/routes.ts`, never the client i18n catalog (a
  `.tsx` carrying a React provider must not reach the server).
