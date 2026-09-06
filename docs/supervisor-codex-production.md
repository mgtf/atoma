# Supervisor with a ChatGPT subscription

The sentinel remains quota-free. The analyst and mender can explicitly select
Codex and use ChatGPT Pro. This path never uses `OPENAI_API_KEY`, refuses API
credentials in auth.json, and keeps the existing Claude path available.

## Debian analyst

Install Codex CLI 0.152.0 or a compatible version under the service account.
A nologin account can run an explicitly selected shell. Create a dedicated
analyst profile under the writable service state directory:

```sh
sudo install -d -o atoma -g atoma -m 700 /home/atoma/state/codex /home/atoma/state/codex/analyst
sudo -H -u atoma env CODEX_HOME=/home/atoma/state/codex/analyst /bin/bash -lc 'codex login --device-auth'
sudo -H -u atoma env CODEX_HOME=/home/atoma/state/codex/analyst /bin/bash -lc 'codex login status'
sudo -H -u atoma /bin/bash -lc 'command -v codex'
```

Add these to the service's EnvironmentFile, normally
`/home/atoma/config/atoma.env`:

```dotenv
ATOMA_ANALYST_TRANSPORT=codex
ATOMA_ANALYST_MODEL=gpt-5.6-sol
ATOMA_ANALYST_CODEX_HOME=/home/atoma/state/codex/analyst
ATOMA_SUPERVISOR_CMD_CODEX=/home/atoma/state/.local/bin/codex
ATOMA_SUPERVISOR_DIR=/home/atoma/supervisor
ATOMA_VIZ_ANALYST=1
ATOMA_ANALYST_QUIET_MS=120000
ATOMA_MENDER_DISPATCH_REPO=mgtf/atoma
ATOMA_MENDER_DISPATCH_TOKEN=<repository-dispatch token>
ATOMA_MENDER_DISPATCH_MIN_CONFIDENCE=high
```

Use the actual installed binary path printed above. The profile's parent must
also be writable by atoma: its SQLite lease is a sibling of CODEX_HOME. A
root-owned `/home/atoma` does not meet that requirement for `/home/atoma/.codex`.
Remove `ATOMA_ANALYST_BASE_URL` and
`ATOMA_ANALYST_AUTH_TOKEN` when selecting Codex. Create the supervisor directory
owned by atoma. Restart the service when no run/preview is active. The sentinel
is on by default behind the auth gate; `ATOMA_VIZ_SENTINEL=0` disables it.

The deployment artifact carries sources, docs and subsystem contracts matching
the deployed revision. The analyst's single dynamic tool reads only that
allowlisted evidence and the selected run. It has no command execution or
access to credentials, stores, or other runs. The product MCP stays on `/mcp`.

## GitHub Actions mender

Repository-level Actions settings (the workflow has no GitHub environment):

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `ATOMA_MENDER_MODEL` | `gpt-5.6-sol`, or an explicitly chosen model |
| Secret | `ATOMA_MENDER_CODEX_AUTH_JSON` | auth.json from a dedicated ChatGPT login |
| Secret | `ATOMA_MENDER_GITHUB_TOKEN` | Fine-grained PAT: Contents, Pull requests and Secrets read/write on this repository |

Create a **separate** Codex login for Actions under a dedicated CODEX_HOME.
Authenticate it with the same ChatGPT subscription using device login; do not
copy the Debian service's active profile. Upload auth.json without displaying it:

```sh
gh secret set ATOMA_MENDER_CODEX_AUTH_JSON --repo mgtf/atoma < /path/to/ci-profile/auth.json
```

Stop using that CI profile interactively after uploading it. The serial Mender
workflow owns its refresh lifecycle. Its final step stores renewed auth back
into the same GitHub secret even after a failed mend. An interrupted runner
may still lose a refresh; if login becomes invalid, create and upload a new
dedicated session. Credentials are never included in artifacts or caches.

Codex runs as a text-only app-server in an empty jail, with built-in execution,
Apps, plugins, MCP and skills disabled. A private worktree_command dynamic tool
executes proposed commands through the mender's Docker boundary with no network
or credentials. Docker's default security profiles remain intact. The temporary
ChatGPT profile stays outside every command container. Tests also receive no
model credentials; GitHub credentials and the Docker socket are never mounted.
The harness alone publishes. CI exercises this protocol-to-container boundary.

## Verification

After deployment, expect `sentinel: watching` and `analyst: on` in the journal.
Run a project task reproducing an existing source defect and let it finish.
After the quiet period, with no run active, inspect:

1. `/home/atoma/supervisor/verdicts/<runId>.json` and `supervisor.verdict`.
2. An eligible high-confidence `defect` with a cited proposedFix.
3. `mender.dispatched`, followed by the Mender Actions run.
4. The workflow artifact's mend record and the correction PR.

The regression must fail on the unfixed source and the full check must pass
after the fix. A failed task does not guarantee an eligible source defect.
Manual workflow dispatch accepts a genuine MendRequest to test only the CI half.
Merge remains manual; the ordinary main CI/deployment activates the correction.

Codex does not expose Claude's USD ceiling. The analyst retains a 15-minute
wall clock and at most 40 evidence reads; the mender retains its 30-minute
phase clock. Recorded cost is null, never zero or a guessed subscription price.
All runs draw from the same subscription quota.
