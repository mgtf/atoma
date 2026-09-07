# Automatic deployment after GitHub CI

This is the deployment path the repository supports today: one compiled Atoma
process on an existing Linux host, with Docker Engine available to its
in-process launcher and a reverse proxy in front. It does **not** claim that
the future web/launcher image topology in
[`deployment-docker-launcher-2026-08-28.md`](deployment-docker-launcher-2026-08-28.md)
has been built.

The workflow is disabled until an operator explicitly arms it. With no host
configuration, a successful CI run produces a short-lived immutable artifact
and the deployment workflow is skipped.

## What happens

1. The `core` CI job builds and verifies one commit, then archives the runtime
   files under `atoma-<full-sha>/` with a revision receipt and SHA-256 file.
2. Only a successful `CI` workflow caused by a push to `main` may enter the
   `production` GitHub environment. Pull requests can never reach its secrets.
3. The deployment job downloads the artifact from that exact CI run, verifies
   its digest, and streams it over SSH with strict host-key checking.
4. The root-owned host activator takes a host-local deployment lock, creates
   the deployment marker, takes the machine-global run lease without stale
   recovery, and refuses while a project run or result preview is live.
5. It stops the old service, installs production dependencies, runs the
   compiled release smoke, builds an immutable `atoma-worker:<sha>` image,
   moves `atoma-worker:latest`, and atomically switches `/home/atoma/current`.
6. Any failure after service shutdown restores the previous release symlink,
   worker tag and service; this includes a failed loopback health check.
   The lease guard also removes the admission marker if its parent dies without
   running shell cleanup. GitHub then verifies the public HTTPS path too.

Runtime stores, traces, skills, workspaces and secrets never enter a release
directory. The supported host layout puts every application byte on the
dedicated filesystem mounted at `/home/atoma`; only the root trust anchors
(systemd unit, deployment config, sudoers rule and forced-command executables)
stay in their standard system directories.
The host activator verifies `/home/atoma` with `findmnt` before creating an
incoming directory, and refuses the deployment if the disk is absent.

## One-time host bootstrap

The commands below assume the names from the checked-in templates. Review them
before running them on the host. Mount the dedicated disk at `/home/atoma`
first and make that mount persistent by UUID in `/etc/fstab`. Formatting a
device destroys its existing contents: identify and verify the exact device
with `lsblk --fs` and `findmnt` before running any partitioning or filesystem
command. The required state before continuing is:

```bash
findmnt --mountpoint /home/atoma
sudo install -d -o root -g root -m 0755 /home/atoma
```

Use one root-owned mount with explicit ownership below it. The service and
deployment users get separate homes on the same disk; the release root and
Docker data remain root-owned.

```bash
sudo useradd --system --create-home --home-dir /home/atoma/state --shell /usr/sbin/nologin atoma
sudo useradd --system --create-home --home-dir /home/atoma/deploy-user --shell /bin/bash atoma-deploy
sudo install -d -o root -g root -m 0755 /home/atoma /home/atoma/releases /etc/atoma
sudo install -d -o root -g atoma -m 0750 /home/atoma/config
sudo install -d -o atoma -g atoma -m 0750 /home/atoma/state /home/atoma/state/runs /home/atoma/state/skills /home/atoma/state/projects /home/atoma/state/workspaces
sudo install -d -o atoma -g atoma -m 0700 /home/atoma/state/account-profiles
sudo install -d -o root -g root -m 0711 /home/atoma/docker
sudo usermod -aG docker atoma

sudo install -o root -g root -m 0755 deploy/host-deploy.sh /usr/local/sbin/atoma-deploy
sudo install -o root -g root -m 0755 deploy/ssh-command.sh /usr/local/sbin/atoma-deploy-ssh
sudo install -o root -g root -m 0644 deploy/atoma.service /etc/systemd/system/atoma.service
sudo install -o root -g root -m 0600 deploy/deploy.env.example /etc/atoma/deploy.env
```

`atoma` joining the Docker group is host-root-equivalent. That is an explicit
cost of the launcher still being in-process; it is not the final containerised
launcher boundary.

On a fresh Docker installation, put its image, layer, container and volume
store on the dedicated disk by merging this property into
`/etc/docker/daemon.json` (do not overwrite unrelated existing properties):

```json
{
  "data-root": "/home/atoma/docker"
}
```

Restart Docker and prove which directory it actually uses before building an
Atoma worker. Changing `data-root` on a host that already contains Docker data
requires a separately planned migration; otherwise the existing images and
volumes become invisible under the new root.

Make Docker require the mount too, so a boot with the disk absent cannot put a
second, hidden Docker store on the VPS root filesystem:

```bash
sudo install -d -o root -g root -m 0755 /etc/systemd/system/docker.service.d
sudoedit /etc/systemd/system/docker.service.d/atoma-disk.conf
```

```ini
# /etc/systemd/system/docker.service.d/atoma-disk.conf
[Unit]
RequiresMountsFor=/home/atoma
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
sudo docker info --format '{{.DockerRootDir}}'
```

Create `/home/atoma/config/atoma.env` as a root-owned file readable by the
`atoma` group. In addition to provider/auth/preview settings, use absolute
durable paths:

```dotenv
ATOMA_DB_PATH=/home/atoma/state/atoma.db
ATOMA_LEDGER_DB=/home/atoma/state/atoma.db
ATOMA_RUNS_DIR=/home/atoma/state/runs
ATOMA_SKILLS_DIR=/home/atoma/state/skills
ATOMA_PROJECTS_ROOT=/home/atoma/state/projects
ATOMA_ACCOUNT_PROFILES_ROOT=/home/atoma/state/account-profiles
ATOMA_BUILD_WORKSPACE=/home/atoma/state/workspaces/build
ATOMA_MCP_RUN_LOCK=/home/atoma/state/mcp-run-lock.db
ATOMA_DEPLOY_LOCK_PATH=/home/atoma/state/deploy.lock
```

### ChatGPT subscription on all three tiers

After installing and signing in to Codex under the service account (below),
set `ATOMA_HOST_SUBSCRIPTION_ORG` to the operator's active organisation id and
include Codex's executable directory in the service `PATH`. In Settings → LLM
models, choose the **ChatGPT (host subscription)** family for all three personal
account pins. `sub:openai` remains forbidden in organisation defaults and host
model environment variables: the account choice is the authorization to spend.
No API credential is required when all three resolved pins use ChatGPT.

L1's tool loop runs in Atoma: Codex emits a structured action, the host checks
its declared scope and calls the existing sandbox executor, then sends the
observed result back. Codex's native tools stay disabled. Each action is a
separate isolated text completion; latency and subscription consumption should
be measured for the workload rather than assumed equal to native function calls.

### Z.ai L1 with ChatGPT supervisors

For the recommended production split, keep L1 on a credentialled Z.ai
transport and use ChatGPT only on L2/L3. Put the Z.ai key in the root-owned
host file above — not in a GitHub variable or secret. The optional
`ATOMA_HOST_SUBSCRIPTION_ORG` declaration below is needed only if the platform
admin will also use the machine's host Codex profile:

```dotenv
PATH=/home/atoma/state/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ZAI_API_KEY=zai-...
ZAI_BASE_URL=https://api.z.ai/api/anthropic
ATOMA_MODEL_L1=api:zai:glm-4.5-air
ATOMA_MODEL_L2=api:zai:glm-4.5
ATOMA_MODEL_L3=api:zai:glm-4.5
ATOMA_HOST_SUBSCRIPTION_ORG=<organisation-id>
```

All three tiers are required on the host: they are the third level of the
account > organisation > host chain, and a tier no level resolves refuses the
run. The organisation id is shown in the Settings organisation card. Do not
set any tier to `sub:` in this host file: hosted project runs accept a
subscription only from a guarded account choice, resolved again for every run
as either the platform admin's host login or the requesting member's exact
personal profile.

Install Codex under the service account's real home. This binary serves both
the operator-only host profile and each member's isolated personal profile:

```bash
sudo -u atoma env HOME=/home/atoma/state sh -c \
  'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
```

After deploying this version, every `org:owner`, `org:admin` or `org:member`
can open **Settings → Personal subscriptions → Codex**, start the device-code
flow, and authenticate their own ChatGPT subscription in their browser. Atoma
stores the provider-owned credentials only below
`ATOMA_ACCOUNT_PROFILES_ROOT`, in a private profile belonging to that
principal. The database and audit journal contain only a non-secret connection
receipt and provider-name lifecycle events, respectively. A run resolves the
profile of the member who requested it; a missing or disconnected profile
fails explicitly and never falls back to the host. App-server checks and run
children share a crash-safe SQLite lease beside each profile, so a restart or
overlapping process cannot rotate the same `auth.json` concurrently.

Codex is a supervisor transport, so personal ChatGPT choices are offered only
on L2/L3. Keep L1 on Z.ai, Anthropic or another credentialled tool-capable
transport.

The commands below are optional and create the legacy **host subscription**
used only by the platform-admin exception. They are not needed for members'
personal connections:

```bash

sudo -u atoma env \
  HOME=/home/atoma/state \
  PATH=/home/atoma/state/.local/bin:/usr/local/bin:/usr/bin:/bin \
  codex login --device-auth

sudo -u atoma env \
  HOME=/home/atoma/state \
  PATH=/home/atoma/state/.local/bin:/usr/local/bin:/usr/bin:/bin \
  codex login status
```

Open the URL printed by the device-login command in your own browser and enter its
one-time code. Device-code login may first need to be enabled in ChatGPT
security settings. The resulting credentials live under the service account's
Codex home (normally `/home/atoma/state/.codex`); treat them like a password,
never copy them into the repository or GitHub. This follows OpenAI's
[Codex CLI installation](https://learn.chatgpt.com/docs/codex/cli) and
[headless authentication](https://learn.chatgpt.com/docs/auth) guidance.

For the optional host profile, sign in as the platform admin and choose:

- L1: `Z.ai — GLM-4.5 Air` (or inherit the host default);
- L2: `ChatGPT (host subscription) — GPT-5.6-Terra`;
- L3: `ChatGPT (host subscription) — GPT-5.6-Sol`.

Claude CLI remains available as a separate host-subscription family. The
Settings page does not offer personal Claude subscription login: Anthropic
requires prior approval before a third-party product may offer `claude.ai`
login or route Free/Pro/Max subscription credentials. The disabled card makes
that boundary visible until such approval exists. See Anthropic's
[Agent SDK authentication boundary](https://code.claude.com/docs/en/agent-sdk#authentication)
and [legal and compliance guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

```bash
sudo chown root:atoma /home/atoma/config/atoma.env
sudo chmod 0640 /home/atoma/config/atoma.env
sudo visudo -f /etc/sudoers.d/atoma-deploy
```

The sudoers file contains one command only:

```sudoers
atoma-deploy ALL=(root) NOPASSWD: /usr/local/sbin/atoma-deploy *
```

Put the public half of a dedicated deployment key in
`/home/atoma/deploy-user/.ssh/authorized_keys`, prefixed with the forced
command and SSH restrictions:

```bash
sudo install -d -o atoma-deploy -g atoma-deploy -m 0700 /home/atoma/deploy-user/.ssh
sudo install -o atoma-deploy -g atoma-deploy -m 0600 /dev/null /home/atoma/deploy-user/.ssh/authorized_keys
sudoedit /home/atoma/deploy-user/.ssh/authorized_keys
```

```text
restrict,command="/usr/local/sbin/atoma-deploy-ssh" ssh-ed25519 AAAA... github-actions-atoma
```

The forced command accepts only `deploy <40-hex-revision> <64-hex-digest>`.
The key cannot request a shell or choose a systemd unit, filesystem root or
health URL.

Finally:

```bash
sudo systemctl daemon-reload
sudo systemctl enable atoma.service
```

Do not start the empty service before its first release has created the
`/home/atoma/current` link.

## Plugging an agent into the instance (MCP)

The instance serves ONE MCP at `https://atoma.run/mcp`. A signed-in principal
mints a bearer token for its active organisation in **Settings → Connect your
AI agent (MCP)** — the panel shows the address, the procedure and the exact
line to paste — (`POST /api/tokens` underneath, or the operator on the host: `npm run auth -- token --principal <id-or-email> --org
<org-id-or-name> --label "<what for>"`), then registers the URL:

```bash
claude mcp add atoma --transport http https://atoma.run/mcp --header "Authorization: Bearer <token>"
```

The tools the agent sees follow the principal's role; a platform admin's token
sees the operator tools as well. Tokens are listed and revoked through
`/api/tokens`, and every mint and revocation is a journal row.

## Self-repair on the VPS

The read-only analyst remains inside Atoma. A separate `atoma-mender.service`
uses its own clone, persistent verdicts and a dedicated ChatGPT profile to
prepare correction PRs. Both reserve the existing machine-global run slot;
Docker limits the executable checks independently of the service's memory cap.
A person merges, and the merge follows the deployment path above.

The activator moves that clone to the deployed revision at the END of every
deployment — fetch, checkout, `npm ci`, `tsc`, the `atoma-mender:local` image,
the unit file, restart — after the application is healthy and outside the
rollback section. A refresh failure leaves the mender STOPPED on its previous
checkout and fails the deployment run so it is seen, but never restores the
previous application generation. A host without a mender (no clone at
`ATOMA_DEPLOY_MENDER_CHECKOUT`, no `ATOMA_DEPLOY_MENDER_ENV`) skips the phase.
`install-mender.sh` remains the first installation and the manual recovery.
The activator itself is root-owned and installed by hand: after changing
`deploy/host-deploy.sh`, reinstall it from the deployed release
(`sudo install -m 0755 /home/atoma/current/deploy/host-deploy.sh /usr/local/sbin/atoma-deploy`).

Follow [the production supervisor guide](supervisor-codex-production.md) for
installation, GitHub configuration cleanup, and end-to-end verification.

## GitHub configuration

Create an environment named `production`, restricted to the protected `main`
branch. Add these environment variables:

| Variable | Example |
|---|---|
| `ATOMA_DEPLOY_HOST` | `atoma.run` |
| `ATOMA_DEPLOY_PORT` | `22` |
| `ATOMA_DEPLOY_USER` | `atoma-deploy` |
| `ATOMA_DEPLOY_URL` | `https://atoma.run/` |

Add two environment secrets:

- `ATOMA_DEPLOY_SSH_PRIVATE_KEY`: the dedicated private OpenSSH key;
- `ATOMA_DEPLOY_KNOWN_HOSTS`: a reviewed `known_hosts` line for the target
  (including `[host]:port` when the port is not 22).

Only after the host and environment are complete, create the repository-level
variable `ATOMA_DEPLOY_ENABLED=true`. Removing it disables future automatic
deployments without deleting credentials.

## Operational boundaries

- The first automatic cutover from a version that predates the deployment
  marker must be performed in a manually drained window. Every later version
  closes new write admission before taking the run lease.
- Busy runtime state fails the deployment; it is never cancelled or recovered.
  Re-run the completed workflow after the work finishes.
- The worker image follows the control-plane revision. The preview image does
  not: production preview configuration is pinned to a registry digest by
  contract, so publishing and rotating that digest remains a separate release
  operation.
- Releases are retained under `/home/atoma/releases`. Pruning is deliberately
  not automated until backup/retention policy is accepted.
