# Deploying result previews

What a host needs before a member can watch the app a run produced. Verify all
of it with one command:

```bash
npm run doctor -- --preview
```

It starts a real container, asks the ENGINE which runtime ran it, and then
proves the root filesystem refuses a write and a network-less container cannot
resolve a name. A passing result is those refusals. Nothing here calls a model.

This document is the OPERATOR side. The subsystem contract is
[`src/preview/AGENTS.md`](../src/preview/AGENTS.md); the design of record is
[`docs/result-preview-design-2026-08-28.md`](result-preview-design-2026-08-28.md).

## Trying it on a laptop first

```bash
npm run preview:demo
```

It runs a loopback-only OAuth provider (so the auth gate has a complete client
without registering anything), waits for your first login to found an
organisation, then seeds a project and a DELIVERED run through the SAME store
calls the coordinator makes. It prints the `.env` block, and it seeds a
**static** deliverable — that branch starts no container at all, so it needs
neither gVisor nor the preview image. It is the whole machinery apart from the
isolate, which is the half a laptop can run.

**No proxy, no certificate, no DNS.** `ATOMA_PREVIEW_ALLOW_HTTP_DEV=1` serves
previews over plain HTTP on `*.previews.localhost`. Browsers resolve that
family to loopback themselves (RFC 6761 reserves it, so no registrar can sell
one) and treat it as a SECURE CONTEXT, so the grant cookie keeps every
attribute it has in production — `__Host-`, `Secure`, `SameSite=None`,
`Partitioned` — and is still stored inside the cross-site frame. Measured in
Chrome 152, not assumed. The claim and the grant do travel in the clear on
this machine, which is why the flag refuses to resolve unless all four hold:
itself, a `.localhost` domain, a loopback visualizer origin that is PRESENT,
and a loopback gateway bind.

Two things it cannot substitute, and does not pretend to: the gVisor boundary,
and executing a run to produce the deliverable (the run host must be POSIX).

`node` deliverables need a container, and therefore `runsc` — or, on a machine
whose engine cannot register it, `ATOMA_PREVIEW_RUNTIME=runc` with
`ATOMA_PREVIEW_ALLOW_RUNC_DEV=1`. That combination boots ONLY when the
visualizer's public origin and the gateway's bind are both loopback: a machine
nobody else can log in to has no tenants to hand a weaker sandbox. Anything
else — an HTTPS origin, a LAN address, a gateway on `0.0.0.0` — still refuses.

## What this is not

A compose reference for a containerised control plane. That topology — atoma
web, the launcher in its own container, worker and preview images — is
[decided and not built](deployment-docker-launcher-2026-08-28.md): the launcher
runs IN-PROCESS today. A compose file describing containers nobody starts would
be a development-only path advertised as a release contract.

What follows is what an operator deploys TODAY: one atoma process, plus the
wildcard proxy the preview origins need in front of it.

## 1. The host

- **Linux.** macOS with Docker Desktop cannot register an alternative container
  runtime, so `--runtime=runsc` fails there — `runsc --version` working proves
  only that gVisor is installed, not that Docker will accept it. Doctor reads
  the runtime list from `docker info`, which is the engine's own answer.
- **Docker Engine 28+.** Older engines cannot create an `--internal` network
  with `gateway_mode_ipv4/ipv6=isolated`, and a plain `--internal` bridge can
  still reach host services through its gateway. Atoma fails closed rather than
  silently serving a weaker network.
- **gVisor registered with the daemon:**

  ```bash
  # install runsc per the gVisor documentation, then:
  sudo runsc install
  sudo systemctl restart docker
  docker info --format '{{json .Runtimes}}'   # must list "runsc"
  ```

- **The preview image, already present:**

  ```bash
  npm run build:preview          # -> atoma-preview:latest
  docker tag atoma-preview:latest <registry>/atoma-preview:<version>
  docker push <registry>/atoma-preview:<version>
  docker inspect --format '{{index .RepoDigests 0}}' <registry>/atoma-preview:<version>
  ```

  The last command prints the value for `ATOMA_PREVIEW_IMAGE`. It is pinned by
  DIGEST because a mutable tag is not an identity, and the configuration
  refuses one. A preview never pulls at open time: a member's click is not the
  moment to go to a registry.

## 2. The domain

A dedicated subdomain is supported, including `previews.atoma.run` for a
visualizer at `https://atoma.run`. The preview namespace must not equal or
contain the visualizer host. A separate registrable domain remains supported.

HTTPS authentication uses `__Host-` cookies (Secure, Path=/, no Domain), and
never accepts the former unprefixed cookies. Existing HTTPS users must log in
again after this upgrade. Preview responses carry a CSP sandbox even when
opened directly, disallow domain relaxation and restrict resource requests;
control-plane mutations still require the exact application Origin.

For this deployment, create `*.previews.atoma.run` pointing at the VPS, arrange
wildcard TLS, and proxy that wildcard host to `127.0.0.1:4311`. Configure
`ATOMA_PREVIEW_DOMAIN=previews.atoma.run` (without `*.`). Do not enable previews
until the image digest, DNS and TLS are ready.

One host per preview GENERATION, derived from `(orgId, runId, generation)`. A
restart mints a new generation and therefore a new origin, which is what makes
a previous generation's service workers, storage and caches unable to reach the
next. Wildcard DNS and wildcard TLS are both required; there is no list of
hosts to enumerate.

## 3. The proxy

Terminate wildcard TLS and forward to the atoma-owned gateway, which routes
from the `Host` header alone. Send the header through unchanged — it IS the
routing key.

```caddyfile
atoma.run {
    reverse_proxy 127.0.0.1:4111
}

*.previews.atoma.run {
    tls {
        dns <your-provider>          # wildcard needs a DNS-01 challenge
    }
    reverse_proxy 127.0.0.1:4311 {
        header_up Host {host}
    }
}
```

Two rules, and both are the difference between a policy and a suggestion:

- **Do not add response headers of your own** to the preview vhost. The gateway
  drops and re-imposes `Content-Security-Policy`, `X-Frame-Options`,
  `Set-Cookie`, `Permissions-Policy` and the cross-origin family on every
  response. A proxy that appended its own would be a second, weaker opinion on
  the same headers.
- **Do not serve the visualizer and the previews from one vhost.** The origin
  separation is the isolation; a shared vhost quietly rejoins them.

If the visualizer sits behind this proxy too, set
`ATOMA_VIZ_TRUSTED_PROXIES` to the proxy's exact IP — `X-Forwarded-For` is
ignored otherwise.

## 4. The environment

Every variable, with the reasoning, is in
[`.env.example`](../.env.example). The preview-specific settings below accompany
the complete OAuth configuration
from [automatic deployment](automatic-deployment.md):

```bash
ATOMA_VIZ_AUTH=1
ATOMA_VIZ_PUBLIC_ORIGIN=https://atoma.run
ATOMA_PREVIEW=1
ATOMA_PREVIEW_DOMAIN=previews.atoma.run
ATOMA_PREVIEW_IMAGE=<registry>/atoma-preview@sha256:...
ATOMA_PREVIEW_GATEWAY_HOST=127.0.0.1
ATOMA_PREVIEW_GATEWAY_PORT=4311
ATOMA_PREVIEW_RUNTIME=runsc
```

The auth gate is a PRECONDITION, not a companion setting: a preview belongs to
an organisation's run, and there are no organisations without the gate. The
public origin must be a SECURE CONTEXT: HTTPS anywhere anyone else can reach,
or loopback, which browsers already treat as trustworthy. The grant cookie is
`SameSite=None; Partitioned`, so it is the visualizer's own context that
decides whether the browser keeps it for the frame — get this wrong and every
preview 404s with nothing in the logs to explain it. Doctor names both.

There is no partial mode: half a configuration is a hard failure at boot rather
than a silent "disabled".

## 5. What it costs while it runs

A Node preview uses one container per generation plus a small relay; static
previews serve the classified files without an application container. Both are bounded by
`ATOMA_PREVIEW_MAX_GLOBAL` and `ATOMA_PREVIEW_MAX_PER_ORG`. A preview lives only
while someone is watching: the visualizer heartbeats, and the instance stops at
`ATOMA_PREVIEW_IDLE_MS` without one, or at `ATOMA_PREVIEW_HARD_MS` regardless.
The application's own traffic never counts as activity — a tab left open on
generated code that polls itself cannot keep its own container alive.

Refusing past capacity is deliberate and never evicts someone else's preview:
the caller gets `429` with a `Retry-After`.

## 6. Egress

Only approved destinations are reachable. The operator resource baseline below
applies to delivered and in-flight previews. Organisation admins may additionally
approve hosts a delivered project requested. Changing project approvals stops
its live previews so the next generation gets a coherent policy.

## Operator-approved network access

`ATOMA_PREVIEW_ALLOWED_HOSTS` is a comma-separated list of exact public DNS
hosts. An explicitly empty value disables operator-approved external access.
The default permits Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`),
jsDelivr and unpkg. Browser resource policy and Node preview proxies use the
same effective list. Each Node preview gets a proxy owned by its generation;
its application container retains an isolated internal network.

Project runs now enable proxied egress by default. `ATOMA_EGRESS=0` disables
it; `ATOMA_EGRESS_ALLOWLIST` replaces its default registry and resource hosts.
Chromium uses the worker proxy explicitly, while localhost probes remain direct.
Changes take effect for new runs and preview generations after server restart.

To exercise the live network path locally (Docker and the worker image required):

```bash
npx vitest run tests/preview-egress.test.ts
```

This smoke uses a controlled origin on the proxy uplink and checks refusal of
unapproved hosts and the control plane. The worker CI job runs it against the
real preview image under `runc`; the manual gVisor job repeats it under `runsc`
alongside the isolation suite. Missing Docker is a hard failure in both CI jobs.
