# Tools — AGENTS.md

`src/tools/` owns element declarations, the registry, the sandbox, builtins,
the worker protocol and the execution backends — the only code L1 reaches.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
Element invocation names are immutable wire contracts.

Neighbours:

- [`src/atoms`](../atoms/AGENTS.md) — capability buckets and ground-truth policy
- [`src/contracts`](../contracts/AGENTS.md) — manifest merge identity
- [`src/run`](../run/AGENTS.md) — backend selection

## Elements, sandbox and isolation

- L1 is the only tier with tools. `src/tools/` owns declarations, registry,
  sandbox, builtins, worker protocol, and execution backends.
- `ToolSandbox` is the filesystem/process boundary. Resolve paths through it;
  do not compare raw user spellings for protected files.
- Default builtins and the closed tool vocabulary must stay in lockstep. Tests
  compare names/order; executor scope is the ultimate permission gate.
- `record_probe` writes the manifest from machine-observed results. Models choose
  what to probe; they do not transcribe the record.
- Worker and in-process backends share contracts from `src/contracts/`; never
  fork protocol shapes.
- Container execution uses `network none` unless explicit egress is selected.
  Proxied egress requires Docker Engine 28+: its per-run internal bridge uses
  isolated IPv4 and IPv6 gateway modes, because plain `--internal` can still
  reach host services through the bridge address. Fail closed on older engines.
- The worker receives an allowlisted environment, not a spread parent env.
  Credentials and control-plane store paths never cross the boundary.
- THE HOST CREATES THE MOUNT SOURCE before the engine is asked for it. A
  bind-mount source that does not exist is created by the DAEMON, as root; the
  worker then runs as the host user and finds `/workspace` unwritable, and the
  L1 agent — told nothing — improvises in `/tmp`, so the deliverable never
  lands where delivery, publication and the preview look for it. Measured on
  the first real containerised project run (2026-09-02). The local sandbox
  creates its own root; in container mode that sandbox lives INSIDE the worker
  and cannot create the host directory it is mounted from, and the operator
  path never saw this because its workspace persists across runs while a
  project run gets a fresh path every time. `tests/container-executor-lifecycle`
  asserts the property at the seam: the source is a directory at spawn time.
- Network allowlists compare parsed hostnames; lookalikes and IP literals fail.
  Default egress includes package registries and the shared public resource
  hosts in `contracts/webResources.ts`. Chromium receives the worker proxy
  explicitly; its loopback bypass keeps local application probes direct.
- Cleanup is mandatory on success, failure, timeout, signal, and hard-exit paths.
  Network teardown races need bounded retry.
- `ToolSandbox.drain()` is the stronger local contract before workspace
  replacement: await cleanup, kill surviving owned children/groups and confirm
  their exit; a surviving process prevents replacement.
- `ContainerToolExecutor.drain()` permanently closes its transport, removes
  every worker it started through the launcher-issued ownership handle and
  requires a successful engine query proving absence. CLI exit alone is not
  worker exit. The backend drains workers before stopping its egress sidecar.
- Docker image packaging is verified statically against the worker import graph
  and dynamically by booting the real image.
- `start_static_server` and `start_node_server` use OS-selected ports and explicit
  readiness markers, and register `{ port → kind, pid, entry }` in the tool
  set's ONE `servedOrigins` registry, which `fetch_url` and `validate_html`
  read. Do not kill arbitrary process groups; only safe integer PGIDs greater
  than 1 may reach group syscalls.
- A loopback URL with NO port is refused PRE-FLIGHT by both probe tools
  (`unservedLoopbackProbeRefusal`, prefix `PROBE_URL_REFUSAL_PREFIX` from
  [src/contracts](../contracts/AGENTS.md)): the server tools never bind the
  protocol default, so `http://localhost/` is a request-shape error, and the
  refusal names the registered origins. An EXPLICIT unregistered port is NOT
  refused — a `run_shell`-started server is invisible to the registry — but a
  refused connection there gets the registered origins appended to its error.
  Measured 2026-09-21 (run `d3098d25`): a final review probing the bare origin
  read the refusal as a dead service and replayed executions into the 1800 s
  deadline.
- `validate_html` treats smoke input as a JS expression, bounds every supplied
  duration, and ignores Chrome's own favicon 404. Browser console errors remain
  evidence but not every one is a mechanical failure.
- Do not relax `detectBrittleComputedStyleLiteral` (the rgb()/rgba()-literal
  pre-flight refusal). Measured across six batches on 2026-08-21 (15 firings
  over seven web runs): every refusal was followed by in-run compliance at
  ~one model turn each, every run delivered, and the expensive streak blamed
  on it (batch 5, seven calls on one unreachable check) was an AWAITED
  before/after comparison on a background-color transition that never
  progressed in the headless page — removing the transition made the
  identical check pass with a 100ms wait — plus an over-specified aggregate:
  shapes the guard neither causes nor could catch. The allowed routes (source-toggled class/inline
  marker; captured before/after comparison) are strictly more robust, and a
  conditional relaxation would need colour-space resolution against the page
  source for marginal gain.
- Tool results are truncated before returning to the model, with the relevant
  head/tail retained. Budget-exhausted finalization keeps tools declared so the
  provider transcript remains valid.
- Shared smoke guidance lives in one constant. Do not duplicate or specialize
  it around one widget vocabulary. The guidance and the `validate_html`
  pre-flight guards are ONE contract: `SMOKE_ASYNC_TRANSITION_EXAMPLE` is
  exported so `tests/smoke-guidance.test.ts` can feed it to the real guards.
  Never teach a smoke shape the tool refuses.
- The erased-intermediate-state refusal hands out TWO shapes since
  2026-09-15, rendered from ONE contract constant (`SMOKE_TWO_CALL_SHAPE`,
  [src/contracts](../contracts/AGENTS.md)) because atoms and tools may not
  import each other: real interactions up to the milestone under a read-only
  smoke, then one change plus the reset under a read-only smoke — the only
  taught shape that also covers a declared `dom-interaction` obligation — and
  the self-driving IIFE, which passes every guard and executes NO interaction,
  so both texts say it covers nothing. The covering shape comes first.
  `tests/smoke-two-call-coverage.test.ts` feeds both calls to the guards and
  through the attestation seam to `checkProofCoverage`. Why, and the measured
  cost of teaching the self-driving shape alone:
  [incident](../../docs/incidents/verification-replay-2026-09-15.md).
- A SYNCHRONOUS `getComputedStyle`
  read on a TRANSITIONED property returns the pre-transition value (verified
  in Chrome, 2026-08-21): assert the class/inline marker the source toggles,
  or make the smoke async and await past the declared duration — the tool
  awaits the returned promise.
- That await is BOUNDED to one repaint or transition. It is not a way to wait
  for real time: a smoke still running at `CDP_PROTOCOL_TIMEOUT_MS` is killed
  and returns NOTHING, and `diagnoseSmokeEvaluationError` replaces Puppeteer's
  `protocolTimeout` advice (addressed to the harness author, not the caller)
  with the remedy the `holdMs` description already gives — drive
  `window.__test.advance(ms)`. Measured 2026-08-21: teaching the await without
  the bound made a countdown task await 33s and 35s inside two smokes, both
  killed after burning ~45s each, and the run failed on its whole budget.

## Generated artefact conventions

- HTTP servers bind `process.env.PORT`, accept port 0, and emit
  `LISTENING_ON_PORT=<N>` once ready.

## Probe manifest writes

- `write_file` REFUSES an unparseable `.atoma-probes.json`
  (`probeManifestWriteRefusal`) before touching disk. The verbatim
  pass-through exists so the model can REPAIR a broken manifest, and only the
  INCOMING document is checked, so repair still works — but a repair that does
  not itself parse is corruption, and no writer may leave a record no reader
  can read back. Measured 2026-08-21: a hand-authored 10857-byte document with
  a raw newline inside a string reached disk, the ground-truth probe reported
  MALFORMED, the validator rejected, and the run paid an extra execute cycle
  to repair our own write. `edit_file` refuses manifest edits and points at
  this path, so the two halves must hold the same standard.

## Browser observation

- `validate_html` lays the page out at the caller's `viewport` (default
  800x600, Puppeteer's own) and ALWAYS reports the size it used. A malformed
  size is refused, never clamped: a page silently laid out at another width is
  the false proof the parameter exists to end. Until 2026-09-25 there was no
  parameter, so a task demanding 320/375/768px proof could not be met, and a
  smoke labelled "320px" read `innerWidth` 800 (runs `2fac992c`, `0e89e0ce`).
  The size rides the ATTESTED observation too (`viewport=WxH` in the line a
  validator reads), and keys the smoke stuck/oscillation detector, whose
  refusals report it: a width sweep is several layouts, not one flaky smoke.
- `validate_html` reports `requestedInteractions`, `ignoredInteractions` and
  the served `document` digest alongside `interactionLog`. The counts are the
  CALLER's fact and the log is the runtime's; a result that carries only one
  side cannot distinguish an executed click from a discarded one.
- `smokeDrivesOwnState()` still discards external interactions — the filter
  preserves one coherent state-transition path and is deliberately unchanged.
  What changed is that its effect is now reported as a number instead of only a
  warning string, so a consumer can act on it.
- The `document` binding is established on the FINAL RESPONSE the browser
  loaded, after every redirect, never on the requested URL
  (`bindObservedDocument`, 2026-09-13): the final URL's port must be one this
  tool set's server tools bound whose process HOLDS the listening socket NOW —
  asked of the kernel through `listeningPorts.ts`, `/proc` on Linux and `lsof`
  on darwin, failing closed elsewhere; alive is necessary, not sufficient —
  and the main-frame response bytes must equal the designated workspace file
  read at that instant (`/` → `index.html` is a designation, not a proof). A
  stranger's server, our server that exited or closed its listener while a
  stranger reuses the port, a registered server redirecting to a stranger, a
  Node server returning another file or generated HTML, an unchanged root
  `index.html` while the server serves a different page — all yield NO
  document. Absence is a weaker observation and never a failure, and it
  attests content correspondence at that instant, not the application's
  dependency chain.

## Intentional choices and rejected shortcuts

- A SYNCHRONOUS smoke observes only what the page has already committed, so
  the canonical state-driving shape (`SMOKE_CANONICAL_STATE_SHAPE`) is ASYNC
  and keeps its `settle()` awaits. Measured 2026-08-21 twice in one batch: a
  transitioned colour read back stale (`rgb(51, 51, 51)` with the class
  already applied) and a stopwatch display stuck at `"00:00.00"` while
  `elapsed` reached 988ms, because the `setInterval` tick could not run. Both
  runs retried an assertion that could not become true.
- The `validate_html` pre-flight reports EVERY refusal that applies, via
  `preflightSmokeRefusals`. This REVERSES the 2026-08-21 entry that forbade
  batching, and the honest accounting is that the reversal is NOT justified by
  measured savings: across both 2026-08-21 runs and project run `a786358a`
  (2026-08-23), every refused payload still violated exactly ONE guard, so
  batching has saved zero round-trips to date. It changes because three
  sequential early returns made the ORDER of the guards part of the contract,
  and one consequence of that order is a real hole: `interactions` is emptied
  before `detectResetErasedIntermediateEvidence` is consulted, so a
  self-driving smoke can never receive the erased-state refusal. Consulting
  all three keeps the report order-independent. Closing the hole itself would
  change a disposition and is NOT done here — see
  [`docs/decided-not-built-2026-08-23.md`](../../docs/decided-not-built-2026-08-23.md).
- A refused call is still ATTESTED. The pre-flight early return carries
  `requestedInteractions`, `ignoredInteractions` and the discard warning,
  because a refusal reporting none of them is indistinguishable from a call
  that sent no interactions at all — the exact confusion that field pair
  exists to prevent. It carries NO `document` since 2026-09-13: no page was
  loaded, and a binding is established on the loaded response. Its error
  strings start with the contract's `SMOKE_PREFLIGHT_REFUSAL_PREFIX`
  ([src/contracts](../contracts/AGENTS.md)), which is how the L1 validation
  ledger tells a refusal from a failed observation of the page; keep the
  wording behind the prefix free to change, never the prefix.
- Moving smoke guidance closer to the call site is NOT the untried variable.
  The erased-intermediate-state rule already sits in the `smoke` PARAMETER
  description and the model still violated it six times across two batches.
