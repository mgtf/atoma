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
- [`src/cli`](../cli/AGENTS.md) — `analyst` and `mender`, two of the hosts
- [`src/viz`](../viz/AGENTS.md) — the gated server that hosts the resident analyst
- [`src/projects`](../projects/AGENTS.md) — the tenant corpus the analyst reads

## Three risk profiles, one boundary between them

- The SENTINEL watches live and holds no LLM. The ANALYST holds an LLM and no
  power beyond a verdict file. The MENDER holds write power over a worktree
  and never reads raw trace prose. Nothing here collapses two of these into
  one process: a resident LLM watcher would be the top injection surface in
  the system holding power (design §"Why not a resident LLM watcher").
- ONE IDLE PREDICATE (`activity.ts`), checked before reserving the shared run slot. It is built from the repository's existing facts — the operator
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
- ONE SELECTOR PER STAGE (`session.ts`): `ATOMA_ANALYST_MODEL` and
  `ATOMA_MENDER_MODEL` hold a full `<api|sub>:<vendor>:<model>`
  ([src/contracts](../contracts/AGENTS.md) `modelSelector.ts`), the mender
  borrowing the analyst's WHOLE selector when it has none, and neither has a
  default. The selector names the session: `sub:anthropic` and `api:*` run
  Claude Code (login, or `ANTHROPIC_API_KEY` / `ZAI_API_KEY` scoped to the
  child), `sub:openai` runs Codex. A model id can no longer be paired with the
  other stage's endpoint, because there is no separate endpoint variable; the
  retired `_TRANSPORT` / `_BASE_URL` / `_AUTH_TOKEN` are refused by name. An
  alias resolves to another model next month and the recorded cost stops
  meaning what it said, so aliases are warned about. The credential is scoped
  to the child session's environment and never exported at platform launch,
  which would reroute the runs' own Claude transport.
- COST IS RECORDED FROM WHAT WAS SERVED (`modelUsage`), never from the
  requested id — the same lie `servedModel` prevents in the product's traces.
  A pin absent from what was served is warned about as "not comparable".
- CODEX IS EXPLICIT (`sub:openai:<model>`, likewise MENDER). It requires
  ChatGPT subscription auth and rejects API-key profiles: `api:openai` is
  refused at resolution. Each session gets a fresh auth-only
  profile under the shared Codex HOME lease; rotated credentials are copied
  back atomically after the process/container has been reaped, on errors too.
  Codex reports tokens and the model resolved by thread/start, but no price:
  cost stays null. USD ceilings are Claude-only; both retain wall-clock limits.

## Where each stage runs

- Production hosts the sentinel and resident read-only analyst inside the viz
  server (`ATOMA_VIZ_ANALYST=1`), and a SEPARATE `atoma-mender.service` over a
  dedicated clone. This shared-host arrangement was explicitly selected by the
  operator on 2026-09-06; it replaces the GitHub Actions mender.
- Verdicts and mend records persist under `ATOMA_SUPERVISOR_DIR`, outside
  releases. The mender resumes every unrecorded eligible finding after restart;
  busy findings stay pending, completed or failed attempts require an explicit
  retry. No dispatch credential or auth-secret rotation through GitHub is needed.
- Analyst and mender reserve the existing machine-global run lease, without
  stale recovery, throughout their work and cleanup. Product admission and
  deployment use that same slot. A new product run is refused while maintenance
  holds it; this is the explicit resource trade on the 4 GB production host.
- The mender model and checks stay in disposable Docker containers: 2 GiB RAM,
  no additional swap, one CPU, 512 MiB tmpfs, one Vitest worker. Host Codex is
  text-only and holds a dedicated ChatGPT profile; the harness alone holds the
  GitHub publisher token. Never give containers product state or credentials.
- Chromium and its libraries live in the mender image, with Puppeteer downloads
  disabled. Each fresh command can run browser tests without an install cache.
  Synthetic read-only passwd/group files describe only the executing UID/GID;
  Node gets a 1536 MiB heap within the existing 2 GiB container limit.
- `deploy/install-mender.sh` installs from a verified deployed revision, preserves
  an existing clone and configuration, and removes retired dispatch settings.
  The developer CLI remains available with the same idle reservation.

## The analyst

- TWO CORPORA, like the sentinel: the operator index through the bounded
  reader, and every ENDED project run through `ProjectStore.listFinishedRunTraces`
  (`ended_at` is the transactional fact). A project verdict's row carries
  `orgId`/`projectId` as ATTRIBUTION, never as audience. The tenant reader is
  attached only where the store already holds project tables.
- READ-ONLY BY CONSTRUCTION: `--tools Read,Glob,Grep`, `--strict-mcp-config`,
  no session persistence, a spend ceiling, a wall clock. Verification is
  read-only and never replays model-authored commands — applied to the
  supervisor itself. The argument shape is the one measured 2026-08-22
  against the real CLI; change it only with a new measurement.
- Every trace string is UNTRUSTED. The prompt says so, the appended system
  prompt says so again, and an instruction-shaped payload in a trace is itself
  a `security_incident` finding.
- Codex uses an ephemeral app-server thread with one private dynamic reader
  (`codexReader.ts`): an exact allowlist of source/docs and this run's evidence,
  bounded lines and literal searches, no model-authored commands. Built-in
  execution, Apps, plugins, hooks, skills, delegation and MCP are disabled;
  residual file tools see only an empty read-only jail. This is not a second
  atoma MCP surface. The same verdict schema derives Codex's nullable optionals.
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

- THE POWER SPLIT IS BETWEEN THE MODEL AND THE HARNESS.
  Executable proposals (model, install, tests and checks) run through
  `menderIsolation.ts` in disposable Linux Docker containers. Build
  `docker/mender.Dockerfile` as `atoma-mender:local` first. Only the worktree
  and sanitized read-only git metadata are mounted; no host HOME, GitHub
  credential or engine socket crosses. Configure an explicit provider token;
  host login files are intentionally unavailable. Container removal precedes
  publication, including after a timeout. Tool allowlists alone are not isolation. The model edits files
  inside an isolated worktree cut at the tip of the base branch and may run
  the repository's own checks there (`--restricted`, `--permission-mode
  dontAsk`, `MENDER_ALLOWED_TOOLS`: `npm`/`npx` verification and read-only
  `git`; no MCP, no network tools). It never runs `git commit`, `git push` or
  `gh`. The harness does, AFTER its own verification. The model's report is
  recorded, never trusted.
- Codex's app-server is text-only, with the same empty jail and disabled
  built-ins as the analyst. Its private worktree_command dynamic tool sends
  model-authored commands to the existing Docker executor, with networking
  disabled and no inference credentials. Docker's default security profiles
  remain intact. Each command is bounded to 120 seconds and the remaining
  session clock; queued commands are cancelled when the session ends and
  active containers are reaped before releasing the worktree or auth lease.
  The auth-only temporary Codex HOME stays outside every command container.
  The dedicated local ChatGPT profile owns its refresh lifecycle. The host publisher token needs Contents and Pull requests write only; no Secrets permission. Never share the analyst profile or renew this profile elsewhere.
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
- The shared host holds the run lease through cleanup. It never recovers a stale lease to make background work proceed; an occupied slot defers the finding.
- The idle gate is a decision, not an inference. `--no-idle-gate` is a flag
  an operator explicitly passes on a dedicated machine, never a default derived from `CI=true`: an
  environment variable that silently disabled a safety gate on a developer's
  machine would be the exact silence the run-host contract exists to end.
- The legacy optional dispatch API remains available for external integrations; the production deployment does not configure it and ships no Mender Actions workflow.
- Prompts are TypeScript constants (`analystPrompt.ts`, `menderPrompt.ts`),
  not Markdown assets: `tsc` ships nothing but `.js`, and a prompt the
  compiled CLI cannot find is a release-path failure typecheck never sees.
