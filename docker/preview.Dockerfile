# The runtime one preview generation runs in.
#
# It holds NOTHING of atoma. Not the repository, not `dist/`, not the SQLite
# store, not a credential, not even the tool layer the worker image carries —
# because the process this image starts is not ours. It is whatever a run
# produced, and the launcher's `preview-app` profile runs exactly
# `node <entry>` against a workspace mounted from outside.
#
# That is the whole design: the image is a Node runtime and a non-root user,
# and everything that makes a preview safe is imposed by the caller —
# `--runtime=runsc`, `--network` on an isolated internal bridge,
# `--read-only`, `--cap-drop ALL`, `no-new-privileges`, bounded memory, pids
# and nofile, two tmpfs that die with the container. See
# `src/launcher/AGENTS.md`, which owns those flags and asserts them by test.
#
# WHY NO `npm install` LAYER. A deliverable brings its own `node_modules` in
# the copied workspace or it does not run: installing at open time would put a
# network operation on a member's click, and this container has no egress to
# do it with. A missing dependency is a bounded failure the classifier reports,
# not something to paper over here.
FROM node:24-slim

# NO apt layer. The worker image installs python3 and chromium because the
# TOOLS need them; nothing here runs a tool. Every package added is attack
# surface a member's generated code inherits, so the answer is none.

ENV NODE_ENV=production \
    # The profile passes exactly five environment variables and never spreads
    # the parent's. This one is the app's own port contract, restated here so
    # an image run by hand behaves like one run by the launcher.
    PORT=8080

# uid 10002, one above the worker's 10001: the two images are mounted by the
# same host process, and a shared uid would let a file written for one be
# written by the other.
RUN useradd -m -u 10002 preview && mkdir -p /app && chown preview /app
USER preview
WORKDIR /app

EXPOSE 8080

# NO CMD, deliberately. The launcher passes `--entrypoint node` and the one
# start command the profile allows; an ENTRYPOINT or CMD here would wrap or
# replace it, and a preview that could choose its own command would be a
# remote shell with a nice name. Running this image bare is meant to do
# nothing.
ENTRYPOINT []
CMD []
