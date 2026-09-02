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

**It must be a separate registrable domain from the visualizer's**, and atoma
refuses to boot otherwise. The session cookie is host-only, so it is never sent
to a preview host — but a shared registrable domain puts model-authored code
within reach of cookie-scoping tricks and same-site assumptions the design
relies on. The check is conservative on purpose (it compares the lowest two
labels), so it refuses more configurations than strictly necessary.

```
visualizer   atoma.example.com
previews    *.previews.example.net      A/AAAA -> the same host
```

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
atoma.example.com {
    reverse_proxy 127.0.0.1:5173
}

*.previews.example.net {
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
[`.env.example`](../.env.example). The minimum:

```bash
ATOMA_VIZ_AUTH=1
ATOMA_VIZ_PUBLIC_ORIGIN=https://atoma.example.com
ATOMA_PREVIEW=1
ATOMA_PREVIEW_DOMAIN=previews.example.net
ATOMA_PREVIEW_IMAGE=<registry>/atoma-preview@sha256:...
ATOMA_PREVIEW_GATEWAY_PORT=4311
```

The auth gate is a PRECONDITION, not a companion setting: a preview belongs to
an organisation's run, and there are no organisations without the gate. The
public origin must be HTTPS — the grant cookie is `__Host-` and `Secure`, and a
browser stores neither over `http://`, so previews would 404 with nothing in
the logs to explain it. Doctor names both.

There is no partial mode: half a configuration is a hard failure at boot rather
than a silent "disabled".

## 5. What it costs while it runs

A preview is one container per generation plus a small relay, bounded by
`ATOMA_PREVIEW_MAX_GLOBAL` and `ATOMA_PREVIEW_MAX_PER_ORG`. It lives only while
someone is watching: the visualizer heartbeats, and the container stops at
`ATOMA_PREVIEW_IDLE_MS` without one, or at `ATOMA_PREVIEW_HARD_MS` regardless.
The application's own traffic never counts as activity — a tab left open on
generated code that polls itself cannot keep its own container alive.

Refusing past capacity is deliberate and never evicts someone else's preview:
the caller gets `429` with a `Retry-After`.

## 6. Egress

Denied by default. A preview reaches nothing — not the internet, not the
control plane, not another tenant's container. An organisation admin may
approve specific hosts, and only hosts a delivered run of that project actually
requested: an approval for a host nobody asked for is a standing permission
nobody reviewed. Changing the set stops that project's live previews, so the
next generation gets a coherent policy rather than a running one whose rules
changed underneath it.

Previews of a run still IN FLIGHT get no egress at all: the run has declared no
hosts yet, which is the right default for code nobody has finished writing.
