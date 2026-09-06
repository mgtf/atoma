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

**It must be a separate registrable domain from the visualizer's**, and atoma
refuses to boot otherwise. The session cookie is host-only, so it is never sent
to a preview host — but a shared registrable domain puts model-authored code
within reach of cookie-scoping tricks and same-site assumptions the design
relies on. The check is conservative on purpose (it compares the lowest two
labels), so it refuses more configurations than strictly necessary.

```
visualizer   atoma.run
previews    *.previews.example.net      A/AAAA -> the same host
```

`atoma.run` is the one public name of the product. Previews cannot live under
it: a subdomain such as `previews.atoma.run` shares its registrable domain and
is refused at boot, so the preview domain is a second, purpose-bought name.

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
ATOMA_VIZ_PUBLIC_ORIGIN=https://atoma.run
ATOMA_PREVIEW=1
ATOMA_PREVIEW_DOMAIN=previews.example.net
ATOMA_PREVIEW_IMAGE=<registry>/atoma-preview@sha256:...
ATOMA_PREVIEW_GATEWAY_PORT=4311
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
