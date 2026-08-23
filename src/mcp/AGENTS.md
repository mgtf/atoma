# MCP — AGENTS.md

`src/mcp/` owns the stdio control plane: the 13-tool surface, the prompt and
completion surface, the run lease, run serialisation and the bounded readers.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
The `atoma_*` tools are host control APIs, not L1 elements.

Neighbours:

- [`src/run`](../run/AGENTS.md) — the launcher it spawns
- [`src/registry`](../registry/AGENTS.md) — what the registry readers read
- [`src/skills`](../skills/AGENTS.md) — what the skill readers read

## Contract

- Stdio is the safety boundary. Do not add an HTTP port to the MCP control plane.
- Stdout is JSON-RPC only and must be claimed before importing modules that may
  log. Diagnostics go to stderr.
- `spawnRun` is the sole sanctioned run launcher. Keep compiled/source paths and
  flag ordering aligned; the goal is always the last argument.
- Resolve the repository root once before touching relative store, skill, run,
  or workspace paths.
- Runs are serialized by both in-memory state and the SQLite lease. A second
  start is refused; stale lease recovery must validate PIDs/PGIDs safely.
- Cancellation is a state, not successful completion. Signal the whole validated
  child group, bound termination, and retain trace/status evidence.
- `finishRun` must free the in-memory slot in `finally` even if lease deletion
  fails. Failed cleanup is stderr-only and recoverable as a stale row.
- Hard server backstops bound driver promises that never settle. Partial status
  remains observable rather than becoming a false success.
- MCP readers carry mechanical-review caveats in-band; they do not claim semantic
  approval.
- MCP payloads are BOUNDED and honest about trust: `atoma_run_trace` pages its
  events (`offset`/`limit`, capped) and truncates error strings; `goal` has a
  hard length cap; run output/skill bodies/trace text are marked UNTRUSTED
  model data (INSTRUCTIONS + `caveat` on runStatus and runTrace). Stale-lease
  recovery is VISIBLE: startRun reports what it reaped (`recovered`), and
  runStatus with no in-memory match reports the cross-process lease row
  instead of amnesia.
- The exported 13-tool surface is a compatibility contract. Add/remove tools only
  with protocol tests, docs, compiled smoke updates, and explicit rationale.
- The PROMPT surface is separate from that contract and adds no tool: one goal
  template per launchable family plus one prompt per reader group. Prompt text
  QUOTES its source — `TaskProfileGuidance` for the guidance, the exported
  caveat constants for the caveats — and never restates it, and the guidance
  ban applies to it: a prompt must not teach a caller to name a builtin element
  in a goal. The one exemption is a quoted caveat that names the tool whose
  output it warns about.
- Argument completions hang off PROMPTS because the protocol has `ref/prompt`
  and `ref/resource` and no `ref/tool`. Every completable argument is REQUIRED:
  the SDK enables the capability behind an optional but its completion handler
  does not unwrap one, so an optional completable argument advertises
  completion and returns nothing. Completion sources live in `readers.ts` under
  the reader rules, and bound their own SCAN, not just the returned slice — a
  filter applied after the cap answers "no such trace" for anything older than
  the newest page.

## Intentional choices and rejected shortcuts

- The MCP lease `ALTER TABLE` loop is corruption repair, not version
  migration. The lock DB lives in `~/.atoma/` outside the product store, and
  the burn-in pgid guard already documents it as writable by the run itself;
  without the loop a foreign-shaped table makes every `atoma_run_start` throw
  a raw SQLite error until a human deletes the file.
