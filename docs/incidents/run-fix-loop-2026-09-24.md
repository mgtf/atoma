# Run → fix → run, on the local corpus — 2026-09-24

Status: evidence collected in one evening session; nothing designed. The
findings below are recorded for the backlog under the COOLING-OFF contract
(root `AGENTS.md`), except the one code defect fixed the same morning and
cited here only because a verdict independently confirmed it.

Code under test: `main` at `820025b` (host `dist/` rebuilt at 23:18 local so
the runs after the first carried it), worker image `atoma-worker:latest` of
2026-09-12. All runs are PROJECT runs from the CLI (`projects:dev run`), on
the platform admin's account pins `sub:anthropic:{haiku,sonnet,opus}`, budget
3600 s, `--container`.

## Why this session

The store held 20 project runs, the newest from 2026-09-10, and ONE analyst
verdict, dated 2026-08-22. Everything landed in the two weeks between —
analyst, mender, sentinel trajectories, deadline landing, root acceptance —
consumes run evidence, and none had been pointed at the corpus. The root
`AGENTS.md` rule "close every real error from the prior batch at its source
before the next live batch" made the analyst pass the prerequisite, not an
option.

## Analyst pass over the old corpus

`api:zai:glm-5.3`, 16 verdicts written (15 today), **$10.16**, then a Z.ai
`429 Usage limit reached for 5 hour` at 20:09Z stopped the batch with six
runs unanalysed — including `7ec691c8` (mdn-theme-fork, "declared artifact
does not exist: scripts/theme.js"), the last failure without an explanation.
The one-event `$0` preview fixture `54d3decf` spent 35 turns and $0.41 before
the limit hit it: a run with zero LLM calls is not a post-mortem subject.

Findings: **0 defect, 7 mechanism_candidate, 20 observation.** Three runs of
the 2026-09-07 browser-phase incident graded `deficient` with the analyst's
own note that every mechanism is already remediated in tree.

The verdict on `f260d120` (the failed MDN greeting run) was checked line by
line against the code before being believed, and every citation held:
`fonts.googleapis.com` at `src/contracts/webResources.ts:3`, `ok` as the AND
of `allErrors`, `realFailedRequests` and `smokeOk` at
`src/tools/builtin.ts:2013`, the `internal-validation-failed` gate in
`disposition: 'reject'` at `src/atoms/resultGates.ts:390`. Its two `failure`
records on `dialog-to-inline-form` were the gate rejecting Water results
whose smoke checks all passed, because the seeded page's font link could not
load without egress. `skills forgive Ammonia dialog-to-inline-form
--failures 2` retracted them, audited as `skill-counter-compensation`.

One observation on `04595ae2` — "every trajectory row reads credited:false
despite two approval-fired skill successes" — is the donor-match identity
defect fixed that morning (`820025b`), confirmed independently.

## The runs

| run | project | shape | outcome | wall | cost | LLM calls | escalations |
|---|---|---|---|---:|---:|---:|---:|
| `d7b6b9b5` | mdn-greeting-fork | the EXACT goal of failed `f260d120` | delivered | 2 m 25 s | $0.25 | 7 (haiku) | 0 |
| `584e3fdc` | kanban-progression | full-stack Kanban, twice cancelled on 09-08 | delivered | 3 m 26 s | $0.38 | 7 (haiku) | 0 |
| `0e89e0ce` | mdn-theme-fork | the EXACT goal of failed `7ec691c8`, on the repaired seed | delivered | 3 m 43 s | $0.34 | 10 (1 sonnet) | 0 |
| `d677d824` | expenses-node-api | ETag / `If-Match` / atomic write — the 2026-09-21 production failure shape, as a progression on the seeded corpus (goal authored for this session) | delivered, one root remediation | 7 m 34 s | $1.12 | 23 (2 sonnet) | 0 |

Against the 2026-09-10 arm of the first row: $2.86, 91 calls (1 opus,
7 sonnet, 83 haiku), 4 escalations, six Water executions rejected on
`ok:false`, budget abort at 1787 s discarding two accepted phases. Same goal,
same page, same font link. This is the first measured, same-goal evidence
that the 2026-09-21 → 24 changes (deadline landing, 60-minute budget, the
font host, short-first depth) do what they claim.

"Seven calls" is the number of calls, not the amount of work: run 2's single
`execute` call carried 36 tool calls — 6 `write_file`, `start_node_server`,
15 `fetch_url` recorded in `.atoma-probes.json` (200/201/400/404/204),
12 `validate_html` with interactions and smoke — then plan validation, result
validation at L2 and root acceptance on `basis: validation-call`. Seven real
files on disk. Run 3 matched and credited `fix-mobile-overflow-preserve-content`
on Water (owner = executor, so no executor field: the morning's contract holds),
and distilled `recover-plan-uses-undeclared-tool` after the existing gate refused
a plan naming a tool the child does not hold.

Every root acceptance carried `floorCoverage: []` and `obligations: []`: the
build profile has no universal floor and no run declared a proof obligation.
That is the analyst's 2026-09-07 candidate ("the declared dom-interaction
obligation never reaches the L1 executor") seen from the other side —
nothing declares one, so nothing can be uncovered.

## Run 4: the root refused once, for a reason the seed had planted

`server.js` carries `generateETag`, a `tmp` + `rename` write, 428 without
`If-Match`, 412 on mismatch; the transport recorded `PUT` → 428, 412, 200,
404, 400, the 412 after an intervening change, and `data/expenses.json`
persisted. Root acceptance attempt 1 REFUSED: "`.atoma-probes.json`
malformed: entries #11–#14 (shell invocations) lack numeric `exitCode`".
Read, those entries are prose — `"cmd":"curl …","exitCode":null,"note":"Would
verify…"`, `"cmd":"Code Review - app.js","result":"PASS"` — and they were not
written tonight. They are in the SEED workspace, run `ef70c2b8` of
2026-08-23, whose own verdict this evening reads "fallback executor
fabricated probe-manifest ground truth via `write_file`" — written before
`write_file`/`edit_file` refused manifest edits. The seed copies the whole
workspace (`src/run/runner.ts:804`, `cpSync(seedRoot, workspaceRoot,
{recursive: true})`), so every later run of this project inherits six
fabricated entries with no run identity and no timestamp, and presents them
as its own ground truth. The downstream code did what its contract says —
`validateProbeManifest` flagged them, a malformed manifest forces review and
never rejects alone — and the review refused once and approved once with the
same six entries present: the L2 pass in between refused for a different
reason (a numeric loopback port copied into the README, recovered and
distilled as `recover-hardcoded-runtime-port-in-docs`).

The contract that is broken sits upstream: validators are told to read
observations as "historical observations from the same attempt and branch"
([src/atoms](../../src/atoms/AGENTS.md)); a manifest inherited from another
run is not from this attempt, and nothing marks it. The smallest restoration
is to exclude `.atoma-probes.json` from the seed copy — it is run evidence,
not corpus, and the run's own tools rebuild it — with a regression test that
seeds a workspace carrying a manifest and asserts the child run starts with
none. NOT applied tonight: the incident surfaced in this session, and the
root contract says design once, later, against the collected set.

Also inherited from that seed and shipped as deliverables: `wrapper-server.js`,
`test-setup.js`, `start.sh`, `sw.js`, `mock-api-expenses.json`, `package.json`,
`VALIDATION.md` — the 2026-09-21 observation about run-created fixtures, now
compounding across four runs of one project.

## Every publication failed, and none of it is code

- `POST /repos/mgtf/atoma-mdn-greeting-fork/git/blobs → 403` (runs 1 and 3).
  Reproduced with the installation token, read-only:
  `repository_selection: selected`, `total_count: 1`, the one repository
  being `mgtf/atoma` itself; both forks answer
  `403 Resource not accessible by integration` with
  `x-accepted-github-permissions: contents=write`, and `permissions.push:
  false` as the App. The local `github_installations` row for `158307021`
  still says `all`, written before the selection was narrowed; without a
  reachable webhook the row never moves — documented in
  [src/github](../../src/github/AGENTS.md) as the intended shape.
- `POST /app/installations/155229027/access_tokens → 404` (run 2). Seven of
  the nine projects are bound to an installation that no longer exists on
  GitHub; the App was reinstalled as `158307021`. No path in the product
  rebinds a project to a new installation.
- The client drops response bodies by contract ("never includes
  authorization headers or response bodies"), so the journal carries a bare
  `HTTP 403`. The diagnosis above needed a hand-written probe.

## Recorded for the backlog — not designed here

1. A read-only publication PRE-FLIGHT: `GET /repos/{owner}/{repo}` with the
   installation token, refusing with "the App installation no longer
   includes this repository" (and the settings URL) when `permissions.push`
   is false, before the first write. Turns a bare 403 into a sentence a
   tenant can act on. Design question: whether the pre-flight's own failure
   modes (rate limit, transient) may block a publication that would have
   succeeded.
2. Reconciling `github_installations` on the first `403`/`404` of this
   family, or on `connect`, so a narrowed or replaced installation is
   visible in the product instead of only in GitHub's UI.
3. Rebinding a project to the organisation's current installation when its
   recorded one answers 404 — seven projects here have no way forward.
4. The analyst skipping runs with zero LLM calls (fixtures, demo seeds).
5. (defect-shaped, see run 4) Exclude `.atoma-probes.json` from the seed copy, or stamp entries with the run that observed them and have readers ignore the rest.
6. The Z.ai 5-hour ceiling bounds an analyst batch at roughly fifteen runs
   (~$10); `--backfill` should probably be sized to it, or the batch should
   stop on the first 429 instead of burning one `claude` spawn per remaining
   target (six spawns, six 429s in seven seconds).

## Operator actions still owed

- Reopen the App's access to `atoma-mdn-greeting-fork` and
  `atoma-mdn-theme-fork` (GitHub → Settings → Applications → atoma →
  Repository access), then `projects publish --run` for `d7b6b9b5` and
  `0e89e0ce`; the manifests are re-verified byte for byte.
- Decide what a project bound to `155229027` should do.
- Re-run `analyst --once --backfill 6` after the Z.ai reset for the six
  unanalysed runs, then `--run` for the three new deliveries.
