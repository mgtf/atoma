FROM node:22.14.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ chromium ca-certificates procps \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code
WORKDIR /work

# Every command gets a fresh container. Keep the browser in the image, as the
# tool worker does, rather than downloading it into a disposable /tmp cache.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
