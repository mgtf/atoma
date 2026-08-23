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
- The door does NOT change what a project run disables
  (`ATOMA_SKILL_LEARN=0`, `ATOMA_SKILL_PROMOTE=0`, `ATOMA_SKILL_DIRECT=0`,
  `ATOMA_EVENT_SKILLS=0`, `ATOMA_PREFILTER_CACHE=0`). A measurement that
  depends on skill learning cannot be run as a project run.

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
