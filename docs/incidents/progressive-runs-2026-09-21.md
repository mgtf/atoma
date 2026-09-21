# Progressive project runs under `mgtf2` — 2026-09-21

Status: evidence collected; one claimed defect WITHDRAWN as a misreading of
the product model, two confirmed, and — by the operator's same-day decision
against the collected backlog set — two changes landed (see "Acted on" at the
end). Everything else stays observation.

Continues the campaign recorded in
[the second-account production run](mgf2-production-run-2026-09-21.md). That
note closed with two delivered scenarios; this one adds two runs of rising
demand and reads what the supervisor stages did with them.

The connection is the production MCP on `https://atoma.run/mcp`, resolving to
`mgtf2` — organisation owner, **not** platform admin. That role boundary is
itself load-bearing for the third section below.

## The three runs

Project `828f429a-7a5f-465e-a628-1c73580e025c`, family `build`. Demand rising,
and each run chosen to exercise a verification shape the previous one did not.

| run | shape demanded | outcome | wall | cost USD | LLM calls | escalations |
|---|---|---|---:|---:|---:|---:|
| `a34e4d7e-e887-44ea-8d61-fb2cf974b2bf` | CLI: argv, four exit codes, quote-aware CSV | delivered | 790.978 s | 1.1619 | 17 | 0 |
| `cc894dad-26b3-40b5-800f-21ddc2c8c7e9` | HTTP service: file persistence, atomic write, ETag / `If-Match` | failed | 1805.429 s | 2.8273 | 25 | 0 |
| `d3098d25-1c46-4fd6-9848-3c9216a7f339` | link shortener: server + CLI client + page, three artefacts at once | failed | 1805.610 s | 3.5046 | 28 | 1 |

Campaign cost 7.4938 USD, of which 6.3319 USD bought nothing.

The agent pairs differ per run and are worth recording: `a34e4d7e` ran
Sclereid/L2 over Ammonia/L1, `cc894dad` Sclereid/L2 over Methane/L1 then
Ammonia/L1, `d3098d25` Idioblast/L2 over CarbonDioxide/L1. Meristem/L3 is the
tissue throughout.

`d3098d25` is the only run of the three to exercise all three probe shapes —
`fetch_url` against the server, `run_shell` invoking the CLI, `validate_html`
loading the page in a headless browser — which is the behaviour the `build`
family documents and it worked as described.

All three were started without MCP task augmentation and all three exceeded
the client's 300-second wait; the server carried each to completion and each
was observed through the status and trace readers. No duplicate start was
submitted — the idempotency keys are
`claude-progressive-2026-09-21-a-csv-cli`,
`claude-progressive-2026-09-21-b-notes-etag` and
`claude-progressive-2026-09-21-c-shortener`.

## Withdrawn: "the shared build workspace is not cleared between project runs"

A first draft of this note read the manifest accumulation below as a defect —
files crossing runs by `sha256` identity, monotone 2 → 3 → 6 paths:

| run | published paths | `README.md` | `server.mjs` | `index.html` |
|---|---|---|---|---|
| `b5e873f8` bookmarks API | 2 | `6ed651e3…` | `daeb59f3…` | — |
| `fd557ba9` task list | 3 | `6ed651e3…` | `daeb59f3…` | `2ed9dd4d…` |
| `a34e4d7e` CSV CLI | 6 | `01f391c2…` | `daeb59f3…` | `2ed9dd4d…` |

The reading was WRONG, and the code says so plainly: the coordinator seeds
each project run from the previous DELIVERED run of the same organisation and
project (`previousDeliveredRun` → `--seed`, with `cleanWorkspace: true` on a
per-run workspace path), and its own comment states the contract — "the
workspace is the seed of the next". A project is one evolving corpus feeding
one repository; the accumulation IS the product. The seed is scoped to
(orgId, projectId), so nothing crosses tenants, and the analyst's verdicts —
which a draft of this note faulted for not flagging the accumulation — were
silent about it because there was nothing to flag.

What survives of the observation is small and real: run-created test fixtures
(`empty.csv`, 0 bytes; `quoted.csv`, 67 bytes) ship to the customer repository
as deliverables, and a molecule opening a seeded workspace pays for the
inherited files in context (`cc894dad`'s first tool call is `list_files`).
Untidiness worth a later look at what a manifest counts as a deliverable — not
a defect, and nothing here was acted on.

## Defect — the run deadline discards every completed phase

Reproduced twice, identically. `cc894dad` ran 1805.429 s and `d3098d25` ran
1805.610 s: the same 1800 s wall clock, not two coincidences. In both, the
deadline aborts the LLM call in flight, the abort surfaces as an `llm` event
carrying `error: "The operation was aborted due to timeout"`, both parent
branches close, and the run is recorded `failed` with no manifest and no
publication.

`cc894dad`'s trace (144 events) ends:

| event | actor | fact |
|---|---|---|
| `registry` `recordSuccess` | Sclereid/L2 → Methane/L1 | phase 3 credited |
| `skill` `learn` | Sclereid/L2 | recipe written |
| `trust` | Meristem/L3 | trust threshold crossed |
| `registry` `recordSuccess` | Meristem/L3 → Sclereid/L2 | phase 3 closed |
| `branch` `start` | Meristem/L3 | phase 4 opens |
| `skill` `match`, `inject` | Sclereid/L2 | recipe handed to Ammonia/L1 |
| `llm` `plan`, `validate-plan` | Ammonia/L1, Sclereid/L2 | plan approved |
| `llm` `execute` | Ammonia/L1 | `error: "The operation was aborted due to timeout"` |
| `branch` `end` ×2 | Sclereid/L2, Meristem/L3 | run over |

Three phases had completed and been credited. The fourth phase was mid-flight
when the deadline arrived, and everything was discarded: no partial manifest,
no publication. 2.8273 USD recorded, zero bytes delivered. `d3098d25` ends on
the same two events (`llm` `execute` with the same error string, then
`branch` `end` ×2) after 3.5046 USD.

The defect is not the deadline, which is a legitimate bound. It is that
reaching it throws away phases that were finished, validated and credited
minutes earlier. A run that completed three of four phases delivers exactly
as much as a run that completed none.

Two asymmetries follow, and both are worth a designed answer rather than a
reflex:

- The registry credited Methane, Sclereid and a trust crossing on Meristem
  during a run whose recorded outcome is `failed`. Trust was earned by work
  that was never delivered.
- `learnedEventSkills: 1` — the run still wrote a recipe on the way out.

## Defect — escalation exists and did not engage

`cc894dad` records `escalations: 0`. Of its 25 calls, 24 went to
`own:openai:gpt-5.6-terra`; the single `own:openai:gpt-5.6-sol` call is the
opening tier-3 plan. Between them the run absorbed at least one rejected
`validate-result` (a `validate-result` at `t+1151 s` followed by a fresh
`context` and `plan` for the same molecule, with no intervening
`recordSuccess`), four `start_node_server` restarts and roughly fifteen
`fetch_url` probes, all on the cheap pin.

The mechanism is not missing: `d3098d25` records `escalations: 1` under a
comparable rejection pattern, so something does fire. The finding is narrower
and therefore sharper — whatever triggers escalation did not trigger once in
the thirty minutes `cc894dad` spent being rejected on the cheap pin, and the
one escalation `d3098d25` did make was not enough to change its outcome.
Both runs are 27–28 calls with exactly one `sol` call, the opening tier-3
plan.

For contrast, `a34e4d7e` delivered the same day on the same pins with 17
calls.

## What the sentinel saw, and why

Applying the rule table in [`src/sentinel/rules.ts`](../../src/sentinel/rules.ts)
to these traces by hand:

- `identical-tool-streak` (≥ 4 consecutive identical calls) — the `fetch_url`
  probes of `cc894dad` address different routes, so the key differs on every
  call. This is the blind spot already measured in
  [the sentinel's blind spot](sentinel-blind-spot-2026-08-23.md): every content
  rule keys on IDENTITY, and a model that keeps VARYING a failing attempt is
  invisible. These runs are a second, independent instance of it.
- `recurring-tool-error` (≥ 3 of one `(tool, error)` pair) — **fired**, and the
  hand-application above the host read had called it silent. The journal holds
  `fetch_url failed 3× with the same error` on `cc894dad` (seq 136, 00:56:58)
  and `fetch_url failed 4×` on `d3098d25` (seq 142, 08:50:48). The failures
  live in `result.ok === false`, which `atoma_run_trace` omits with the rest of
  the payloads — so the tenant-facing trace reader cannot show what the
  sentinel keys on, and an org reader hand-applying the rules will systematically
  under-count this rule. The narrower llm-blindness point still stands: the
  fatal `llm` abort itself produced no row, because no rule reads `llm` events
  except `cost-alert`.
- `slow-tool-outlier` — did NOT fire on any of the three runs: no row in the
  journal. The inter-event gaps that looked like candidates were not tool
  durations.
- `cost-alert` — no row at 2.8273 or 3.5046 USD; the host either configures no
  threshold or one above that. Either way it is an operator alert, not a
  budget; nothing refuses to spend.

Both kinds the sentinel can emit, `run.anomaly` and `security.flagged`, are
`null` in `PUSH_ROUTES`. What it found on these runs was journalled and reached
nobody — confirmed live: the org owner account received no push for any of the
rows above.

## What the supervisor actually did — settled from the host

A first draft of this section, written from the MCP vantage point alone, could
not distinguish "the analyst did not run" from "it ran and raised nothing
eligible". A host read (as `mgf` over SSH, then three `sudo` reads by the
operator: the `platform_events` journal, the verdicts directory listing, the
mender's systemd journal) settled it the same day, and it settled it AGAINST
the draft's leading suspicion. The pipeline ran end to end, promptly, on every
run:

| run | ended | verdict written | latency | grade, worst finding |
|---|---|---|---|---|
| `1dba127d` failed | 23:17:57 | 23:21:10 | 3 m 13 s | deficient, `mechanism_candidate` |
| `b5e873f8` delivered | 23:26:19 | 23:41:37 | 15 m | sound, none |
| `fd557ba9` delivered | 23:40:24 | 23:43:40 | 3 m | sound, none |
| `a34e4d7e` delivered | 00:45:25 | 00:48:40 | 3 m | **deficient**, `mechanism_candidate` |
| `cc894dad` failed | 01:21:32 | 01:24:52 | 3 m 20 s | deficient, `mechanism_candidate` |
| `d3098d25` failed | 09:11:06 | 09:14:41 | 3 m 35 s | deficient, `mechanism_candidate` |

The resident analyst is armed (`ATOMA_VIZ_ANALYST=1`,
`ATOMA_ANALYST_MODEL=sub:openai:gpt-5.6-sol`) and the verdict files exist under
`/home/atoma/state/supervisor/verdicts/`, 7–12 KB each. Note `a34e4d7e`:
delivered AND graded deficient — the grade and the delivery are independent
judgements, as designed.

**Why the mender has still never opened a PR — by policy, not by fault.** Its
banner states its floor: `confidence ≥ high, defects only`. Every worst finding
above is `mechanism_candidate`, which routes to the backlog and is deliberately
never mender-eligible ("a mender that took candidates would be a same-day gate
with a commit button"). The service has been watching the verdicts directory on
a 30 s poll continuously across the whole campaign, saw all six verdicts, and
correctly did nothing; it has never journalled a single `mender.*` row. The
production analyst has yet to issue a `defect` at or above `high` — THAT is the
open question the first-real-mend item reduces to, and it is a question about
the analyst's grading, not about the mender's plumbing.

What remains true from the org owner's chair: **all of this was invisible.**
`supervisor.verdict` pushes to nobody, the journal is platform-tier, and six
verdicts plus three sentinel findings happened without one observable signal on
the account that paid for the runs. The draft's wrong suspicion is itself the
measurement: an organisation owner watching every surface it has cannot tell a
working supervisor from an absent one.

## The verdict bodies

The operator then read the verdict files and the backlog. Three additions and
one subtraction follow.

**The analyst located run C's root cause, and it reads like code.** Verdict
`d3098d25`: the worker repeatedly started the service on an OS-assigned port
and validated it there (`"url":"http://localhost:40207/"`), while independent
result validation probed bare `http://localhost/`, got
`ERR_CONNECTION_REFUSED`, rejected the standing evidence and relaunched
near-duplicate executions until the deadline. An independent probe that
substitutes an unported default URL for the bound one is not model variance —
yet the finding is `mechanism_candidate`, `fixDirection: null`.

**The analyst confirmed run B's shape.** Verdict `cc894dad`: three sequential
branches (implement, comprehensive re-audit, README); the re-audit repeated the
implementation's verification (~$2.51, ~1573 s across three Methane
executions); the README worker "timed out before making any tool call"; digest
records `run aborted after 1800s budget`. Its second finding is an
`observation` crediting the machinery: the run was "recorded as failed rather
than falsely delivered".

**The eligibility gap is the KIND, not the floor.** Both of today's failed-run
findings carry `confidence: high` — they clear the mender's floor and are
refused on kind alone. The backlog now holds 17 entries since 2026-09-06,
every one a `mechanism_candidate`, zero `defect` ever emitted, even where the
finding names an unported URL substitution or (2026-09-12, `39f2fbfd`) a trust
fast-path converting an explicitly incomplete result into a delivery. Whether
the analyst's `defect` bar is calibrated right is now THE question the
first-real-mend item reduces to.

**The subtraction is this note's own.** A draft faulted the analyst for not
flagging the manifest accumulation; the accumulation turned out to be the
project-continuity contract (see the withdrawn section above), and the
analyst's silence was correct. What its `a34e4d7e` verdict flags instead — the
delivered CLI printing a non-numeric column the goal excluded — is a real
quality miss the run's own validation accepted.

The backlog's own dominant theme, for whoever designs next against it: at
least eight of its seventeen entries describe recovery or validation
discarding standing proof and replaying broad execution — the same family the
[verification-replay contract of 2026-09-15](verification-replay-2026-09-15.md)
closed one instance of.

## Acted on — the operator's same-day decision, 2026-09-21

The operator directed implementation the same day, against the collected set
(this note plus the seventeen backlog entries since 2026-09-06), not against a
single run. Two changes landed, both regression-tested
(`tests/unserved-loopback-probe.test.ts`):

- **Portless loopback probes are refused pre-flight.** `fetch_url` and
  `validate_html` refuse a loopback URL with no port
  (`unservedLoopbackProbeRefusal`, prefix `PROBE_URL_REFUSAL_PREFIX`,
  `isPreflightRefusal` widened over both prefixes), naming the origins the
  `servedOrigins` registry holds; a refused connection on an explicit
  unregistered loopback port gets those origins appended to its error, and
  `fetch_url` now surfaces the cause code behind Node's bare "fetch failed".
  This is run `d3098d25`'s exact mechanism made a request-shape error instead
  of a fake dead service — and it turns that finding into what the analyst's
  own classification calls a `defect`: a mechanism at a file:line, fixed with
  a regression test.
- **Standing proof at plan grain.** `STANDING_PROOF_PLANNING_GUIDANCE` in both
  planners: verification lives inside the phase that builds, recorded probes
  stay valid until a mutation invalidates them, and a phase whose only purpose
  is re-auditing recorded evidence is a plan defect. The within-phase half of
  the same rule is the 2026-09-15 validation ledger; this is the
  between-phases half, cut against the backlog family (eight of seventeen
  entries are recovery or validation discarding standing proof).

## Still open, deliberately

- Deadline behaviour is UNCHANGED: delivering unaccepted work at the watchdog
  would fake a delivery, which the analyst's own observation credits the
  system for not doing. The lever landed is what the plan spends the deadline
  on, not what gets shipped when it fires.
- The analyst's `defect` bar and the mender's reachability: 17/17 backlog
  entries are `mechanism_candidate`, several at `high` confidence, so the
  mender has never had an eligible finding. Whether that bar is right is a
  calibration question for its own review, not a same-day prompt edit.
- The org owner's blindness: six verdicts and three sentinel findings on
  their runs, zero observable signals on their account, and a tenant trace
  reader that omits `result.ok === false` so the tenant cannot re-derive the
  sentinel's findings. Audience changes are `PUSH_ROUTES` decisions with their
  own review.
- Sentinel `llm`-event blindness: both failed runs died at an `llm` event no
  rule reads. A new row is a new mechanism — cooling-off applies.
- Trust and skill credit surviving a run that delivered nothing; and what a
  manifest counts as a deliverable (run-created test fixtures ship today).
