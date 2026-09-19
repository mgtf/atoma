# Separate launcher service (W1–W3)

Implementation: 2026-09-19. Execution, Docker and deployment acceptance are
explicitly deferred. Without `ATOMA_LAUNCHER_SOCKET`, source hosts keep their
in-process backend. A configured service never falls back to local Docker.

## Boundary

The Linux launcher alone holds `docker.sock`. Its private Unix control socket
accepts closed, versioned profiles, never caller commands, images, bind paths,
network names or environment maps. Socket group membership is operator authority.
Callers verify the worker/preview image and runtime reported by the service.

Workers receive `/workspace` as a named volume and one read-only socket FILE.
They connect to that socket; the launcher relays NDJSON to a separately issued
caller endpoint. The worker cannot replace the socket with a symlink or reach
the control endpoint or a sibling worker. Tool requests stay concurrent and
id-matched. Losing either connection is terminal; mutations are not replayed.

Egress remains explicit and deny-by-default. For service workers,
`ATOMA_EGRESS_ALLOWLIST` is read on the launcher (comma-separated hosts, empty
when absent). The caller chooses whether to use the closed proxy topology,
never its network names or policy. Local mode retains its host allowlist.

## Build and configure

Compile with `npm run build`, then build the worker and launcher images with
`npm run build:worker` and `npm run build:launcher`. Rebuild the worker: an older
stdio-only image cannot serve the socket transport. `npm run launcher -- --help`
uses the compiled entrypoint. The launcher image contains its code, contracts,
Zod, Node's SQLite support and the Docker client; no product store or credentials.

| Variable | Where / meaning |
|---|---|
| `ATOMA_LAUNCHER_SOCKET` | Launcher and caller: absolute control socket in a private pre-created directory |
| `ATOMA_LAUNCHER_STATE_ROOT` | Launcher only: pre-created real directory, mode `0700`, persistent on the machine |
| `ATOMA_LAUNCHER_WORKSPACE_ROOT` | Launcher and project coordinator: same dedicated absolute workspace projection root |
| `ATOMA_LAUNCHER_WORKER_SOCKET_ROOT` | Launcher: short, private, pre-created socket root, also visible to callers at the same path |
| `ATOMA_LAUNCHER_PREVIEW_IMAGE` | Launcher: required digest-pinned preview image |
| `ATOMA_LAUNCHER_WORKER_IMAGE` | Launcher: worker/relay image, default `atoma-worker:latest`; deployment digest pins are W7 |
| `ATOMA_LAUNCHER_PREVIEW_USER` | Launcher: non-root numeric `uid:gid`, also used by service workers |
| `ATOMA_LAUNCHER_RUN_WORKSPACES` | Launcher: optional operator aliases, e.g. `{"build":"/srv/atoma-workspaces/operator/build"}` |
| `ATOMA_LAUNCHER_WORKSPACE_ID` | Operator run caller: one configured alias; project runs use their recorded ids instead |

Do not share state between two active launcher instances or configure separate
state roots against the same engine. Keep operational state and socket roots
outside every workspace. The worker socket root must be short enough for Unix
socket names (the implementation refuses overlong paths). Never mount product
state or a whole home directory into the launcher or worker.

The service and caller use the same uid, or the caller runs as root, so private
data endpoints remain accessible without widening permissions. The worker user
must own seeded workspace bytes. A root service assigns the workspace directory
to that identity; the preview copy writer assigns its filtered files as well.
A non-root launcher uses its own uid/gid. Provision these permissions explicitly.
The coordinator forwards the control selector and optional operator key to the
supervisor; the Element worker never receives the control socket path.

## Workspaces and recovery (W3)

Each service workload mounts an issued **named volume**, using `--mount
type=volume,...,volume-nocopy`. The selected local driver binds a directory
beneath the launcher's dedicated workspace root. Only the launcher supplies
those driver options. The handle carries the volume identity; `hostPath` is a
shared file projection for delivery, classification, previews and backups,
never permission to choose an engine bind path. This is not a remote-filesystem
or arbitrary volume-driver implementation.

The engine host, launcher and control plane must see that projection at the
same absolute path. W7 packages those mounts; this implementation does not
claim an all-container deployment has been accepted. The existing local backend
keeps its historical direct bind mounts.

Project workspace directories are derived from stable organisation, project
and run ids by one shared function. The coordinator records the projected path
before launch, and the launcher provisions the volume automatically. No
per-project/run alias is needed. Operator aliases must be below the same root;
the caller's existing profile path must equal the issued projection. A mismatch
refuses before any tool invocation. Overlapping active workspaces are refused.

Operational state is independent of the product database. `workspaces.json`
records reserved/creating/ready intent before engine side effects, with atomic
replacement and fsync. `lock.db` holds a SQLite exclusive transaction as a
process mutex; it is not the journal. A crash releases the OS lock without
rolling back the separate journal. Failed journal writes stop further workspace
mutations until restart. An existing volume without this creation intent is
never adopted or deleted.

The caller renews leases every 30 seconds. Leases expire after ten minutes
without renewal and cannot outlive 24 hours from workspace creation. An expired
lease cannot be resurrected. Expiry closes the owning connection and waits for
its in-flight operation before cleanup. Failed disconnect teardown retains
ownership and is retried every 30 seconds.

Teardown removes workers/apps, then networks, then volumes. A failed engine
query is never evidence of removal. Releasing a run volume retains its files
for delivery, backup and W9 retention; releasing an ephemeral preview also
removes its copied projection. No run evidence is swept by this change.

On startup, while holding the process mutex and before accepting callers, the
launcher reaps labelled workers, replays journaled owners in reverse teardown
order, reconciles preview/egress orphans and removes stale UUID worker socket
directories. Failure aborts startup with the journal intact. A stale control
socket is removed only after a liveness probe and under the mutex. A live
endpoint refuses startup. `npm run launcher -- --reconcile` remains available
on an idle running service; it refuses active ownership.

Preserve this machine-local state directory across launcher restarts. Changing
its root or discarding its journal is not recovery. Switch topology only while
runs and previews are quiescent. Relay ports remain on the Docker host's
loopback; gateway connectivity and the reference stack are W7.

## Verification status

Static TypeScript/build/lint and documentation checks are separate from runtime
acceptance. Regression sources cover the real service/worker socket boundaries
with fake engines, volume identity and projections, failed removal, lease
expiry, and a process-held lock plus SIGKILL journal replay. Execution of these
tests was deferred at the owner's request. Run them, release checks, worker
build/isolation and real restart recovery before deployment.

## Reference stack

W7 packages the shared path and loopback requirements in
[the Linux reference stack](packaged-stack.md). Its web environment forwards
`ATOMA_WORKER_IMAGE` into project children, and both callers and launcher use
the same exact published digest reference. Image builds and runtime acceptance
remain deferred.
