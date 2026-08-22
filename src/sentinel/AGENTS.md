# Sentinel — AGENTS.md

`src/sentinel/` owns the mechanical live watch over runs in flight: the
declarative rule table, and (later) the resident process that polls and
journals. Stage 1 of
[`docs/supervisor-design.md`](../../docs/supervisor-design.md).

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

- Detection is `runs/index.json` plus `isIndexEntryLive`, the repo's ONE live
  predicate. Not the MCP lease: a lease-only watch would miss the CLI runs
  (burn-in, benchmark) that most need watching. The lease is read for context
  only — which pid holds it.
- NEVER a parser on the runner's stdout. That stream is the burn-in harness's
  parsed API, and a second parser would couple the sentinel to a format it
  does not own.
- De-duplication reads the JOURNAL, not process memory: each finding's
  `dedupeKey` is stored in `detail` and read back per run. A restarted watcher
  repeats nothing, and two watchers cannot double-report. A journal read that
  FAILS is treated as "already said" for that tick — a gap is better than a
  flood.
- Rows are attributed `system`: a resident process, not the operator CLI and
  not a signed-in principal.
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
