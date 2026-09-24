# Projects — AGENTS.md

`src/projects/` owns organisation-scoped projects: the run corpus they hold,
their artifact manifests, and publication.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/auth`](../auth/AGENTS.md) — the identities projects belong to
- [`src/github`](../github/AGENTS.md) — where publication lands
- [`src/platform`](../platform/AGENTS.md) — the journal this domain emits into

## Run network

Project runs enable isolated, proxied egress by default. The operator may set
`ATOMA_EGRESS=0` to disable it or `ATOMA_EGRESS_ALLOWLIST` to replace the host
list. These values come from the host snapshot, never a tenant prompt.

## Scoping and storage

- Projects, GitHub App installations and publications are organisation-scoped;
  a run belongs to exactly one project and a project to exactly one
  organisation. Gated `/api/runs` lists that org's project traces from
  `orgs/<orgId>/projects/<projectId>/runs/<runId>/` (override the host root
  with `ATOMA_PROJECTS_ROOT`, default `~/.atoma`). It does not mix the
  operator `./runs` corpus used by CLI, MCP and ungated viz.

## Tier selectors and credentials

- Every tier of a project run resolves to one full selector,
  `<api|sub|own>:<vendor>:<model>` ([src/contracts](../contracts/AGENTS.md)
  `modelSelector.ts`), by walking account pin > organisation default > host
  `ATOMA_MODEL_L*`. ALL THREE TIERS MUST RESOLVE: there is no base transport,
  no `ATOMA_LLM` and no built-in default since 2026-09-07; a tier no level
  can honour refuses the run and names the two ways out (a Settings choice
  whose vendor key the organisation saved, or a host pin beside its
  credential).
- An `api:` selector is honoured when its vendor's credential is available to
  THIS run: the organisation's OWN key first, else the host's. One answer PER
  VENDOR, because a vendor's credential is one environment variable and every
  tier on that vendor shares it. A BYO-only deployment carrying no platform
  key at all is therefore a supported shape, and an org key WINS over a host one.
- `ANTHROPIC_AUTH_TOKEN` is REFUSED, not ignored, when an `api:anthropic`
  tier takes the host credential. No tenant can supply one (the org key store
  is keyed by vendor, and anthropic's credential variable is
  `ANTHROPIC_API_KEY`), and a bearer is refreshed from a login profile the
  run child cannot read — a frozen env snapshot would expire mid-run.
  Operator LOCAL runs keep it ([src/run](../run/AGENTS.md)).
- An `api:ollama` selector is honoured only where the HOST declared its
  endpoint: `OLLAMA_BASE_URL` is forwarded on every run (self-hosted selects
  no payer), and without it the pin falls through like a keyless vendor —
  presuming localhost is exactly what detonates. The endpoint is the
  operator's infrastructure: an org picks ollama models, never an ollama
  destination (a tenant URL would be SSRF from the platform's own process).
- Only the credentials of vendors the RESOLVED tiers reference cross into the
  child, and a BYO key crosses WITHOUT the host's gateway variables
  (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, …): a tenant's key belongs to its
  own issuer, the host's gateway applies to the host's own credential only.
- `api:openai` is OpenAI's API with function tools, admissible on every tier
  from the org's or the host's `OPENAI_API_KEY`. `sub:openai`/`own:openai`
  are the Codex CLI on a ChatGPT login; L1 actions pass through Atoma's
  host-side tool loop and ToolSandbox.

## Subscription selectors

- A `sub:` selector spends the HOST's own login session (Claude Code for
  anthropic, Codex for openai) and cannot honour a supplied credential — for a
  tenant that would be one account billing another. It is ADMISSIBLE BY CHAIN
  LEVEL, not merely by value: the ACCOUNT level only. An org default is
  inherited by every member by construction, and the host env is the third
  candidate for every tier; a `sub:` at either level would be a payer-bearing
  default nobody chose, and is refused whatever the requester's flag. The
  former whole-deployment regime (`ATOMA_LLM=claude-cli`) no longer exists.
- Authority is re-asked PER RUN and is never handed in: through the
  fail-closed `resolveSubscriptionGrant`, EITHER the platform-admin flag OR a
  host-subscription delegation for this principal in THIS organisation
  ([src/auth](../auth/AGENTS.md)), plus `ATOMA_HOST_SUBSCRIPTION_ORG` naming
  the ONE organisation where the operator's own login may be spent, plus a
  match against this run's org. Both resolvers fail closed, and the run is
  never told which one answered. A stored pin is data; permission is not
  storable. `platformAdmins` is passed
  to the coordinator as a QUESTION, never as an answer — absent resolver,
  `false`, or a throwing resolver all mean refusal — deliberately the opposite
  of `tierModelsFor`, which is fail-open: a preferences lookup must not block
  a run, an authority lookup must never be read as permission to spend.
- FALL-THROUGH IS PERMITTED WITHIN A PAYER; REFUSAL IS REQUIRED ACROSS PAYERS.
  A vendor you may not use THROWS, a credential nobody brought CONTINUES. A
  revoked authority is the first kind: falling through would change the payer
  from a subscription to a billed credential with no event anywhere, which is
  what finding 2.2 closed.
- A run is MIXED by design: `sub:` tiers spend the login, `api:` tiers keep
  their own credential, and the three-row `payers` ledger
  ([src/contracts](../contracts/AGENTS.md) `runPayers.ts`) names each. The
  ledger is what fires `onSubscriptionTransport`, journaled by the caller as
  `run.host_subscription` (severity `security`, never pushed) — the
  coordinator emits no audit row itself, so there is one delivery path, as
  with `onRunFinished`. A run touching a subscription forwards no
  `ANTHROPIC_BASE_URL`, and `ATOMA_SUBSCRIPTION_TIERS` names exactly the
  authorised tiers for the child's own gate
  (`assertTransportHonoursCredentials`, [src/run](../run/AGENTS.md)).
- The selector travels into the child AS STORED — it is the routing identity —
  and the child refuses any `sub:`/`own:` tier its parent did not list. The
  stored value is data; the two authority checks are what make it a transport.
- Design and the owner's decisions:
  [docs/subscription-per-tier-design-2026-08-28.md](../../docs/subscription-per-tier-design-2026-08-28.md)
  (its `host-subscription:` / `claude-cli:` spellings predate the selector
  grammar of 2026-09-07).

## Per-tier personal Codex subscription

- `own:openai:<model>` is an ACCOUNT-only selector on any tier. The
  coordinator resolves it from the requesting principal's exact private Codex
  generation at launch, records payer `principal-subscription`, and injects
  only that generation's `CODEX_HOME`/`CODEX_SQLITE_HOME`. `own:anthropic` has
  no transport yet (provider approval pending) and is refused by name.
- Missing, revoked, wrong-chain-level and mixed host/personal Codex profiles
  THROW. None may fall through to a host login, organisation key or lower
  preference level. Disconnect is refused while that principal has an active
  run, so credential deletion cannot race an already captured generation.

- The door does NOT change what a project run may learn or execute. That is
  stated once, under "What a tenant run may learn" below.

## Readers outside this subsystem

- Public run `durationS` is persisted project elapsed time (`endedAt` minus
  `startedAt`), including host finalization, not the narrower trace duration.
  A missing endpoint or reversed interval remains unknown (`null`).
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
  set is the finished workspace inventory, the filter is filenames only, publication
  is automatic on delivery, and the manifest never crosses the API — so a
  public default hands an unreviewed set to the internet whenever nobody looks.
- A new empty repository is created at PUBLICATION, not at project creation, so a
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
- `ATOMA_SKILLS_DIR` points at the host's ONE catalog, and `ATOMA_DB_PATH` at
  the host's ONE registry: a tenant run reads and earns exactly what every
  other run does ([platform trust record](../../docs/platform-trust-2026-09-15.md)).
  New run receipts persist the selected skills path, and launch authority
  (`assertProjectRunAuthority`) compares workspace, runs and skills paths to
  that receipt before any writable handle — it gates the launch, never the
  rows. Legacy receipts retain their recorded layout. The coordinator folds
  old partitions with backups before admitting new work
  ([skill storage contract](../skills/AGENTS.md)).
- PROMOTION, DETERMINISTIC DISPATCH and the PREFILTER CACHE follow the same
  defaults as any run on the host (a run is a run,
  [platform trust record](../../docs/platform-trust-2026-09-15.md)): a seeded
  workspace enables promotion, dispatch is on unless the host env says
  `ATOMA_SKILL_DIRECT=0`, and the cache is the platform's. The coordinator
  pins none of them and sends no veto flag; the one thing a tenant launch
  insists on is `--container`. A host that wants a lifecycle stage off says
  so in its own environment, for every run alike.
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

- New delivery manifests inventory every publishable regular file in the
  finished workspace, including files child work added after the root plan.
  `source: workspace` distinguishes them from legacy plan-only manifests;
  existing hashes and rows are never rewritten. The root plan declaration is
  retained as run evidence, not used as the publication file allowlist.
- Inventory uses the existing path jail, size/count limits and exclusions.
  Internal records, VCS, dependencies, workflows and secret-like paths are
  excluded before traversal; other symlinks and special files refuse delivery.
  Revalidation of a workspace manifest compares the complete inventory again,
  so added files cannot silently miss publication after delivery.
- Delivery status and its manifest commit in one SQLite transaction. A failure
  rolls both back; previews and publication run only after that transaction.

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
- First publication checkpoints its root seed in the private
  `project_publications.seed_commit_sha` column before uploading the rest.
  It is scoped to the same org/publication and survives failed retries and
  restarts; it is never inferred from a ready repository or an observed head.
  The exact retry authority lives in [src/github](../github/AGENTS.md).
- `MAX_CONTROL_JSON_BYTES` now governs `declared-artifacts.json` ALONE, and the
  difference between the two files is the whole point: a declared manifest is
  small by contract and its CONTENT is model-chosen, so a size bound plus a
  whole-document parse fits it; a trace is a control-plane-owned path whose
  SIZE grows with the work. Bounding them the same way is what caused the
  erasure. Do not reunify them.
- Host-side finalization failures retain the runner's measured spend. The
  project stats outcome becomes failed/cancelled to match its persisted status;
  the original runner outcome remains in the trace. No delivered stats are
  attached to a failed row, and no paid work disappears from the accounting.
- PUBLICATION IS A SEQUENCE, one row per run, and every delivered run reaches
  the repository. Exactly one commit used to be possible per project, because
  `repository_status = 'ready'` is terminal and routed every later run into the
  first publication's empty-branch refusal. `ready` means the repository EXISTS
  and never that it is current; the authority to commit onto an existing branch
  is `lastPublishedCommitForProject` — this project's own last published commit
  — passed to the client as `expectedHead`
  ([src/github](../github/AGENTS.md)).
- `base_sha` on a publication row is an OBSERVATION, never a pointer anything
  decides from: the head found before publication (the captured run base for
  imported projects). NULL means
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
  60-minute default, and REFUSES anything malformed or outside 60s..7200s
  rather than falling back — a run that quietly gets the default when the
  operator asked for 40 minutes is the same defect wearing a different hat.
- `ATOMA_BUILD_TIMEOUT_MS` is the CHILD's variable and is inert on the host:
  `spawnRun` writes it from this value AFTER spreading the caller's
  environment, so an exported one is overwritten. That is why "raise the
  timeout", which run `949ecd5d`'s post-mortem advised after dying at 900s on
  68 tool calls and $0.96, was unreachable advice until the lever existed.
- The DEFAULT is 60 minutes, raised from 30 on 2026-09-22 after two production
  runs died at exactly that wall clock having spent $2.83 and $3.50. It is the
  smaller half of that answer: a bigger budget only moves the cliff, and what
  stops the loss is that reaching the deadline now LANDS
  ([src/atoms](../atoms/AGENTS.md)) and records `partial`.
- THE PREPARATION IS NOT BILLED TO THE RUN. The repository import and the
  corpus build happen before the child is spawned and have their own ceiling,
  `PROJECT_RUN_PREPARATION_TIMEOUT_MS`; the tenant's clock starts when the child
  does. `deadlineAt` used to be stamped above that work and the child got the
  remainder, which is the arithmetic behind `run aborted after 1787s budget` on
  a 1800s setting. Moving it off the budget must not make it unbounded.

## A landed run: `partial`

- `partial` is TERMINAL and is not a failure: the run reached its budget with
  phases already accepted and reported those. It reaches the store through the
  same `completeProjectRun` transaction as a delivery — same trace bar, same
  workspace manifest, same atomicity — and differs on exactly three points.
  It may carry an error string, because the phases it never ran are worth
  naming and no other field says so; its files remain downloadable, but it is
  never offered as an executable preview; and it NEVER publishes.
- Publication stays `delivered`-only, by the operator's decision of 2026-09-22.
  The customer's repository is the one surface where an incomplete artefact set
  would be indistinguishable from a finished one once it landed.
- For projects without an imported repository, `previousSeedRun` (formerly
  `previousDeliveredRun`) takes a landed run too, and
  that is the half that actually recovers the spend: the next run continues
  from the phases that did complete instead of rebuilding them. Retention and
  the retrieval source follow it, so a landed seed is held like any other.
- The status CHECK on `project_runs` was widened by a TABLE REBUILD
  (`migrateProjectRunsForPartial`), because SQLite cannot relax a CHECK by
  `ALTER TABLE` and a store created before that date would refuse every landed
  run. The copy is driven by the OLD table's column list so the additive
  migrations below it are not silently dropped.

## What a published commit says

- The commit message is a PRODUCT SURFACE: permanent, in the tenant's own
  repository, and public if they chose a public one. It is rendered once, by
  `publicationCommitMessage`, and its shape is a decision rather than a format.
- SUBJECT: the goal through `eventLabel`, cut at a word boundary. BODY: the
  provenance, the run's publication file set, and the goal in full. TRAILERS:
  `Atoma-Project` and `Atoma-Run`, so a machine can read them.
- The body labels workspace inventories as delivered files and legacy
  manifests as declared files. Publication still merges onto the parent's
  tree: additions and updates are supported; deletion remains unimplemented
  and must never be inferred from a legacy manifest's absent paths.
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

## Starting from GitHub

- `repositoryTarget.source` explicitly distinguishes work on an existing
  repository (one PR per changed delivered run) from a fork (direct commits).
  Creation reads the source identity and visibility; the first fork run creates
  the real GitHub fork. Imported runs snapshot the current default branch before
  model work instead of seeding the previous delivered workspace. Merge a PR
  before starting work that depends on it. Forks advance their own branch.
- The captured `repositoryBase` belongs to the run in the primary store;
  publication uses that exact base and persists a PR URL when applicable.
  Old projects retain their existing publication and seed behaviour. The source
  choice is immutable; imported visibility is inherited, never chosen locally.

## Retention and admission

Finished run bytes are eligible after 90 days; current active-project seeds
and unfinished publications hold them. Offline maintenance preserves run
metadata, payers and lifecycle_events; expiry never changes delivery status.
Per-org admission defaults to one (zero suspends), with the global lease still
limiting the host to one run. Recheck inside reservation after idempotency.
The operator commands and offline prerequisites live in
[W9/W10](../../docs/project-maintenance.md).
## A landed run, from the tenant's side

- `partial` is a run that produced real work and did not deliver it, for either
  of two reasons that compose: the deadline left phases unrun, or root delivery
  acceptance refused the result. `landedRunDetail` reports BOTH — reporting only
  the phases drops the half a customer needs, which is that the work was judged
  and found wanting rather than merely cut short.
- It NEVER publishes (three gates, all keyed on the row status) and is NEVER
  offered as a preview. The second is a deliberate refusal rather than an
  inheritance from the delivered case: the preview runtime EXECUTES the
  workspace and serves it, so previewing a refused deliverable would hand the
  customer, running, the artefact the judge called unproven.
- It DOES seed the next run (`previousSeedRun`), and that is the half that
  recovers the spend. WHY it did not deliver travels with the bytes, as
  `PREVIOUS_LANDING_ENV` in the child's environment and `Task.inputs
  .previousRunLanding` at the other end — never argv (`parseRunnerArgs`
  discards an undeclared flag with a warning, argv is the E2BIG surface the
  goal already fills, and it is world-readable in `ps`), and never on a
  repository-backed project, where `seedFrom` is replaced by a fresh repo-HEAD
  snapshot and the refused workspace never reaches the child.
- THE VALUE IS THE TYPED REASONS (`stats.landingReasons`), never the row's
  error string. That string is recovered from a log the tenant's own goal is
  echoed into verbatim, and the recovery took the FIRST matching line while the
  genuine banner is printed much later — so a goal carrying a newline and a
  plausible `refused at delivery:` line forged the explanation its own run
  showed the customer. The epilogue is written once by the runner and
  `parseRunStatsEpilogue` keeps the LAST valid object, so an earlier forged
  line cannot win. `landedRunDetail` reads the epilogue and falls back to the
  banner only to say THAT a run landed, never why.
- `verifiedTrace` separates INTEGRITY from PUBLISHABILITY. A failed or
  cancelled trace is never recordable; `degraded` refuses only a run that would
  publish. A refusal reached after a deepening is degraded by construction
  (`viaFallback`), so checking it on the landed path coerced the run straight
  back to `failed` — the feature would have been inert on one of its two
  production shapes while appearing to work.

## Intentional choices and rejected shortcuts

- Reading egress settings, or an ollama destination, from a tenant prompt:
  refused. They come from the HOST snapshot. An organisation picks ollama
  MODELS, never an endpoint — a tenant URL would be SSRF from the platform's
  own process.
- A `sub:` selector as a deployment-wide or organisation-wide default:
  refused whatever the requester's flag, because it is a payer-bearing default
  nobody chose. The former whole-deployment regime (`ATOMA_LLM=claude-cli`) no
  longer exists.
- Storing the authority to spend a subscription: refused, and this is the
  sharpest line here. A stored pin is DATA; permission is not storable.
  Authority is re-asked per run through `resolveSubscriptionGrant`, both
  resolvers fail closed, and the run is never told which one answered.
  `platformAdmins` reaches the coordinator as a QUESTION — absent, `false` or
  throwing all mean refusal — deliberately the opposite of `tierModelsFor`,
  which is fail-open: a preferences lookup must not block a run, and an
  authority lookup must never be read as permission to spend.
- Falling through to a host login when a personal Codex profile is missing,
  revoked or mixed: refused, it THROWS. Fall-through is permitted WITHIN a
  payer and forbidden ACROSS payers.
- Letting a reader repair a `running` row it noticed: refused. That is
  `reconcileInterrupted`'s job at the next boot. `hasProjectTables` exists
  precisely so a reader can ask about the control plane without triggering
  `ProjectStore.open`'s DDL.
- Offering to change a repository's visibility later: refused, and anything
  in a UI that offers it is lying. `ensureRepository` refuses a repository
  whose visibility disagrees with the row ("never a convergence") and
  `REPOSITORY_TRANSITIONS.ready` is empty.
- A public repository default: refused. The published set is the finished
  workspace inventory, the filter is filenames only, publication is automatic
  on delivery, and the manifest never crosses the API — so a public default
  would hand an unreviewed set to the internet whenever nobody looks.
- Creating the repository at project creation: deliberately not done. It is
  created at PUBLICATION, so a project with no delivered run leaves no empty
  repository behind.
- Resolving the request-key conflict outside a transaction: refused. Two
  processes write this file, and the loser of that race met the index instead
  of the typed conflict, handing the caller a driver's UNIQUE prose naming an
  index.
