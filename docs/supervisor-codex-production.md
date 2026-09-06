# Supervisor with a ChatGPT subscription on Debian

The sentinel is quota-free. The analyst and mender explicitly select Codex and
use a dedicated ChatGPT login each. This path rejects API-key profiles and
never uses OPENAI_API_KEY. A separate mender service replaces GitHub Actions.

For the current production test and remaining acceptance work, see the
[2026-09-06 VPS handoff](incidents/mender-vps-handoff-2026-09-06.md).

## Analyst configuration

Keep these in `/home/atoma/config/atoma.env`:

```dotenv
ATOMA_VIZ_ANALYST=1
ATOMA_ANALYST_TRANSPORT=codex
ATOMA_ANALYST_MODEL=gpt-5.6-sol
ATOMA_ANALYST_CODEX_HOME=/home/atoma/state/codex/analyst
ATOMA_SUPERVISOR_CMD_CODEX=/home/atoma/state/.local/bin/codex
ATOMA_SUPERVISOR_DIR=/home/atoma/state/supervisor
```

The profile and its parent must be writable by atoma. Remove analyst API token
and base URL overrides when using Codex. Keep supervisor state outside releases.

## Install the separate mender

Deploy the migration first. On Debian install `git`, `gh`, `python3` and Docker;
the supported Node and Codex binaries must already exist. Disable the former
Mender workflow before reusing its dedicated login. The installation script
uses `/home/atoma/.codex-mender-ci/auth.json` only when the new mender profile
has no auth file. It never copies the analyst login.

```sh
sudo apt-get install -y git gh python3
sudo bash /home/atoma/current/deploy/install-mender.sh
```

The installer asks for the GitHub publisher PAT without echoing it. It needs
Contents and Pull requests read/write on `mgtf/atoma`; Secrets write is no
longer needed. Do not paste credentials in chat. It stores the token in
`/home/atoma/config/mender.env` (root:atoma, 0640).

Installation refuses active runs/previews, then briefly stops Atoma while
preparing the clone and image. A failure restarts Atoma. The clone is pinned
to the deployed revision; rerunning the installer upgrades it only if clean.
Each actual mend fetches current main into its own disposable worktree.
The installer preserves existing configuration and verdicts, copies the shared
DB/runs/lease paths from atoma.env, and removes ATOMA_MENDER_DISPATCH_* settings
with a root-only backup. It never changes the production release checkout.

The mender service has its own environment, no product OAuth/provider secrets,
and a dedicated profile at `/home/atoma/state/codex/mender`. Do not keep using
the old CI profile after migration. Once the new login is verified, remove the
obsolete CI profile securely as an operator; keep the analyst profile.

```sh
sudo systemctl status atoma-mender --no-pager
sudo journalctl -u atoma-mender -f
```

## Execution and resource boundaries

The analyst and mender hold the existing machine-global run lease through their
work and cleanup. New product starts are refused while this slot is reserved;
deployment waits too. An occupied or stale lease is never recovered by a
background supervisor. After a crash, inspect the owner and surviving processes
before using the normal run recovery path; do not delete the lease database.

Codex runs as a text-only app-server in an empty jail. Built-in execution,
Apps, plugins, MCP and skills are disabled. Its private worktree command sends
executable proposals to Docker without network or inference credentials.
Containers receive only the worktree and sanitized read-only git metadata,
never host HOME, product state, publisher credentials or Docker socket.

Docker enforces 2 GiB RAM, no extra swap, one CPU and a 512 MiB tmpfs. Vitest
runs one worker. The service itself has a separate 1 GiB cap and reduced CPU
priority. systemd allows the current bounded attempt to finish on stop; its
stop backstop reaps containers labeled atoma.role=mender after process death.

## Clean up GitHub

After local publisher authentication is installed, delete the repository secrets
ATOMA_MENDER_CODEX_AUTH_JSON and ATOMA_MENDER_GITHUB_TOKEN. Delete obsolete
ATOMA_MENDER_MODEL, ATOMA_MENDER_BASE_URL and ATOMA_MENDER_AUTH_TOKEN variables
or secrets if present. The Mender Actions workflow is retired.

Keep OPENAI_API_KEY while the i18n CI job still uses it. Keep ATOMA_DEPLOY_ENABLED
and all production environment deployment variables and SSH secrets. Revoke the
retired dispatch PAT, and remove Secrets write from the publisher PAT once its
CI use is over. GitHub secret deletion does not revoke a PAT.

## End-to-end verification

A finished run produces a supervisor.verdict row. An eligible high-confidence
defect with cited intentional choices is consumed from the persistent verdict
file. The local mender emits mender.started and one terminal outcome; inspect
`/home/atoma/state/supervisor/mender/<runId>.<finding>.json` and the production
journal. A refusal or decline is a valid outcome, not proof of a correction PR.

The harness requires a regression that fails on the unfixed code, then a full
passing check with the fix, before pushing a branch and opening a PR. A person
merges it; ordinary main CI and deployment activate the correction. An existing
genuine verdict can be retried with `--verdict <id> --finding <n> --force` while
the watch service is stopped. Never manufacture a finding just to get a PR.

ChatGPT usage consumes the subscription quota. Codex cost remains null because
it does not report USD cost; wall-clock limits still apply.
