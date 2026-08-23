# Projects — AGENTS.md

`src/projects/` owns organisation-scoped projects: the run corpus they hold,
their artifact manifests, and publication.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/auth`](../auth/AGENTS.md) — the identities projects belong to
- [`src/github`](../github/AGENTS.md) — where publication lands
- [`src/platform`](../platform/AGENTS.md) — the journal this domain emits into

## Scoping and storage

- Projects, GitHub App installations and publications are organisation-scoped;
  a run belongs to exactly one project and a project to exactly one
  organisation. Gated `/api/runs` lists that org's project traces from
  `orgs/<orgId>/projects/<projectId>/runs/<runId>/` (override the host root
  with `ATOMA_PROJECTS_ROOT`, default `~/.atoma`). It does not mix the
  operator `./runs` corpus used by CLI, MCP and ungated viz.

## The subscription-transport door

- A project run normally requires `ATOMA_LLM=anthropic` plus exactly one
  per-run credential. A machine-bound transport (`claude-cli`, and its bare
  `claude` alias) binds to the HOST's own login session, so it spends that
  subscription and cannot honour a supplied credential — for a tenant that
  would be one account billing another.
- The ONE exception is a requester holding the platform-admin flag, whose own
  instance's subscription it is. The flag is the right authority because it is
  never derived from an OAuth claim: only `auth grant-admin`, run by the
  operator against the store on disk, can mint it.
- `platformAdmins` is passed to the coordinator as a QUESTION, never as an
  answer: the coordinator asks it, so no route and no CLI can hand in a
  pre-decided yes. It is FAIL-CLOSED — absent resolver, `false`, or a throwing
  resolver all mean refusal. This is deliberately the opposite of
  `tierModelsFor`, which is fail-open: a preferences lookup must not block a
  run, an authority lookup must never be read as permission to spend.
- A run that goes through the door forwards NO credential (the transport
  cannot use one, and a stale exported key only confuses provider
  precedence), normalises `ATOMA_LLM` to `claude-cli`, and does not relax
  isolation: `ATOMA_CONTAINER` and `ATOMA_REQUIRE_ISOLATION` stay on.
- Every such run is journaled as `run.host_subscription` (severity
  `security`, never pushed). The coordinator emits no audit row itself — it
  calls `onSubscriptionTransport` and the caller journals, so there is one
  delivery path, as with `onRunFinished`.
- The door does NOT change the lifecycle settings a project run pins. Those
  are stated once, under "What a tenant run may learn" below.

## Readers outside this subsystem

- `listLiveRunTraces()` is the ONE read that exposes which project runs are
  executing, and it exists for the sentinel
  ([src/sentinel](../sentinel/AGENTS.md)). It has to: each project run writes
  into its own `runs/<runId>/traces` directory, so there is no shared index to
  poll and `status = 'running'` is the only fact. Cross-org by construction,
  like `listAllRunTraces`, because its caller is platform-wide.
- Such a reader must not WRITE here. A `running` row that outlived its process
  is repaired by `reconcileInterrupted` at the next boot, never by the
  observer that noticed it. `hasProjectTables` exists so a reader can ask
  whether this store has a control plane without `ProjectStore.open`'s DDL
  creating one.

## Repository visibility

- It is chosen ONCE, at project creation, and it is IRREVERSIBLE: no update
  schema, no `UPDATE projects` touching the column, no PATCH route, and the
  HTTP transport has no PATCH method. Flipping it at GitHub instead breaks the
  project permanently — `ensureRepository` refuses a repository whose
  visibility disagrees with the row ("never a convergence") and
  `REPOSITORY_TRANSITIONS.ready` is empty, so the row can never be reconciled.
  The create form says so; anything that offers to change it later is lying.
- `DEFAULT_REPOSITORY_VISIBILITY` in [src/contracts](../contracts/projects.ts)
  is the ONE definition, read by the schema default and by the create form, and
  it is `private`. The reasons are recorded beside it, including the one that
  decides it: nothing in this pipeline reviews what gets published — the file
  set is model-declared at plan time, the filter is filenames only, publication
  is automatic on delivery, and the manifest never crosses the API — so a
  public default hands an unreviewed set to the internet whenever nobody looks.
- The repository is created at PUBLICATION, not at project creation, so a
  project sits at `repository_status = 'pending'` until its first delivered
  run. Everything about the target is therefore validated late: create-project
  checks only that the installation row is active and belongs to the viewer's
  organisation.
- A failed repository creation is recorded ON THE PROJECT ROW (`failed` plus
  `repository_error`), not only on the publication. It used to stay `creating`
  with a NULL error, indistinguishable from a publish in flight sitting above a
  green delivered run. `failed → creating` is allowed, so it stays retryable.
- Every transition here is a compare-and-set, so the publisher reads the
  repository status FRESH from the store rather than from the caller's
  `Project` snapshot — a retry's snapshot is as old as the attempt that failed.
- A `ready` repository is not re-derived: its receipt on the row IS its
  identity. Calling GitHub again would fail the terminal `ready` CAS, which is
  what made a retry-after-failed-commit impossible.
- HTTP 422 from repository creation is NOT proof the name is taken — an
  account can also refuse to create a repository of that visibility, and
  `GitHubApiError` carries no body to tell them apart. Say what is known.

## What a tenant run may learn

- SKILL LEARNING IS ON (`ATOMA_SKILL_LEARN=1`, `ATOMA_EVENT_SKILLS=1`). It is
  the point of the platform: a tenant's runs get cheaper as their project
  grows. It was off, and two delivered runs measured the cost of that —
  $0.59 spent, `learnedSkills: 0`, nothing carried forward.
- What makes it safe is PARTITIONING, not restraint: `ATOMA_SKILLS_DIR` points
  at `<projectRoot>/skills`, so what a run learns belongs to that project
  alone. Nothing reaches another project, let alone another organisation. The
  cross-tenant question is a separate design with a human gate
  ([offer review](../../docs/platform-skill-offer-review-2026-08-23.md)).
- PROMOTION and DETERMINISTIC DISPATCH stay off, and explicitly: a project run
  is `--seed`ed from the previous delivered workspace, and a seeded workspace
  is the maintenance-mode signal that enables promotion BY DEFAULT. Silence
  would therefore promote tenant scripts to trusted executables as a side
  effect of seeding. `--no-promote-skills` and `--no-direct-skills` also
  travel as FLAGS, because those are the final word over both the environment
  and the seed ([src/skills](../skills/AGENTS.md)).
- The PREFILTER CACHE stays off for a different reason, and the difference
  matters: it is the one lifecycle store that is not partitioned per project.
  It lives in the shared product store, so one tenant's cached planning
  decisions would be readable to the next. Partitioning it is its own change.
- A measurement that depends on PROMOTION or deterministic dispatch therefore
  still cannot be run as a project run. Learning, now, can.
- A FAILED run records what it cost. The outcome vocabulary is
  `delivered | failed | error | cancelled`, and the failure path used to
  enumerate two of the three non-delivered values, so the ordinary
  `outcome: 'failed'` had its stats dropped — measured on a real tenant run:
  $1.10 over 41 calls, persisted as `stats_json = NULL`. `delivered` is the
  only outcome that cannot ride a failure; the store refuses the remaining
  contradictions itself.

## Delivery, and the evidence it is decided from

- DELIVERY IS DECIDED FROM SIX DEPTH-1 TRACE MEMBERS, never from the whole
  document. `verifiedTrace` reads `id`, `endedAt`, `cancelled` and `degraded` as
  values and `result`/`error` as shapes, through
  [`readTraceTopLevelFields`](../contracts/AGENTS.md). Its three refusal
  messages are unchanged; what changed is that a trace is no longer refused for
  being large. Delivered run `2857a579` wrote 781_071 bytes, passed every
  semantic check, and was recorded `failed` by a 524_288-byte cap — which also
  made the NEXT run of that project seed from an older workspace, silently
  skipping the work, because `previousDeliveredWorkspace` reads only rows whose
  status is `delivered`.
- `MAX_CONTROL_JSON_BYTES` now governs `declared-artifacts.json` ALONE, and the
  difference between the two files is the whole point: a declared manifest is
  small by contract and its CONTENT is model-chosen, so a size bound plus a
  whole-document parse fits it; a trace is a control-plane-owned path whose
  SIZE grows with the work. Bounding them the same way is what caused the
  erasure. Do not reunify them.
- A trace-refused delivery still records NO cost: `finish()` keys its stats
  exclusion on the PARSED outcome (`stats.outcome !== 'delivered'`), so a run
  the runner called delivered and the trace refused persists
  `stats_json = NULL` — `2857a579` lost $0.8421 and one learned skill that way.
  Recorded, not fixed: a `failed` row may not carry `delivered` stats, so the
  repair is a store-contract decision
  ([register](../../docs/decided-not-built-2026-08-23.md)).
