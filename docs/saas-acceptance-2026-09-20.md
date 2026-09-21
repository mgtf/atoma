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
hosted recovery requirement. W14 subsequently passed its corpus/HTTP-trace
extension: [scope and results](shared-learning-acceptance.md#assembled-isolation-acceptance).
W13 was committed as `5f1a6c2`: [CI passed](https://github.com/mgtf/atoma/actions/runs/35508994558)
and [production deployment passed](https://github.com/mgtf/atoma/actions/runs/35509259717).

## Final closure

**W8-b completed:** the [final hosted drill](saas-hosted-recovery-2026-09-20.md#final-capture--w8-b-passed)
restored a fresh production backup on another machine: complete inventory,
15 runs without issues and eight envelopes decrypted with the separately
retrieved key. Observed snapshot age was 42.4 seconds at receipt; offline
extraction/integrity took 10.99 seconds. No secrets or customer payloads are
committed. The first incomplete snapshot remains unchanged historical evidence.

**W12 completed:** the [hosted-service terms](platform-commons-terms.md) are
published in this public repository and linked from the README. They include
Matthieu Foillard's confirmed identity, Athens postal address and `mgf@iotanet.net`
support/privacy contact. Publication is not evidence of individual acceptance;
the agreed W12 scope adds no consent-recording mechanism.

The owner lifted the test deferral on 2026-09-20 for isolated environments.
The agreed SaaS work list is complete within the scopes recorded above. No real
retention purge or restoration over the live production state was performed.
