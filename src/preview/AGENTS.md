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
What is built so far is the classification, policy and state half; the
isolation runtime, the gateway and the client surface are not implemented.

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

- **Nothing is exposed before it answers.** Readiness is TWO facts: the
  application's own `LISTENING_ON_PORT` marker, and then a real request that
  reaches it through the relay. A route or a claim handed out on the marker
  alone opens a preview onto a connection refused, and the member reads our
  timing as their bug.
- **A failed start leaves nothing behind.** Every exit path — refusal, timeout,
  crash, an error from the engine — runs the same teardown, because the
  alternative is a leaked container holding a tenant's bytes. The hard-exit
  fallback is disarmed only once everything is gone.
- **Teardown never throws.** Relay, then application, then network, then the
  ephemeral copy; a step that cannot finish is logged by NAME and the remaining
  steps still run. One loud failure in the middle would abandon everything
  after it, which is the opposite of what teardown is for.
- Failures carry a bounded code from the closed vocabulary the instance row and
  the browser summary share, so a member reads one word rather than an engine's
  prose. `copy-limit` is distinct from `internal` on purpose: it is the one
  failure a member can act on.

## Configuration is all-or-nothing

Resolved once, from the host environment, at boot. Half a configuration is a
HARD FAILURE, never a silent "disabled": any `ATOMA_PREVIEW_*` variable arms the
check, so a deployment that set four of the six is told so.

- The image must be **pinned by digest**. A mutable tag is not an identity, and
  the instance row records the digest that served each generation.
- `runsc` is the default and production requires it. `runc` needs an explicit
  `ATOMA_PREVIEW_ALLOW_RUNC_DEV=1` **and** refuses to boot behind the auth
  gate: a deployment with accounts is a deployment with tenants, and `runc` is
  not the boundary this feature promises them.
- The preview domain must not share a registrable domain with the visualizer
  origin. The check is deliberately CONSERVATIVE — two labels, no Public Suffix
  List — so it refuses more configurations than strictly necessary, which is
  the safe direction for a check whose job is keeping a session cookie away
  from generated code. An origin that will not parse is not proof of safety.
- Every bound REFUSES rather than falls back. An operator who asked for a
  two-hour idle bound and silently got fifteen minutes is the defect the
  project-run timeout already records. Contradictory settings are refused too:
  a per-org cap above the global one never applies, and an idle bound at or
  past the hard bound never fires.

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
