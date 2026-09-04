#!/usr/bin/env bash
# ForcedCommand for the GitHub Actions deployment key. The key may request one
# validated revision/digest pair and may not obtain a shell, forwarding or an
# arbitrary sudo command.
set -euo pipefail

REQUEST="${SSH_ORIGINAL_COMMAND:-}"
if [[ "${REQUEST}" =~ ^deploy\ ([0-9a-f]{40})\ ([0-9a-f]{64})$ ]]; then
  exec sudo -n /usr/local/sbin/atoma-deploy "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
fi

echo "refused deployment command" >&2
exit 2
