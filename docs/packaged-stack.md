# Packaged Linux stack (W7)

Implemented on 2026-09-19. Web and launcher image builds and compiled help
smokes passed on 2026-09-20, followed by [W13 deterministic stack acceptance](saas-stack-acceptance-2026-09-20.md). See the [evidence receipt](saas-acceptance-2026-09-20.md). This is a reference deployment definition,
not evidence that the instance is ready to admit mutually distrusting tenants.

## Runtime boundary

[compose.yaml](../deploy/compose.yaml) starts web, launcher and Caddy. Only the
launcher mounts the engine socket. Workers and previews are created by that
service, not by Compose. All five deployed image references (including those
two workload images) must be published `repository@sha256:<64 hex>` identities.
There are deliberately no sample hashes masquerading as published images.

Use a dedicated Linux host with Docker Engine 28+, Compose 2.30+ and gVisor
registered as `runsc`. Docker Desktop is not this acceptance environment.
The web and launcher use host networking because preview ingress is published
on host loopback; web API and preview gateway bind only 127.0.0.1, on 4111 and
4311. Caddy exposes HTTPS. Leave Docker on its Unix socket only, with no TCP
API. Host networking is a control-plane choice: workloads retain their
launcher-owned isolated networks and non-root identities.

The two application containers currently run as root inside their separate
containers, with read-only image filesystems and no-new-privileges. They need
ownership capabilities for the shared workspace projection and private sockets;
this stack does not claim rootless control-plane operation. Product data is
mounted only in web; launcher state is mounted only in launcher. Workspaces
and socket directories have the same absolute path on the host and both
containers. Keep these mounts together if adapting the file.

The web image packages the complete compiled server/client, production npm
lockfile dependencies and Python/Haystack BM25. It fingerprints the installed
retrieval runtime at startup. No inference or model downloads occur there.
This reference image supports API model transports; subscription CLI binaries,
hybrid embedding models and the source-checkout mender are not included.
Do not enable subscription selectors until deploying an explicitly extended,
pinned image and verifying the corresponding login/run flow.

## Build and publish from one revision

Use the pinned Node version, install with `npm ci`, and complete
`npm run release:check` before a release. Then build all application images
from that revision's compiled output:

```sh
npm run build:web
npm run build:launcher
npm run build:worker
npm run build:preview
```

These commands create local build tags, not deployment identities. Tag and
push each to your registry using your release identifier, then record the
registry digest returned by the push. Pull each exact reference on the target
host, including the worker and preview (Compose does not pull workload images).
Pin the selected Caddy 2 image in the same way. For an already pulled image,
`docker image inspect --format '{{json .RepoDigests}}' <image>` lists real
manifest references; an image's `.Id` is not a registry manifest digest.
The web Dockerfile accepts `--build-arg NODE_IMAGE=<repository@sha256:...>`
when the build pipeline also pins its base. Deployed image digests fix the
resulting OS and Python dependency bytes; this is not a claim of reproducible
upstream package resolution.

[.dockerignore](../.dockerignore) admits only packaging inputs. Stores, traces,
workspaces, source checkouts, node_modules and environment files stay outside
the context. Build the client first: the web recipe refuses missing client
output instead of shipping a server-only image.

## First installation

On a fresh host, create the dedicated directories before Compose sees them:

```sh
sudo install -d -m 0700 /srv/atoma /srv/atoma/config /srv/atoma/product \
  /srv/atoma/control /srv/atoma/worker-sockets /srv/atoma/workspaces \
  /srv/atoma/launcher-state /srv/atoma/certs
sudo install -d -m 0700 -o 10001 -g 10001 /srv/atoma/workspaces/operator
```

These are initial provisioning commands, not a procedure to reset existing
state. Keep `/srv/atoma/launcher-state` persistent across recreation; never
remove its journal or lock database while a launcher is alive.

Copy [stack.env.example](../deploy/stack.env.example) and
[web.env.example](../deploy/web.env.example) to the private config directory,
mode 0600. Fill the five real image refs, the public hostname, preview namespace,
approved egress hostnames, OAuth client credentials and encryption key.
Generate the latter once with `openssl rand -hex 32` and escrow it separately.
Values in web.env are raw: no shell expansion and no surrounding quotes.
Configure API model selectors and organisation BYO keys through Settings, or
provide explicit host tier pins and credentials as described in
[.env.example](../.env.example). Do not put secrets in image build arguments.

Point DNS for the public host and `*.<preview-domain>` to this host. Provision
`web.crt`, `web.key`, `preview.crt`, `preview.key` under `/srv/atoma/certs`; the
preview certificate must cover the wildcard. [Caddyfile](../deploy/Caddyfile)
uses these operator-managed certificates. Arrange renewal and Caddy reloads;
this stack does not automate DNS challenges or certificate issuance. Register
the OAuth callback as `https://<public-host>/auth/callback`.

```sh
npm run stack:check -- --env-file /srv/atoma/config/stack.env
docker compose --env-file /srv/atoma/config/stack.env -f deploy/compose.yaml pull
docker compose --env-file /srv/atoma/config/stack.env -f deploy/compose.yaml up -d
```

Run the checker before either mutation. It renders Compose without contacting
the engine, verifies digest syntax/profile agreement and does not print secrets.
It cannot prove an image exists, is trusted, or boots; pulling exact refs and
W13 acceptance establish those later properties. Provision/pull the two workload
refs separately before startup. The first login bootstraps the founder; use the
compiled auth CLI inside web for subsequent invitations.

## Operations and remaining evidence

Use `docker compose ... exec web npm run deploy:preflight` before an update;
exit 75 means a run/preview is live and the update must wait. Preserve the
product directory, workspaces, launcher state and separately escrowed secrets.
Backups run with `ATOMA_LAUNCHER_WORKSPACE_ROOT` also capture its `projects/`
projection as a mandatory `workspaces.tar.gz` tier (manifest layout version 2).
Restore with `scripts/restore-drill.py`; an absent projection fails the drill.
The hosted backup/restore drill and its RPO/RTO remain W8-b; do not infer them
from the local backup command. Never copy live SQLite files without the supported
backup procedure, and do not restore launcher state over a running daemon.

Compose orders web after the launcher handshake and gateway after web HTTP
readiness. These probes do not prove login, inference or isolation. Restart web
after any launcher replacement/crash: lost control connections are terminal and
operations are never replayed automatically. Explicit Compose dependency
restarts help planned updates; engine crash restarts are not a reconnection
protocol. Follow [launcher-service.md](launcher-service.md) for lease recovery.

W13 passed for the deterministic assembled boundary on 2026-09-20. Hosted
restore (W8-b) and W14 corpus/trace isolation remain distinct acceptance.
See the [measured scope](saas-stack-acceptance-2026-09-20.md); no production
migration or process-crash recovery is inferred from a graceful restart.

Compose syntax: [Docker service reference](https://docs.docker.com/reference/compose-file/services/).
Proxy configuration: [Caddyfile concepts](https://caddyserver.com/docs/caddyfile/concepts).
