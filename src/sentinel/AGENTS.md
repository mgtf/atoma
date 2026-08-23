# Sentinel — AGENTS.md

`src/sentinel/` owns the mechanical live watch over runs in flight: the
declarative rule table, the discovery sources, and the two shells that host a
watch — `runSentinelLoop` for the CLI and `startResidentSentinel` for the viz
server. Stage 1 of
[`docs/supervisor-design.md`](../../docs/supervisor-design.md).

TWO HOSTS, ONE WATCH PER STORE. The gated viz server arms the watch
in-process, so `npm run viz` covers whoever is looking at the screen; the CLI
covers what a server cannot — an ungated checkout, another machine, another
store, a burn-in batch that must not also run a browser, `--once` in cron. A
resident CLI TAKES the store's watch over from a viz server, because typing
that command is the deliberate act and a forgotten browser tab must not refuse
it; it yields to another live CLI, where the tie is ambiguous. The displaced
server notices on its next ownership check and re-arms once the CLI stops.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/platform`](../platform/AGENTS.md) — the journal it writes into
- [`src/viz`](../viz/AGENTS.md) — the trace shapes it reads
- [`src/atoms`](../atoms/AGENTS.md) — `resultGates.ts`, the table this copies
- [`src/mcp`](../mcp/AGENTS.md) — the bounded-reader discipline and the lease

## The rule table

- ONE declarative table, one explicit journal kind per rule, never an inline
  `if` — the shape `resultGates.ts` settled on. A new incident adds a row.
- Rules are PURE functions over a bounded window of trace events: no
  filesystem, no LLM, no clock of their own, and no power. A rule's entire
  output is a finding; a finding's entire effect is a journal row. There is
  deliberately no disposition field, because a heuristic here decides nothing.
- Every finding carries a `dedupeKey` and the caller emits each key at most
  once per run. The sentinel polls, so without it one anomaly would write one
  row per tick and the channel would be useless inside a single run. The rule
  chooses the granularity: once per run for a threshold, once per
  (tool, args) for a stall, once per event for a content match.
- A rule that throws is contained and skipped. The sentinel is an observer;
  one bad pattern must not stop the screen behind it.
- The two kinds are `run.anomaly` and `security.flagged`, and nothing else.
  Severity and push audience are forced by the exhaustive maps in
  [`src/contracts/platformEvents.ts`](../contracts/platformEvents.ts) and
  [`src/viz/push/routes.ts`](../viz/push/routes.ts).

## The watch and the loop

- Detection is TWO SOURCES behind one interface (`sources.ts`), because there
  are two run corpora and they never mix. A watch on either alone is half
  blind, and the half it misses is the product: `runs/index.json` holds the
  operator runs, while every project run points `ATOMA_RUNS_DIR` at its own
  directory precisely so its trace never joins the instance corpus.
  - operator: `index.json` plus `isIndexEntryLive`, the repo's ONE live
    predicate — an INFERENCE from event timestamps, because nothing records
    the fact.
  - project: `project_runs.status = 'running'`, a transactional fact, plus a
    staleness bound (`ABANDONED_AFTER_MS` against the trace's mtime) for the
    window in which a row outlives its process. The sentinel does NOT repair
    such a row — `reconcileInterrupted` does that at the next boot, and an
    observer that writes the control plane is no longer an observer.
  Above the sources there is ONE tick, ONE rule table and ONE de-duplication
  path. A source that throws is reported and the other keeps being read: a
  locked tenant store is exactly when operator runs still need watching.
- Not the MCP lease: a lease-only watch would miss the CLI runs (burn-in,
  benchmark) that most need watching. The lease is read for context only —
  which pid holds it.
- A project finding carries `orgId`/`projectId` as ATTRIBUTION, not audience.
  The push audience is unchanged and stays in `viz/push/routes.ts`: these
  rules are not calibrated, and the first thing a customer learns from atoma
  must not be an uncalibrated heuristic about their own run.
- The tenant source is added only when the store ALREADY holds project tables
  (`hasProjectTables`). `ProjectStore.open` applies its DDL, and a watcher
  must not bring a tenant control plane into being by looking at it.
- NEVER a parser on the runner's stdout. That stream is the burn-in harness's
  parsed API, and a second parser would couple the sentinel to a format it
  does not own.
- De-duplication reads the JOURNAL, not process memory: each finding's
  `dedupeKey` is stored in `detail` and read back per run, PAGED to
  `MAX_DEDUPE_PAGES`. A restarted watcher repeats nothing. A journal read that
  FAILS — or a run with more findings than the cap will read — is treated as
  "already said" for that tick: a gap is better than a flood.
  CORRECTION, and it is load-bearing: this is a CROSS-TICK guarantee, not a
  within-tick one. `emittedKeys` reads and `screen` writes as two statements
  and `platform_events` has no uniqueness over (kind, run_id, dedupeKey), so
  two watchers ticking in the same window each write the same finding once.
  That is what `lease.ts` is for, and the earlier claim that "two watchers
  cannot double-report" was simply wrong.
- ONE APPENDING RESIDENT WATCH PER STORE, held as the `sentinel_watch`
  singleton in the product store — keyed by the store, which is why it lives
  in it, unlike `mcpRunLockPath()`. Reclaim is automatic when the owner is
  gone, is a different process wearing its pid, or is silent past THREE OF ITS
  OWN INTERVALS (floored at a minute): reading the owner's cadence rather than
  the claimant's is what stops a `--interval 2000` CLI evicting a healthy
  20-second server. `--once` takes no lease and still journals, because a
  bounded pass that appends nothing would be a dry run wearing a safety
  feature's name.
- The lease is a PER-TICK fact, never a boot decision. A refused claim at boot
  would leave a server blind until somebody restarted it, so every tick
  asserts ownership first — and the heartbeat IS that assertion: zero rows
  changed means the row is no longer ours and appending must stop.
- CONTAINMENT IS `safeTick`, called by both shells. A throwing tick cost the
  CLI one pass; in a server an exception escaping an interval callback is an
  uncaught exception with no handler above it, so the process dies and
  `viz-dev.mjs` takes Vite with it. The resident also stops calling itself a
  watch after three consecutive failures, and its timer is `unref()`ed so a
  watch can never be why a host refuses to exit.
- Rows are attributed `system` — a resident process, not a signed-in
  principal — for BOTH hosts, and `detail.watch` names which one wrote the
  row. Watcher identity is a sentinel fact, not an actor; the pid and start
  time stay out of the row, where they would rot, and live in the health
  payload and the lease instead.
- A run whose trace is unreadable or over `MAX_TRACE_BYTES` is REPORTED as
  skipped, never silently dropped. A tick that throws is logged and the loop
  continues: an observer that dies on one bad trace stops observing
  everything behind it.
- A tool failure lives in TWO places and the rules read both: `event.error`
  is the transport's exception, `result.ok === false` is the element's own
  verdict — and the second is where atoma's tools report almost everything.
  Measured on the cold `web-counter` trace: 1 against 4.

## Untrusted content

- Element RESULTS are where content the system did not author enters it, so
  that is the only place the signature rule reads. Tool ARGUMENTS are
  model-authored and belong to the anomaly rules.
- Untrusted bytes reach an operator through `excerpt` and nowhere else:
  whitespace collapsed so a payload cannot forge journal structure, length
  hard-capped under the journal's own detail limit. A journal excerpt is
  evidence to read, never an instruction, and nothing may act on it
  automatically.
- Push bodies never carry the payload — only which rule matched and where. A
  notification quoting attacker-controlled text makes the notification the
  delivery channel.
- The signature list is a SCREEN that says where to look. It is not an
  authorization boundary, and `src/skills/scriptScan.ts` records what happens
  to a pattern list mistaken for one: 8 of 9 obfuscated payloads passed it.

## Intentional choices

- The cost rule is an operator ALERT THRESHOLD, not a budget. The product has
  no per-run cost budget — `Limits` bounds iterations, the runner bounds wall
  clock — so naming it a budget would invent a contract nothing enforces.
- The outlier rule needs three samples per tool name before it will call
  anything an outlier, and compares only within one tool name. With two
  samples the slower one is always "3× the median"; across tool names a
  browser validation and a file read share no scale.
- Adding a rule is adding a mechanism: it follows the COOLING-OFF contract —
  collect incidents, design once, land reviewed — never same-day reaction to
  the run that surfaced it.
- The sentinel's only possible power is a journaled `atoma_run_cancel`, and
  whether it has it at all is still an open decision in the design document.
  Until that is settled the table cannot express it, and no row here is
  cancel-eligible.
