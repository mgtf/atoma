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
| 1. sentinel | mechanical live watch | always, INSIDE the gated viz server (or the CLI) | never | journal rows only (+ optional run cancel) |
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

LANDED 2026-08-23, with one correction to this design: the watch is not a
process beside the server, it is a resident tick INSIDE it. `npm run viz`,
`viz:dev` and `viz:serve` are all the same file, and `viz:serve` is one
process, so a sibling would have armed the development launcher and left the
release contract with nothing. `npm run sentinel` remains a first-class host
for what a server cannot cover, and at most one appending watch holds a store
(`src/sentinel/lease.ts`). What the stage does, unchanged:

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
  the exhaustive maps. It does NOT ride the push routes: both kinds are null
  audiences. `run.anomaly` never had one, and `security.flagged` shipped with
  a platform-admin audience that never fired once, because the journal
  notifies only subscribers in its own process and the only watch was a
  separate CLI. Hosting the watch in the server would have turned that route
  on silently, so it was disarmed until the injection screen has a measured
  noise floor. Re-arming is one line and one measurement.
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

### Verdict schema v1

v0 carried a single global `verdict` and the calibration broke it: two runs
came back `ok` from the model while carrying a `mechanism_candidate`, and
both readings were right about different questions. v1 splits them.

```json
{
  "schema": "atoma.supervisor.verdict/v1",
  "runId": "2026-08-21T11-02-26-148-48faa963",
  "runStatus": "delivered | failed | cancelled | unknown",
  "runAssessment": {
    "grade": "sound | wasteful | deficient",
    "summary": "one operator-facing paragraph about THIS run"
  },
  "findings": [
    {
      "kind": "defect | mechanism_candidate | security_incident | observation",
      "title": "short",
      "detail": "what happened, mechanism, impact",
      "evidence": [{ "ref": "path:line", "quote": "≤200 chars verbatim" }],
      "proposedFix": {
        "where": "file or subsystem",
        "what": "a direction, not a patch",
        "checkedIntentionalChoices": "which AGENTS.md was read, and why this is not a recorded rejected shortcut"
      },
      "confidence": "low | medium | high"
    }
  ]
}
```

`runAssessment` answers "how did this run go"; `findings` answer "what should
change"; routing (backlog, alerts) reads findings only, and the harness
derives a worst-finding kind for logs instead of asking the model for a
global verdict. `proposedFix.checkedIntentionalChoices` is enforced because
asking the analyst to read intentional-choices was measurably not enough.

### Haiku A/B protocol (pre-registered 2026-08-22)

Three re-analyses under a pinned `claude-haiku-4-5-20251001`, schema v1,
against the recorded baselines (`*.baseline-*.json`): the failed
web-countdown run `…48faa963`, and two delivered runs `…811b766e`
(web-counter) and `…cf5ec323` (http-healthz). Criteria, fixed before the
runs: (1) on the failed run, it reaches the validator-escalation mechanism
or an equivalent root cause, not just the surface timeout; (2) and (3) on
each delivered run, it reaches the phase-redundancy finding; (4) zero
`security_incident` false positives; (5) grades do not inflate (`sound` or
`wasteful` for the delivered pair). 4/5 or better → Haiku is viable for
delivered-run sampling, with failed runs staying on Sonnet 5. Costs are
read from `_meta.modelsServed`, never from the requested id.

**Operator decision, 2026-08-22 (supersedes the Sonnet-5 default below):**
the analyst runs on **GLM-5.3** through the operator's own subscription. The
provider is injected at platform launch through three scoped variables —
`ATOMA_ANALYST_MODEL=glm-5.3`,
`ATOMA_ANALYST_BASE_URL=<anthropic-compatible endpoint>` (Z.ai coding plan:
`https://api.z.ai/api/anthropic`), `ATOMA_ANALYST_AUTH_TOKEN=<key>` —
forwarded by the watcher to its child `claude` session only. The scoping is
deliberate: raw `ANTHROPIC_*` exported at platform launch would reroute the
runs' claude-cli transport too. A separate subscription also dissolves the
quota-contention rationale for out-of-band sequencing (the machine-dedication
rule during burn-in batches stands). GLM-5.3 must pass the same five
pre-registered criteria above before the decision is confirmed by
measurement; when the override is absent, Sonnet 5 remains the fallback
default.

**Result, measured 2026-08-22: 5/5 — GLM-5.3 is confirmed as the analyst.**
(1) PASS: on the failed web-countdown run it reconstructed the three RESULT
validator rejections and their escalating evidence demands, rather than
stopping at the surface timeout. (2) and (3) PASS: it independently measured
the redundant later phase on web-counter (~54% of run spend) and http-healthz
(~30%). (4) PASS: zero `security_incident` false positives. (5) PASS: the
delivered pair were both graded `wasteful`; the failed run was `deficient`.
All three verdicts conformed to schema v1, requested and served `glm-5.3`
(plus the CLI's small auxiliary Haiku calls), and are archived as
`*.baseline-glm-5-3.json` under the ignored supervisor evidence directory.
The CLI-reported equivalent analysis cost was $0.6995 + $0.4122 + $0.3280 =
$1.4396 over 52 turns and 797s, against $1.3322 for the three runs examined
(108%). The separate subscription removes quota contention, not the economics:
failed/cancelled runs remain automatic, while delivered runs remain batch-end
or sampled. The exact committed measurement rows are
[`incidents/supervisor-glm-calibration-2026-08-22.csv`](incidents/supervisor-glm-calibration-2026-08-22.csv).

**Result, measured 2026-08-22: 2/5 — Haiku is not viable, for any run
class.** (1) FAIL: on the failed run it stopped at the surface (smoke-test
design, classList vs computed style) and never reached the validator
escalation that three Sonnet-generation analyses found; its one proposedFix
also cited the WRONG intentional-choices file (`src/atoms/AGENTS.md` "does
not record rejected shortcuts on smoke-test design" — the recorded rejection
lives in `src/tools/AGENTS.md`), proving the citation field enforces
presence, not diligence. (2) and (3) FAIL: both delivered runs came back
`sound` with zero actionable findings — the phase redundancy that two
Sonnet-generation models found independently (54% and 31% of run cost) is
invisible to it; the http-healthz summary even celebrates port 53260, the
redundant phase-2 server. (4) PASS: zero security false positives. (5) PASS
on the letter (no grade inflation) while under-grading in substance:
web-counter with ~54% avoidable spend deserved `wasteful`. Cost: $0.14–0.20
per analysis (~4× cheaper than pinned Sonnet 5) — irrelevant, since it
misses the systemic findings the analyst exists to produce. Decision at that
measurement point: **both failed and delivered runs stayed on pinned Sonnet 5;
the economics were managed by the trigger (batch-end / sampling), not by the
model.** The later operator-owned GLM-5.3 measurement above supersedes that
transport choice without changing the trigger. The v1
plumbing itself held: 3/3 schema-conformant, `modelsServed` recorded the
real usage, grades split cleanly from findings.

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

## P0 results, measured 2026-08-22

Seven analyses: the 2026-08-21 web-countdown failure, then a calibration
sweep over the six delivered runs of that day's batch 6 (the default six
tasks, third pass, 6/6 delivered). Every number below is reproducible from
`supervisor/verdicts/`.

**Cost — this is the finding that settles decision 1.** The six analyses cost
$1.90 equivalent against $1.68 for the six runs they examined: **113% of the
work's own cost**, at 4–7 turns and ~2 minutes each. Analysing every delivered
run costs more than producing it, so per-run analysis is indefensible as a
default: failed and cancelled runs always, delivered runs at batch end or by
sampling.

That 113% UNDERSTATES the intended configuration, and the correction matters
more than the original number. Those six analyses ran under the `sonnet`
alias, which resolved to `claude-sonnet-4-6` — while the runs being judged
were served by `claude-opus-5`, `claude-sonnet-5` and `claude-haiku-4-5`. The
analyst was reading Opus-5 work from a previous-generation model, nobody chose
that, and the stored metadata recorded the alias rather than what was served,
so the measurement did not show it. Re-running the CHEAPEST case
(`http-healthz`, 58 events) under an explicit `claude-sonnet-5` pin cost
**$0.7354 against a run that cost $0.1648 — 446%**, versus $0.2846 under the
alias: 2.6× for the same analysis, faster (83s) and with more turns (7). One
data point is not a new headline ratio, but the direction is not in doubt, and
it promotes the cheaper-model question from a nice-to-have to the next
measurement worth paying for.

The fix is landed: the default is a pinned `claude-sonnet-5`, an alias warns
BEFORE spending, `_meta.modelsServed` records the real per-model usage in the
same shape as a run's `totals.perModel`, and a pin that does not appear in
what was served warns that the verdict is not comparable. Recording the alias
was the same lie `servedModel` exists to prevent in the product's own traces —
naming one model while pricing another.

**The convergent finding survived a model change.** The pinned re-run reached
the phase-redundancy finding independently ("L3 phase split caused a full
redundant rebuild+reboot+re-probe"), from a different model than the two runs
that first produced it. Three instances across two model generations is
stronger evidence than three instances from one.

**Signal quality — better than the raw split suggests.** Three verdicts came
back `ok` and three `mechanism_candidate`, but the candidates are not
independent noise: two are the SAME finding reached from two different runs,
and a third run carries it as an observation. L3 chose a PHASED sequential
decomposition whose second phase re-verified what the first had already
proven — on `web-counter` phase 2 spent $0.180 of the run's $0.359 and 11
`validate_html` iterations re-proving a delivered artefact; on `http-healthz`
phase 2 re-booted the server on a new port and re-ran the same three probes,
with the molecule's own plan text saying "the previousStepSummary shows
pinger.js was already built and verified with all routes working. However, I
need to follow the current task". That is a plan-shape question for
[src/atoms](../src/atoms/AGENTS.md), it is not covered by any existing rule,
and three dated instances is exactly what COOLING-OFF asks for before
designing anything.

**One real calibration defect.** The third candidate (`web-stopwatch`,
async smokes not observing `setInterval` updates) re-proposes moving smoke
guidance into the prompt — the exact shortcut
[src/tools/AGENTS.md](../src/tools/AGENTS.md) records as already tried and
rejected, with the measurement showing the rule was violated six times
despite already sitting in the parameter description. The prompt asks the
analyst to read the subsystem's intentional-choices section; asking is not
enough. Fix for v1: make the check a required field — a proposed remedy must
cite the subsystem file it checked, or it is not a proposal.

**One false positive**, filed as an observation: `record_probe` writing
`.atoma-probes.json` during a re-verification phase was read as a read-only
violation, when writing the manifest from machine-observed results is what
that element is for.

**One catch worth the whole exercise**, in a run that PASSED: `http-kv`
never probed the wrong-method case its own task contract required. A
delivered verdict is a claim, and the analyst tested the claim.

**Zero security alerts across seven runs**, and 7/7 verdicts conformed to the
schema with no raw-output fallbacks.

**A schema flaw the sweep exposed.** Two runs came back `ok` from the model
while carrying a `mechanism_candidate` finding, and the harness's recompute
promoted the global verdict. Both readings are right about different
questions: the run went fine AND there is something systemic worth fixing.
v1 must split them — `runAssessment` (how did this run go) separate from
`findings` (what should change), with routing driven by findings only. The
conflated global verdict is the wrong shape.

## Open decisions

1. ~~**Analyst trigger granularity**~~ — SETTLED by the P0 measurement above:
   analysis costs 113% of the run it examines, so failed and cancelled runs
   are analysed always, delivered runs at batch end or by sampling. What
   remains open is the sampling rate only: Haiku misses the systemic findings,
   while the operator-owned GLM-5.3 pin passed the same protocol 5/5. GLM-5.3
   is the configured analyst; pinned Sonnet 5 is only the no-override fallback,
   and the economics remain managed by the trigger.
2. **Mender initial autonomy** — proposal-only with operator approval
   (proposed default), or immediate auto-merge for trivial defect classes?
3. **Green/blue scope** — compiled path only (proposed default: it is the
   release contract), or also source-level `mcp:dev` launches?
4. **Sentinel kill switch** — active from P1, or journal-only first?
