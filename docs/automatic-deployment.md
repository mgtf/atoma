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
   moves `atoma-worker:latest`, and atomically switches `/opt/atoma/current`.
6. Any failure after service shutdown restores the previous release symlink,
   worker tag and service; this includes a failed loopback health check.
   The lease guard also removes the admission marker if its parent dies without
   running shell cleanup. GitHub then verifies the public HTTPS path too.

Runtime stores, traces, skills, workspaces and secrets never enter a release
directory. The service environment must point every state path at
`/var/lib/atoma` (or another persistent root).

## One-time host bootstrap

The commands below assume the names from the checked-in templates. Review them
before running them on the host.

```bash
sudo useradd --system --create-home --home-dir /var/lib/atoma --shell /usr/sbin/nologin atoma
sudo useradd --system --create-home --shell /bin/bash atoma-deploy
sudo install -d -m 0755 /opt/atoma /opt/atoma/releases /etc/atoma /var/lib/atoma
sudo usermod -aG docker atoma

sudo install -o root -g root -m 0755 deploy/host-deploy.sh /usr/local/sbin/atoma-deploy
sudo install -o root -g root -m 0755 deploy/ssh-command.sh /usr/local/sbin/atoma-deploy-ssh
sudo install -o root -g root -m 0644 deploy/atoma.service /etc/systemd/system/atoma.service
sudo install -o root -g root -m 0600 deploy/deploy.env.example /etc/atoma/deploy.env
```

`atoma` joining the Docker group is host-root-equivalent. That is an explicit
cost of the launcher still being in-process; it is not the final containerised
launcher boundary.

Create `/etc/atoma/atoma.env` as a root-owned file readable by the `atoma`
group. In addition to provider/auth/preview settings, use absolute durable
paths:

```dotenv
ATOMA_DB_PATH=/var/lib/atoma/atoma.db
ATOMA_LEDGER_DB=/var/lib/atoma/atoma.db
ATOMA_RUNS_DIR=/var/lib/atoma/runs
ATOMA_SKILLS_DIR=/var/lib/atoma/skills
ATOMA_PROJECTS_ROOT=/var/lib/atoma/projects
ATOMA_BUILD_WORKSPACE=/var/lib/atoma/workspaces/build
ATOMA_DEPLOY_LOCK_PATH=/var/lib/atoma/deploy.lock
```

```bash
sudo chown root:atoma /etc/atoma/atoma.env
sudo chmod 0640 /etc/atoma/atoma.env
sudo visudo -f /etc/sudoers.d/atoma-deploy
```

The sudoers file contains one command only:

```sudoers
atoma-deploy ALL=(root) NOPASSWD: /usr/local/sbin/atoma-deploy *
```

Put the public half of a dedicated deployment key in
`/home/atoma-deploy/.ssh/authorized_keys`, prefixed with the forced command and
SSH restrictions:

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
`/opt/atoma/current` link.

## GitHub configuration

Create an environment named `production`, restricted to the protected `main`
branch. Add these environment variables:

| Variable | Example |
|---|---|
| `ATOMA_DEPLOY_HOST` | `atoma.example.com` |
| `ATOMA_DEPLOY_PORT` | `22` |
| `ATOMA_DEPLOY_USER` | `atoma-deploy` |
| `ATOMA_DEPLOY_URL` | `https://atoma.example.com/` |

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
- Releases are retained under `/opt/atoma/releases`. Pruning is deliberately
  not automated until backup/retention policy is accepted.
