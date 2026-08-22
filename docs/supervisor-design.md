# Run supervision and the self-improvement loop — design

Status: **draft accepted in discussion, P0 in progress (2026-08-21)**. The
three-stage shape and the phasing were agreed with the operator on
2026-08-21; the [open decisions](#open-decisions) at the end are not settled
yet. As stages land, their normative rules move into the owning `AGENTS.md`
files; this document stays the reasoning behind them, like
[platform-events-design.md](platform-events-design.md).

## Problem

The deployment already runs a viz server, the MCP stdio control plane, web
push, and an offline friction report — but nothing watches runs with
judgment:

- **Live**: push notifies a human on terminal states; nobody reacts to a run
  that is burning budget on an unreachable check, looping on identical tool
  calls, or ingesting web content that carries prompt-injection payloads.
- **Post-mortem**: the burn-in sessions (e.g.
  [2026-08-21](incidents/burn-in-2026-08-21.md)) are manual Claude sessions:
  run → analyse traces → fix → measure on the next batch. The loop works —
  six defects closed in one day — but a human drives every step.
- **Self-improvement**: fixes reach later runs only when the operator
  rebuilds and restarts by hand. There is no controlled path from "run N
  surfaced a defect" to "run N+1 executes the fixed code".

Wanted: live event control, post-mortem analysis with a decision, a security
screen (prompt injection and friends), and a gated fix → redeploy loop
(green/blue) so later runs benefit from what earlier runs taught.

## Shape: three stages, three risk profiles

One resident process cannot do all three jobs, because "watch live",
"judge", and "modify the codebase" have incompatible cost and risk profiles:

| stage | what | runs | LLM | may write |
|---|---|---|---|---|
| 1. sentinel | mechanical live watch | always, beside viz/MCP | never | journal rows only (+ optional run cancel) |
| 2. analyst | post-mortem judgment | after a run ends, never beside one | Claude Code headless, read-only | verdict files only |
| 3. mender | fix + green/blue redeploy | on a `defect` verdict, gated | Claude Code in an isolated worktree | a branch, then a deploy slot |

### Why not a resident LLM watcher

A Claude agent polling events continuously during runs is the obvious shape
and the wrong one here:

- **Quota contention.** Runs execute over the same Claude subscription
  (`ATOMA_LLM=claude-cli`). Measured operational rule: never fan out
  subagents while a batch is running — a resident watcher would violate it
  permanently.
- **Attribution.** The journal design requires every actor and action to be
  attributable ([src/platform/AGENTS.md](../src/platform/AGENTS.md)). A
  free-running LLM making judgment calls off-journal is exactly what that
  design exists to prevent.
- **The watcher is the top injection surface.** Run output, trace text and
  skill bodies are model-authored; the MCP readers mark them UNTRUSTED
  in-band for precisely this reason. An LLM that reads them live *and* holds
  power is the most attractive target in the system. Stage 1 therefore holds
  (almost) no power and no LLM; stage 2 holds an LLM and no power beyond a
  verdict file; stage 3 holds write power and never reads raw trace prose.

## Stage 1 — the sentinel (P1, in-product)

A long-running `atoma sentinel` process beside `viz:serve` and the MCP
server:

- **Reads**, read-only: the `platform_events` journal, the MCP run lease
  (`~/.atoma/mcp-run-lock.db`), and the active run's trace through the same
  bounded-reader discipline the MCP tools use. No new HTTP port — the MCP
  control plane stays stdio-only — and never a parser on the runner's
  stdout, which is a burn-in API.
- **Applies a declarative rule table**, modelled on
  `src/atoms/resultGates.ts`: one table, one explicit disposition per rule,
  never an inline `if`. Initial rule families: cumulative cost vs budget,
  identical-call streaks (the batch-5 "seven calls on one unreachable check"
  pattern), smoke duration outliers, recurring tool errors, and lexical
  injection signatures in element results ("ignore previous instructions",
  suspicious base64 blobs, exfiltration-shaped URLs in fetched content) —
  element results are where untrusted content enters, so that is where the
  screen sits.
- **Emits** journal rows under new closed-vocabulary kinds (`run.anomaly`,
  `security.flagged`) — severity and audience are forced at compile time by
  the exhaustive maps — and rides the existing push routes. Like the
  operator CLI, it writes its rows from its own process.
- **Single power**: `atoma_run_cancel` as an optional kill switch, journaled.
  Never a modification. Consistent with the standing rule that heuristics
  flag and never judge alone.

Sentinel rules are themselves mechanisms: designing a new rule follows the
COOLING-OFF contract (collect incidents, design once, land reviewed), never
same-day reaction.

## Stage 2 — the analyst (P0 validates the format)

Triggered when a run reaches a terminal state — and during burn-in batches,
coalesced to batch end by a quiet period, because the machine belongs to the
batch:

- A **headless `claude -p` session** with read-only tools (`Read`, `Glob`,
  `Grep` — no Bash, no writes, no MCP servers), structured output enforced
  by `--json-schema`, a spend ceiling, and a wall-clock timeout.
- It reads a **mechanically pre-digested** view of the run (bounded,
  truncated, error-preserving) plus the raw trace on demand, and produces
  one **verdict** per run (schema below).
- **Hardening**: everything inside a trace is untrusted model/tool-authored
  text. The analyst quotes, never follows; an instruction-shaped payload in
  a trace is itself a `security_incident` finding. The stage-3 mender never
  receives raw trace prose — only the structured verdict and file:line
  pointers. This is "never replay model-authored commands" applied to the
  supervisor itself.
- **Cooling-off triage** is built into the classification: a `defect` is a
  net bug with a mechanism you can point at in `src/`; anything that wants a
  NEW gate, heuristic, validator rule or prompt rule is a
  `mechanism_candidate` and goes to a dated backlog — never implemented the
  same day, per the root contract.

### Verdict schema v0

```json
{
  "schema": "atoma.supervisor.verdict/v0",
  "runId": "2026-08-21T11-02-26-148-48faa963",
  "runStatus": "delivered | failed | cancelled | unknown",
  "verdict": "ok | defect | mechanism_candidate | security_incident",
  "summary": "one operator-facing paragraph",
  "findings": [
    {
      "kind": "defect | mechanism_candidate | security_incident | observation",
      "title": "short",
      "detail": "what happened, mechanism, impact",
      "evidence": [{ "ref": "path:line", "quote": "≤200 chars verbatim" }],
      "proposedFix": "defect only — where and what, not a patch",
      "confidence": "low | medium | high"
    }
  ]
}
```

The global `verdict` is the maximum severity across findings
(`security_incident > defect > mechanism_candidate > ok`; `observation`
never raises it). The harness recomputes this instead of trusting the model.

## Stage 3 — the mender and green/blue (P2/P3)

- On an approved `defect` verdict, the mender (Claude Code) works in an
  **isolated git worktree** — never in the checkout serving runs, which makes
  "never edit `src/` while a batch is running" true by construction.
- **Exit contract**, same as the manual burn-in loop: a regression test that
  fails before the fix, `npm run check` green, `release:check` when the
  release path is touched.
- **Human gate first**: the mender pushes a branch and a push notification;
  the operator approves the diff and owns the commit. Autonomy then widens
  the way the product's own trust does: N approved-without-retouch fixes on
  a defect class earn that class an auto-merge fast path. The system applies
  its own earned-trust philosophy to itself.
- **Green/blue, local form**: two compiled slots (`releases/a`, `releases/b`)
  and a `current` symlink; the compiled MCP server and `viz:serve` run from
  `current`. A switch: wait for the run lease to be free (one-run-at-a-time
  makes the swap safe by construction), build + `release:check` into the
  idle slot, swap the symlink, restart services, `release-smoke.mjs`,
  rollback = swap back. Every switch is journaled (`deploy.switched`).

## Quota sequencing (hard rule)

The sentinel costs zero tokens forever. The analyst and the mender spend the
shared subscription and therefore **never run while a run is active**: the
pipeline is strictly `run(s) → lease free + quiet → analyse → fix → check →
switch → next runs`. Long-lived supervisor processes must hold a sleep
inhibitor (`caffeinate`) because the machine sleeps on battery.

## Existing rules this design must keep true

- COOLING-OFF: mechanism candidates are backlog entries, never same-day
  implementations ([AGENTS.md](../AGENTS.md), safe working rules).
- Never edit `src/` during a batch → the mender's worktree + compiled slots.
- Verification is read-only; never replay model-authored commands → the
  analyst has no execution tools at all.
- Trace text is UNTRUSTED → quote-never-follow, structured verdicts, the
  mender never sees raw prose.
- No HTTP on the MCP control plane; the runner's stdout is a parsed API →
  the sentinel reads stores and trace files, not process streams.
- Runs are serialised by the lease → the deploy switch waits for it.
- Journal attribution → sentinel/mender actions become journal rows.
- `runs/`, `skills/` and stores are evidence → supervisor outputs live in
  their own `supervisor/` directory, git-ignored, and never mutate traces.

## Phasing

- **P0 (this commit)** — out-of-product validation of the analyst loop:
  `scripts/analyst-watch.mjs` (watcher: detects terminal runs from
  `runs/index.json`, checks the lease and live-run activity, digests the
  trace, drives `claude -p`, validates and routes the verdict) and
  `scripts/analyst-prompt.md` (the analysis prompt). Outputs under
  `supervisor/` (git-ignored): `verdicts/<runId>.json`,
  `backlog.jsonl` (mechanism candidates, dated), `ALERTS.jsonl`
  (security incidents). No product code is touched. What P0 must prove:
  the verdict format is right, the classification is calibrated on real
  runs, and the quota sequencing holds.
- **P1** — the in-product sentinel: rule table, new journal kinds, push.
- **P2** — the gated mender: worktree, branch, notification, approval.
- **P3** — green/blue slots, lease-gated switch, rollback, deploy journal.
- **P4** — measured autonomy widening for the mender.

## Open decisions

1. **Analyst trigger granularity** — per run, or per batch during burn-in?
   Proposed default: per run outside burn-in, batch-end during (the quiet
   period approximates this in P0).
2. **Mender initial autonomy** — proposal-only with operator approval
   (proposed default), or immediate auto-merge for trivial defect classes?
3. **Green/blue scope** — compiled path only (proposed default: it is the
   release contract), or also source-level `mcp:dev` launches?
4. **Sentinel kill switch** — active from P1, or journal-only first?
