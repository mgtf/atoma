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
- Authority is re-asked PER RUN and is never handed in: the platform-admin
  flag through the fail-closed `resolveSubscriptionGrant`, plus
  `ATOMA_HOST_SUBSCRIPTION_ORG` naming the ONE organisation where the
  operator's own login may be spent, plus a match against this run's org. A
  stored pin is data; permission is not storable. `platformAdmins` is passed
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
- What makes it safe TODAY is PARTITIONING, not restraint: `ATOMA_SKILLS_DIR`
  points at `<projectRoot>/skills`, so what a run learns belongs to that
  project alone. Nothing reaches another project, let alone another
  organisation, yet. That is containment, not the premise: skills are a
  platform commons, and the organisation bounds trust and execution rights,
  not knowledge ([the premise](../../docs/saas-architecture.md#skills-are-a-commons)).
  Sharing a body arrives with the body/trust split; the human gate applies to
  execution rights, i.e. compiled scripts and direct dispatch
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
  15-minute default, and REFUSES anything malformed or outside 60s..7200s
  rather than falling back — a run that quietly gets 15 minutes when the
  operator asked for 40 is the same defect wearing a different hat.
- `ATOMA_BUILD_TIMEOUT_MS` is the CHILD's variable and is inert on the host:
  `spawnRun` writes it from this value AFTER spreading the caller's
  environment, so an exported one is overwritten. That is why "raise the
  timeout", which run `949ecd5d`'s post-mortem advised after dying at 900s on
  68 tool calls and $0.96, was unreachable advice until the lever existed.
- The DEFAULT is 30 minutes, allowing project runs on small production hosts
  more wall-clock time. Explicit operator budgets still take precedence.

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
