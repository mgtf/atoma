# v0.1.1 release acceptance matrix

Date: 2026-08-12  
Artifact SHA-256: `259c75ce04f2e3800276d7bb9c7db37c05830103b8ddcf4dc5ea37299357f5ac`

This pass extends the original CLI soak to the compiled MCP, Docker worker,
proxied egress and cancellation paths. It started from the archive downloaded
from the published GitHub Release, not from the source checkout.

## Artifact setup

- The downloaded checksum verified before extraction.
- `npm ci --omit=dev` completed with zero known advisories.
- The host was on Node 22.12.0, below the documented 22.13.0 project floor;
  npm emitted `EBADENGINE`, and the runtime checks below still completed.
- Runtime state, workspaces and the MCP lease used isolated paths inside the
  temporary extraction.

## Release defect found

`npm run build:worker` failed from the production archive:

```text
error TS5058: The specified path does not exist: 'tsconfig.json'.
```

The archive intentionally contains compiled `dist/`, not TypeScript source,
but the command rebuilt TypeScript before invoking Docker. The correction
splits the contracts:

- `npm run build:worker` builds the image from packaged `dist/`;
- `npm run build:worker:dev` compiles source first, then builds the image.

The release workflow now runs the former after an extracted production-only
install. A static test pins both script definitions so the two contracts
cannot silently collapse again.

## Container and egress

The worker image built from the extracted archive. A quota-free probe then
started the real per-run egress sidecar and worker:

- `fetch_url` returned HTTP 200 from the allowlisted
  `https://registry.npmjs.org/left-pad`;
- `http://host.docker.internal:4111/` remained unreachable from the worker;
- the sidecar, worker container and private Docker network were all removed.

That probe is now `npm run release:container-smoke` and runs for every release
tag after the archive is extracted.

## HTTP run

A compiled-MCP run used both `container: true` and `egress: true`. Skill
learning, promotion and direct dispatch were disabled so the run isolated the
transport and tool backend rather than modifying the acceptance state.

The task delivered `server.js`, `test-api.js` and a probe manifest in 387
seconds, using 14 LLM calls at $0.2705 API-price equivalent. The independent
post-run check executed `node test-api.js` on the host and verified:

- `GET /health` returned status 200 and `{"status":"ok"}`;
- `POST /echo` preserved a Unicode JSON payload;
- the harness stopped its child server and exited zero;
- the manifest contained the successful harness invocation.

Trace: `2026-08-12T09-46-44-701-24de0977.json`.

## Cancellation and serialization

A second compiled-MCP session started a container-plus-egress run, cancelled
it after 1.5 seconds, and immediately attempted another start. The second
start was refused while cancellation was settling. The original record moved
from `cancelling` to `cancelled` only after the detached process group exited.

The complete check settled in 14.5 seconds. No worker container, egress
network or process rooted in the extracted release remained afterward.

## Non-passing diagnostic

The first, broader HTTP task also requested package metadata and documentation
with every lifecycle feature enabled. It exhausted a 600-second budget after
26 LLM calls and was correctly recorded as failed, although its final
`server.js`, test harness and `npm test` all passed independently. The run had
spent most of its tail correcting a CommonJS/ES-module mismatch introduced
when a later phase wrote `package.json`, plus one L1 result outside the JSON
envelope.

This is not counted as an acceptance success and is not presented as a
container regression: the narrower run proved the same runtime backend and
network path. It does show that a broad first-run HTTP build can still spend
its budget on model-authored integration churn; the release matrix proves the
mechanisms, not universal delivery within 600 seconds.
