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
  per-run credential: the host's `ANTHROPIC_API_KEY`, or the organisation's
  OWN anthropic provider key. A BYO-only deployment carrying no platform key
  at all is therefore a supported shape, and an org key WINS over a host one.
- `ANTHROPIC_AUTH_TOKEN` is REFUSED here, not ignored. No tenant can supply
  one (the org key store is keyed by catalogue provider, and anthropic's
  credential variable is `ANTHROPIC_API_KEY`), and a bearer is refreshed from
  a login profile the run child cannot read — a frozen env snapshot would
  expire mid-run. Operator LOCAL runs keep it, where the SDK reads the live
  profile ([src/run](../run/AGENTS.md)).
- An `ollama:*` pin is honoured only where the HOST declared its endpoint:
  `OLLAMA_BASE_URL` is forwarded on every branch (self-hosted selects no
  payer), and without it the pin falls through like a keyless provider —
  presuming localhost is exactly what detonates. The endpoint is the
  operator's infrastructure: an org picks ollama models, never an ollama
  destination (a tenant URL would be SSRF from the platform's own process).
- A BYO key is forwarded WITHOUT the host's `ANTHROPIC_BASE_URL`. That
  variable points the anthropic transport at a gateway, and a tenant's key
  belongs to its own issuer — the host's gateway applies to the host's own
  credential only. Z.ai is reached through `ZAI_API_KEY`/`ZAI_BASE_URL`
  instead, which is also what lets one run split tiers across both
  providers. A machine-bound transport (`claude-cli`, and its bare
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
- NO credential includes the ORGANISATION's own keys. A subscription run
  spends the host subscription and nothing else: injected, an org key would
  let a tier pinned to `anthropic:*`/`zai:*` bill the organisation while the
  journal records `run.host_subscription`, and the audit row would name the
  wrong payer. The keys are withheld before tier resolution, not only at
  injection, so the pins they would have unlocked are dropped with them
  rather than reaching the router without a credential.
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
- ONE PROJECT PER REPOSITORY, per organisation, and the comparison FOLDS CASE
  because GitHub does. `acme/Site` and `acme/site` are one repository there and
  were two rows here, so the collision that creation-time refusal exists to
  catch came back at the second project's first publish as a permanent
  `GitHubDivergenceError`, after the run and the spend. The unique index is on
  `lower(owner)`/`lower(name)` under its own name; the COLUMNS keep the
  spelling the tenant typed, because that spelling is what `ensureRepository`
  asks GitHub to create. A store already holding such a pair cannot take that
  index — and needs it most — so it keeps the binary one, is told which pair to
  resolve, and still OPENS.
- Creating a project is ONE `BEGIN IMMEDIATE` transaction: both identity checks
  and the INSERT. Two processes write this file (the route and the CLI), and
  outside a transaction the loser of that race met the index instead of the
  typed conflict, so the caller got a driver's UNIQUE prose naming an index
  rather than a 409 naming the holder.
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
- PUBLICATION IS A SEQUENCE, one row per run, and every delivered run reaches
  the repository. Exactly one commit used to be possible per project, because
  `repository_status = 'ready'` is terminal and routed every later run into the
  first publication's empty-branch refusal. `ready` means the repository EXISTS
  and never that it is current; the authority to commit onto an existing branch
  is `lastPublishedCommitForProject` — this project's own last published commit
  — passed to the client as `expectedHead`
  ([src/github](../github/AGENTS.md)).
- `base_sha` on a publication row is an OBSERVATION, never a pointer anything
  decides from: the head found immediately before that publication. NULL means
  it created the branch, and `commit_sha = base_sha` means the attempt added no
  commit because the branch already held the manifest. There is deliberately NO
  last-published column on the projects row: "is the branch where we left it"
  is answerable only by GitHub, and a stored head is a cache of state GitHub
  owns — a stale one is how a wrong divergence verdict gets manufactured.
- PUBLISHING A RUN OLDER THAN THE ONE ALREADY PUBLISHED IS REFUSED
  (`PublicationSupersededError`, HTTP 409, not 502). Every entry point accepts
  any delivered run whose publication is pending or failed, so without the gate
  a retry of an older run would move the branch back to older artifacts. There
  is no override flag: a later run's workspace is seeded from the earlier one,
  so its artifacts already contain that work. The gate reads run creation
  order, which can differ from delivery order — accepted, for the same reason.
- STALENESS IS A QUERY, NOT A COLUMN. How far behind a repository is = delivered
  runs of the project newer than the last published one, which `projects list`
  prints. A project can sit at `ready` over a repository several runs old.
- A publication failure NEVER changes a delivered run's status. The run was
  delivered, the cost is real, `previousDeliveredWorkspace` seeds from
  `delivered` rows, and a `failed` row may not carry `delivered` stats — marking
  it failed would rebuild the measured cost erasure and silently stop seeding.
  The operator surface is `publication.failed` plus the publication status
  beside the run, and `projects run` now exits non-zero when a publisher is
  configured and the publication did not reach `published`.

## The run budget

- ONE place decides how long a project run may take: `projectRunTimeoutMs`,
  which reads an explicit argument, then `ATOMA_PROJECT_TIMEOUT_MS`, then the
  15-minute default, and REFUSES anything malformed or outside 60s..7200s
  rather than falling back — a run that quietly gets 15 minutes when the
  operator asked for 40 is the same defect wearing a different hat.
- `ATOMA_BUILD_TIMEOUT_MS` is the CHILD's variable and is inert on the host:
  `spawnRun` writes it from this value AFTER spreading the caller's
  environment, so an exported one is overwritten. That is why "raise the
  timeout", which run `949ecd5d`'s post-mortem advised after dying at 900s on
  68 tool calls and $0.96, was unreachable advice until the lever existed.
- The DEFAULT is unchanged at 15 minutes. What a tenant run may spend is a
  product decision; only its reachability was a defect.

## What a published commit says

- The commit message is a PRODUCT SURFACE: permanent, in the tenant's own
  repository, and public if they chose a public one. It is rendered once, by
  `publicationCommitMessage`, and its shape is a decision rather than a format.
- SUBJECT: the goal through `eventLabel`, cut at a word boundary. BODY: the
  provenance, the run's DECLARED output set, and the goal in full. TRAILERS:
  `Atoma-Project` and `Atoma-Run`, so a machine can read them.
- THE DECLARED SET IS THE REASON THE BODY EXISTS. Publication merges the
  manifest onto the parent's tree, so the tree carries paths from earlier runs
  and the diff shows only what changed — the run's declared outputs are NOT
  recoverable from git. Nothing else in the message earns its place that way.
- The goal is quoted INDENTED, and that is a guard, not a style. Git trailers
  are unindented `Key: value` lines at the end, and a goal is up to 4 000
  characters of tenant text that permits newlines — so a goal shaped like a
  trailer would forge one. `git interpret-trailers --parse` is the authority
  that it does not, and a test uses it.
- OMITTED ON PURPOSE: the parent and created-versus-extended, because those are
  first-class git fields and naming them in prose would both duplicate the
  commit's own metadata and be decided BEFORE the head is read; cost and call
  counts, because they come from the run log, a channel a tenant's goal can
  write into ([src/cli](../cli/AGENTS.md)) — a git history must not carry a
  number the tenant can influence, and the journal already has it; and the trace
  id, which means nothing outside this instance.
