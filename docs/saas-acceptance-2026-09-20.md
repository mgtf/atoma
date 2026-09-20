# SaaS acceptance evidence — 2026-09-20

This receipt separates executed checks from remaining acceptance. Reuse the
linked evidence until the relevant implementation changes; a missing hosted
check does not invalidate unrelated passing regression tests.

## Executed evidence

| Scope | Evidence | Result |
|---|---|---|
| Release checks, W9 retention, W10 admission, W11 audited reads, W14 shared-learning arm | [CI at `4788dfd`](https://github.com/mgtf/atoma/actions/runs/35478666242) | 4,215 tests passed; 19 skipped. Both TypeScript configurations, lint, docs, audit, build and compiled release smokes passed. |
| Deployment of that revision | [Production deployment](https://github.com/mgtf/atoma/actions/runs/35478977451) | Passed, including public TLS verification. This is the existing deployment, not acceptance of the new Compose stack. |
| Local admin MCP access | Source viz, existing local platform-admin account, HTTP MCP through the configured public origin on port 5173 | Connected; 38 tools listed; `atoma_projects_list` succeeded. Temporary test token revoked. No inference call made. |
| Launcher workspace backup regression | Isolated Linux ext4 snapshot of `4788dfd` plus the backup/restore changes in this receipt; Node 24.20.0; fresh `npm ci` | `tests/backup.test.ts` and `tests/restore-drill.test.ts`: 29 passed. |

The backup regression uses the production backup implementation and a separate
Python restore process. It archives the launcher projection, moves the original
workspace away, restores the delivered file, and verifies that loss of the
configured projection fails the drill. Legacy six-tier snapshots remain readable;
launcher deployments emit layout version 2 with a mandatory `workspaces` tier.
This fixture is not a backup retrieved from production.

## Image packaging

The web, launcher and worker images built successfully from the isolated Linux
snapshot. The web image's compiled backup help and the launcher image's help
passed with networking disabled. Dedicated `saas-acceptance-20260920` local tags
were used; no production image was replaced or registry image published.

Both TypeScript configurations, targeted ESLint, documentation checks and the
server/client build passed for the backup change. These checks do not replace a
release check for a future publication.

## Real launcher and worker boundary

`scripts/launcher-container-smoke.mjs` passed against an isolated Docker 28.3.2
daemon inside a disposable container. The existing Docker Desktop engine had an
old Atoma container, so the harness refused it before creating any resources.
No existing workload was removed. Built images were copied into the private
engine; the driver and launcher held that engine's socket, while the web-image
client and workers did not.

The scenario exercised the packaged launcher service, its actual RPC socket,
named workspace volumes and actual worker protocol. Organisation A wrote and
read its file. Organisation B wrote its own deliverable and tried filesystem
access to A's file, the launcher socket, Docker socket and product-store path;
all were unavailable. After a graceful launcher restart, A's bytes were still
readable and the same isolation probes passed again. The engine confirmed no
labelled workload containers, networks or workspace volumes remained afterward.

This is a filesystem and lifecycle proof, not the complete W13 scenario: it
uses test workspace identities, not authenticated project admission or a model
run. It does not exercise HTTP trace/corpus readers, worker egress, a launcher
crash or previews. A pulled Node digest supplied the unused preview profile;
no gVisor execution or full reference Compose boot is claimed.

Reproduce on an idle disposable Linux engine with the built images available:

```sh
ATOMA_TEST_WEB_IMAGE=<built-web-image> \
ATOMA_TEST_LAUNCHER_IMAGE=<built-launcher-image> \
ATOMA_TEST_WORKER_IMAGE=<built-worker-image> \
ATOMA_TEST_PREVIEW_IMAGE=<pulled-preview-repository@sha256:digest> \
node scripts/launcher-container-smoke.mjs
```

The harness requires a short engine volume mountpoint for Unix socket paths,
refuses existing Atoma resources, and removes its own service and test volume.

## Packaged-stack acceptance, completed later on the same day

W13 passed with the preview image-selection fix: [full scenario and limits](saas-stack-acceptance-2026-09-20.md).
The earlier narrower launcher result above remains historical evidence. The
new result includes actual Compose boot, HTTPS/OAuth, gVisor, worker egress,
scoped HTTP reads, backup/restore and graceful restart. It does not close the
hosted recovery requirement or W14's remaining corpus/HTTP-trace checks.

## Remaining closure conditions

1. **W14 isolation:** complete corpus-search and HTTP trace-reader acceptance
   for two organisations on the stack. W13 has now proved the assembled stack,
   worker filesystem separation, scoped run/preview reads and runtime confinement.
2. **W8-b:** restore a backup actually retrieved from the hosted deployment,
   retrieve its encryption key separately, verify decryption without printing
   secrets, and record backup age (observed recovery point) and recovery time.
   The admin MCP catalogue does not provide host backup/key retrieval.
3. **W12:** the [commons terms draft](platform-commons-terms.md) records the
   commissioned product terms. Operator identity/contact and publication remain
   to be supplied by the operator.

The owner lifted the test deferral on 2026-09-20 for isolated environments.
Remaining runtime checks are pending environment execution, not permission to
test. No real retention purge or production restoration was performed.
