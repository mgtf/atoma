# Mirrors the ONE environment this repo is actually verified in: CI runs every
# job on ubuntu-latest with Node pinned to 22.13.0 (.github/workflows/ci.yml).
# The Node version is pinned here to the same patch, deliberately — `.nvmrc`
# says 22.13.0 and `engines` accepts `^22.13.0 || >=24`, so a floating tag
# would let this container drift away from the version CI proves.
FROM node:22.13.0-bookworm

# Passwordless sudo for the stock `node` user (uid 1000). Needed only so
# postCreateCommand can take ownership of the node_modules volume, which the
# container runtime creates as root.
RUN apt-get update && apt-get install -y --no-install-recommends sudo \
  && echo 'node ALL=(root) NOPASSWD:ALL' > /etc/sudoers.d/node \
  && chmod 0440 /etc/sudoers.d/node

# Puppeteer (^25.6.0) downloads its own Chrome but not the shared libraries it
# links against. Without these, every viz/browser test fails on a missing .so
# rather than on the change under test.
RUN apt-get install -y --no-install-recommends \
  ca-certificates fonts-liberation \
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 \
  libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 \
  libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
  libxfixes3 libxkbcommon0 libxrandr2 libxss1 \
  # node-gyp fallback: better-sqlite3 ships linux-x64 prebuilds, but a
  # prebuild miss must degrade to a local compile, not to a failed install.
  build-essential python3 \
  # scripts/viz-mark-turn-analyze.py needs Pillow. python3-pil instead of pip
  # because bookworm enforces PEP 668 on the system interpreter.
  python3-pil \
  && rm -rf /var/lib/apt/lists/*

# Chrome lives outside the workspace so a rebuild does not re-download it and
# `npm ci` cannot wipe it.
ENV PUPPETEER_CACHE_DIR=/home/node/.cache/puppeteer
RUN mkdir -p "$PUPPETEER_CACHE_DIR" && chown -R node:node /home/node/.cache

USER node
