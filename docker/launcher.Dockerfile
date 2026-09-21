# Separate engine holder. Build after compiling dist/.
FROM node:24.20.0-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY docker/launcher-package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY dist/launcher ./dist/launcher
COPY dist/contracts/launcher.js dist/contracts/launcherRpc.js dist/contracts/launcherVolumes.js dist/contracts/launcherWorker.js dist/contracts/workerProtocol.js ./dist/contracts/
# The operator supplies a private socket directory, Docker's socket and a
# dedicated workspace mount at the SAME absolute path as on the engine host.
# No product store, credentials, skills or run corpus belongs in this image.
ENV NODE_ENV=production
CMD ["node", "/app/dist/launcher/main.js"]
