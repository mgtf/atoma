#!/usr/bin/env bash
# Run from a verified deployed release. Never fetch/run an unreviewed installer.
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 2; }
release="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
config=/home/atoma/config/mender.env
checkout=/home/atoma/mender
[[ ! -L "$config" && ! -L "$checkout" ]] || { echo 'Refusing symlinked config or checkout.' >&2; exit 2; }
[[ -f "$release/REVISION" ]] || { echo 'Use the installer in /home/atoma/current after deployment.' >&2; exit 2; }
revision="$(cat "$release/REVISION")"
[[ $revision =~ ^[0-9a-f]{40}$ ]] || exit 2
for command in git gh docker node npm python3; do
  command -v "$command" >/dev/null || { echo "Install prerequisite: $command" >&2; exit 2; }
done
if [[ ! -f "$config" ]]; then
  read -r -s -p 'GitHub publisher PAT (Contents + Pull requests write on mgtf/atoma): ' publisher
  printf '\n'
  [[ $publisher =~ ^[A-Za-z0-9_]+$ ]] || { echo 'Invalid token format.' >&2; exit 2; }
  install -o root -g atoma -m 640 "$release/deploy/mender.env.example" "$config"
  printf 'GH_TOKEN=%s\n' "$publisher" >> "$config"
  unset publisher
fi
# Copy ONLY shared path settings, never product/provider secrets. Resolve HOME
# and the default lease from the account exactly as systemd does.
service_home="$(getent passwd atoma | cut -d: -f6)"
env HOME="$service_home" bash -c '
  set -a
  source /home/atoma/config/atoma.env
  printf "HOME=%s\nATOMA_MCP_RUN_LOCK=%s\nATOMA_RUNS_DIR=%s\nATOMA_SUPERVISOR_DIR=%s\nATOMA_DB_PATH=%s\n" \
    "$HOME" "${ATOMA_MCP_RUN_LOCK:-$HOME/.atoma/mcp-run-lock.db}" \
    "${ATOMA_RUNS_DIR:-/home/atoma/current/runs}" \
    "${ATOMA_SUPERVISOR_DIR:?Persist ATOMA_SUPERVISOR_DIR first}" \
    "${ATOMA_DB_PATH:-/home/atoma/current/atoma.db}"
' >> "$config"
install -d -o atoma -g atoma -m 700 "$checkout" /home/atoma/state/codex/mender
if [[ ! -f /home/atoma/state/codex/mender/auth.json ]]; then
  [[ -f /home/atoma/.codex-mender-ci/auth.json ]] || { echo 'Create the dedicated mender ChatGPT login first.' >&2; exit 2; }
  install -o atoma -g atoma -m 600 /home/atoma/.codex-mender-ci/auth.json /home/atoma/state/codex/mender/auth.json
fi
systemctl stop atoma-mender.service 2>/dev/null || true
# Refuse installation alongside product work. Setup is an operator maintenance
# operation; stopping admission keeps a new run from racing the clone/build.
runuser -u atoma -- bash -c 'set -a; source /home/atoma/config/atoma.env; cd /home/atoma/current; node dist/cli/deploy-preflight.js'
systemctl stop atoma.service
trap 'systemctl start atoma.service' EXIT
runuser -u atoma -- env MENDER_REVISION="$revision" bash -c '
  set -Eeuo pipefail
  set -a
  source /home/atoma/config/mender.env
  set +a
  if [[ ! -d /home/atoma/mender/.git ]]; then
    git clone https://github.com/mgtf/atoma.git /home/atoma/mender
  fi
  cd /home/atoma/mender
  [[ $(git remote get-url origin) == https://github.com/mgtf/atoma.git ]] || exit 2
  [[ -z $(git status --porcelain) ]] || { echo "Mender checkout is dirty; preserve and inspect it." >&2; exit 2; }
  git fetch origin main
  git checkout --detach "$MENDER_REVISION"
  git config user.name "Atoma Mender"
  git config user.email "atoma-mender@users.noreply.github.com"
  HUSKY=0 npm ci
  npx tsc -p tsconfig.json
  docker build -f docker/mender.Dockerfile -t atoma-mender:local .
  CODEX_HOME="$ATOMA_MENDER_CODEX_HOME" "$ATOMA_MENDER_CMD_CODEX" login status
  node dist/cli/mender.js --help >/dev/null
'
# Keep a root-only backup of the old environment; remove the retired dispatcher.
cp -a --no-clobber /home/atoma/config/atoma.env /home/atoma/config/atoma.env.before-local-mender
chmod 600 /home/atoma/config/atoma.env.before-local-mender
chown root:root /home/atoma/config/atoma.env.before-local-mender
python3 - <<'PY'
from pathlib import Path
p = Path('/home/atoma/config/atoma.env')
lines = p.read_text().splitlines(keepends=True)
p.write_text(''.join(line for line in lines if not line.lstrip().removeprefix('export ').startswith('ATOMA_MENDER_DISPATCH_')))
PY
install -o root -g root -m 644 "$release/deploy/atoma-mender.service" /etc/systemd/system/atoma-mender.service
systemctl daemon-reload
systemctl start atoma.service
trap - EXIT
systemctl enable --now atoma-mender.service
echo 'Mender installed. Inspect: sudo journalctl -u atoma-mender -f'
