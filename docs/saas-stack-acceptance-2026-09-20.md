# Packaged-stack acceptance — W13

Result: **passed** on 2026-09-20, from `66950eb` plus the preview image-selection
fix described below. The [machine-readable report](saas-stack-report-2026-09-20.json)
records the five actual image digests and the two disposable organisations/runs.

## Executed boundary

The unmodified reference `deploy/compose.yaml` booted web, launcher and Caddy
on an isolated Docker Engine 28.3.2 daemon inside a disposable Linux container.
The outer engine was Docker Desktop; its existing Atoma resources were untouched.
The private daemon registered gVisor `release-20260914.0`. A runtime smoke passed,
and the acceptance driver subsequently inspected the actual preview container's
`HostConfig.Runtime`: `runsc`, with a read-only root filesystem and non-root user.

All five images were pushed to a private registry inside that test environment
and deployed by their registry manifest digests. The web image used the normal
Dockerfile after compiling the fix. No image or state was installed in production.
The temporary registry references in the report are evidence identifiers, not
public download links.

[`packaged-stack-smoke.mjs`](../scripts/packaged-stack-smoke.mjs) and
[`packaged-stack-workload.mjs`](../scripts/packaged-stack-workload.mjs) proved:

1. Clean Compose startup and service readiness, using HTTPS with a fixture
   certificate trusted by the driver. TLS verification stayed enabled.
2. Founder admission through the real OAuth/PKCE flow, compiled CLI invitations,
   member and viewer admission into the founder's organisation, and a second
   independent organisation. Member, viewer and second-owner sessions could not
   use the platform-admin invitation endpoint.
3. Registered project runs with real launcher-issued volumes and real Element
   execution in the worker. Each wrote its own files. The second could not read
   the first workspace/trace, the launcher socket, engine socket or product store.
4. Allowed worker egress to the configured npm registry and denied access to the
   control-plane address. The worker never received engine access.
5. A Node deliverable served through the real preview runtime and relay under
   gVisor. The application could neither write the root filesystem nor reach
   the control-plane address. The engine, not the application, attested runsc.
6. Authenticated HTTP run-list and preview-status reads for the owning
   organisation, with HTTP 404 for the other organisation.
7. The production backup implementation followed by the separate Python restore
   drill: complete inventory, SQLite and both delivered workspaces verified.
8. Graceful launcher/web restart, renewed Compose health, and a still-valid
   authenticated session able to read projects. Compose then removed its services.

The workload is deterministic: project/run records and completion are fixtures
through `ProjectStore`; the real worker produces the deliverable. It does not
exercise a paid model, coordinator planning, GitHub publication, browser GPU
rendering, a process crash or production recovery. W13's assembled mechanical
boundary is accepted; W14 still needs its corpus/HTTP-trace acceptance, and W8-b
still needs a real hosted backup plus separately retrieved key and recovery timing.

## Defect found and regression

The web preview startup passed `DEFAULT_WORKER_IMAGE` to the launcher handshake
even when `ATOMA_WORKER_IMAGE` named a configured digest. The private service
correctly refused that mismatch, so Compose health was green while preview
routes returned 503. The server now compares the configured image, with the
legacy default only when the environment variable is absent.

The acceptance script asserts the authenticated preview-status endpoint too.
It failed with **503 instead of 200** on the old web image, then passed on the
rebuilt image. Checking only container health or invoking the preview runtime
directly would have missed this regression.

The OAuth fixture is shared with `auth-release-smoke.mjs`; that existing
compiled smoke passed after extraction. Both TypeScript configurations, targeted
lint and the server/client build also passed.

The full release-check attempt passed 4,211 tests, with 22 skipped and two
failures: the retrieval scorer compilation exceeded its test deadline, and the
development HTTP routing test did not obtain a response before its readiness
deadline. Both files then passed unchanged with one worker (65 tests). The
remaining release stages passed separately: dependency audit, build, compiled
MCP and auth smokes, and all six CLI help smokes. This records a successful
focused rerun, not a green uninterrupted `release:check` invocation.

## Reproduction

Use a disposable Linux engine host with Node 24.20.0, Docker 28+, Compose 2.30+
and registered gVisor. Follow the [gVisor installation instructions](https://gvisor.dev/docs/user_guide/install/),
including archive checksum verification when installing manually. Never run the
scenario against a production engine: launcher startup reconciles old resources.
The harness refuses an existing product database or labelled Atoma resources.

Build the four application images from compiled output as described in
[packaged-stack.md](packaged-stack.md). Push them as
`localhost:5000/{web,launcher,worker,preview}:w13` to the disposable registry;
push Caddy as `localhost:5000/gateway:w13`, and pull `docker:28.3.2-cli`.
The harness obtains the real digests from those tags, never from image IDs.

On that engine host, create `/srv/atoma/certs` and fixture `web.crt`/`web.key`
and `preview.crt`/`preview.key`, valid for IP `127.0.0.1` and
`*.preview.atoma.test`. The runner creates private configuration, accounts,
workspaces and a random test encryption key; it consumes no real credentials.
Run the driver as root in the host network namespace, with engine access and
the checkout plus `/srv/atoma` mounted at their identical absolute host paths:

```sh
ATOMA_STACK_SMOKE=isolated \
NODE_EXTRA_CA_CERTS=/srv/atoma/certs/web.crt \
node scripts/packaged-stack-smoke.mjs
```

Retain `product/stack-smoke-report.json` before removing the disposable engine.
The registry and fixture keys are disposable; they are not recovery material for
any other deployment. Repeating accepted checks is needed only after a relevant
implementation or deployment-profile change.
