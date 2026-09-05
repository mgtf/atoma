# Supervisor — AGENTS.md

`src/supervisor/` owns the two supervisor stages that spend model quota: the
ANALYST (post-mortem verdicts on finished runs) and the MENDER (a cited
defect verdict becomes a pull request on `main`). Stages 2 and 3 of
[`docs/supervisor-design.md`](../../docs/supervisor-design.md); stage 1, the
sentinel, is its own subsystem because it holds no LLM and no power.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/contracts`](../contracts/AGENTS.md) — the verdict and mend schemas, and the JSON Schema derived from them
- [`src/platform`](../platform/AGENTS.md) — the journal every stage action lands in
- [`src/sentinel`](../sentinel/AGENTS.md) — the bounded trace reader this reuses, and the stage that never spends
- [`src/mcp`](../mcp/AGENTS.md) — the run lease the idle predicate peeks at
- [`src/cli`](../cli/AGENTS.md) — `analyst` and `mender`, the two hosts

## Three risk profiles, one boundary between them

- The SENTINEL watches live and holds no LLM. The ANALYST holds an LLM and no
  power beyond a verdict file. The MENDER holds write power over a worktree
  and never reads raw trace prose. Nothing here collapses two of these into
  one process: a resident LLM watcher would be the top injection surface in
  the system holding power (design §"Why not a resident LLM watcher").
- ONE IDLE PREDICATE (`activity.ts`), asserted before every session and every
  heavy phase. It is built from the repository's existing facts — the operator
  index through the sentinel's bounded reader, liveness through
  `isIndexEntryLive`, the MCP lease through `peekRunLease` — and never from a
  parser on the runner's stdout. A torn index read counts as ACTIVE. Two
  stages with two predicates is how one of them ends up spending beside a
  batch.
- ONE SCHEMA PER SHAPE, in `src/contracts`: `supervisorVerdict.ts`,
  `supervisorMend.ts`. The JSON Schema a headless session is held to is
  DERIVED from the zod schema by `contracts/jsonSchema.ts`, which throws on
  any zod node it cannot express — so a contract that outgrows the converter
  fails the suite rather than shipping a schema the model was never held to.
  Never hand-write the JSON twin.
- PROVIDERS ARE READ AS SETS (`session.ts`): the three `ATOMA_ANALYST_*`
  variables together, the three `ATOMA_MENDER_*` together, the analyst set as
  the mender's fallback, and a PINNED default id. A model id paired with the
  other stage's base URL would send a Claude id to a GLM endpoint; an alias
  resolves to another model next month and the recorded cost stops meaning
  what it said. The override is scoped to the child session's environment and
  never exported at platform launch, which would reroute the runs' own
  claude-cli transport.
- COST IS RECORDED FROM WHAT WAS SERVED (`modelUsage`), never from the
  requested id — the same lie `servedModel` prevents in the product's traces.
  A pin absent from what was served is warned about as "not comparable".

## The analyst

- READ-ONLY BY CONSTRUCTION: `--tools Read,Glob,Grep`, `--strict-mcp-config`,
  no session persistence, a spend ceiling, a wall clock. Verification is
  read-only and never replays model-authored commands — applied to the
  supervisor itself. The argument shape is the one measured 2026-08-22
  against the real CLI; change it only with a new measurement.
- Every trace string is UNTRUSTED. The prompt says so, the appended system
  prompt says so again, and an instruction-shaped payload in a trace is itself
  a `security_incident` finding.
- A run with no `endedAt` is refused, never analysed: the digest of a live
  trace is a partial view and the session would spend beside the run.
- Routing reads FINDINGS, never the grade: `mechanism_candidate` → the dated
  backlog (`supervisor/backlog.jsonl`, COOLING-OFF: never same-day),
  `security_incident` → `supervisor/ALERTS.jsonl` plus a console warning,
  `defect` → left in the verdict for the mender. `runAssessment` is about this
  run alone; a `sound` run may carry a candidate.
- An invalid verdict is kept raw beside the verdicts and journals NOTHING: a
  row about a verdict that does not exist would be a fact about nothing.
- TRIGGER ECONOMICS are settled by measurement (design, P0 results): analysis
  costs about the run it examines, so failed and cancelled runs always, and
  delivered runs at batch end or by sampling. The quiet period is what
  coalesces a burn-in batch to its end.

## The mender

- THE POWER SPLIT IS BETWEEN THE MODEL AND THE HARNESS. The model edits files
  inside an isolated worktree cut at the tip of the base branch and may run
  the repository's own checks there (`--restricted`, `--permission-mode
  dontAsk`, `MENDER_ALLOWED_TOOLS`: `npm`/`npx` verification and read-only
  `git`; no MCP, no network tools). It never runs `git commit`, `git push` or
  `gh`. The harness does, AFTER its own verification. The model's report is
  recorded, never trusted.
- THE EXIT CONTRACT IS THE MANUAL BURN-IN LOOP'S, proven mechanically: the
  source change is stashed (untracked files included), the new test files run
  and must FAIL, the stash is restored, the full check runs and must PASS.
  A test that passes on the unfixed code means the mechanism is not
  established and the attempt is `refused`.
- WHAT MAY BE MENDED (`menderPolicy.ts#eligibleFindings`): a `defect` at or
  above the confidence floor (`high` by default) whose `proposedFix` cites the
  intentional choices it checked. A `mechanism_candidate` is never eligible
  and there is deliberately NO option to make it one — a mender that took
  candidates would be a same-day gate with a commit button.
- WHAT MAY BE SHIPPED (`checkDiffPolicy`): an allowlist — `src/`, `tests/`,
  `docs/incidents/` — at least one test file, at least one source file, at
  most `DEFAULT_MAX_DIFF_LINES` changed lines. Workflows, deploy scripts,
  hooks, dependencies and this subsystem's own code are a person's decision.
  Anything else is `refused`, nothing is pushed, and the worktree is KEPT for
  inspection.
- TRACE TEXT NEVER REACHES THE MODEL. `sanitiseFinding` keeps evidence quotes
  only for refs into the repository source and replaces every other quote
  with `WITHHELD_QUOTE`; the worktree has no `runs/` and no `supervisor/` to
  open. The PR body is built from the same sanitised view.
- ONE DEFECT, ONE PR. `defectKey` is a normalised hash of where and title and
  rides the commit and the PR body as `Defect-Key:`; a key with an open PR or
  a local `pr-opened` record is `skipped-duplicate`. An approximation,
  documented as one; calibrate it on real verdicts before trusting it.
- The pull request IS the human gate and the existing `main` → CI → deploy
  path IS the redeploy. There is no auto-merge in the code; widening waits
  for a measured count of mends merged without retouch (design, P4).
- EVERY ATTEMPT ENDS IN ONE `MendRecordOutcome`, recorded under
  `supervisor/mender/`, appended to `mender.jsonl`, and journaled for every
  outcome that touched the deployment. The lock (`supervisor/mender.lock`)
  keeps mends serial on one machine; a dead holder is reclaimed.

## The journal

- Kinds: `supervisor.verdict`, `mender.started`, `mender.declined`,
  `mender.refused`, `mender.pr_opened`, `mender.failed` — severities and push
  audiences forced by the exhaustive maps. Only `pr_opened` and `failed` reach
  a person (platform admins): one is a review waiting, the other a worktree
  left behind. `skipped-duplicate` and `dry-run` write no row: nothing
  happened to the deployment.
- Rows are `system`, like the sentinel's, and carry FACTS ONLY (`journal.ts`):
  grade, finding kinds, defect key, branch, PR URL, cost, model served. Never
  a finding's title, a verdict's summary or a mend report's text — those are
  model prose over untrusted material and stay in the git-ignored
  `supervisor/` records, where a reader opens them knowing what they are.
- Both CLIs journal only into a store that ALREADY EXISTS. `PlatformEventLog.open`
  applies DDL, and a supervisor must not bring a control plane into being by
  writing to it. An ungated checkout keeps its file outputs and journals
  nothing, and says so in its banner.

## Intentional choices

- Out of product first, in product now. The analyst was validated as a script
  (P0, 2026-08-22) to settle the verdict format before touching `src/`; the
  mender landed the same way on 2026-09-05 and was moved here the same day,
  because a stage with write power needs the contracts, the journal and the
  typed tests the scripts could not have. Do not re-create a `.mjs` stage.
- `.mjs` command seams, not shell shims. `ATOMA_MENDER_CMD_*` and
  `ATOMA_SUPERVISOR_CMD_CLAUDE` accept a `.mjs` first token that runs under
  the current Node, so the pipeline tests substitute `claude`, `gh` and `npm`
  on every platform; `npm`/`npx` get a shell on Windows because they are
  `.cmd` shims, and nothing else ever does.
- The idle gate is asserted at phase boundaries, not held. Holding the MCP run
  lease during a mend (as `deploy:preflight --hold` does) would refuse product
  runs for a background improver; the trade is documented as open work in the
  design document, with the data to revisit it.
- Prompts are TypeScript constants (`analystPrompt.ts`, `menderPrompt.ts`),
  not Markdown assets: `tsc` ships nothing but `.js`, and a prompt the
  compiled CLI cannot find is a release-path failure typecheck never sees.
