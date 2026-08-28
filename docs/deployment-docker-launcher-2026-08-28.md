# Deployment shape: Docker images + in-house launcher — decision record

> Internal design decision · Atoma · 2026-08-28
>
> Status: **direction decided, not implemented**. This document records the
> deployment target and the launcher architecture that the result-preview
> design (and any future run-execution change) must build against. It is
> evidence in the `docs/decided-not-built-2026-08-23.md` pattern, not a
> normative contract: `AGENTS.md` files remain the runtime rules until an
> implementation lands and links back here.

## 1. Decisions

1. **Deployment target is SaaS on Linux infrastructure.** Atoma is not a
   laptop-local product in its target form. The developer workstation
   (macOS/Docker Desktop) is a development environment, never a constraint
   that production designs must satisfy. Any design that grounds itself on
   Docker Desktop behaviour (unreachable container IPs, `*.localhost`
   resolution, missing gVisor) is describing the dev profile, not the product.
2. **Atoma ships as Docker images.** The release artefact evolves from an
   archive toward a set of images plus a reference compose/stack file:
   the atoma web/control-plane image, the launcher image, the worker image
   (already built from packaged `dist/`), and a pinned preview image.
3. **Each run executes in its own container(s)**, launched per run (worker +
   egress sidecar), as today — but launched *by the launcher*, not by the
   web process.
4. **Each result preview executes in its own container(s)** (app + ingress),
   also launched by the launcher, under a separate lifecycle from runs.
5. **v1 orchestration is plain Docker plus an in-house launcher.**
   Kubernetes is explicitly deferred (section 4) and must remain a backend
   swap, not a rewrite — which constrains the launcher interface (section 2).

## 2. The launcher

### Why it exists

A containerised atoma must start sibling containers. Mounting
`docker.sock` into the web-facing container would hand host-root to the
process that also holds session cookies, the authenticated API, and the
product store — the exact inversion of the repository's isolation
discipline (workers are already forbidden the socket). Therefore:

- **Invariant: the atoma web container never mounts the Docker socket, in
  any mode, including development.**
- **Invariant: exactly one component — the launcher — holds Docker API
  access.** It runs as a separate container (or host daemon) under its own
  OS identity, with the socket (or a scoped socket proxy) mounted only there.

This generalises the `previewd` proposal from `docs/sandbox-co.md`: not a
preview-only daemon, but the single container-launching boundary shared by
runs and previews. Designing it once for both is the point.

### Interface: narrow, typed, backend-agnostic

The web process reaches the launcher over a permissioned Unix socket (or
internal-network endpoint) speaking a typed protocol. The launcher accepts
only closed operations; it **never** accepts a raw command line, image
name, mount path, environment map, network name, or any Docker option from
its callers — those are derived launcher-side from the profile.

Sketch (shapes live in `src/contracts/` when implemented, one schema per
shape):

- `startRun(runSpec)` — worker + egress sidecar, per-run internal network,
  workspace volume mount; returns a run handle.
- `startPreview(previewSpec)` — app container + ingress relay, per-preview
  internal network, read-only/copy mounts; returns a preview handle.
- `status(handle)` / `stop(handle, reason)` / `list(kind)`.
- Heartbeat/TTL enforcement and label-based GC of orphans live in the
  launcher, since only it can see and remove Docker objects.

Both profiles reuse the existing container discipline verbatim: one
`--internal` network per unit with isolated gateway modes, `--cap-drop ALL`,
`no-new-privileges`, non-root uid:gid, bounded resources, labelled objects,
bounded teardown in reverse order, reconcile-on-boot. `src/tools/`
(`containerExecutor.ts`, `egressSidecar.ts`) is the code that migrates
behind this seam.

The interface must be narrow enough that a Kubernetes backend later
implements the same operations (Job/Pod creation under RBAC) without the
callers changing. That is the concrete meaning of "Kubernetes is a swap".

### Consequences for existing code

- **Workspaces become volumes.** `projectRunHostLayout()` and `~/.atoma/*`
  paths are host-filesystem assumptions. Containerised, run workspaces live
  on named volumes the launcher mounts into run containers and (as a
  filtered copy or read-only view) into preview containers. This is a real
  migration of existing code, independent of the preview feature.
- **Ingress is a container attached to two networks.** The relay pattern
  from `docs/sandbox-cl.md` — dismissed there as a Docker Desktop
  workaround — is in fact the natural all-container ingress: the gateway
  joins the publishable network and each per-preview internal network.
- **The MCP run lease and run serialisation** move conceptually into the
  launcher's domain: it is the component that can actually guarantee one
  live run.
- **`doctor`** gains launcher checks (socket reachable, images pinned and
  present, orphan counts) instead of assuming host-local Docker.

## 3. Impact on the preview design consolidation

The three drafts (`docs/sandbox-cl.md`, `docs/sandbox-co.md`,
`docs/sandbox-gr.md`) all assume atoma runs on the host. Arbitration under
the decided deployment shape:

- **Base: `sandbox-co.md`** — its production posture (gVisor `runsc`
  required, dedicated preview domain, wildcard TLS, daemon boundary,
  one-time claims, org-admin egress approval) matches the SaaS target; its
  `previewd` generalises into the launcher above.
- **Keep from `sandbox-cl.md`** — the measured fact that the artifact
  manifest is not runnable (3 declared files of 12 present on a real run),
  which forces an explicit choice between serving a filtered workspace copy
  and funding `co`'s declared-bundle + dependency-layer run-side work; the
  exact network flags and two-network relay mechanics; the precise code
  anchors (host-only session cookie, `projectRunPublicSchema`, egress
  sidecar discipline).
- **Keep from `sandbox-gr.md`** — the product name **result preview**
  ("sandbox" stays the `ToolSandbox` word, which is not an isolation
  boundary — F1); operator-corpus previews explicitly out of v1.
- **New section required** — a development-environment profile: production
  requires runsc with no silent fallback, so feature development needs a
  stated dev story (Linux VM/host with runsc, or an explicitly non-prod
  dev flag), written down rather than discovered at `doctor` time.

## 4. Kubernetes: recorded analysis, deferred decision

Deferred, not rejected. Recorded here so it is not re-litigated from
scratch.

### What it would buy

- **Replaces the in-house launcher**: the Kubernetes API with a
  tightly-scoped ServiceAccount is the launcher with RBAC and audit built
  in; no socket handling at all.
- **Declarative lifecycle**: Jobs with `activeDeadlineSeconds` (watchdog),
  `ttlSecondsAfterFinished` (GC), `ownerReferences` (cascade cleanup)
  replace exit registries, bounded teardowns, and label-sweep
  reconciliation.
- **gVisor as one line**: `runtimeClassName` per pod instead of per-host
  runsc installation checks.
- **Multi-node scheduling and per-tenant quotas**: `ResourceQuota` per
  namespace (org→namespace) replaces in-memory counters; node failure
  reschedules work.
- **Industrialised ingress/TLS**: Gateway API + cert-manager replace the
  hand-run wildcard proxy.

### What it would cost

- Operating a cluster (even managed): upgrades, CNI, CSI, RBAC — a
  permanent tax oversized for a one-or-two-node SaaS.
- gVisor support on managed offerings is uneven (native on GKE Sandbox;
  self-managed node pools on EKS/AKS) — it constrains cloud choice.
- Network isolation changes model: per-unit `--internal` networks become
  `NetworkPolicy`, enforced only by capable CNIs (Cilium/Calico), and
  hostname-level egress allowlisting still needs Cilium or the existing
  sidecar proxy — the sidecar is ported, not deleted.
- Real rewrite of the Docker-CLI-shaped layer and of the isolation tests
  that cross the actual boundary (kind + runsc is workable but heavy).

### What it does not solve

Everything product-level is substrate-independent and remains the bulk of
the work: per-preview browser origin, claims/tokens/cookies, CSP and
response-header stripping, workspace-vs-manifest, the
`PORT`/`LISTENING_ON_PORT` contract, org roles and quotas policy, the GPU
client surface.

### Revisit triggers

Adopt Kubernetes when any of these becomes true: more than one execution
node is needed; per-org quotas must be platform-enforced rather than
process-enforced; the team no longer wants to own GC/rescheduling logic.
Until then, the launcher interface (section 2) is the insurance policy.

## 5. Follow-ups

1. Consolidate the three `sandbox-*` drafts into one
   `docs/result-preview-design-<date>.md` under the arbitration in
   section 3, then remove the drafts (they contradict each other and must
   not coexist as evidence).
2. Design the launcher contract in `src/contracts/` and the migration of
   `src/tools/` container code behind it — a prerequisite shared by
   containerised runs and previews.
3. Link this document (and the consolidated preview design) from the root
   `AGENTS.md` *Historical evidence* list at approval time — deliberately
   not done in this session.
