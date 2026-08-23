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
fallback. Every launcher here also arms the mechanical watch in-process behind
the gate (`--no-sentinel`, `--sentinel-interval`, `--cost-alert`, or
`ATOMA_VIZ_SENTINEL=0` on the launcher path, which forwards no flags). `viz:smoke` is in `release:check`. `viz:smoke:gc` and the mark-turn
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
- `isRunLive` / `isIndexEntryLive` are the only live predicates, and they live
  in `src/viz/liveness.ts`, OUTSIDE `client/`, because server-side readers ask
  the same question (the sentinel's operator source). `client/run-utils.ts`
  re-exports them, so there is one definition behind both import paths. The
  abandoned threshold exceeds plausible LLM/tool activity (currently 12 min).
- NOTHING outside `client/` and `client-gl/` may import `src/viz/client/*` at
  runtime. `viz:build` EMPTIES `dist/viz/client/`, so the `.js` tsc emitted
  there is gone by the end of `npm run build` and a compiled server importing
  it dies with ERR_MODULE_NOT_FOUND — invisible to typecheck, lint and
  `tests/`, all of which run from source. `tests/viz-client-bundle-boundary`
  is the cheap guard; `viz:smoke` is the behavioural proof.
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
- The gem's CAST is ONE polygon on TWO surfaces — the far-field mesh behind the
  UI and the pointer-light stage filter over it, so it crosses buttons and
  frames instead of stopping at the backdrop. `projectMarkCaustic` alone derives
  its throw falloff, `packMarkCaustic` alone writes its corners,
  `renderer/caustic-shader.ts` alone tests containment, in GLSL kept ES 1.00-legal.
- The UI is English and catalog-backed; add strings to i18n catalogs rather than
  hardcoding. Tests enforce representative parity, not every incidental string.
- PWA/service-worker registration is production-only. `/api/*`, `/auth/*`,
  `/webhooks/*`, and every response marked `Cache-Control: no-store` stay
  outside the cache so live data, identity state and GitHub deliveries cannot
  be hidden by an offline shell.
- Do not name a root client module `api.ts`; Vite's `/api` proxy can intercept it.
- ONE frame style, and ONE definition for the SINGLE-COLUMN views:
  `renderer/view-frame.ts`. Projects/Admin/Settings/Burn-in use its elevation-2
  `panel()`, title and `VIEW_FRAME_CONTENT_TOP`; the established split views
  (Registry/Skills/Docs/Runs) keep their own pane geometry. The app had grown
  two single-column conventions, one framed and one with a title floating at
  y = 78, so one product carried two ideas of what a surface is. A DOM overlay
  that sits inside a column uses `.gpu-panel-skin`, the sole CSS restatement of
  `panel()`'s fill, border, radius and elevation-2 resting shadows (the GL
  shadows swing with the pointer light). Do not add a per-form skin beside it.
- The app OPENS on Projects, the authenticated launch surface. Runs is where
  you go to watch what you started, which is a second step, not an arrival. The
  unroutable-view fallback lands on Projects too. On the ungated developer path
  project routes do not exist, so Projects shows its explanatory empty state
  and the DOM mutation form is absent.
- The ADMIN PLANE is FOUR views, one per job — Organisations (`admin`), the
  platform journal, the catalogue ledger, and the Sentinel — under one nav
  heading. It was one tab holding all four: three questions on one screen, and
  one scroll position between them, so the journal could never page past its
  first page. `ADMIN_VIEWS` in `store.ts` is the one list and the rail reads
  it; each view's query is enabled on ITS OWN view.
- The journal PAGES and FILTERS SERVER-SIDE. `nextBefore` is an exclusive
  `seq` cursor, so a page boundary can neither repeat nor skip a row; filters
  ride the query key, because filtering loaded pages client-side would THIN
  each page instead of finding more matching rows. Filters are two closed
  vocabularies: severity, and the kind's FAMILY
  (`PLATFORM_EVENT_FAMILIES`, derived from the kind list, never written twice).
  Live tailing polls only while ONE page is loaded — React Query refetches
  every loaded page. Reaching the bottom asks for the next page: the wheel
  handler is the only place that knows a view's scroll maximum, so it announces
  `scroll.end.<view>` through the ordinary activation channel and the handler
  is idempotent. The foot-of-list button is that page by keyboard.
- THE SERVER HOSTS THE MECHANICAL WATCH in-process whenever the auth gate is
  on: `npm run viz`, `viz:dev` and `viz:serve` are all this file, so one
  placement arms the development launcher and the release contract alike — a
  watch spawned beside `viz-dev.mjs` would have armed only the development
  path. It exists where the journal does, because de-duplication is against
  the journal and a watch with nowhere to write is theatre; the ungated path
  says so in the boot banner, and `npm run sentinel` is its watch. That banner
  line is also the answer to "one command for the whole stack": there is
  nothing else to launch, so there is no `npm run atoma` — and the MCP server
  could not join one anyway, spawned as it is by its client over stdio.
  `sentinelSources()` is shared with `/api/admin/sentinel`, so the screen
  describes the corpora the watch actually covers.
- The SENTINEL view may report the watch's health, and ONLY ITS OWN. That
  became sayable when the tick moved in-process; before, the honest answer was
  silence. The scope is stated on screen in every state rather than implied, a
  stale incumbent renders as an age and a timestamp instead of a red light, and
  an aggregate ("nothing is watching") stays forbidden — a sentinel on another
  machine or another store is invisible here. Still no control: a finding is a
  flag, never a judgment, and whether the sentinel may cancel a run is an open
  decision, so every button on that screen is a navigation. Coverage spans
  BOTH run corpora — see [`src/sentinel`](../sentinel/AGENTS.md).
- The agent detail pane names its sections. It showed the system prompt as one
  unlabelled monospace block and nothing else, while the payload already
  carried elements, parameters and provenance. The USER INSTRUCTION has a
  heading and no body on purpose: it is composed per call from the task, the
  plan and injected skills, so it belongs to a run — the heading points at an
  LLM event in Runs rather than inventing a template nobody ever sent.
- The nav is a LEFT RAIL (`renderer/views/sidebar.ts`), not a header tab strip.
  `visibleViews` remains the ONE definition of which tabs a viewer gets; the
  rail only groups them, and a test holds the group list to it so a new view
  cannot reach the nav ungrouped and silently vanish. Settings has no rail row
  on purpose — the account menu is its entrance, and a second one would put one
  job in two places.
- The renderer draws in two spaces. `stage` is the persistent scene root;
  `root` is the container the CURRENT pass draws into. Chrome (header, rail,
  overlays, account menu) draws into the stage, and each view draws into a
  viewport layer offset by `sidebarWidthForViewport(width)`. That layer is
  POSITIONED BEFORE the view draws, and the ordering is load-bearing: controls resolve
  their own screen geometry with `parent.toGlobal()`, sometimes lazily from a
  closure on a later pointer event. Reparenting a finished view left those
  closures holding the old ancestor — the tuning slider's drag then mapped the
  pointer against a track 208px from where it was drawn, and clamped to the
  range's end on first press. So views keep drawing from x = 0 and nothing
  shifts them afterwards. `recordHitTarget` projects every diagnostic/a11y hit
  target through its live parent with `toGlobal()`, including pane centring and
  scroll; raw x/y must never be pushed into `metrics.hitTargets`. Two other
  values still escape Pixi's transform: `detailBounds` is translated once by
  the view offset because the wheel router compares its plain Rectangle with a
  page position; a retained avatar orb sits on `markRoot`, so
  `retainAvatarOrb` resolves the caller's coordinates through `this.root` and
  keys the retention on the resolved pair. Any DOM overlay that sits over a
  VIEW is positioned from the `--gpu-sidebar` CSS variable, whose CSS clamp a
  test holds equal to `sidebarWidthForViewport`: the rail shrinks from 208px
  to a 112px legibility floor before stealing the view's 320px minimum. The
  run search input is not one of them, it lives in the header
  band. View DOM overlays are removed while the Pixi account menu is open so
  their higher CSS layer cannot intercept its controls. Short viewports
  compact the rail, then drop group headings before they drop a destination.
  The accessibility bridge is visually clipped only at rest; `:focus-within`
  reveals it as a bounded command palette so keyboard focus is never invisible.
- The project form is ONE form with TWO shapes, never one that grows: the
  create fields with no project selected, the run prompt with one. Selecting is
  a TOGGLE — reactivating the selected GL row or its accessible DOM mirror
  deselects it — and that is the route back to the create form, which is why
  Projects must NOT auto-select the first project. Auto-selection made creating
  a second project unreachable and would have re-selected on the render right
  after every deselect. Only the repair remains: a selection whose project is
  gone falls back to the first that exists. The GitHub connect link stays
  outside the switch, so an organisation with no installation can always reach
  it. The create/run form heights are explicit shared TS/CSS contracts in both
  wide and stacked-narrow modes; GPU rows start below the matching height.
  Compact GL project and run rows stack status metadata below their full-width
  targets rather than allowing fixed status columns to cover the label.
  Variable row copy is strictly single-line and fitted only after Pixi measures
  the real glyphs; character-count truncation alone is not a geometry bound.
- There is NO Launch tab in the GPU client. A tab that could only DESCRIBE how
  to phrase a goal, beside a Projects tab that actually starts runs, split one
  job over two places; the family guidance (`/api/profiles`, with a
  `launch.help.<id>` catalog override per family) renders in the GL guidance
  panel directly below the project run form, on the same condition as the
  prompt textarea it describes, and its examples fill that prompt.
  `/api/profiles` stays a READER: it is ungated, so
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
  The browser permission ask lives in the FIRST LIVE RUN for members
  (`shouldOfferPushPrompt`), never in their login or signup flow — login
  stays zero-friction; the run is where the value shows. PLATFORM ADMINS
  are the one exception: push routes target them for a CURATED set of
  instance-wide platform events (not every run) whether or not they ever
  launch one, so an unsubscribed admin is an admin whose alerts go nowhere.
  Admins are asked on their first console entry after login and their
  "not now" is session-scoped
  (`pushPromptStorage`: sessionStorage for admins, localStorage for members)
  and cleared on logout (`clearSessionPushDismissal`), so each new login
  asks again until the browser permission itself settles. A permission
  already GRANTED shows no prompt by construction, so an admin in that
  state is silently re-subscribed at login instead
  (`shouldEnsureAdminSubscription`) — which also repairs a server row the
  push service pruned. The prompt never fires in dev builds: the service
  worker registers in production only. The subscriber's
  language rides the subscription (`locale` column, captured at subscribe
  time) because a push is generated from an event with no request left to
  read a header off; rendering uses the server-side frozen `PUSH_COPY`
  map in `src/viz/push/routes.ts`, never the client i18n catalog (a
  `.tsx` carrying a React provider must not reach the server).
