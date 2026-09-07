# MCP surface roadmap — candidate features

> Historical proposal (2026-08-21), not the current MCP setup guide. The
> stdio-only boundary and 13-tool inventory below were superseded on 2026-09-05
> by one role-scoped HTTP `/mcp` surface. Operator run names now
> use `atoma_operator_run_*`; `atoma_run_*` drive organisation project runs.
> See the [current README](../README.md#drive-it-from-the-agent-you-already-use-mcp)
> and [decision record](mcp-one-surface-2026-09-05.md).
>
> **Closed 2026-09-07.** Every item below that was still open has been built,
> on the HTTP surface, as one commit (37 tools): `atoma_skills_show` (with the
> skill-id completion that waited for it), `atoma_ledger_tail`, `atoma_costs`,
> `atoma_registry_history`; the `waitMs` long-poll on both status tools, with
> `notifications/progress` for a host that sends a progress token; resources
> (`atoma://families`, `atoma://runs/{file}`, `atoma://operator-runs/{runId}`,
> `atoma://projects/{projectId}/runs/{runId}`) with `resources/subscribe` and
> a `resources/updated` notification when a run ends; `structuredContent` on
> every payload and `outputSchema` on the new readers; and the operator
> writes (`atoma_skill_reset|drop|merge`, `atoma_registry_rollback`), whose
> actor question the 2026-09-05 identity layer answered — a bearer token names
> a principal, and each write is journaled as `skill.*` / `registry.rolled_back`
> with that actor. Beyond this list, the same commit exposed what had appeared
> since the roadmap was written: `atoma_run_preview`, `atoma_notifications`,
> `atoma_verdicts_list`, `atoma_verdict_show`, `atoma_sentinel_health`.
> `atoma_doctor` was NOT built, on the caution recorded below: doctor probes
> Docker and the environment and is not a pure reader.
> The normative rules live in [src/mcp/AGENTS.md](../src/mcp/AGENTS.md).


Status: PROPOSAL, not scheduled, EXCEPT where an item is marked DELIVERED.
Recorded 2026-08-21 after a survey of the current 13-tool surface against the
CLI/viz capabilities and the unused parts of the MCP protocol. Nothing else
here is committed; each item goes through the contract in
[src/mcp/AGENTS.md](../src/mcp/AGENTS.md) when picked up.

Delivered so far, on 2026-08-22: recommendation 2, MCP prompts and argument
completions. What that item actually turned out to be — including one claim
below that the protocol does not support — is recorded in place.

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

### Prompts — DELIVERED 2026-08-22

Per-family goal guidance already exists (`families()` consumes
`TaskProfileGuidance`). Exposing it through `prompts/list` gives hosts
native goal templates without duplicating the source — a fourth consumer of
`TaskProfile`, for free. The existing ban still holds: guidance must never
teach a caller to name a builtin tool in a goal.

Shipped as `src/mcp/prompts.ts`: one `atoma_goal_<family>` template per entry
in `LAUNCHABLE_PROFILES`, plus `atoma_inspect_trace`, `atoma_inspect_agent`
and `atoma_review_skills` driving the readers. Prompt text quotes the profile
guidance and the exported caveat constants rather than restating either, and
`tests/mcp-prompts.test.ts` holds it to the tool-naming ban — with one recorded
exemption, `TRACE_ERROR_CAVEAT`, which names `edit_file` because that is the
reader whose error strings it warns about.

### Argument completions — DELIVERED 2026-08-22, with a correction

The protocol's `completions` capability, for trace filenames
(`run_trace.file`), molecule names (`registry_show.name`, `skills_*.l1`)
and skill ids. Notable host comfort for a small cost.

CORRECTION: the item as written above is not implementable. `completion/complete`
accepts `ref/prompt` and `ref/resource` and nothing else — there is **no
`ref/tool`** — so a tool argument cannot be completed at all. The completions
therefore hang off the prompts above, each one driving the reader whose
argument it completes, with sources in `readers.ts`: newest trace filenames,
agent-type names across all three tiers, and molecule display names for `l1`.

Two things the implementation had to get right, both now in the subsystem
contract. Every completable argument is REQUIRED, because the SDK enables the
capability behind an optional but its completion handler does not unwrap one —
an optional completable argument advertises completion and answers nothing. And
a source bounds its own SCAN rather than only the returned slice: trace names
are timestamps, so filtering after the 100-value cap answers "no such trace"
for every trace older than the newest page.

SKILL IDS ARE NOT DONE. There is no reader that shows one skill, so a
completed skill id would have nothing to open. That completion belongs with
`atoma_skills_show` in recommendation 1, not here.

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

Note after delivering the completions: `ref/resource` is the OTHER half of the
completion capability, so a resource template would let a host complete a trace
URI directly rather than through a prompt argument. That is a reason to
consider resources, not a reason to redo the prompt completions — the prompts
are what a host offers a human, and the two would coexist.

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
   near-free. Now also carries the skill-id completion that recommendation 2
   could not deliver without a reader to open.
2. ~~MCP prompts + argument completions~~ — DELIVERED 2026-08-22. Big
   host-ergonomics gain, pure reuse, no change to the 13-tool contract.
3. `atoma_costs` — the aggregate economics question nothing answers today.
4. Run progress (notifications or `waitMs`) — improves the polling
   contract.
5. Resources, `outputSchema`, operator writes — later; each deserves its
   own discussion.
