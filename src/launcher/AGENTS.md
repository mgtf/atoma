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
runtime breaks; the preview profiles join when the preview runtime lands.

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

## What is IN-PROCESS today, and what that costs

`DockerLauncher` runs inside the calling process. The recorded target is a
launcher in its own container, reached over a permissioned socket. Two things
had to come first: a contract narrow enough that the transport can change
without a caller changing, and one implementation proving that contract
against behaviour that already works.

Until the move happens, be honest about what is true: "the launcher owns the
images and the flags" is a CODE-ORGANISATION property, not yet a security
boundary. It becomes the boundary the day this class runs somewhere else. Do
not describe the current state as satisfying invariant 1 — nothing is
containerised yet, so the invariant is not yet under test.

## What did NOT migrate, and why

The worker container's **attached stdio** stays in
[`src/tools/containerExecutor.ts`](../tools/containerExecutor.ts). It is an RPC
TRANSPORT, not a lifecycle operation: the control plane pipes the tool-call
protocol over the child's stdin and stdout, and a launcher reached over a
socket cannot hand a pipe back.

Closing that gap means giving the worker a socket or network protocol instead
of stdio — a protocol change, with its own compatibility and isolation
questions. Phase 0's contract is explicitly that the run path is unchanged
behaviourally, so it is out of scope here and must not be smuggled in as a
refactor. `workerRunArgs` remains the isolation contract for that path and is
asserted by test, not by comment.

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
  transport out of this subsystem instead of half-in.
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
