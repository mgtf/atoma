# Result preview — AGENTS.md

`src/preview/` owns the result preview: classifying what a delivered project
run produced, the policy over its bytes, the state of a running preview, and
the service the transports call.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/projects`](../projects/AGENTS.md) — the delivered runs this describes
- [`src/contracts`](../contracts/AGENTS.md) — the shapes, and the probe manifest
- [`src/tools`](../tools/AGENTS.md) — where the entry stamp is observed
- [`src/viz`](../viz/AGENTS.md) — the HTTP adapter and the GPU surface

Design of record:
[`docs/result-preview-design-2026-08-28.md`](../../docs/result-preview-design-2026-08-28.md),
under the deployment shape fixed in
[`docs/deployment-docker-launcher-2026-08-28.md`](../../docs/deployment-docker-launcher-2026-08-28.md).
Built: classification, byte policy, instance state, the container runtime, the
claim and origin model, the gateway, the manager that orders them, and the
gated HTTP surface. NOT built: the GPU client, so a member cannot yet click
Preview — the routes answer, nothing calls them. The Node path's isolation is
proved only where a real gVisor runtime exists
(`tests/preview-isolation.test.ts`, and the manual CI job).

## What this is, and what it is not

- A preview is an authenticated organisation member opening the application a
  DELIVERED run produced, in an isolated iframe, and USING it.
- "Sandbox" is not this feature's word. It belongs to `ToolSandbox`, which is
  in-process L1 tool confinement and **not an isolation boundary**. The iframe
  `sandbox` attribute is a browser mechanism, not a product name. UI copy is
  *Preview*, English, `en.json` only.
- A preview is NOT a run: it never takes the MCP run lease and never touches
  the registry, skills or ledger.
- A preview is NOT a deployment. It is ephemeral review evidence, and the
  member guide says so.

## Two sources: a deliverable, and a moment

- A **delivered** preview shows what a finished run produced, described once by
  its immutable descriptor.
- An **in-flight** preview shows a SNAPSHOT of a run still building, taken when
  it was opened and labelled with that moment. It writes NO descriptor row: a
  descriptor is immutable and records what DELIVERY observed, so carving a
  moment into one would be a lie about the run.

The instance row and the browser summary both carry `source` and `snapshotAt`,
because a surface that cannot say "as of 14:32" lets a member read a snapshot
as the present.

A torn copy is NOT a defect to eliminate — it is the nature of watching
unfinished work — and the readiness contract already filters what matters: no
runnable entry, a server that will not start, a marker that never arrives, a
probe that goes unanswered. What survives all four starts and answers, and that
it is incomplete is the information that was asked for. The design and the
rejected alternatives are in
[`docs/in-flight-preview-2026-09-02.md`](../../docs/in-flight-preview-2026-09-02.md).

**WHICH of the two a request gets is the HOST's decision, from the run's own
status.** `inFlight` is a willingness to accept a snapshot, never an assertion
about the run: a running run gets one, a delivered run gets its delivered
preview, and nobody is served a snapshot that silently disagrees with a
published result. `queued` is not in flight — nothing has been produced yet.

**The summary must know that status too**, or the control can never appear.
Availability read from the descriptor and the instance alone answered
`unavailable`/`legacy-run` for a run nobody had previewed yet; the client hides
the control for exactly that answer, so the preview could not be asked for,
therefore never existed, therefore stayed unavailable. `runInFlight` closes
that loop and still allocates nothing. It is also why `stop` re-reads through
the service: the manager answers about the instance it just removed and knows
nothing about the run, so its own summary would take the control away mid-run.

Three rules make it safe: the run's workspace is only ever READ; the COPY is
what gets classified, never the live workspace, so the classifier sees bytes
that cannot move under it; and a reopen takes a NEW snapshot on a NEW
generation rather than reusing one, because a member reopening wants the state
now. In-flight egress is denied outright — a run has declared no hosts, which
is the right default for code nobody has finished writing.

## The two facts, and why they are separate rows

- A **descriptor** is what delivery OBSERVED: immutable, one per delivered run,
  written inside the delivery path. Revising it would describe a workspace that
  has not changed, so the store refuses the UPDATE with a trigger rather than
  trusting every future writer.
- An **instance** is what is running now: mutable, at most one per run,
  compare-and-set only, with a monotonic generation.
- Mixing them would make "what did this run build" answerable only while
  something is running, and the first question a member asks is asked when
  nothing is.

## Classification is machine-observed, and total

- The inputs are `.atoma-probes.json` — written by the machine from what tools
  actually did — and the presence of files on disk. NOTHING here reads
  `result.output`, a README, trace prose, or replays a `run_shell`.
  Verification is read-only, and a classifier trusting a model's claim about
  its own deliverable is the supervisor replaying a child's command wearing a
  different hat.
- An `http` probe entry means `node`; a `web` entry, or a bare `index.html`,
  means `static`; anything else is `unsupported-deliverable`.
- The node entry resolves in one order and stops at the first hit: the `entry`
  stamped on the newest http probe, then `package.json.main`, then `server.js`
  → `index.js` → `app.js`. Each candidate must be a regular non-symlinked file
  ending `.js`/`.mjs`/`.cjs`, because `node <entry>` is the ONLY start command
  a preview will ever run — an entry node cannot execute is `not-runnable`,
  reported now, rather than a crash the member has to interpret later.
- The answer is TOTAL: every delivered run gets a descriptor, available with a
  kind or unavailable with a bounded reason. A control that fails after the
  click is worse than a stated absence.
- Classification happens ONCE, at delivery, and is persisted. Per-request
  classification would probe the filesystem on a route a browser polls, and
  would answer differently once the next run reseeded from that workspace.

## The delivery hook is fail-open, and that is measured

`describeDeliveredPreview` is a narrow collaborator on the coordinator, like
`publisher` and `onRunFinished`. It runs after the run is durably delivered and
before publication, inside its own guard that reports to stderr.

Nothing on this path may downgrade a delivered run. The repository has measured
the other choice: a trace-size cap recorded delivered run `2857a579` as
`failed`, erased $0.84 of stats, and made the NEXT run seed from an older
workspace. A preview is a convenience over work already delivered and already
paid for; a missing descriptor reads as `legacy-run`, which is exactly what it
is, and there is deliberately no backfill.

## One path jail, three exclusion policies

The jail — traversal, every symlink component, the real-path re-check, the
stable-fd read — lives in [`src/projects/artifacts.ts`](../projects/artifacts.ts)
and is **never restated here**. `resolveWorkspaceFile` and
`secureReadWorkspaceFile` take the exclusion list as a parameter, defaulting to
`assertPublishableArtifactPath`, so publication behaviour stays byte-identical.

Only the exclusion differs, and it differs for stated reasons:

- **classify** may read `.atoma-probes.json` at the workspace ROOT, and nothing
  else under `.atoma*`. That record is how the host learns what the run built;
  a nested one was written by something else.
- **copy** excludes `.atoma*` and secrets but KEEPS `node_modules`: executing a
  Node deliverable needs its dependencies, and the copy is mounted into an
  isolate, not handed to anybody.
- **serve** excludes `node_modules` too: a static preview is the workspace read
  through an HTTP surface, and publication does not put a dependency tree on
  the internet either.

`.git` and `secretLike` are refused by all three. Publication and preview are
the two ways workspace bytes leave the run that made them, so a file
publication refuses must not become readable by serving it instead — one list,
two consumers, never a second copy that drifts.

## The materialised copy

- The delivered workspace is NEVER touched. It is the durable deliverable and
  the seed of the next run (`previousDeliveredWorkspace`), so the app writes to
  a filtered ephemeral copy that is deleted at teardown.
- Everything is `lstat`-driven and a symlink is SKIPPED, never followed: a link
  inside the workspace would otherwise pull bytes from outside it into a
  directory about to be mounted into a container.
- Caps are REFUSALS, not truncations. A copy that silently stopped at the cap
  would mount half an application and report `ready`, and the member would be
  debugging our bookkeeping instead of their app.
- The copy may not nest with its source in either direction: a destination
  under the source copies the copy, and a source under the destination is
  erased by a teardown that believes it owns everything below it.

## State, generations and liveness

- States are closed and monotonic within a generation:
  `stopped -> starting -> ready -> stopping -> stopped`, with
  `failed` reachable from the live states and leaving on the next explicit open.
- `generation` is the browser ORIGIN's identity and only ever increases —
  enforced by a trigger. A restart mints a new origin so stale service workers,
  storage and caches from a previous generation can never control the next.
- `openInstance` reuses `starting`/`ready` rather than starting a second
  isolate, so two members clicking Preview at the same moment get one.
- Only a trusted UI heartbeat from the authenticated parent extends a preview.
  Application traffic, polling, SSE and WebSockets never count: abandoned
  generated code must not keep itself alive.
- A heartbeat for a generation that has moved on is not an error. The browser
  is a beat behind, and saying so is the caller's job.

## Bringing one up, and taking it down

The order is the contract, and it is the shape the egress sidecar already
proved: purge the owner's debris, arm the hard-exit fallback **before** anything
exists, create, and tear down in reverse.

- **Nothing is exposed before it answers.** Readiness is TWO facts: the app's
  own `LISTENING_ON_PORT` marker, then a real request reaching it through the
  relay. A claim handed out on the marker alone opens a preview onto a
  connection refused, and the member reads our timing as their bug.
- **A failed start leaves nothing behind.** Every exit path — refusal, timeout,
  crash, an error from the engine — runs the same teardown, because the
  alternative is a leaked container holding a tenant's bytes. The hard-exit
  fallback is disarmed only once everything is gone.
- **Teardown never throws.** Relay, application, network, then the ephemeral
  copy; a step that cannot finish is logged by NAME and the rest still run. One
  loud failure midway would abandon everything after it.
- Failures carry a bounded code from the closed vocabulary the instance row and
  the browser summary share, so a member reads one word rather than an engine's
  prose. `copy-limit` is distinct from `internal`: it is the one a member can
  act on.
- Teardown ends with a SWEEP BY OWNER, not only by the handles it collected.
  Measured: a `startUnit` that created a container then threw on a later step
  left it running with no handle to name, and the leak survived the failure.

## The image holds nothing of atoma

`docker/preview.Dockerfile` (`npm run build:preview`) is a Node runtime and a
non-root user, and that is the whole file. The process it starts is not our
code — it is whatever a run produced — so every line of atoma reachable from
inside it is a line a member's generated application inherits. The worker image
is the OPPOSITE guard: that one must contain everything it imports, and
`tests/container-image-closure.test.ts` asserts both directions. Three absences
are deliberate:

- **No `npm install` layer.** A deliverable brings its own `node_modules` in
  the copied workspace or it does not run; installing at open time would put a
  network operation on a member's click, in a container with no egress for it.
- **No apt layer.** The worker installs python3 and chromium because TOOLS need
  them; nothing here runs a tool, and every package is surface the generated
  code inherits.
- **No ENTRYPOINT and no CMD.** The launcher passes `--entrypoint node` and the
  one start command the profile allows. An image command would wrap or replace
  it, and a preview that could choose its own command would be a remote shell
  with a nice name.

Its uid is 10002, one above the worker's 10001: the same host process mounts
both, and a shared uid would let a file written for one be written by the
other. Production pins the image BY DIGEST, which means pushing it — a mutable
tag is not an identity, and `snapshotPreviewConfig` refuses one.

## Configuration is all-or-nothing

`npm run preview:demo` is the laptop path: a loopback OAuth provider, then a
project and a delivered STATIC run seeded through the coordinator's own store
calls. Three correct rules stand between a fresh checkout and a clickable
button — previews need the gate, a project needs an active GitHub installation,
a run needs a POSIX host — and none is worth weakening for a local look. It
touches no preview code, so a button that does not work has not been hidden by
it; `tests/preview-demo-harness.test.ts` pins the one coupling that would break
silently, the workspace path the harness writes against the one `workspaceOf`
derives.

The OPERATOR view of everything below — host, domain, proxy, cost, egress — is
[`docs/preview-deployment.md`](../../docs/preview-deployment.md), verified by
`npm run doctor -- --preview` ([`src/cli`](../cli/AGENTS.md)).

Resolved once, from the host environment, at boot. Half a configuration is a
HARD FAILURE, never a silent "disabled": any `ATOMA_PREVIEW_*` variable arms the
check, so a deployment that set four of the six is told so.

- The image must be **pinned by digest**. A mutable tag is not an identity, and
  the instance row records the digest that served each generation.
- `runsc` is the default and production requires it. `runc` needs an explicit
  `ATOMA_PREVIEW_ALLOW_RUNC_DEV=1` **and** a deployment nobody else can reach:
  the visualizer's public origin AND the gateway's bind must both be loopback.
  The rule is "a deployment with TENANTS never gets `runc`", and testing it as
  "is the gate on?" made the hatch UNREACHABLE — previews REQUIRE the gate, so
  it was refused on every machine including the one-person laptop it exists
  for. Reachability is the sharper test: a session gates a claim, a claim is
  the only way to reach a preview origin, and a session needs an OAuth round
  trip against THAT origin. Nothing falls back to `runc` on its own.
- The preview domain must not share a registrable domain with the visualizer
  origin. The check is deliberately CONSERVATIVE — two labels, no Public Suffix
  List — so it refuses more than strictly necessary, the safe direction for a
  check whose job is keeping a session cookie away from generated code. An
  origin that will not parse is not proof of safety.
- Every bound REFUSES rather than falls back — an operator who asked for a
  two-hour idle bound and silently got fifteen minutes is the defect the
  project-run timeout already records. Contradictory settings too: a per-org
  cap above the global one never applies, and an idle bound at or past the hard
  bound never fires.

## The origin, and who may open it

A preview lives on its own registrable domain, so no Atoma cookie ever reaches
it — which is exactly why the gateway needs its own way to know the browser in
front of it was sent by an authenticated member.

- **One host per GENERATION**, derived from `(orgId, runId, generation)`. A
  restart mints a new generation and therefore a new origin, which is what
  makes a previous generation's service workers, storage and caches unable to
  control the next — no cache-busting on one origin gives that. It is derived
  rather than stored because the gateway routes from the `Host` header alone,
  before it has consulted anything.
- **A claim is one-time, thirty seconds, and bound to everything it depends
  on** — principal, session, org, run, generation and the exact host. It is
  CONSUMED BEFORE it is validated, exactly as `consumeOauthState` is, so a
  leaked value cannot be probed repeatedly for a match. It is stored hashed.
- **The raw value travels in a URL FRAGMENT.** A fragment is never sent to a
  server, so it stays out of request lines, access logs and `Referer`. Only a
  script on the preview origin can read it, hand it back, and erase it — which
  is the entire reason the gateway serves a bootstrap page of its own.
- **The grant cookie carries a TOKEN the registry issued, and the registry
  verifies it.** An earlier shape keyed grants by route alone and checked only
  that one existed, which accepted ANY cookie value for as long as some member
  held a live grant on that origin. A cookie must be a credential, never a
  flag.
- **A grant lasts five minutes and only the PARENT'S HEARTBEAT extends it**,
  through `renewRun`, which matches on the BINDING rather than the token: the
  token is a cookie on the preview origin, which the control plane can neither
  read nor be sent, and that separation is the whole reason for the separate
  domain. Renewal is scoped to the beating principal, so one member cannot keep
  another's credential alive after they closed the tab. Wiring it was not
  optional — against a fifteen-minute idle TTL, every viewing session was
  capped at five and ended in the 404 below with a healthy container behind
  it.
- **One generic 404 for every negative answer** — unknown host, expired claim,
  forged token, wrong organisation, stopped preview. Telling them apart tells
  an unauthenticated caller which generation hosts exist and which
  organisations own them, and no legitimate member needs the distinction. The
  reason is logged for an operator and never returned.

## The response policy is the gateway's, not the application's

Headers an application sets that could weaken its own container —
`Content-Security-Policy`, `X-Frame-Options`, `Set-Cookie`, the
cross-origin family — are DROPPED and re-imposed. That is the difference
between a policy and a suggestion. In the other direction the member's cookie,
address, forwarding chain and referrer never reach the application: none of
them are its business and all of them are things a hostile deliverable would
like.

- `frame-ancestors` is the exact visualizer origin; `frame-src`, `object-src`
  and `base-uri` are closed.
- `'unsafe-inline'` for scripts and styles is a DELIBERATE deviation from the
  design's literal `'self'`. A deliverable is routinely a single HTML file with
  inline `<script>`, and refusing those makes the feature not work for the
  commonest shape a run produces. What the host allowlist actually buys is
  EXFILTRATION control, and that lives in `default-src`/`connect-src`, which
  stay closed — inline script is same-document and reaches nothing new. There
  is also no trusted application here to protect from injected script: the
  application IS model-authored code the member chose to open. `'unsafe-eval'`
  is NOT granted.
- A redirect is ALWAYS resolved against the origin, never pattern-matched. A
  "looks relative, so it is safe" shortcut allowed `/\evil.example`, which
  starts with a single slash and resolves off-origin in every WHATWG-compliant
  browser because a special scheme treats a backslash as a separator. The
  parser is the only thing that knows what a browser will do with a string.
- The CSP host allowlist is a BROWSER RESOURCE POLICY, not a remote-browser
  boundary: generated JavaScript runs on the member's own machine, so an
  approved but hostile domain could still observe what they type. The chrome
  says so permanently, and no header here can fix it.

## Egress is requested by a run and approved by a person

- Hosts are exact, lower-case, dotted public DNS names. No wildcards, no
  `.domain` subdomain form, no ports, no IP literals, no reserved or
  private-network suffixes — deliberately narrower than
  `DEFAULT_EGRESS_ALLOWLIST`'s two forms, because that list is an operator
  allowlisting dependency registries while this is a tenant admin approving
  what generated code may reach from a member's browser.
- The effective policy is `intersection(requested by this run, approved for
  this project)`, computed in ONE place: computing it twice is how a CSP and a
  sidecar come to disagree about the same preview.
- An unapproved requested host stays blocked and VISIBLE. It never prevents a
  no-egress preview from starting.
- `requestedHosts` is empty in v1 and the column is not decoration: there is no
  run-side channel through which a run declares the hosts its deliverable
  needs. Inventing one from the probe manifest would read localhost probes as
  internet destinations. The column and the approval flow exist so that channel
  lands without a migration.

## Attribution rides the instance row

`imageDigest` and `runtime` record what actually served a generation. This is
the 2026-08-26 Lovable review applied rather than deferred: it measured that
`atoma-worker:latest` gives neither an immutable artefact nor an attributable
rollback, and asked every unit of work to persist the exact runtime that served
it. `runsc` and `runc` are different security boundaries, and a row that does
not say which one ran cannot answer the question afterwards. Both stay
server-side — `previewSummarySchema` deliberately carries neither.

## What crosses to the browser

- `PreviewSummary` and nothing else: an explicit allowlist, never a projection
  of the rows, because a projection acquires whatever a row gains next — which
  is how `projectRunPublicSchema` came to need an audit.
- No host path, container or runtime id, token, grant, URL, application output
  or container log crosses this boundary, in a response, a journal row or a
  metric. `project_runs.error` already leaked an absolute host path once.
- Platform events are journal-only: `preview.started`, `preview.stopped`
  (info) and `preview.failed` (warning), all mapped to `null` in `PUSH_ROUTES`.
  A preview is something a member is watching while they watch it, so a push
  would arrive on the device already showing the thing it is about.
  `preview.failed` is a warning and not an error because the deliverable is
  delivered and published; only the convenience over it did not come up.

## The HTTP surface

Five routes under the gated project hierarchy, and every decision lives in
`httpService.ts` rather than in the transport — a decision made in a route
handler is a decision the CLI cannot reach.

- **Reading allocates nothing.** `org:viewer` may see whether a preview exists
  and what state it is in; a GET never starts a container, because a route that
  allocated compute on a read would let a tab left open spend an organisation's
  quota. A test asserts no instance row appears.
- **Writing is `org:member`+ and bound to the viewer's ACTIVE organisation**,
  exactly as `cancel` and `publish` are. A platform admin reading across
  organisations still writes only in its own.
- **The run must be under the project named in the path.** A run of another
  project in the same organisation is a 404, or the REST hierarchy is a lie.
- Statuses mean one thing each: `202` while a generation is still building,
  with the retry delay, because the alternative is holding a request open for
  the length of a container start; `409` for a run whose state is the reason;
  `429` for capacity, with `Retry-After`, and never by evicting someone else;
  `503` when the deployment has no preview runtime at all, which is an
  operator's problem and not the member's.
- Egress approval is `org:admin`+ and accepts ONLY hosts a delivered run of
  that project actually requested — an approval for a host nobody asked for is
  a standing permission nobody reviewed. Changing the set stops the project's
  live previews, so the next generation gets a coherent policy rather than a
  running one whose rules changed underneath it.

## The client surface

The GPU client's contract is in [`src/viz`](../viz/AGENTS.md); what belongs
HERE is what the preview's own shape forces on it.

- **The control is a SIBLING of the run summary card, on `ctx.root`.** A parent
  `hitArea` PRUNES its whole subtree, so a control inside the card but outside
  its rectangle would be unreachable rather than merely covered; and a nested
  target that IS inside it still bubbles, so one click would open the preview
  AND collapse the card. There is no `stopPropagation` precedent in that
  client, and a layout choice is the wrong reason to add one.
- **The plane REPLACES the canvas rather than floating over it**, and the
  product tree goes `inert` behind it — which is what exempts it from the
  grandfathered CSS-skin list: with nothing underneath, there is no pointer
  light to escape and no hover bubble to bury.
- **The iframe mounts only in `ready`**, and its `key` is the generation plus
  the reload nonce. A restart is a NEW ORIGIN and gets a new element; reusing
  one would carry the previous origin's session history into it.
- **The first load spends the claim; every reload uses the origin root.**
  Re-navigating to a one-time claim lands on "this link has already been used"
  — a reload button that breaks what it reloads. The grant carries the rest.
- **`allow-same-origin` IS granted to the frame.** Withholding it puts the app
  in an OPAQUE origin, where the gateway's own `default-src 'self'` matches
  nothing and every separate script or stylesheet is blocked — nothing built
  from more than one file would work. The isolation is the separate registrable
  domain carrying no Atoma cookie, not the sandbox flag. `allow-popups` stays
  absent.
- **NO "open in a new tab", and it is not an omission.** The grant cookie is
  `Partitioned`, keyed to the visualizer as the embedding site, so a TOP-LEVEL
  tab on the preview origin is a different partition and would arrive with no
  grant at all — the member would get the generic 404 on their own preview.
  Making it work means minting a second claim for a top-level context, which
  is a decision about what a claim binds.
- **NO per-row Preview button in the Projects run list**, which the design
  §14 asked for. Eligibility is decided per run, so an honest row control needs
  a status query PER ROW; without one the row offers a button that fails after
  the click — the exact thing the same paragraph forbids. The row already
  navigates to the run detail, where the control has real state. Reopening this
  means a batch status route, not a button.
- **The heartbeat beats only while the plane is up**, at one minute — inside
  both clocks it feeds. That is D6 made mechanical: the generated app's own
  traffic never reaches it, so an abandoned tab full of polling code cannot
  keep its own container alive.
- **A frame that loads nothing SAYS so** after ten seconds. Cross-origin,
  `onError` never fires and `onLoad` fires even for the browser's error page,
  so a timer expiring with no load is all the parent can observe — a false
  negative beats a chrome reporting `ready` over a blank rectangle.

## The service is the seam

Transports translate a request, authenticate, authorise, and call
`src/preview/service.ts`. They do not own what a preview is. This subsystem was
born extracted rather than added to `src/viz/server.ts`, which already composes
almost the whole control plane while still describing itself as tiny — the
concrete gap the Lovable review named, whose remedy is to strangle it one
coherent group at a time
([`docs/lovable-lessons-atoma-2026-08-26.md`](../../docs/lovable-lessons-atoma-2026-08-26.md)).
A new preview route belongs in the adapter as one call; new preview BEHAVIOUR
belongs here.

## Intentional choices and rejected shortcuts

- **Serving the artifact manifest as the file allowlist.** Measured incomplete
  on a real run: 3 declared files of 12 present, with `package.json` and
  `start.sh` outside it. A usable preview serves the WORKSPACE.
- **Generated HTML on the visualizer origin.** The session cookie and `/api/*`
  are the reason the origin itself is the asset.
- **Reusing `ToolSandbox` as the jail.** It is not an isolation boundary.
- **Keeping the build run's server alive.** `ToolSandbox` cleanup destroys it
  at run end, by contract.
- **Live preview of a run in flight.** It races L1 on the same workspace and
  ports. The compatible shape is a snapshot contract at phase boundaries, which
  is deferred and has its own review
  ([`docs/live-preview-direction-2026-08-31.md`](../../docs/live-preview-direction-2026-08-31.md)).
- **A reusable or shareable preview URL.** v1 mints a one-time claim.
- **`npm install` at open time.** A missing `node_modules` is a bounded failure,
  not a network operation on a member's click.
