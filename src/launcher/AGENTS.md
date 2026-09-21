# Launcher — AGENTS.md

`src/launcher/` owns engine access: it is the one component allowed to create,
inspect and remove containers and networks.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/contracts`](../contracts/AGENTS.md) — the typed launcher contract
- [`src/tools`](../tools/AGENTS.md) — the egress sidecar that composes it
- [`src/preview`](../preview/AGENTS.md) — the next caller
- [`src/cli`](../cli/AGENTS.md) — doctor's engine checks

Design of record:
[`docs/deployment-docker-launcher-2026-08-28.md`](../../docs/deployment-docker-launcher-2026-08-28.md) §2.

## The two invariants

1. **The atoma web container never mounts the Docker socket**, in any mode,
   including development.
2. **Exactly one component holds engine access**, under its own OS identity.

Mounting `docker.sock` into the web-facing container hands host-root to the
process that also holds session cookies, the authenticated API and the product
store — the exact inversion of the discipline that already forbids the worker
that socket.

## The contract is narrow on purpose

A caller names a PROFILE and supplies identity plus the few values that
profile takes. It may never supply a command line, an image, a mount path, an
environment map, a network name or any other engine option: those are derived
here. A launcher that accepted them would be a remote shell wearing a typed
interface, and invariant 2 would buy nothing.

There is deliberately no `exec`, no raw `inspect`, and no option passthrough.
Each would reopen the invariant, so each is a change to this file's contract
rather than an addition to a backend.

The kind vocabularies are CLOSED and hold exactly what a backend implements. A
member with no implementation is a promise the type system makes and the
runtime breaks.

## It must stay swappable

Kubernetes is deferred, not rejected, and this interface is the insurance
policy: a Kubernetes backend implements the same operations over Job/Pod under
RBAC without any caller changing. That is the concrete meaning of "Kubernetes
is a swap", and it is why nothing in the contract names Docker.

Two consequences worth stating:

- **Readiness is a log line.** These units sit on internal networks the control
  plane cannot reach, so there is nothing to connect to from here. Every
  backend can read a unit's output; a port probe would not survive the swap.
- **`armHardExitCleanup` may be a no-op.** A backend whose objects are already
  owned by something that cascades — `ownerReferences` — needs no synchronous
  fallback. That difference is exactly what the swap should absorb.

The local composition seam is `createContainerLauncher`: it returns only
`ContainerLauncher`, and egress and viz consumers use that return type.
Shared-deadline network removal and launcher-selected preview copy ownership
are contract operations; neither requires the concrete backend type.

## Local and separate service modes

`connectContainerLauncher` selects the local backend when no
`ATOMA_LAUNCHER_SOCKET` is configured, otherwise the separate Linux service.
The configured socket must work; never fall back to Docker on the caller.
Setup and limitations: [launcher service](../../docs/launcher-service.md).

The socket is private, versioned and bounded. Only the service chooses images,
runtime, workspace location and identity. Callers verify the reported profile;
handles cannot name another owner or arbitrary engine object. Naming has one
shared derivation. Arm/disarm calls are awaited so registration precedes work.
Each connection holds its owners; disconnect cleanup follows any in-flight
operation and never reaps another connection's objects. Unknown outcomes are
not replayed. Global reconciliation refuses while a connection owns work and excludes new claims until it finishes.

W1–W3 supply the service, transport and volumes, not deployed acceptance.
The shared workspace projection remains a W7 packaging requirement. Local mode
remains in-process and does not satisfy the deployment boundary.

## Worker lifecycle and transport

`ContainerToolExecutor` is a compatibility facade. Local stdio attach lives
in `localWorker.ts`; the service mode uses `RemoteWorkerExecutor` and the
closed `WorkerLauncher` contract. The launcher chooses image, uid, workspace
mapping and egress topology. No caller path or engine argument crosses RPC.

The launcher creates two private Unix endpoints per worker. The worker
CONNECTS to its endpoint, mounted as ONE read-only socket file; the caller
connects to the separately issued endpoint. The launcher relays their NDJSON
protocol with stream backpressure. Neither the control socket nor any sibling
endpoint is mounted in the worker. A worker-writable socket directory would
allow replacing an endpoint with a host-side symlink: do not use that shape.
Tool requests remain concurrent and id-matched on the data channel, independent
of serialized lifecycle RPC. Shared wire types live in `contracts/workerProtocol.ts`.

The socket root is bounded: `<socketRoot>/<uuid>/w.sock` must fit `sun_path`
(104 bytes on macOS/BSD, 108 on Linux), so a root over 56 bytes cannot hold a
worker. `LauncherWorkers` refuses it at CONSTRUCTION and names the arithmetic,
because bound late the protocol answers a coded `operation-failed` with no
message and a root a few bytes too long reads as an engine fault (2026-09-22).

One connection owns each worker and one worker owns each configured workspace.
A lost data channel is terminal. Removal must be confirmed by the engine before
network teardown or reuse; failed removal retains the workspace claim. Startup
cleanup waits for the outstanding create, and control disconnect retries it.
The worker label is `dev.atoma.owner=worker`, separate from preview and egress.
The explicit orphan sweep includes it, and the exit backstop removes workers
before the network registry runs. Boot recovery and stale socket sweeping are
launcher-owned.

Service workspaces are named volumes. The local driver binds a launcher-owned
projection beneath one dedicated root; callers never choose driver options.
The projection preserves host-side delivery, preview classification and backups
without mounting product stores into workloads. `hostPath` describes that view;
only the issued volume identity is used for a workload mount. Projects derive
their path from stable ids through `projectWorkspaceRelative`; operator aliases
remain service configuration and must fall beneath the same root.

`WorkspaceVolumes` journals intent BEFORE creation in machine-local operational
state. It never opens the product store. A separate SQLite exclusive transaction
fences service processes while the JSON journal is atomically committed and
fsynced; OS process death releases the lock. A failed journal write poisons the
manager until restart. A volume that predates its creation intent is never
adopted or removed. Failed removal retains its lease and prevents reuse.

Heartbeats renew a ten-minute lease, capped at 24 hours from workspace creation.
Expired leases cannot be resurrected. Socket expiry joins the in-flight operation
before reverse teardown; failed disconnect cleanup retries every 30 seconds.
Boot recovery runs under the process lock, before accepting clients: workers,
owner networks, volumes, then stale UUID socket directories. Engine absence
must be confirmed. Run bytes survive volume teardown for retention/backup (W9);
only ephemeral preview projections are removed. Never broaden that deletion to
run data. Shared root paths and local-driver backing must be mounted consistently
on the engine host, launcher and control plane; W7 packages that topology.
## The flags are the isolation

Every flag in a profile was verified against a real container before it was
written down, and `tests/egress-sidecar-lifecycle.test.ts` asserts the exact
command sequence rather than trusting a comment. Three facts sit behind the
egress profile and none may be relaxed:

- `--network none` blocks the control plane and the internet; the DEFAULT
  bridge REACHES the control plane; only `--internal` WITH
  `gateway_mode_ipv4/ipv6=isolated` blocks both while still being a LAN a proxy
  can bridge. Plain `--internal` is not enough — its bridge gateway can reach
  host services.
- Docker Engine 28+ is required for those gateway modes, and an older engine
  FAILS CLOSED. `isIsolatedGatewayUnsupported` exists so the caller can say so
  rather than silently serving a weaker network.
- One network per owner, never shared. Reproduced: two containers on one
  `--internal` network read each other's HTTP servers, so a shared network
  hands one tenant's workspace to the next.

## Two families, one namespace each

`dev.atoma.owner` is `egress` or `preview`, and every object carries it. The
families must not share a namespace: a sweep collecting orphaned previews must
never remove a live run's egress network. A reconciler therefore queries once
per family, and `listUnits` reads a unit's kind from its name prefix.

Object names are deterministic from the owner id and are **wire contracts
between containers**, not cosmetics: the relay resolves its upstream by the app
unit's name, and the run reaches its proxy by the proxy's. Renaming one is a
change to what two containers agree on.

Sweeps and per-owner teardown remove **containers before networks**. A network
with an endpoint still attached refuses removal, so the reverse order spends
the entire bounded retry budget losing to a container nobody removed. Within a
preview, the relay goes before the app: it is what holds the network open and
what a member is still connected to.

## The preview profiles

- **`preview-app`** runs the delivered application: pinned image by digest,
  `--runtime=runsc`, non-root, read-only root filesystem, `--cap-drop ALL`,
  `no-new-privileges`, memory equal to memory-swap (otherwise the cap is
  escapable by swapping), bounded CPU/pids/nofile, two bounded tmpfs (`/tmp`
  and `/data`, both dying with the container, which is what makes a restart
  begin again from the immutable copy), rotated logs, and a fixed set of
  environment variables — never a spread of the parent environment, whose
  variables are credentials and store paths. One mount: the launcher-issued
  workspace. The command is exactly `node <entry>`, never a shell.
- **`preview-ingress`** runs the relay. Its upstream is resolved HERE from the
  app unit of the same owner, which is what makes it impossible to point
  anywhere else. It publishes on **loopback only**, on an OS-assigned port the
  launcher reads back — a caller that could choose a host port could collide
  with another preview's, or with anything else on the machine.
- `runsc` is the default and production requires it. Whether a dev runtime is
  admissible is the CALLER's decision, made when it constructs the launcher;
  an unset runtime here would be a bug, not a permission.

A mount string is a wire value for the engine, and the engine speaks POSIX, so
a host path is converted rather than passed through — a developer host with
backslash separators would otherwise hand Docker one unreadable component.

Three of these were MEASURED against a real container rather than reasoned
about, and each was wrong before it was measured:

- **The relay needs a PUBLISHABLE leg.** Docker publishes no port at all for a
  container whose only network is `--internal` — `docker port` answers "No
  public port published" — so a relay attached to the isolate's network alone
  listens where nothing can reach it. It is created on the publishable network
  and the internal one is connected after, which is also why the design says
  it is the one component on both.
- **The container must be able to READ the mount.** The copy is written by the
  control-plane process, so a container running as anyone else dies with
  MODULE_NOT_FOUND on its own entry file. `hostContainerUser()` — the helper
  the worker backend already used for exactly this — is the default; as root
  there is no uid to match, so the copy is chowned to the fixed non-root
  identity instead of being widened to world-readable.
- **The command must not be the image's.** `--entrypoint node` is passed
  explicitly, because an image ENTRYPOINT would otherwise wrap the one start
  command the profile is allowed to run.

The optional `preview-egress-proxy` belongs to the preview family and is
removed with its generation. The app receives only a derived proxy address
and loopback bypass; it remains on the internal network. The Docker backend
reads the proxy IPv4 endpoint on that exact internal network before starting
the app, so gVisor does not depend on Docker embedded DNS. A missing endpoint
refuses startup; the uplink address is never used.

## Workspaces: the launcher issues, the caller fills

`createWorkspace` hands back a location; the preview subsystem writes the
filtered copy into it. That split keeps "no mount paths from callers" true
while the copy's CONTENT and its filtering policy stay with the subsystem that
understands the deliverable. The directory is recreated empty every time: one
left by a crashed predecessor would be mounted into the next generation, which
is how a preview would serve bytes the run that owns it never produced.

The service uses a named volume with a shared projection; the legacy local
backend retains its direct directory. The optional `hostPath` is a copy/view
capability, not the engine identity. Mount construction resolves the issued
volume inside the launcher rather than accepting a handle's path back.
## Ordering belongs to the caller

`purgeOwner`, `createNetwork`, `startUnit` and `removeNetwork` are primitives.
WHICH objects are cleaned, created, connected and torn down, and in WHAT
sequence, is the caller's contract with its own domain — the egress sidecar
keeps that order, and it is unchanged from before the extraction. A launcher
that decided the order would make every caller's teardown its business, and
the asymmetry between the failure path and the stop path (internal-then-uplink
versus uplink-then-internal) would have been quietly normalised away.

`removeNetworkBefore` exists for the same reason: several removals in one
teardown must share ONE deadline, not each get a fresh budget.

## Intentional choices and rejected shortcuts

- **A launcher that returns a pipe.** It would make the interface unswappable
  for the one operation that matters most, and it is what keeps the worker's
  transport behind an explicit socket protocol.
- **Auto-arming the hard-exit registry inside `createNetwork`.** Tracking is
  armed BEFORE creation on purpose: if stale-object removal raced the engine's
  endpoint teardown, `create` itself can fail while the old objects are still
  durable and still need the fallback.
- **Recovering an owner id from an object name.** Names carry a hash, so they
  cannot be reversed. A reconciler only needs to remove the object; a caller
  that needs the original owner holds it already.
- **A second copy of the naming rule.** `networkName` and `unitName` are on the
  contract so a failure path with no handle can still name what it must
  remove, instead of rebuilding the rule at the call site.
