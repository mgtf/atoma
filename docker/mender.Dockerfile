FROM node:22.13.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code @openai/codex@0.152.0
WORKDIR /work
