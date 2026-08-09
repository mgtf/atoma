# Tool worker for one atoma run.
#
# Holds ONLY the tool layer: a ToolSandbox rooted at the mounted /workspace
# plus the nine builtins. The supervise loop, the LLM calls, the atom
# registry and the skill store stay on the control plane, which talks to this
# over stdio (see src/tools/containerProtocol.ts).
#
# What is deliberately NOT here: the repository, the SQLite registry, the
# skills directory, the ledger, any credential. `run_shell`'s child is not
# jailed to its cwd, so in a single process those are always one filesystem
# walk away; here the walk finds nothing because they were never mounted.
FROM node:22-slim

# python3  -> start_static_server
# chromium -> validate_html (puppeteer uses the system browser rather than
#             downloading its own; the bundled download is skipped below)
# procps   -> the sandbox's process-group reaping
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 chromium ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# puppeteer is the tool layer's ONLY external dependency — everything else it
# needs is a node builtin. Installing just that keeps the image small and
# keeps the SQLite driver, the LLM SDKs and the MCP bridge out of the
# container entirely: the worker has no business holding them.
COPY docker/worker-package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# Compiled output only (npm run build). Source and tests stay out.
COPY dist/tools ./dist/tools
COPY dist/core ./dist/core

# A non-root user: `--cap-drop ALL` and `no-new-privileges` are set by the
# caller, and this closes the last easy privilege the container had.
RUN useradd -m -u 10001 atoma && mkdir -p /workspace && chown atoma /workspace
USER atoma

ENV ATOMA_WORKER_ROOT=/workspace
# ABSOLUTE path: the caller sets `-w /workspace` (so a stray relative tool
# path lands in the sandbox, not in /app), which would make a relative CMD
# resolve to /workspace/dist/... and fail with MODULE_NOT_FOUND.
CMD ["node", "/app/dist/tools/worker.js"]
