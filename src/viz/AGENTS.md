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
`ATOMA_VIZ_SENTINEL=0` on the launcher path, which forwards no flags).
NO browser check is in `release:check` any more — `viz:smoke`, `viz:smoke:gc`
and the mark-turn film all need a real Chrome (and, for GC, a real WebGPU
adapter), which CI does not have. Run `viz:smoke` on a real machine before
shipping a viz change; the root file records why it left CI.
`npm run viz`, `doctor:dev` and `auth:dev` fill unset keys from checkout `.env`
so a local GitHub-gated visualizer does not need a shell export. Compiled
`viz:serve` does not load `.env`: production injects the process environment.

`viz:shot` captures a PNG of the rendered client (logged-in via stubs or
anonymous) for visual review after UI edits — [docs/viz-screenshot.md](../../docs/viz-screenshot.md).

```bash
npm run viz
npm run viz:mui
npm run viz:serve
npm run viz:demo
npm run viz:shot -- --auth --select-first
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
- The hover bubble is ONE bubble, on its own sibling layer above the crystal,
  and it obeys the rule above: views declare RECTANGLES per render through
  `ctx.tooltip` (local coordinates, projected while the parent transform is
  live), and `renderer/tooltip.ts` moves the bubble from the same pointer
  sample the pointer light reads. That layer is never filtered — the pointer
  light must not smear text a reader opened the bubble to read — and never
  hit-tested, so it cannot eat a click meant for the row under it. The canvas
  is one DOM surface, so a Pixi label cannot carry a native `title=`; do not
  add a DOM overlay for one instead.
- Relative ages come from `renderer/relative-time.ts` alone: it owns the
  buckets and the two-week horizon past which an exact date is shown. NOT
  `Intl.RelativeTimeFormat`, which cannot say "hier" or "il y a quelques
  minutes"; it still formats the exact instant. The phrase is lossy by design,
  so every relative stamp keeps the exact instant reachable in a bubble, and a
  stamp this bundle cannot parse shows its RAW value rather than an empty
  column — the same tolerance journal rows apply to kind and severity.
- A Pixi filter that OUTLIVES one `render()` must never sit `enabled = false`
  across a GC window without `buffer.autoGarbageCollect = false` on its uniform
  buffer. Pixi skips disabled filters, so the buffer stops being touched, ages
  out and is destroyed, while `BindGroupSystem._hash` keeps serving a cached
  bind group that points at it — every later `queue.submit` is then a
  validation error, permanently. Today only the pointer-light filter has that
  lifetime.
- Timeline cards use a repeated direct `Graphics` texture fill for their grain.
  Never put a Pixi `Filter` on each card: every filtered object becomes its own
  render-to-texture pass, so GPU cost scales with the visible event count and
  the full RUNS timeline cannot sustain 120 Hz. Hover and selection belong in
  batchable tint, border, aura, rail, and shadow properties instead.
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
- Registry counter events stamp the TARGET TYPE VERSION they credit or blame;
  they do not copy a full prompt snapshot into every event. The typed run
  projection recovers that version chronologically for older traces when it
  can, and the card omits an unknowable version instead of printing `v?`.
  `/api/runs` stays raw at the client reader: a delta rejoins the complete run
  BEFORE projection, or an earlier patch is invisible and the initial version
  can be stamped onto a later counter. Empty-delta identity comparisons ignore
  projection-only fields such as the rank derived from a stored numeric tier;
  otherwise every raw poll looks changed and rebuilds the GPU scene.
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
- The brand mark is a single all-diamond Pixi crystal with an archived inactive
  teal/amber/violet material palette, dynamic relighting, reduced-motion support,
  and no overlapping R3F logo.
- The gem's CAST is four three-ray facet bundles on TWO surfaces — the far-field
  mesh behind the UI and the pointer-light stage filter over it, so it crosses
  buttons and frames instead of stopping at the backdrop. `projectMarkCaustic`
  alone traces and derives throw falloff, `packMarkCaustic` alone writes the
  bundles, and `renderer/caustic-shader.ts` alone reconstructs their curved folds,
  in GLSL kept ES 1.00-legal. The bundles are traced at TWO wavelengths (the
  material dispersion band, diamond by default): the published corners are the
  mean trace and each carries its signed red−blue half-separation, so the
  fold reconstruction draws three real traces — the fringe is traced, never a
  radial heuristic. The Scene Tuning `causticDetail` scalar opens or closes
  that band around the traced measurement, as a live uniform.
- The UI is English and catalog-backed; add strings to i18n catalogs rather than
  hardcoding. Tests enforce representative parity, not every incidental string.
- PWA/service-worker registration is production-default and dev-opt-in
  (`ATOMA_VIZ_SW_DEV=1` → `__ATOMA_SW_DEV__`). `serviceWorkerRegistrationAllowed()`
  in `client/pwa.ts` is the ONE answer, shared with the push prompt so an
  enable button never appears without a worker to attach to. The off state
  UNREGISTERS: the worker's scope is the ORIGIN, not the build, so a dev
  registration outlives its dev server and would control whatever is served on
  that port next — cleanup touches only a `/sw.js` registration and the
  `atoma-viz-` cache namespace, never a neighbour's. `isDevModuleGraph` keeps
  Vite's rewritten module URLs out of the shell cache. `/api/*`, `/auth/*`,
  `/webhooks/*`, and every response marked `Cache-Control: no-store` stay
  outside the cache so live data, identity state and GitHub deliveries cannot
  be hidden by an offline shell.
- REJECTED, and why: `vite-plugin-pwa`'s `devOptions`. It serves a dev worker,
  which is the easy half; it does not UNREGISTER one, and the docs are explicit
  that in dev "the PWA will not be registered, only the service worker logic" —
  so the origin-scope cleanup above stays our code either way. `generateSW`
  cannot emit the `push`/`notificationclick` handlers this worker exists for,
  so the route would be `injectManifest`: our `sw.js` stays the source, a
  `workbox-precaching` import joins the SHIPPED bundle, and `viz:build` stops
  being a `publicDir` copy the smoke asserts. Its two documented hazards —
  workbox-window's one-minute update heuristic, and route interception bounded
  by `navigateFallbackAllowlist` — are the class our own bypass list already
  answers against the real server surface. WHAT WOULD REOPEN IT: precaching.
  `SHELL_ASSETS` is seven hand-written entries, so hashed bundles are cached
  only after a first successful fetch, never at install. If offline becomes a
  product goal rather than a side effect of being a PWA, `injectManifest` is
  the door, and it is one injection line in the file we already own.
- Do not name a root client module `api.ts`; Vite's `/api` proxy can intercept it.
- ONE frame style, and ONE definition for the SINGLE-COLUMN views:
  `renderer/view-frame.ts`. Projects/Admin/Settings/Burn-in use its elevation-2
  `panel()`, title and `VIEW_FRAME_CONTENT_TOP`; the established split views
  (Registry/Skills/Docs/Runs) keep their own pane geometry. The app had grown
  two single-column conventions, one framed and one with a title floating at
  y = 78, so one product carried two ideas of what a surface is. A DOM overlay
  that sits inside a column uses `.gpu-panel-skin`, the sole CSS restatement of
  `panel()`'s fill, border, radius and elevation-2 resting shadows (the GL
  shadows swing with the pointer light). The Projects form is the exception
  that proves the boundary: its DOM wrapper is transparent and the view draws
  its frame with the SAME `panel()` call as the project list below, so adjacent
  cards cannot disagree as the pointer moves. Do not add a per-form skin.
- The app OPENS on Projects, the authenticated launch surface. Runs is where
  you go to watch what you started, which is a second step, not an arrival. The
  unroutable-view fallback lands on Projects too. On the ungated developer path
  project routes do not exist, so Projects shows its explanatory empty state
  and the DOM mutation form is absent.
- The ADMIN PLANE is FIVE views, one per job — Organisations (`admin`), the
  platform journal, the catalogue ledger, the Sentinel, and Announcements —
  under one nav heading. It was one tab holding several: three questions on one
  screen, and one scroll position between them, so the journal could never page
  past its first page. `ADMIN_VIEWS` in `store.ts` is the one list and the rail
  reads it; each view's query is enabled on ITS OWN view. Announcements is the
  plane's only WRITE surface and is last for that reason. It draws a frame and
  nothing else: the composer is DOM filling the frame's content box, so unlike
  every other overlay here it has no GL content to reserve space against — the
  height contract is inverted, and the test pins the CSS box to
  `view-frame.ts`. It rode at the foot of the organisation list before, which
  put a broadcast composer under a screen nobody opens to broadcast and cost
  that list 260px on every visit.
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
- The Registry's ordinary one-store source is INFORMATION, not a selector:
  show its database basename and population, with the full path on hover.
  Repeated `--db` inputs turn that same row into measured, wrapping choices;
  no store may disappear behind a fixed slice.
- The agent detail pane names its sections. It showed the system prompt as one
  unlabelled monospace block and nothing else, while the payload already
  carried elements, parameters and provenance. Its header keeps the catalogue
  ordinal; elements retain both periodic metadata and their immutable call
  names; empty parameters say there is no type-level override; provenance
  names the latest archived change; and a bounded prompt preview says when it
  is incomplete. The USER INSTRUCTION comes BEFORE that prompt and has a
  heading but no body on purpose: it is composed per call from the task, the
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
- A CANVAS CONTROL MUST BE REPRODUCED AND TESTED AS A CANVAS CONTROL. The DOM
  tablist is an accessibility mirror: clicking its `role="tab"` button proves
  neither Pixi's `pointertap` handler nor the active rail target that the user
  actually clicked. When a state transition belongs to both surfaces, put its
  signal in `store.ts` and let both surfaces consume that one state; do not
  route it through one-off React state or a callback bridge in `GpuApp`, which
  can pass a DOM test while the canvas path remains broken. A regression first
  drives the complete precondition (for example compose → review → send →
  receipt), then resolves the exact id from `__ATOMA_GPU__.hitTargets()` and
  mouse-clicks its projected centre in `viz:smoke`; assert the resulting UI,
  not merely that the activation callback fired. Finally verify from a fresh
  page or full scene rebuild: Fast Refresh can leave an already-created Pixi
  listener holding the pre-edit closure, so the current tab is not proof of
  the newly loaded path.
- Scene Tuning is a floating DOM window, not Runs content or a second canvas.
  Its toggle is the final control in the ADMIN rail, its pressed state is the
  window's visibility, and its DOM layer sits above view forms. Title-bar
  dragging clamps the complete window inside the viewport; slider values stay
  in the mutable live sample so pointer motion never rebuilds the GPU scene.
- The project form is ONE form with TWO shapes, never one that grows: the
  create fields with no project selected, the run prompt with one. A selected
  project's name owns the page title (`Project : <name>`) and is NOT repeated
  as an active row in its detail card. Re-clicking Projects in the rail returns
  to the full list and create form; the accessible DOM mirror also preserves
  toggle semantics. Projects must NOT auto-select the first project: that made
  creating a second one unreachable and re-selected immediately after every
  deselect. Only the repair remains: a selection whose project is gone falls
  back to the first that exists. The GitHub connect link stays
  outside the switch, so an organisation with no installation can always reach
  it. The create/run form heights are explicit shared TS/CSS contracts in both
  wide and stacked-narrow modes; GPU rows start below the matching height.
  Compact GL project and run rows stack status metadata below their full-width
  targets rather than allowing fixed status columns to cover the label.
  A SELECTION IS A FILTER: one selected project draws THAT card alone, so the
  run form sits against the card it acts on. `projectHidden` is the one rule,
  read by BOTH the measuring and draw passes — two copies desynchronise
  `scrollMax`. The form stays a DOM overlay ABOVE the canvas, never inside the
  card, which no `fixed` element can do over a GL scroll pane.
- WIDTHS ARE MEASURED, NEVER ESTIMATED, and row copy stays single-line: a
  character count is not a geometry bound. `ctx.measureText`/`ctx.fitText` are
  the one source and `button()` fits every label through them, so views pass
  UNBOUNDED copy. A reserved column is measured from the copy the VISIBLE rows
  carry, floored, and ceilinged as a SHARE of the card — never a constant,
  which both steals width from its neighbour and under-serves itself. A run
  TOTAL renders in whole cents, not `fmtCost`'s four decimals, which price ONE
  LLM call. A row stacking a second line APPENDS it below a FIXED control.
  `chip-layout.ts` is deliberately Pixi-free so recordings test geometry with
  no renderer; it obeys this rule by INJECTION — a view passes `ctx.measureText`
  through the layout's `measure` option (bound to the face the chips draw
  with), and the per-character `gpuFilterButtonWidth*` estimates are the
  renderer-less FALLBACK only. An estimate must over-shoot to never clip, so
  it pads long labels unevenly; do not add a new chip surface on the fallback.
- There is NO Launch tab in the GPU client. A tab that could only DESCRIBE how
  to phrase a goal, beside a Projects tab that actually starts runs, split one
  job over two places; the family guidance (`/api/profiles`, with a
  `launch.help.<id>` catalog override per family) renders in the GL guidance
  panel directly below the project run form only for a selected project with
  NO runs, and its examples fill that prompt. Once the first run exists the
  WHOLE guidance panel disappears; no collapsed heading remains above history.
  While eligible it is a DISCLOSURE: tri-valued `projectGuidanceExpanded`
  defaults open through `projectGuidanceOpen`, and an explicit toggle may
  collapse or reopen it, so its activation id carries the DRAWN state
  (`…toggle.open|closed`).
  `/api/profiles` stays a READER: it is ungated, so
  it must never gain launch power — browser launches live on the authenticated
  project routes, where a session the run does not hold is the boundary. The
  shell path for an instance with no organisations is the `launch` docs theme.
  The FROZEN MUI fallback keeps its own Launch tab: it has no Projects view to
  fold the guidance into, and it is a fallback, not where product decisions get
  expressed.
- `TraceRecorder.persist()` IS A WIRE CONTRACT for one reader outside this
  subsystem. It must keep emitting ONE top-level JSON object whose members are
  `VizRun`'s, because the projects control plane decides delivered-versus-failed
  from six of them through
  [`readTraceTopLevelFields`](../contracts/AGENTS.md) rather than by parsing the
  document — a trace grows ~19KB per tool call and a 512KB whole-file cap
  recorded a delivered run as failed. That reader depends on neither member
  ORDER nor INDENTATION, which is deliberate: a throttled partial flush already
  moves `totals` ahead of `endedAt`, so order was never stable. Changing the
  document to a stream of records, or nesting the terminal members, is a change
  to that contract.
- TWO hand-rolled JSON scanners now exist and they own different jobs: this
  subsystem's neighbour `src/atoms/json.ts` (`findBalancedEnd`,
  `repairPrematureClose`) repairs a whole model-authored STRING already in
  memory; `traceFields.ts` projects depth-1 members out of a FILE it must never
  hold. Neither may drift into the other's job — the second exists precisely
  because the first needs the whole document.

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
  push service pruned. The prompt follows the WORKER, not the build
  (`serviceWorkerRegistrationAllowed`), so it is silent in a dev session
  until that session opts the worker in. The subscriber's
  language rides the subscription (`locale` column, captured at subscribe
  time) because a push is generated from an event with no request left to
  read a header off; rendering uses the server-side frozen `PUSH_COPY`
  map in `src/viz/push/routes.ts`, never the client i18n catalog (a
  `.tsx` carrying a React provider must not reach the server).
  The worker logs whether `showNotification` was accepted or rejected with
  the notification tag only, never the title or body: DevTools diagnostics
  must be observable without copying operator or project text into a log.
- OPERATOR ANNOUNCEMENTS (`platform.announcement`) are the ONE push whose
  words a human writes, and the only route with an audience wider than an
  organisation. Two steps, and the split is the safety property:
  `/api/admin/announce/draft` proposes translations and sends NOTHING;
  `/api/admin/announce` delivers only text the admin read in EVERY
  supported language. That review is what keeps model prose out of the
  audit row (`src/platform/AGENTS.md`) — a translation an operator
  accepted is the operator's text — and out of a tray no one can undo.
  After delivery, re-activating the already-active Announcements destination
  returns the composer to its empty initial state; the same gesture while a
  draft is in progress preserves it. It follows the canvas-control method
  above: the reset signal lives in the shared GPU store, and the real-GPU smoke
  drives the active Pixi hit target after a complete stubbed send.
  `src/viz/push/translate.ts` is the server's ONLY LLM call site: tier 1,
  built on first use so no deployment is asked for a credential it never
  needs, and returning `null` (never a partial draft) whenever the
  provider is absent or the reply unreadable — the form then asks the
  admin to write the other languages. The segment (`src/viz/push/
  segments.ts`) is resolved ONCE by the emitter against the projects
  store and journaled, so the router stays identity-only; `orgIds` absent
  means everyone, and an EMPTY list can never mean that. `orgCount`, not
  the id list, rides the row: `detail` is capped and the journal is
  fail-open, so an oversized row would lose the audit trail AND the push.
  The router refuses to deliver a push that renders no title. The composer
  is its own admin view (above), not a form at the foot of another.
