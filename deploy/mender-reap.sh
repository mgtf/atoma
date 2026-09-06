#!/usr/bin/env bash
# systemd's stop backstop: Docker containers outlive their client processes.
set -Eeuo pipefail
mapfile -t containers < <(docker ps -aq --filter label=atoma.role=mender)
if ((${#containers[@]})); then
  docker rm --force "${containers[@]}"
fi
