# MCP surface roadmap — candidate features

Status: PROPOSAL, not scheduled. Recorded 2026-08-21 after a survey of the
current 13-tool surface against the CLI/viz capabilities and the unused parts
of the MCP protocol. Nothing here is committed; each item goes through the
contract in [src/mcp/AGENTS.md](../src/mcp/AGENTS.md) when picked up.

## Constraints that frame every item

- The exported 13-tool surface is a **compatibility contract**: every
  addition requires protocol tests, docs, compiled smoke updates, and an
  explicit rationale.
- Stdio is the safety boundary — no HTTP transport, ever.
- Readers stay pure: `{ readonly: true, fileMustExist: true }` handles, an
  absent store is an answer, every payload is bounded, and model-authored
  text carries its UNTRUSTED caveat in-band.
- Reuse, never re-derive: new readers compose helpers that already exist
  and are already tested.

## 1. Missing readers (low risk, high coherence)

Ordered by recommended priority.

### `atoma_skills_show`

The most glaring gap. `atoma_skills_review` renders a mechanical pre-screen
verdict that explicitly requires a human to then read the skill body — but no
MCP tool can read one. The CLI already has `skills show <molecule> <id>`.
A bounded reader (truncated at `MAX_TEXT_CHARS`, UNTRUSTED caveat — a skill
body is model-authored text) closes the review → read loop without leaving
the host.

### `atoma_ledger_tail`

`atoma_ledger_check` can report "impossible" drift, but the host has no way
to look at the newest ledger entries to investigate it. The CLI has
`ledger tail 20`; `readLedger` already exists.

### `atoma_costs` (aggregate economics)

`atoma_runs_list` returns per-run totals, but nothing aggregates cost and
LLM calls per model/tier over a window of traces. "Is the cost curve going
down?" is the natural host question, and today it must recompute from N
payloads itself.

### `atoma_registry_history`

Partially covered by `registry_show`'s `versions` field — low priority.
Only worth adding if a host wants history without the excerpted prompts.

### `atoma_doctor` — with caution

Tempting, but doctor probes Docker and the environment; it is not a pure
reader in the sense of the other ten. If added, expose only a strictly
local, side-effect-free subset, annotated accordingly. The quota-free rule
in [src/cli/AGENTS.md](../src/cli/AGENTS.md) applies unchanged.

## 2. Unused MCP protocol capabilities (no new tools)

### Prompts

Per-family goal guidance already exists (`families()` consumes
`TaskProfileGuidance`). Exposing it through `prompts/list` gives hosts
native goal templates without duplicating the source — a fourth consumer of
`TaskProfile`, for free. The existing ban still holds: guidance must never
teach a caller to name a builtin tool in a goal.

### Argument completions

The protocol's `completions` capability, for trace filenames
(`run_trace.file`), molecule names (`registry_show.name`, `skills_*.l1`)
and skill ids. Notable host comfort for a small cost.

### Run progress

Today's contract is "call `atoma_run_start`, then poll `atoma_run_status`".
Two options, from heavier to lighter:

- MCP `notifications/progress` pushing the run's progress (the lines
  `progress.tail` already accumulates) as they arrive.
- A bounded `waitMs` long-poll parameter on `atoma_run_status`, reducing
  polling churn without touching the notification model.

### Structured tool results (`outputSchema`)

Every reader currently returns `JSON.stringify` in a text block. Recent SDK
versions support `structuredContent` plus a declared output schema; hosts
get typed, validated results. Pure modernisation, backwards compatible.

### Resources

Expose traces and families as MCP resources (`atoma://runs/<file>`), with a
"resource updated" subscription firing when a run finishes. More ambitious;
payload bounding must follow the same rules as the readers. Priority below
prompts/completions.

## 3. Operator writes — a contract decision, not an increment

`skills reset/drop/merge` and `registry rollback` over MCP would change the
character of the surface: today only `run_start`/`run_cancel` mutate, and
the skills contract requires every operator lifecycle action to be
**attributable**. Adding these means deciding who the "actor" is when the
action comes from an MCP host, and journaling accordingly (the
`platform_events` journal is built for this, but it is gated-deployments
only). Feasible, but only with a real need and its own design pass.

## Recommended order

1. `atoma_skills_show` + `atoma_ledger_tail` — close existing loops,
   near-free.
2. MCP prompts + argument completions — big host-ergonomics gain, pure
   reuse.
3. `atoma_costs` — the aggregate economics question nothing answers today.
4. Run progress (notifications or `waitMs`) — improves the polling
   contract.
5. Resources, `outputSchema`, operator writes — later; each deserves its
   own discussion.
