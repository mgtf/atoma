# v0.1.3 release acceptance

Date: 2026-08-13

Status: ready to tag; no tag or GitHub Release has been created.

## Scope

This candidate consolidates the post-v0.1.2 verification work:

- exact task contracts survive L3/L2 decomposition;
- trusted results cannot hide a failing required harness, malformed browser
  evidence, an ignored script skill, or non-portable HTTP documentation;
- full-stack browser and shell checks are routed as separate sequential phases;
- probe-manifest writers preserve evidence from earlier phases;
- Codex-backed skill compilation uses the measured `low` effort policy;
- Puppeteer 25 removes the vulnerable `extract-zip` dependency chain, with the
  supported Node floor aligned to 22.13+ or 24+.

## Reproducible release checks

From a clean checkout on Node 22.13+:

```bash
npm ci
npm run release:check
npm run build:worker
CI_REQUIRE_DOCKER=1 npx vitest run \
  tests/container-image-closure.test.ts \
  tests/container-isolation.test.ts \
  tests/container-executor-lifecycle.test.ts
```

Observed:

- `npm audit`: zero known vulnerabilities;
- full typecheck, lint and mocked suite: green;
- compiled build and MCP smoke: 13 tools, JSON-only stdout;
- compiled doctor help smoke: green;
- fresh Puppeteer 25 worker: 24/24 container closure/isolation/lifecycle tests;
- clean-lock GitHub CI: hermetic and fresh-worker jobs green.

## Codex compile acceptance

The exact `write-structured-markdown-files` prompt that had timed out was
replayed ABBA against `gpt-5.4-mini`, with the same 120-second cap:

- `medium`: 120.006s timeout, 119.962s timeout;
- `low`: 50.971s success, 42.375s success.

Both low-effort responses were valid promotable JSON, declared the required
result envelope and passed the static script scan.

A fresh production task then confirmed the real lifecycle path:

- trace: `2026-08-13T08-25-36-940-9c020c0a`;
- delivered in 126 seconds / 11 calls / $0.1574 estimated API equivalent;
- compile completed in 48.649 seconds with `compile_errors=0`;
- promotion succeeded and deterministic Markdown verification ran once;
- friction report: zero events;
- independent score: two files, each H1=1, Procedure=5 numbered items,
  Verification=3 bullets, prose-only Purpose;
- promoted body replayed in a fresh temporary workspace with exit 0 and a
  valid output/summary envelope.

Promotion reset the new script body to 0/0. It remains on the validated path
until three clean runs earn deterministic dispatch.

## Billing note

The OpenAI/Z.ai figures are API-price equivalents derived from recorded usage.
Codex calls used ChatGPT subscription authentication and are not per-token
local billing records.
