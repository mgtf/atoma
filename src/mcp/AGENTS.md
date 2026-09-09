# MCP — AGENTS.md

`src/mcp/` owns atoma's MCP: ONE surface for everyone, served over HTTP on the
viz server's `/mcp` route, with a tiered catalogue of `atoma_*` tools, the
prompt and completion surface, the operator run launcher, its lease and the
bounded readers.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
The `atoma_*` tools are host control APIs, not L1 elements.

Neighbours:

- [`src/viz`](../viz/AGENTS.md) — the server that mounts `/mcp` and `/api/tokens`
- [`src/auth`](../auth/AGENTS.md) — principals, roles, the platform-admin flag, API tokens
- [`src/projects`](../projects/AGENTS.md) — the tenant runs the member tools drive
- [`src/run`](../run/AGENTS.md) — the launcher the operator run tools spawn
- [`src/registry`](../registry/AGENTS.md), [`src/skills`](../skills/AGENTS.md) — what the platform readers read

## One surface, tiered (decision 2026-09-05)

- ONE MCP, ONE TRANSPORT. Streamable HTTP on `/mcp`, and nothing else. The
  stdio server is gone: its argument ("no socket the run could reach")
  described a product installed on the operator's machine, and the product is
  a deployed server with organisations, principals and a journal. Record and
  reasoning: [`docs/mcp-one-surface-2026-09-05.md`](../../docs/mcp-one-surface-2026-09-05.md).
  Do not add a second transport for a special case; make the case a tier.
- THE CATALOGUE IS ONE TABLE (`tools.ts#MCP_TOOLS`): every tool names its
  MINIMUM TIER and what it NEEDS from the host. `tools/list` for a caller,
  `tools/call`'s re-check, the README's tool count and this file all read
  those rows. A tool is registered on a session only when the caller's tier
  admits it AND the host honours its needs — so the ungated loopback server,
  which has no organisations, shows the operator the operator tools and
  nothing tenant-shaped.
- THE LADDER (`identity.ts`): `viewer` reads an organisation's projects, runs
  and traces; `member` starts, cancels and publishes its runs; `admin` reads
  the organisation's members and sets its model defaults; `platform` — the
  platform-admin flag, or the operator on the ungated loopback — everything
  above plus operator runs, registry, skills, ledger, the operator corpus,
  friction, the journal and every organisation. A platform admin READS every
  organisation and WRITES only in its active one, exactly as the HTTP routes.
- ONE SESSION, ONE SERVER, ONE CALLER (`http.ts`). `initialize` authenticates
  the caller and builds a server holding exactly their tools; every later
  request must present the same caller or the session ends with a 401. Hiding
  a tool is therefore never the only guard: a revoked or demoted token cannot
  ride the session it opened. Sessions are memory-only and idle-swept; a
  restart forgets them and the client re-initialises.
- IDENTITY. Gated: `Authorization: Bearer atoma_…`, an API token a principal
  minted for ONE organisation (`/api/tokens`, or `npm run auth -- token`).
  `AuthStore.resolveApiToken` returns a fresh viewer — role and platform flag
  read NOW — and the row keeps a hash, never the secret. Minting and revoking
  are `token.created` / `token.revoked` journal rows. Ungated: the caller is
  the operator, by possession of the machine, as for the CLI; there is no
  token to present and no organisation to act in.
- HOST IS PINNED. The transport's DNS-rebinding protection is on with the
  public origin's host (gated) or the loopback host:port (ungated), so a page
  in a browser cannot address this port by name. Bearer tokens make CSRF
  moot; there is no cookie path into `/mcp`.
- WHAT DID NOT CHANGE: payloads are BOUNDED and honest about trust — traces
  page (`offset`/`limit`, capped), error strings truncate, run output, skill
  bodies, verdicts and trace text are marked UNTRUSTED model data; the
  operator readers never leave their directories (`pathIsInsideDir`, and a
  verdict is opened by run id, never by path); a project run's trace is read
  only through the store's own resolver for a run the caller may see.
- EVERY RESULT GOES OUT TWICE: the text block every host renders, and
  `structuredContent` for hosts that read typed results (`jsonResult`). A
  reader whose shape is stable declares an `outputSchema` (loose,
  `passthrough`-shaped, so an additive field never fails the host's
  validation); the older readers with polymorphic payloads (`note` on an
  absent store) declare none. Never add an `outputSchema` a payload can miss.
- HOST-PROVIDED NEEDS ARE READ AT CALL TIME. `preview`, `sentinel`,
  `analyst` and `notifications` are functions on `McpToolDeps`, because the
  preview runtime comes up after the bind and the watch's health changes every
  tick. A tool whose dependency is absent answers what the HTTP route answers
  (`503 previews are not available`), never a missing-tool error — except the
  tray, which needs a builder to exist at all and is a `needs` row.

## Operator runs and the lease

- `spawnRun` is the sole sanctioned operator run launcher. Keep compiled and
  source paths and flag ordering aligned; the goal is always the last argument.
- Runs are serialised by both in-memory state and the SQLite lease
  (`~/.atoma/mcp-run-lock.db`, machine-global on purpose). A second start is
  refused; stale lease recovery must validate PIDs/PGIDs safely. Deployment
  takes that same slot through `acquireRunLeaseWithoutRecovery` and never
  recovers an existing row.
- Cancellation is a state, not successful completion. Signal the whole
  validated child group, bound termination, retain trace/status evidence.
  `finishRun` frees the in-memory slot in `finally` even if lease deletion
  fails; hard server backstops bound driver promises that never settle.
- An operator run started through `/mcp` is a child of the viz server; a
  generic server exit signals it (`signalActiveRunOnExit`, SIGTERM only) so it
  closes its trace, and the stale lease lets the next start recover it.
- Stale-lease recovery is VISIBLE: `atoma_operator_run_start` reports what it
  reaped, and `atoma_operator_run_status` with no in-memory match reports the
  cross-process lease row instead of amnesia.

## Runs are tasks (`tasks.ts`)

- `atoma_benchmark_start` is a platform-only task over the existing retrieval
  campaign CLI. It accepts a full immutable registration, never caller-chosen
  dataset/output paths. The host fixes the dataset and archive root; source,
  instruments, worker and global lease checks remain the CLI's. Cancellation
  reaches the same campaign signal. Attempts are visible in the current viz
  without creating product project rows. Operator guide:
  [benchmark MCP integration](../../docs/benchmark-mcp-viz-2026-09-09.md).

- BOTH START TOOLS ARE MCP TASKS (spec 2025-11-25, SDK experimental
  `registerToolTask`): `atoma_run_start` (member) and
  `atoma_operator_run_start` (platform) answer a task-augmented call with a
  task id; `tasks/get` reports `working` with a status line, `tasks/result`
  blocks until the terminal result — the status tool's payload — and
  `tasks/cancel` cancels the run. There is NO "start, then poll" contract and
  NO long-poll: the status tools are plain readers, and a host that wants to
  follow a run drives the task, subscribes to the run's resource, or reads the
  run log. The `waitMs` long-poll and its `notifications/progress` were
  removed on 2026-09-07, the day the tasks landed, so that one contract exists.
- `taskSupport: 'optional'` is the SPEC'S fallback, not a second contract: a
  host that does not augment the call gets the SDK's own drive and the
  terminal result when the run ends — a synchronous call, minutes long, over
  the SSE stream that keeps alive and replays. A refused start is a task that
  fails at once, never a hung call.
- `createTask` calls the very start the HTTP routes call (`startRun`,
  `startProjectRunFromInput`), and the cancel hook calls the cancel tool's
  body (`cancelRun`, `cancelProjectRun`). The operator watcher turns each
  output chunk into the status line (bounded, marked untrusted) and the run's
  end into the result; the project watcher reads the tenant store once every
  `TASK_POLL_INTERVAL_MS`, because a project run's truth lives there.
- THE SDK'S `tasks/cancel` ONLY FLIPS THE STORE. `SessionTaskStore` wraps the
  SDK's in-memory store and intercepts the transition to `cancelled` to reach
  the run. A cancelled task has no result by the SDK's rule (a result is
  stored once, never on a terminal task); its last word is `tasks/get`, and
  the run's own final status stays readable through the status tool.
- TASKS LIVE WITH THE SESSION, like the event ring and the subscriptions: the
  store is per server, the ttl is the run timeout plus `TASK_RESULT_GRACE_MS`,
  the watchers are unhooked in `onclose`. A restart forgets task ids, never
  runs.
- THE TRANSPORT ANSWERS ON SSE, NEVER PLAIN JSON. `enableJsonResponse` makes
  the SDK drop every notification related to a request (measured 2026-09-07:
  0 of 3 delivered), and the standalone stream is what carries the run log and
  the resource updates. A script reading `/mcp` by hand parses SSE frames
  (`scripts/release-smoke.mjs#readResponseFrame`).
- EVERY FRAME IS REPLAYABLE. Each session's transport holds a
  `SessionEventStore` (`eventStore.ts`): a bounded in-memory ring that stamps
  frames with ids so a client cut mid-call reconnects with `Last-Event-ID`
  and receives the frames it missed, the response included. The ring dies
  with the session; a cursor that fell off replays nothing rather than
  something wrong.
- THE RUN LOG: the server declares `logging`, and the session that started an
  operator run receives each output chunk as `notifications/message` (`info`,
  logger `atoma.run.<runId>`, `untrusted: true`) and one `notice` when it
  ends. Only runs the session started are followed; the SDK filters by the
  level the client set. Project runs have no chunk source here and log
  nothing; their task's status line follows the store's status.
- The start tools' input schemas live in `tasks.ts` (`OPERATOR_RUN_INPUT`,
  `PROJECT_RUN_INPUT`), one per shape. `McpToolDeps.operatorRunDriver` /
  `operatorRunLease` are `run.ts`'s injectable seam reached through the deps,
  so a wire test drives a start without spawning the runner. Absent in
  production.

## Resources and subscriptions (`resources.ts`)

- Resources are DOORS ONTO THE READERS, never second bodies: `atoma://runs/
  {file}` reads through `runTrace` with its paging and truncation,
  `atoma://operator-runs/{runId}` through `runStatus`, `atoma://projects/
  {projectId}/runs/{runId}` through `ProjectService.projectRunStatus`,
  `atoma://families` through `families`. A URI carries no way to ask for more.
- Registration follows the tools' tiers and needs, per session: the operator
  corpus only at the platform tier on a host with `operatorRuns`, a project
  run only for a principal on a host with organisations. Listings are menus,
  capped at `RESOURCE_LIST_LIMIT`; the trace template completes over
  `completeTraceFile`.
- `resources/subscribe` is per session and dies with it. A finished operator
  run (`onRunFinished`) or a `run.finished`/`run.cancelled` journal row sends
  `resources/updated` to the sessions that subscribed to that URI, and a
  finished operator run also sends `list_changed` (a new trace exists). The
  listeners are unhooked in the server's `onclose`, so nothing is ever written
  to a transport that is gone. The capability is declared BEFORE `connect`
  (`registerCapabilities`), which is when the SDK freezes it.

## Operator writes (`writes.ts`)

- Four verbs, platform tier, `needs: ['operator-runs']`: `atoma_skill_reset`,
  `atoma_skill_drop`, `atoma_skill_merge`, `atoma_registry_rollback`. They
  call the SAME store methods the CLI calls (`SkillRegistry.resetCounters/
  drop/merge`, `AtomRegistry.rollback`), so the lifecycle ledger rows are the
  CLI's rows and `ledger check` projects the same counters.
- THE CLI'S REFUSALS, IN THE CLI'S WORDS: dropping or absorbing a skill with
  recorded successes is refused without `force`; a rollback to the live
  version is a no-op the registry itself reports. A second door must never be
  looser than the first, and must not grow a rule the first lacks.
- ATTRIBUTION is what the MCP adds. The actor is the principal behind the
  bearer (`mcp:<principalId>`) or the loopback operator (`mcp:operator`), and
  it is written into the payload, into `AtomRegistry.rollback`'s `modifiedBy`,
  and — on a gated host — into one journal row per action (`skill.reset`,
  `skill.dropped`, `skill.merged`, `registry.rolled_back`, `actorType:
  principal`, severity warning, never pushed). Rows carry names, ids and
  counters, NEVER a body. On the ungated path there is no journal and the
  payload says `journaled: false`; that matches the CLI, which has no principal
  to name.
- Writes open the store through `openDb` (schema and migrations), exactly as
  the CLI does, and close it before returning. The readers' readonly handles
  are not a write path and must not become one.

## Prompts and completions

- The PROMPT surface adds no tool: one goal template per launchable family
  plus one prompt per reader group. It drives the operator readers and
  completes over the operator store, so it rides the `platform` tier. Prompt
  text QUOTES its source (`TaskProfileGuidance`, the exported caveat
  constants) and never restates it, and a prompt must not teach a caller to
  name a builtin element in a goal.
- Argument completions hang off PROMPTS because the protocol has `ref/prompt`
  and `ref/resource` and no `ref/tool`. Every completable argument is
  REQUIRED (the SDK does not unwrap an optional). Completion sources live in
  `readers.ts` and bound their own SCAN, not just the returned slice.
- A completion that needs ANOTHER argument reads it from the completion
  context (`context.arguments`), which is how `atoma_read_skill` completes a
  skill id inside the molecule already typed; with no molecule there is
  nothing to complete against, and the source answers nothing rather than
  every skill on the machine.
- A prompt may NAME a write tool (`atoma_read_skill` names the three skill
  verbs) only to hand the decision back to the person; it must never instruct
  the host to perform the write.

## Changing the catalogue

- Adding a tool is adding a row: name, minimum tier, needs, registration.
  With it come a behavioural test in `tests/mcp-http.test.ts` (which tier sees
  it, what it refuses), the release smoke if it is operator-visible, and the
  README sentence `docs:check` derives from the table (the spelled-out count
  in `scripts/repo-facts.mjs` runs to forty; extend the table before the
  catalogue passes it). Removing or renaming one is a compatibility change for
  every registered client and is stated in the changelog.
- A reader the MCP grows is a reader the CLI or the viz already has, reached
  through a second door: `skillShow` mirrors `skills show`, `ledgerTail`
  `ledger tail`, the tray builder is shared with `/api/notifications`
  (`src/viz/push/tray.ts`). When a new reader has no first door, build the
  shared body first and mount both doors on it — never a loop the route keeps
  and the tool copies.
- `atoma_doctor` was considered and NOT built (roadmap, 2026-08-21 and
  2026-09-07): doctor probes Docker and the environment and is not a pure
  reader. Exposing a side-effect-free subset needs that subset to exist in
  `src/cli` first.
- The tenant tools call `ProjectService` through its input-based methods
  (`createProjectFromInput`, `startProjectRunFromInput`, `projectRunStatus`);
  the HTTP routes are body readers in front of the same checks. Never
  re-implement a role check in a tool.

## Intentional choices and rejected shortcuts

- The MCP lease `ALTER TABLE` loop is corruption repair, not version
  migration. The lock DB lives in `~/.atoma/` outside the product store, and
  the burn-in pgid guard already documents it as writable by the run itself;
  without the loop a foreign-shaped table makes every start throw a raw
  SQLite error until a human deletes the file.
- Per-session servers rather than one server with enable/disable per call:
  the SDK filters `tools/list` from what is registered, and a tool that is
  not registered cannot be called by name — two properties from one
  mechanism, where toggling would have been two.
- OAuth clients and manually minted API tokens share `resolveApiToken`.
  OAuth discovery, consent, PKCE, expiry and renewal belong to
  [src/auth](../auth/AGENTS.md); the MCP remains the resource server and
  advertises its metadata URL on authentication challenges.
- A `waitMs` long-poll on the status tools, with `notifications/progress`,
  lived two days (2026-09-05 to 2026-09-07) and was removed when the start
  tools became tasks: two ways to follow a run is one too many, and the
  long-poll never delivered its progress line in the JSON transport mode it
  shipped with. Do not re-add a wait parameter to a reader; a host that wants
  to wait drives the task.
- Keeping stdio "for local development" was considered and dropped
  (2026-09-05): `npm run viz` already serves loopback ungated, so the local
  MCP is the same URL on `127.0.0.1`, and a second transport was code kept
  for a case that does not exist.
