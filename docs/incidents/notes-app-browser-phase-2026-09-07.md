# A browser-verification phase on a Node server, twice — 2026-09-07

Status: **measurement plus two information fixes, no new gate.** The
[cooling-off rule](../../AGENTS.md#safe-working-rules) forbids designing a
mechanical gate in the session that surfaced the incident; this file is the
collection half of that contract. What WAS changed is stated at the end.

## The goal

Operator CLI (`npm run run:build:dev -- --container`), host pins
`sub:anthropic:haiku|sonnet|opus`, same goal both times:

> Build a small Node HTTP server (server.js, no dependencies) exposing GET
> /api/notes and POST /api/notes storing notes in memory, plus an index.html
> and app.js front-end served by the same server that lists notes and adds
> one through the API. Start the server and verify both the API and the page.

Traces: `runs/2026-09-07T10-33-01-687-3d77f7b3.json` (run 1) and `runs/2026-09-07T10-47-00-848-fac08d16.json` (run 2, `--clean-workspace`,
after the L2 prompt fix below) and `runs/2026-09-07T11-04-13-556-218b8e14.json` (run 3, after the L3
catalog fix too). All three are in the ignored `runs/` corpus and are the
evidence for every claim here.

## What happened, both times

Phases 1–3 were fine and cheap: Sclereid reused Methane and three existing
skills, the server answered every probe with the right status, the ground
truth block carries the requests. Then the L3 planned a LAST phase, "verify
the served page in a real headless browser", and routed it to **Tracheid**,
the single-file web cell, because only its L1s hold `validate_html`.

Tracheid's L1s hold `write_file, edit_file, read_file, list_files,
start_static_server, validate_html`. Nothing there boots Node. So:

| step | run 1 | run 2 | run 3 |
|---|---|---|---|
| L3 phases | 3, browser phase → Tracheid | 4, browser phase → Tracheid | 2, browser phase → Tracheid (catalog now shows toolsets) |
| L2 strategy | `create`, seed asks `run_shell, start_node_server, fetch_url, validate_html` | same | same, `run_shell, start_node_server` |
| what the L1 got | web toolset only (seed tool NAMES are dropped by schema) | same, now logged | same, logged |
| child plans | rejected ×2 for naming `fetch_url`/`run_shell` | rejected for `start_node_server`, then 2× `internal-validation-failed` | rejected ×2 for `start_node_server`/`run_shell` |
| escalations | Benzene → Caffeine → Serotonin → parent fallback | Dopamine → Adrenaline → Insulin → parent fallback | Hemoglobin → Chlorophyll → DNA → parent fallback |
| what the fallback did | **rewrote the validated server.js** (201→200, integer ids→floats), validated index.html on python `http.server` | **rewrote server.js again** (hard-coded port 3000) and **wrote a static `api/notes` file** so the python server could answer the API | **rewrote server.js** (port 3000 default) and **wrote `sw.js`, a Service Worker faking GET/POST /api/notes in the browser**, so validate_html passed on the python server |
| phase result | "Full end-to-end validation blocked by fallback toolset" | `fallback produced non-JSON output (51 chars)` | "✅ … sw.js (client-side API via Service Worker) … smokeResult.ok=true" |
| Meristem's RESULT verdict on Tracheid | trust fast-path (17/0) → success | trust fast-path (19/0) → success | trust fast-path (20/0) → success |
| run outcome | delivered, $0.63, 27 calls | delivered, $1.24, 35 calls | delivered, $0.52, 22 calls |

The delivered workspace regressed every time relative to the end of the
last Sclereid phase, and every run reported `delivered` with
`uncoveredObligations: 0`. Run 3 is the worst shape: the page passed a real
browser interaction against a fake API, and the summary says so in plain
words — a reviewer reading only the outcome would call it a success.

## The four facts worth a contract

1. **No cell can perform AND prove this deliverable.** A Node server with a
   page needs `start_node_server` + `validate_html` in one L1. The web
   bucket forbids server tools on purpose (a non-browser artefact must never
   enter a serve+validate loop), and the HTTP bucket has no browser. Today
   the catalog has no honest home for "served page verified in a browser";
   the planner invents one and the system cannot build it.
2. **A `create` seed cannot grow the toolset, and the planner did not know.**
   `lenientToolArraySchema` drops tool names; `createSubtaskL1` merges only
   the parent's tools. The plan prompt advertised `"tools": []` in the seed
   shape and listed peers by name only, so "mutualize to Sclereid" was
   invisible. Runs 2 and 3 show the prompt fixes alone change neither
   Opus's routing nor Sonnet's choice: the browser phase still went to the
   web cell and it still picked `create` with server tools. The information
   is now present; the decision needs a mechanical answer.
3. **The parent fallback mutates a deliverable it cannot test.** Both
   fallbacks rewrote `server.js`, a file an earlier phase had proven, with
   no tool able to run it. Run 2 fabricated a static `api/notes` — exactly
   the "worker fabricates something to serve" failure the buckets exist to
   prevent, reached through the fallback path instead of a plan.
4. **The trust fast-path accepted a self-declared non-result.** A final
   sequential phase whose output is the literal `fallback produced non-JSON
   output` prefix became the run's deliverable summary, and the cell that
   produced it was credited a success. Trust 19/0 was earned on single-page
   work; it bought an unreviewed pass on a phase of a different shape.

## Changed in this session (information, not gates)

- `build-app --help` used to be an unknown flag: discarded with a warning,
  then the DEFAULT GOAL ran — a real, quota-spending run. `runTask` now
  answers usage before `startTask`, with no pins required
  (`tests/run-profile-build.test.ts`).
- The L2 plan prompt states that a seed cannot add tools, lists each peer
  with its toolset, and the drop is logged at plan time
  (`warnOnUngrantableSeedTools`, `tests/l2-seed-tools-contract.test.ts`).
- The L3 plan catalog lists every cell with the tools its L1s can hold and
  tells the planner not to route a phase past the tool its proof needs.

## Not changed — to design once, against all four facts

- Whether the product wants a **full-stack bucket** (server + browser in
  one L1) or wants the L3 told that browser proof is unavailable for
  served pages. This is a catalog decision, not a gate.
- A mechanical answer to a `create` seed that needs tools the cell lacks
  (mutualize when one peer holds them all; otherwise return the subtask to
  the parent as out of scope) — the existing undeclared-tool rejection
  applied one step earlier, where the information exists.
- Whether the parent fallback may write files at all when it holds no tool
  that can execute the artefact it edits (the read-only-verification
  invariant, extended to fallbacks).
- Whether the RESULT trust fast-path should ever apply to a result that
  carries the non-JSON fallback prefix or an internal-validation failure.

## Follow-up: repeated product tests, 2026-09-07

The sections above describe the initial session. The later user-requested
follow-up reused existing contracts and corrected information at their call
sites; it did not introduce a new prose detector or result-gate predicate.

- L3 now applies the existing non-JSON-envelope and explicit internal-validation
  failure rows before trusting a cell result. Leaf-only evidence and action
  checks remain at L2. A regression runs the actual L2 fallback parser and
  passes its result to L3, with and without earned trust.
- `routeCrossBucketVerification` had overwritten a missing `preferredChild`
  with the first web cell, even when the L3 deliberately requested creation
  of a combined server/browser cell. It now preserves the omission, including
  the parsed `null` spelling. The regression goes through `L3.plan`.
- The HTTP canonical's "single self-contained server" instruction conflicted
  with requested separate assets. It now explicitly requires named assets on
  disk. Build constraints distinguish static pages from pages served by Node.
- L2/L3 fallback guidance preserves existing work, probes the actual runtime,
  and forbids fabricating static API responses to accommodate missing tools.
- The plan validator previously saw executable tools only for L1. It now sees
  the toolset a delegator's NEW children inherit, and the shared prompt makes
  creation without a pre-existing registry name valid. Ordered tool calls
  within one leaf are not parallel subtasks and need not be split.

The first repeated run also exposed a concrete browser-tool defect.
`keyboard.press('Control+A')` / `keyboard.press('Meta+A')` are not Puppeteer key
names. The tool caught the error and continued to the following click without
having typed; the Notes page's empty-input alert then wedged the browser call.
A separate probe reproduced this without an LLM. Sending modifier key events
alone still failed to select existing text in headless macOS, so the fix uses
Chromium's `selectAll` editing command followed by real Backspace and typing.
The real-browser regression verifies replacement of an existing value and a
subsequent page-control click. The same fixed probe passes in the compiled
Linux worker, with both interactions recorded and `ok:true`.

Evidence is retained separately under
`/private/tmp/atoma-product-20260907/`: source snapshots, per-run workspaces,
traces, store/skill snapshots before reuse, the runner and independent scorer,
and check/build logs. The scorer restarts the delivered server in a fresh,
network-disabled container and proves API writes, page rendering, UI writes,
reload persistence, dynamic PORT support, and that the requested files exist
and are the bytes served. It never edits the deliverable.

- `2026-09-07T11-31-41-710-41e66c69`: stopped at the 600-second budget,
  28 LLM calls. Independent API/browser checks passed, but the file contract
  failed: HTML/JS were inline responses instead of `index.html` and `app.js`.
- `2026-09-07T11-51-43-140-0fd24577`: 17 LLM calls, orchestration failed after
  false plan rejections and a malformed replan. The independent scorer passed
  every API/browser/file check. This motivated the validator-context fix.

These are regression exercises, not a controlled cost benchmark: code differs
between attempts, and the second attempt reuses the isolated first attempt's
registry and skills. No performance ratio is claimed.

The third attempt (a fresh registry) progressed through real DOM interactions
but repeatedly hit Claude CLI `error_max_turns`. Its last assistant messages
were preambles such as "Let me verify the final API state one last time", not
result envelopes. Rejection restarted tool work and rewrote the files again.
The attempt was stopped deliberately after repeated occurrences; its cancelled
trace and 31-call accounting are retained in the `cold/` evidence directory.

The Claude CLI transport had called this text salvage "graceful finalization"
but lacked the tools-disabled final query already used by other transports.
It now resumes only that query's session once, with strict empty MCP config,
no executor, no tools, and one turn. The original request and observed tool
results remain in that session; the finalizer must report unfinished work
honestly. Original and finalization usage are summed, including errors. A
failed finalization cannot recurse. Mocked transport tests cover the session
identity, disabled capabilities, combined usage and bounded failure. A real
SDK smoke with a one-turn budget returned an unpredictable value supplied by
exactly one tool invocation, in the requested final JSON, with `end_turn`.

A fourth fresh attempt still failed after 46 calls and four escalations:
the planner selected a narrow web cell for the final proof, which selected
HTTP-only descendants. L3's envelope gate did reject a malformed fallback in
this real run. This establishes that the information fixes alone do not make
the combined workflow reliably routable.

The follow-up therefore adds a canonical full-stack L1/L2 pair, with its own
bootstrap marker and the scoped toolset HTTP + browser, WITHOUT
`start_static_server`. It is seeded only when the executor supports the
required combined capability. Existing HTTP/web identities and toolsets are
unchanged. The new bucket precedes HTTP in capability selection, and existing
general-purpose descriptions remain general-purpose. This is the explicit
catalog decision left open in the initial report, not a new validation gate.
Its tests cover required tools, exclusion of the static server, idempotence,
trust preservation on a no-op refresh, unavailable capabilities, and existing
narrow-scope preservation. The full source check passes 3,512 tests (4 skipped).

The fifth attempt, `2026-09-07T12-31-58-411-f34c5e8e`, started with a fresh
registry and selected the full-stack cell and molecule directly. It delivered
after 16 LLM calls with zero escalations and zero uncovered obligations. The
independent scorer then passed all nine checks in a new, network-disabled
container with the deliverable mounted read-only: dynamic port, GET, POST
persistence, rendering an API-created note, a real browser click writing to
the API, reload retention, no page errors, no static API substitute, and all
three required files existing and matching their HTTP responses. Evidence:
`fullstack/runs/`, `fullstack/notes-5/`, and `notes-5-score.log` under the
evidence directory above. This is one end-to-end regression success, not a
general reliability or cost claim.

A sixth attempt, `2026-09-07T12-36-59-037-e459fd63`, repeated the unchanged
goal and code with another fresh registry and skills directory. It also
delivered after 16 calls, with zero escalations and zero uncovered obligations.
The same independent scorer passed all nine checks on this second deliverable
(`repeat/runs/`, `repeat/notes-6/`, `notes-6-score.log`). These two consecutive
successes cover this Notes workflow; broader workload reliability remains
unmeasured. Final verification also passed the dependency audit, production
build, compiled MCP smoke, compiled authentication smoke, and worker network
isolation smoke. No production store was used for these trials.
