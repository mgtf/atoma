# Build dist (including the GPU client) from the same revision first.
ARG NODE_IMAGE=node:24.20.0-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies
ENV NODE_ENV=production HUSKY=0 PUPPETEER_SKIP_DOWNLOAD=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY scripts/husky-install.mjs ./scripts/husky-install.mjs
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production HUSKY=0 PUPPETEER_SKIP_DOWNLOAD=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates procps && rm -rf /var/lib/apt/lists/*
COPY scripts/requirements-haystack.txt /tmp/requirements-haystack.txt
RUN python3 -m venv /opt/atoma-python && /opt/atoma-python/bin/pip install --no-cache-dir -r /tmp/requirements-haystack.txt && rm /tmp/requirements-haystack.txt
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY dist ./dist
COPY scripts/retrieval-haystack.py ./scripts/retrieval-haystack.py
COPY docker/web-entrypoint.mjs docker/stack-contract.mjs ./docker/
RUN test -f dist/viz/client/index.html && test -f dist/cli/build-app.js
CMD ["node", "/app/docker/web-entrypoint.mjs"]
