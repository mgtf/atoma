#!/usr/bin/env bash
# Root-owned production activator invoked by GitHub Actions over SSH.
#
# The deploy key may stream one CI-built archive and its digest. It cannot
# choose a command, service, release root or health target: those live in the
# root-owned configuration below. Runtime state and secrets stay outside every
# release directory.
set -Eeuo pipefail

CONFIG_PATH="${ATOMA_DEPLOY_CONFIG:-/etc/atoma/deploy.env}"
if [[ "${EUID}" -ne 0 ]]; then
  echo "host-deploy must run as root" >&2
  exit 2
fi
if [[ ! -f "${CONFIG_PATH}" || -L "${CONFIG_PATH}" ]]; then
  echo "deployment config must be a regular non-symlink file: ${CONFIG_PATH}" >&2
  exit 2
fi

# shellcheck source=/dev/null
set -a
source "${CONFIG_PATH}"
set +a

REVISION="${1:-}"
EXPECTED_DIGEST="${2:-}"
DEPLOY_ROOT="${ATOMA_DEPLOY_ROOT:-/home/atoma}"
REQUIRED_MOUNT="${ATOMA_DEPLOY_REQUIRED_MOUNT:-/home/atoma}"
SERVICE_NAME="${ATOMA_DEPLOY_SERVICE:-atoma.service}"
SERVICE_USER="${ATOMA_DEPLOY_USER:-atoma}"
APP_ENV="${ATOMA_DEPLOY_APP_ENV:-/home/atoma/config/atoma.env}"
HEALTH_URL="${ATOMA_DEPLOY_HEALTH_URL:-http://127.0.0.1:4111/}"

fail() {
  echo "deployment failed: $*" >&2
  exit 1
}

valid_absolute_path() {
  local value="$1"
  [[ "${value}" == /* && "${value}" != "/" && "${value}" != *$'\n'* ]] || return 1
  [[ "/${value#/}/" != *"/../"* && "/${value#/}/" != *"/./"* ]]
}

[[ "${REVISION}" =~ ^[0-9a-f]{40}$ ]] || fail "revision must be a full Git commit SHA"
[[ "${EXPECTED_DIGEST}" =~ ^[0-9a-f]{64}$ ]] || fail "archive digest must be SHA-256"
valid_absolute_path "${DEPLOY_ROOT}" || fail "ATOMA_DEPLOY_ROOT must be a narrow absolute path"
valid_absolute_path "${REQUIRED_MOUNT}" || fail "ATOMA_DEPLOY_REQUIRED_MOUNT must be a narrow absolute path"
[[ "${SERVICE_NAME}" =~ ^[A-Za-z0-9_.@-]+$ ]] || fail "invalid systemd service name"
[[ "${SERVICE_USER}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || fail "invalid service user"
[[ "${HEALTH_URL}" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+/ ]] ||
  fail "ATOMA_DEPLOY_HEALTH_URL must be a loopback HTTP URL"
[[ -f "${APP_ENV}" && ! -L "${APP_ENV}" ]] || fail "application environment is missing or symlinked: ${APP_ENV}"
id "${SERVICE_USER}" >/dev/null 2>&1 || fail "service user does not exist: ${SERVICE_USER}"

for command in node npm docker curl systemctl runuser tar sha256sum realpath getent flock findmnt; do
  command -v "${command}" >/dev/null 2>&1 || fail "required command is missing: ${command}"
done

findmnt --mountpoint "${REQUIRED_MOUNT}" >/dev/null 2>&1 ||
  fail "required deployment filesystem is not mounted: ${REQUIRED_MOUNT}"
REQUIRED_MOUNT="$(realpath -e "${REQUIRED_MOUNT}")"
[[ "${DEPLOY_ROOT}" == "${REQUIRED_MOUNT}" || "${DEPLOY_ROOT}" == "${REQUIRED_MOUNT}/"* ]] ||
  fail "ATOMA_DEPLOY_ROOT must stay on ${REQUIRED_MOUNT}"

install -d -m 0755 "${DEPLOY_ROOT}" "${DEPLOY_ROOT}/releases"
DEPLOY_ROOT="$(realpath -e "${DEPLOY_ROOT}")"
[[ "${DEPLOY_ROOT}" != "/" ]] || fail "resolved deployment root cannot be /"
RELEASES="${DEPLOY_ROOT}/releases"
CURRENT="${DEPLOY_ROOT}/current"
SERVICE_HOME="$(getent passwd "${SERVICE_USER}" | cut -d: -f6)"
SERVICE_GROUP="$(id -gn "${SERVICE_USER}")"
[[ -n "${SERVICE_HOME}" && -d "${SERVICE_HOME}" ]] || fail "service user has no home directory"

# GitHub serialises its own jobs, but the host is the final authority: a
# manual invocation or a second delivery path must not overlap this one. In
# particular, a losing deploy must never remove the admission marker owned by
# the winner. The descriptor holds this lock until the process exits.
exec 9>"${DEPLOY_ROOT}/.deployment.lock"
flock -n 9 || fail "another deployment is already active"

WORK_DIR="$(mktemp -d "${DEPLOY_ROOT}/.incoming-${REVISION}.XXXXXX")"
BUNDLE="${WORK_DIR}/atoma-${REVISION}.tar.gz"
ARCHIVE_ROOT="atoma-${REVISION}"
TARGET_RELEASE="${RELEASES}/${REVISION}"
MARKER_PATH=""
GUARD_PID=""
GUARD_DIR=""
GUARD_RELEASE_FILE=""
ACTIVATION_STARTED=0
WORKER_LATEST_CHANGED=0
WORKER_ROLLBACK_TAG=""

restore_previous_generation() {
  [[ -n "${OLD_RELEASE:-}" ]] || return 0
  echo "deployment activation failed; restoring ${OLD_REVISION}" >&2
  systemctl stop "${SERVICE_NAME}" || true
  local rollback_link="${DEPLOY_ROOT}/.rollback-${OLD_REVISION}"
  rm -f -- "${rollback_link}"
  ln -s "${OLD_RELEASE}" "${rollback_link}"
  mv -Tf "${rollback_link}" "${CURRENT}"
  if [[ "${WORKER_LATEST_CHANGED}" -eq 1 ]]; then
    if [[ -n "${WORKER_ROLLBACK_TAG}" ]] &&
      docker image inspect "${WORKER_ROLLBACK_TAG}" >/dev/null 2>&1; then
      docker tag "${WORKER_ROLLBACK_TAG}" atoma-worker:latest
    else
      # Remove only the mutable tag; the revision tag remains available for
      # diagnosis and a retry.
      docker image rm atoma-worker:latest >/dev/null 2>&1 || true
    fi
  fi
  systemctl start "${SERVICE_NAME}" || true
}

cleanup() {
  local status=$?
  set +e
  if [[ "${status}" -ne 0 && "${ACTIVATION_STARTED}" -eq 1 ]]; then
    restore_previous_generation
  fi
  if [[ -n "${GUARD_RELEASE_FILE}" ]]; then
    touch "${GUARD_RELEASE_FILE}"
  fi
  if [[ -n "${GUARD_PID}" ]]; then
    wait "${GUARD_PID}" >/dev/null 2>&1
  fi
  if [[ -n "${MARKER_PATH}" ]]; then
    rm -f -- "${MARKER_PATH}"
  fi
  if [[ -n "${GUARD_DIR}" ]]; then
    case "${GUARD_DIR}" in
      "${DEPLOY_ROOT}"/.deploy-guard-*) rm -rf -- "${GUARD_DIR}" ;;
    esac
  fi
  case "${WORK_DIR}" in
    "${DEPLOY_ROOT}"/.incoming-*) rm -rf -- "${WORK_DIR}" ;;
  esac
  exit "${status}"
}
trap cleanup EXIT
# A dropped SSH channel sends SIGHUP to the forced command. Route termination
# signals through a normal exit so the EXIT cleanup restores the previous
# generation whenever activation has already stopped the service.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# The archive is streamed over the authenticated SSH channel. It never sits
# in a deploy-user-writable inbox that another local process could replace.
cat >"${BUNDLE}"
ACTUAL_DIGEST="$(sha256sum "${BUNDLE}" | awk '{print $1}')"
[[ "${ACTUAL_DIGEST}" == "${EXPECTED_DIGEST}" ]] || fail "archive digest mismatch"

while IFS= read -r entry; do
  [[ "${entry}" == "${ARCHIVE_ROOT}" || "${entry}" == "${ARCHIVE_ROOT}/"* ]] ||
    fail "archive entry escapes its revision root: ${entry}"
  [[ "${entry}" != /* && "/${entry}/" != *"/../"* ]] ||
    fail "unsafe archive entry: ${entry}"
done < <(tar -tzf "${BUNDLE}")

if [[ -e "${TARGET_RELEASE}" ]]; then
  [[ -f "${TARGET_RELEASE}/REVISION" ]] || fail "existing release has no revision receipt"
  [[ "$(<"${TARGET_RELEASE}/REVISION")" == "${REVISION}" ]] || fail "existing release receipt disagrees"
else
  STAGE="${WORK_DIR}/stage"
  install -d -m 0755 "${STAGE}"
  tar -xzf "${BUNDLE}" -C "${STAGE}" --no-same-owner --no-same-permissions
  [[ "$(<"${STAGE}/${ARCHIVE_ROOT}/REVISION")" == "${REVISION}" ]] || fail "archive revision receipt disagrees"
  [[ -f "${STAGE}/${ARCHIVE_ROOT}/dist/viz/server.js" ]] || fail "compiled viz server is missing"
  [[ -f "${STAGE}/${ARCHIVE_ROOT}/dist/cli/deploy-preflight.js" ]] || fail "compiled deployment preflight is missing"
  chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${STAGE}/${ARCHIVE_ROOT}"
  mv "${STAGE}/${ARCHIVE_ROOT}" "${TARGET_RELEASE}"
fi

run_as_service() {
  local cwd="$1"
  shift
  runuser -u "${SERVICE_USER}" -- env HOME="${SERVICE_HOME}" bash -c \
    'cd "$1" && shift && exec "$@"' bash "${cwd}" "$@"
}

run_as_service_with_app_env() {
  local cwd="$1"
  shift
  runuser -u "${SERVICE_USER}" -- env HOME="${SERVICE_HOME}" bash -c \
    'set -a; source "$1"; set +a; cd "$2"; shift 2; exec "$@"' \
    bash "${APP_ENV}" "${cwd}" "$@"
}

# Existing installations have the dependencies needed by the drain command.
# A first installation has no running Atoma process and therefore no admission
# race to close.
OLD_RELEASE=""
OLD_REVISION=""
if [[ -L "${CURRENT}" ]]; then
  OLD_RELEASE="$(realpath -e "${CURRENT}")"
  [[ "${OLD_RELEASE}" == "${RELEASES}/"* ]] || fail "current release escapes ${RELEASES}"
  OLD_REVISION="$(basename "${OLD_RELEASE}")"
elif [[ -e "${CURRENT}" ]]; then
  fail "current must be a symlink"
fi

if [[ -n "${OLD_RELEASE}" ]]; then
  MARKER_PATH="$(run_as_service_with_app_env "${OLD_RELEASE}" bash -c 'printf %s "${ATOMA_DEPLOY_LOCK_PATH:-}"')"
  valid_absolute_path "${MARKER_PATH}" || fail "ATOMA_DEPLOY_LOCK_PATH must be configured as an absolute path"
  install -d -m 0755 "$(dirname "${MARKER_PATH}")"
  install -m 0644 /dev/null "${MARKER_PATH}"

  # The service user cannot traverse WORK_DIR: mktemp deliberately creates it
  # as 0700 root. Keep the private guard beneath the root-owned 0755 deploy
  # root so only its explicitly assigned owner can enter it.
  GUARD_DIR="$(mktemp -d "${DEPLOY_ROOT}/.deploy-guard-${REVISION}.XXXXXX")"
  install -d -m 0700 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${GUARD_DIR}"
  GUARD_READY_FILE="${GUARD_DIR}/ready"
  GUARD_RELEASE_FILE="${GUARD_DIR}/release"
  GUARD_LOG="${GUARD_DIR}/stderr"
  run_as_service_with_app_env \
    "${OLD_RELEASE}" \
    node "${OLD_RELEASE}/dist/cli/deploy-preflight.js" \
      --hold \
      --parent-pid "$$" \
      --ready-file "${GUARD_READY_FILE}" \
      --release-file "${GUARD_RELEASE_FILE}" \
      --admission-marker "${MARKER_PATH}" \
      >"${GUARD_DIR}/stdout" 2>"${GUARD_LOG}" &
  GUARD_PID=$!
  for _ in {1..80}; do
    [[ -f "${GUARD_READY_FILE}" ]] && break
    if ! kill -0 "${GUARD_PID}" 2>/dev/null; then
      wait "${GUARD_PID}" || true
      fail "runtime drain refused: $(<"${GUARD_LOG}")"
    fi
    sleep 0.25
  done
  [[ -f "${GUARD_READY_FILE}" ]] || fail "runtime drain did not become ready"
fi

# Once the old generation is stopped, no application process can observe the
# release directory while npm and Docker prepare it.
ACTIVATION_STARTED=1
systemctl stop "${SERVICE_NAME}"
run_as_service "${TARGET_RELEASE}" npm ci --omit=dev
run_as_service "${TARGET_RELEASE}" node scripts/release-smoke.mjs
run_as_service "${TARGET_RELEASE}" docker build \
  -f docker/worker.Dockerfile -t "atoma-worker:${REVISION}" .

if [[ -n "${OLD_REVISION}" ]] && docker image inspect atoma-worker:latest >/dev/null 2>&1; then
  WORKER_ROLLBACK_TAG="atoma-worker:rollback-${OLD_REVISION}"
  docker tag atoma-worker:latest "${WORKER_ROLLBACK_TAG}"
fi
docker tag "atoma-worker:${REVISION}" atoma-worker:latest
WORKER_LATEST_CHANGED=1

NEXT_LINK="${DEPLOY_ROOT}/.current-${REVISION}"
ln -s "${TARGET_RELEASE}" "${NEXT_LINK}"
mv -Tf "${NEXT_LINK}" "${CURRENT}"

systemctl start "${SERVICE_NAME}"
HEALTHY=0
for _ in {1..30}; do
  if curl --fail --silent --show-error --max-time 3 "${HEALTH_URL}" >/dev/null; then
    HEALTHY=1
    break
  fi
  sleep 1
done
[[ "${HEALTHY}" -eq 1 ]] || fail "new generation failed health verification"

ACTIVATION_STARTED=0
echo "deployed ${REVISION} to ${SERVICE_NAME}"
