#!/usr/bin/env bash
# systemd's stop backstop: Docker containers outlive their client processes.
set -Eeuo pipefail
container_ids="$(docker ps -aq --filter label=atoma.role=mender)"
if [[ -n "$container_ids" ]]; then
  mapfile -t containers <<< "$container_ids"
  docker rm --force "${containers[@]}"
fi
