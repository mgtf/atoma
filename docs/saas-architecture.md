# atoma hosted architecture

> **CURRENT REVIEW: 2026-09-20.** Implementation and executed checks reconciled
> against `4788dfd`; [acceptance receipt](saas-acceptance-2026-09-20.md) records
> the green CI/deployment, local admin MCP check and remaining hosted evidence.
> The owner authorised isolated runtime tests on 2026-09-20.
>
> This document is the architecture boundary for hosted atoma. It has four
> layers on purpose:
>
> 1. **Current state** is descriptive and dated.
> 2. **Normative invariants** are constraints every implementation must
>    satisfy; current deviations are named explicitly.
> 3. **Remaining work** is one ordered list with an owner-decision register.
>    It replaces the earlier Track A / Track B roadmap.
> 4. **Historical evidence** links the incidents, measurements, rejected
>    designs and superseded premises that established the rules.
>
> The short verdict: atoma is a **single shared-learning instance** with a
> multi-organisation control plane. One registry, one skill catalogue, one
> trust state and one lifecycle ledger serve every run on the instance — the
> operator's and every organisation's alike. Projects, workspaces, traces,
> retrieval corpora and the right to start a run are organisation-scoped;
> knowledge and trust are not. **Mutually distrusting organisations on one
> instance is not a supported deployment shape**, and no work in Layer 3 aims
> to make it one. What remains is the production boundary and the
> operational substrate for the shape that IS supported.

## 1. Current state — 2026-09-20

### What the product is

- One instance holds one `atom_types` table, one `skills/` catalogue, one set
  of trust counters and one `lifecycle_events` ledger. Every run — CLI, MCP,
  operator viz, gated project run — reads and moves them. A store partitioned
  by owner (2026-09-09) or a skill tree with per-project `.trust/` sidecars
  (2026-09-15 morning) is folded back at `openDb` / `reconcilePlatformSkills`,
  with a whole-file backup beside it.
- `AuthStore` persists principals, provider identities, organisations,
  memberships, sessions, invitations, account model pins, organisation model
  defaults, encrypted organisation provider keys and non-secret personal
  subscription receipts.
- An unknown provider subject logging in without an invitation creates a new
  personal organisation; an invitation joins its target organisation. A
  principal may belong to several organisations and select an active one.
- A persisted product run belongs to exactly one project, and that project to
  exactly one organisation. Gated project, run, trace, workspace, GitHub
  installation and publication reads are scoped from the authenticated viewer,
  never from an organisation id supplied by the browser.
- Project runs learn, promote, dispatch deterministically and use the
  prefilter cache at the host's defaults, like any run. Nothing is pinned to
  `0` for a tenant run any more.

The supported claim today is:

> atoma is a multi-organisation control plane over one shared-learning
> instance: organisations own projects, workspaces, traces and retrieval
> corpora; the registry, the skill catalogue, trust and the ledger are the
> platform's and every run reads and writes them.

The following claims are **not** supported:

- a production migration to the reference Compose stack (its deterministic
  acceptance passed on an isolated engine, not on the production host);
- isolation between mutually untrusted organisations;
- a dedicated one-organisation deployment (self-signup creates organisations);
- financial run budgets or metered rebilling. Per-org concurrency admission and
  offline run-byte retention are implemented and regression-tested in W9/W10.

### Ownership model

`Principal` is the internal actor. Provider subjects and email snapshots stay
in the auth plane; product rows use `principal_id`. The schema supports human,
service and system principals, although not every non-human writer has been
migrated to a first-class principal yet.

`Organisation` is the authorization boundary for projects and execution
rights and provider-key ownership. `Project` is optional as an organisation
resource but **mandatory for every persisted product run**.

```text
Platform — shared by every run
├── Atom registry (atom_types, atom_type_versions, trust counters)
├── Skill catalogue (bodies in skills/<atom-id>/…, trust in skill_meta)
├── Lifecycle ledger (lifecycle_events)
├── Prefilter cache
└── Organisation
    ├── Membership (principal × organisation × role)
    ├── Provider keys and model defaults
    └── Project
        ├── Retrieval corpus
        └── Run
            ├── Workspace
            ├── Trace
            ├── Declared artifact manifest
            └── Publication
```

Current resource scopes:

| Resource | Scope | Behaviour today |
|---|---|---|
| Principals, identities, sessions | instance control plane | Provider identities join on `(provider, subject)`, never email. A session names one active organisation. |
| Projects, project runs and cost | organisation | A run has one project and one requesting principal. `org:viewer` reads but cannot execute. |
| Traces, workspaces, manifests | project/run | `projectRunHostLayout` stores traces/manifests below `orgs/<org>/projects/<project>/runs/<run>`; service-mode workspaces use the launcher projection `projects/<org>/<project>/<run>/workspace`. |
| Retrieval corpus | project | Only the project's own passages are searchable (`ownPassages` stays 0 for another project). A validator's paraphrase of a passage, written into a prompt or a description, is platform knowledge. |
| Atom bodies and trust | platform | `atom_types` has no owner column; `AtomRegistry` takes a database and nothing else, and refuses an unfolded store. Readers keep `unfoldedRegistryPredicate` as a guard. |
| Skill bodies and counters | bodies on the platform filesystem, trust in the platform SQLite table `skill_meta` (W4, 2026-09-18) | Learning, promotion, deterministic dispatch, drop and merge are available to every run. Every counter mutation is one statement in one `.immediate()` transaction with its lifecycle event; legacy `_meta.json` sidecars are imported once and retired as `_meta.imported.json`. Before W4, NOT single-writer: `atoma_skill_reset`, `_drop` and `_merge` are platform-tier MCP tools that take no run lease (`src/mcp/writes.ts` imports none), and the production viz server enables them (`operatorRuns: true`). A bearer token can mutate counters while a run is in flight. |
| Lifecycle ledger | platform SQLite table | `lifecycle_events(seq, at, kind, entity, detail, org_id, project_id, run_id, actor_type, actor_id, entity_id)`; scope columns are nullable and additive (2026-09-18), a row without them is a platform-level event. Type counters are compared by atom id; unresolved historical labels remain unchanged. |
| Platform events | organisation/project/run-aware | The control-plane audit journal carries nullable scope ids and a retention window (`ATOMA_EVENTS_RETENTION_DAYS`, default 90). |
| Prefilter decisions | platform SQLite table | Content-addressed, transactional, read and written across every organisation's runs. The existence/volume oracle is accepted (Layer 4). |
| Provider credentials | organisation or host, injected per run | Organisation keys encrypted at rest. Selection is account pin → organisation default → host default; the run receives only its credential snapshot. |
| Host subscription | operator exception | Per-tier `sub:` selectors need the platform-admin door, are limited to one operator-declared organisation and are re-authorised per run. |
| Personal Codex subscription | principal | `org:member+` connects a private Codex profile; only that principal's runs may resolve its exact generation; Codex serves L1/L2/L3. |
| Operator CLI/MCP run corpus | instance operator scope | Separate from the gated project corpus; not exposed as tenant data. |

### Implemented safeguards

`projectRunEnvironment` and `ProjectRunCoordinator` set, for every project run:

- `ATOMA_REQUIRE_ISOLATION=1` and `ATOMA_CONTAINER=1`;
- `ATOMA_EGRESS=1` (isolated, proxied egress) unless the host snapshot says
  `ATOMA_EGRESS=0`; `ATOMA_EGRESS_ALLOWLIST` comes from the host, never a
  prompt;
- a run-specific workspace, trace directory and artifact manifest;
- `ATOMA_SKILL_LEARN=1`, `ATOMA_EVENT_SKILLS=1`; promotion, direct dispatch
  and the prefilter cache at the host's defaults;
- `ATOMA_TENANT_RUN=1` so the child re-checks that every machine-bound
  selector it can see was authorised by the coordinator
  (`assertTransportHonoursCredentials`), with `ATOMA_SUBSCRIPTION_TIERS`
  naming exactly the authorised tiers;
- `assertProjectRunAuthority`: the child proves it is the run the host
  launched, on the paths the host recorded. It selects no rows.

The Element worker container mounts only the workspace, uses a deny-by-default
network, drops capabilities, sets `no-new-privileges` and applies resource
bounds. Optional egress uses one internal network and one proxy sidecar per
run; the control plane is not reachable from that network.

Atom identity is a UUID `atom_id`; skill namespaces derive from it through
`namespaceOf`, and operator surfaces resolve a display name. Path traversal
through all-dot components and removed-identity resurrection are fixed and
regression-tested.

Provider construction consumes a per-run environment snapshot. Configuration
errors throw `RunnerConfigError`. `RunPayerLedger` has exactly three rows —
L1, L2, L3 — each with selector, transport and payer. Every project run persists
these rows in its queued-to-running transaction, including organisation-key
and host-key runs. Subscription-specific journaling remains additional evidence.

Provider login is identity only and never grants inference entitlement.
Personal Claude subscription login remains unavailable pending the third-party
approval Anthropic requires.

Atom trust is recoverable since 2026-09-15
([`recoverable-trust-2026-09-15.md`](recoverable-trust-2026-09-15.md)):
historical counters survive patches and rollbacks, one failure no longer
excludes a type permanently, and automatic creation compares behaviour before
cloning.

### Missing production substrate

The model-authored Element worker has an OS boundary. W1 now implements an
optional separate launcher service over a private socket, with its own image
([setup](launcher-service.md)). The real service/worker/volume smoke passed
on 2026-09-20; the [W13 deterministic stack acceptance](saas-stack-acceptance-2026-09-20.md)
also passed later that day.
Without `ATOMA_LAUNCHER_SOCKET`, `DockerLauncher` remains in-process.
The service issues named volumes with a shared file projection. W2 adds a launcher-issued
worker socket transport; W3 adds named volumes and automatic project workspace provisioning.
The [launcher contract](../src/launcher/AGENTS.md) records both modes and their
limitations. W13 now accepts the assembled mechanical boundary in an isolated
environment; no production topology migration is claimed.

The decided target remains Linux, Docker images and one separate launcher
([decision](deployment-docker-launcher-2026-08-28.md)). The web container never
mounts `docker.sock`; closed profiles cover workers, egress and previews;
W3 implements volumes, leases, TTLs and orphan recovery; the real container
smoke verified graceful restart and retained files; W13 then passed on the
assembled stack. Process-crash recovery remains outside that graceful scenario.
Image definitions exist for worker, preview, mender, launcher and web. W7 adds
the [reference stack](packaged-stack.md), digest validation and a restricted build
context. Web/launcher image builds and compiled help smokes passed on
2026-09-20, followed by the [isolated stack acceptance](saas-stack-acceptance-2026-09-20.md).
### Storage decision, closed

Gate 0 selected hardened SQLite on 2026-09-18. W4, W5 and W6 now persist skill
counters, payer attribution and scoped lifecycle events in the product store.
The launcher keeps only machine-local operational state and is not another
product-store writer. [The earlier PostgreSQL analysis](postgresql-migration-analysis-2026-09-02.md)
remains historical input if measured topology or contention reopens the decision.

## 2. Normative invariants

Constraints every implementation must satisfy. Layer 1 and Layer 3 name the
current deviations; new work must not deepen them. An invariant changes only
by naming the threat it replaces and providing stronger evidence. "The code
happens to work this way today" is not such evidence.

### Tenancy, identity and authorization

- The organisation bounds projects, workspaces, traces, retrieval corpora and
  execution rights. It bounds nothing about the registry or the skills.
- Product data references an internal principal. Provider subjects and email
  claims do not flow into domain keys or paths.
- Identities link only on `(provider, provider_subject)`. Email is a display
  snapshot, never a join key.
- Provider login is an identity signal, never an inference entitlement.
- Reading costs is not authority to execute. `org:viewer` cannot start or
  cancel a run.
- Platform-admin cross-org read is retained operator authority (decision 1).
  Every widening path requires a durable audit receipt and owner notification;
  the same administrator/organisation pair shares an hourly receipt (W11).

### Skills are a commons

Stated 2026-09-06, amended 2026-09-15. The 2026-09-06 form — bodies travel,
trust is earned again by each organisation — is superseded: **a run is a run**.

- **One registry, one catalogue, one trust.** What one organisation's run
  learns — a molecule, a patched prompt, a distilled recipe, a success or a
  failure — is platform knowledge and platform trust the moment it is
  written. There is no per-organisation copy, no zero-trust restart and no
  offer/approval gate between organisations, because there is no boundary for
  a body to cross.
- **Knowledge leaks by design; corpora do not.** A validator's paraphrase of a
  private passage, written into a prompt, is visible to every next run. The
  passage itself is not searchable from another project. An instance
  therefore suits teams that accept pooling what their runs learn.
- **Provenance is attribution, never authority.** Ledger events and skill
  frontmatter record which run wrote what; that record grants nothing.
- **Sharing terms belong to the platform, not to the code licence.** The
  terms under which an organisation's runs contribute to and consume the
  commons are defined in the [terms draft](platform-commons-terms.md), pending
  operator identification and publication (decision 5, Layer 3).

What the amendment did not change: raw trace content is never learning
input; static scans are hygiene, never authorization; container isolation is
what bounds a hostile body, and it bounds blast radius, not authorship.

### Resource ownership

| Resource | Normative scope |
|---|---|
| Run record, trace, cost, publication | organisation/project |
| Workspace and artifacts | run-private, readable only through organisation policy |
| Retrieval corpus | project |
| Atom body, atom trust | platform |
| Skill body, skill trust, matches, promotion/demotion state | platform |
| Lifecycle event | store + stable entity id; project/run/actor where the event arises there |
| Platform event | explicit audience, nullable organisation/project/run scope, retention window |
| Raw trace content | never learning input |
| Prefilter decision | platform, content-addressed; the existence oracle is accepted |
| Provider credential | organisation or platform/host owned; per-run snapshot, never inferred from login |

### Deployment invariants

**D1 — The web/control plane never holds the Docker socket.** The launcher is
the only component allowed to create or destroy workloads. *Not satisfied:
`DockerLauncher` remains the default in-process backend; the W1 service and W2 socket transport passed isolated W13 acceptance; production migration remains separate.*

**D2 — The launcher accepts closed profiles, not Docker syntax.** A caller
cannot choose an image, mount, network, command, capability or arbitrary
environment entry. *Satisfied at the contract level for egress and preview;
W2 service workers use a closed workspace-key profile (runtime acceptance passed in W13).*

**D3 — Every run's model-authored Element workload receives its own boundary.**
Its only writable product mount is its workspace. Stores, skills,
credentials, other workspaces and the control plane are unreachable from it.
Egress is deny-by-default. *Satisfied for the worker container; workspaces
use named local-driver volumes with a shared file projection (W3; W13 graceful restart passed).*

**D4 — Lifecycle ownership follows workload ownership.** The launcher owns
heartbeat, deadlines, bounded stop, reverse teardown and orphan
reconciliation. *Partially satisfied: primitives exist in-process; the worker
lifecycle and operational recovery are launcher-owned (W3; W13 graceful restart passed).*

### Testable invariants

**T1 — No store is reachable from a run's model-authored execution sandbox.**
An Element worker cannot read the atom store, the skill catalogue,
credentials, control-plane state or another run's workspace through any path.
Network policy blocks direct control-plane access. The supervisor child
receives the store path by design and is outside this invariant.

**T2 — Trust and knowledge are platform-wide; only execution rights and
corpora are scoped.** No code path filters `atom_types`, skills or trust by
organisation. A reader that finds an unfolded store refuses or guards
(`unfoldedRegistryPredicate`); it never publishes one row per owner.
*(Replaces the pre-2026-09-15 T2, which forbade cross-organisation trust
aggregation.)*

**T3 — A tenant run proves its authority, not its rows.**
`assertProjectRunAuthority` says whether this process may run at all, on the
paths the host recorded; it selects nothing. `ATOMA_TENANT_RUN` arms the
child's transport re-check. *(Replaces the pre-2026-09-15 T3 body-approval
gate, which has no boundary left to guard.)*

**T4 — Identity uses stable surrogate ids; names are display labels.**
`atom_id` is a UUID. Identity-critical references and namespaces use stable
ids. *Since 2026-09-18 `lifecycle_events.entity_id` carries the stable key
(`atom_id`, or `<atom-id>/<skill-id>`) and `entity` stays the display label;
`ledger check` and `projectCounters` group by the id. Backfill rule: resolve
each label against the store as it is now, leave NULL what does not resolve,
rewrite no bytes.*

**T5 — No control-plane path or identity is derived from model output.**
Model-authored names, branch labels, task text and verdict prose never become
a control-plane filesystem component, primary key or persistent namespace.
Model-authored artifact paths are relative, `ToolSandbox`-mediated and confined
to the workspace.

**T6 — Every counter mutation is one atomic statement inside the required
transaction.** *Both deviations closed. (a) Skill counters moved from
`_meta.json` (whole-file read/modify/write, reachable by a second writer the
run lease never covered) into `skill_meta` rows on 2026-09-18: one statement,
one `.immediate()` transaction, the lifecycle event inserted in it (W4).
(b) Every registry write transaction is `.immediate()` since 2026-09-17 (W4a).
The file+row pairs the skills subsystem still has (`save`, `promoteToScript`,
`demoteToLlm`, `merge`, `drop`) each state their crash order at the call
site; the shared rule is body first, row second, and a body that outlives its
row never inherits trust.*

**T7 — Every lifecycle event is attributable.** It carries a stable entity id
plus project, run and actor when it arises in those scopes. *Since 2026-09-18
the row carries organisation, project, run and a typed actor (the
`platform_events` vocabulary): a run child sets the scope once from the record
`assertProjectRunAuthority` proves, operator writes over the MCP carry the
bearer's principal per request, the CLI carries `cli`. No remaining deviation.*

**T8 — Raw traces never become learning input.** Traces contain prompts, tool
I/O and workspace excerpts; only distilled bodies enter the catalogue.

**T9 — Execution rights are role-gated.** Reading a run, trace or cost does
not grant the right to spend budget or execute model-authored code.

**T10 — Outbound provider credentials and payer decisions are per-run
values.** Never ambient mutable process state. A machine-bound transport is
operator-only except the platform-admin, declared-organisation host
subscription (re-authorised per run, re-checked by the child, recorded in the
payer ledger) or an exact principal-owned Codex generation resolved from the
requesting identity. Absence or revocation never falls back to another payer.
Every access to that generation holds the same cross-process SQLite lease
through provider-child reap, including timeout and cancellation paths.

### Engineering rules to apply now

R1–R11 keep their numbers because code and dated reviews cite them. R1 is
amended; the others are unchanged.

**R1 —** *(amended 2026-09-15)* Trust counters are platform-global by design.
Never add an organisation, project or owner key to registry, skill or trust
storage; a partition is a product decision, not a refactor, and the two that
were tried are folded back with backups.

**R2 —** Never let model-authored text become a control-plane path, identity
key or persistent namespace. Workspace artifact paths stay relative and
sandbox-mediated.

**R3 —** Use stable surrogate ids in every new persisted identity reference.

**R4 —** Add no counter field that cannot be mutated atomically.

**R5 —** Never cite `scanScriptBody` or another detector as an authorization
boundary.

**R6 —** Name the scope of every new table, file, cache and event at creation.

**R7 —** Keep selection and visibility functions pure with injectable inputs;
apply scope filtering upstream and deterministically.

**R8 —** Assume a second writer. Allocation takes an immediate/locking
transaction appropriate to the chosen database; filesystem replacement is not
counter concurrency.

**R9 —** Do not widen the capabilities a compiled script body may use.

**R10 —** Any path that executes without a validator states what stops a
hostile body and proves that property at the actual process/container boundary.

**R11 —** Never link identities or join organisations by email alone.

## 3. Remaining work

The Track A / Track B split is retired. Track A ("exactly one organisation,
mechanically enforced") was never built and is not the product; Track B
("many mutually untrusted organisations with a body/trust split") is the
premise the 2026-09-15 decision withdrew. What remains is **one hosted shape**
— a shared-learning instance for organisations that accept the commons — and
the list below is everything between the current code and calling that shape
production.

### Decision gate 0 — hardened SQLite or PostgreSQL

**Decided 2026-09-18: hardened SQLite.** The owner asked to stabilise, not to
migrate, and the evidence gathered for the gate points the same way: four
processes contending on one store file serialise correctly once every write
transaction takes its lock before its read (W4a, measured); two additive
migrations landed on both open paths without incident (W5, W6); the restore
drill passes on the deployed shape (W8-a). PostgreSQL is reopened only on
evidence this instance cannot produce today — a second host sharing the
store, or a measured `SQLITE_BUSY` after the `busy_timeout` with every
writer `.immediate()`. W4 is therefore unblocked and stays SQLite: one
statement per counter mutation, in the transaction that appends its ledger
event, on the store that already holds `lifecycle_events`. W4 subsequently
implemented that decision. The record below preserves its evidence.

The gate was a DECISION blocking W4 alone. The earlier claim that it also
blocked W5, W6 and W8 did not survive verification: W5 is one additive table
on the store that already holds `project_runs`, W6's plumbing is additive
columns on an existing table, and W8 targets the systemd deployment running
today rather than a packaged stack. Those three INFORM the decision — they
measure the writer topology and prove the restore — without being blocked by
it.

| Criterion | Hardened SQLite | PostgreSQL |
|---|---|---|
| Topology | one control-plane node, explicitly bounded writers | multiple processes/nodes, database-mediated concurrency |
| Allocation | `BEGIN IMMEDIATE`, explicit `busy_timeout`, bounded retry | row/advisory locks, serializable allocation where required |
| Schema lifecycle | one migrator, migration separate from ordinary open | versioned migrations, controlled rollout |
| Skill counters | move out of `_meta.json` into atomic tables | same, in the transactional schema |
| Backup/restore | coordinated file/WAL snapshot with restore drill | logical/physical backup with restore drill |
| Failover | process/node recovery; no multi-node claim | explicit pool, failover and reconnection policy |
| Development | local file stays simple | provisioned dev/test database, isolated fixtures |
| Fit | a one-node product whose concurrent writers stay bounded and enumerated | writers that cannot be enumerated, or horizontal growth |

The decision record must state: (1) maximum control-plane nodes and writer
processes; (2) migration ownership and rollback/cutover policy; (3) allocation
and counter transaction semantics; (4) backup, restore and disaster-recovery
test; (5) local developer and CI provisioning; (6) the migration path for the
existing store and skill sidecars.

Point (1) must be answered against the MEASURED topology, not the intended
one. Concurrent writers on one store file already exist: the viz server, the
run child (the coordinator injects `ATOMA_DB_PATH` into it), the mender as a
separate host service, operator CLIs, and the platform-tier MCP write tools.
`src/projects/store.ts` says so in its own comment. Whether the launcher joins
them is an OPEN DESIGN CHOICE, not a constraint: `src/launcher/docker.ts`
imports no database, and the repository's precedent for run-slot state is a
machine-local file (`~/.atoma/mcp-run-lock.db`), not the product store.
Decision 6 settles it.

### Work items

| # | Item | Status | Blocked by | Done when |
|---|---|---|---|---|
| **W0** | Close the launcher contract leak | **implemented** (2026-09-19): `createContainerLauncher` returns only `ContainerLauncher`; egress and viz use that seam, and shared-deadline removal plus preview copy ownership are explicit contract operations | — | `src/tools/egressSidecar.ts` and `src/viz/server.ts` construct and call through `ContainerLauncher` only; `removeNetworkBefore` and `previewOwnership` are on the contract or gone. Until then W1 cannot be a transport swap. |
| **W1** | Separate launcher service | **implemented; real container smoke passed** (2026-09-20): optional private socket service, typed client, connection-owned cleanup and launcher image; see [setup](launcher-service.md). Not activated on production; worker transport implemented in W2 | W0 implemented | `DockerLauncher` runs in its own container behind a permissioned socket; the web image holds no `docker.sock` (D1). |
| **W2** | Worker transport behind the launcher | **implemented; real container smoke passed** (2026-09-20): closed workspace-key profile, private socket-file transport, concurrent tool calls and confirmed launcher-owned removal; local stdio lives in the launcher. [Setup and limits](launcher-service.md#boundary) | W1 implemented; W3 now provisions project volumes automatically | The Element worker speaks a socket/network protocol issued by the launcher; `containerExecutor.ts` no longer owns attach/remove; `workerRunArgs` isolation assertions still pass (D2, D4). The real RPC/worker smoke passed; W13 assembled-stack acceptance also passed. |
| **W3** | Launcher-managed workspaces | **implemented; real volumes and graceful restart verified** (2026-09-20): named local-driver volumes with a shared file projection, automatic project provisioning, operational lease journal/process lock, heartbeat/TTL, reverse teardown and boot recovery; run evidence is retained. [Setup](launcher-service.md#workspaces-and-recovery-w3) | W1/W2 implemented | Workspace handles carry volume identities; lease, TTL, bounded stop, reverse teardown and orphan reconciliation are launcher operations (D3, D4). The real container smoke passed for volumes and graceful restart; W13 also passed for the assembled stack; crash recovery is a separate scenario. |
| **W4** | Skill counters out of `_meta.json` | **done** (2026-09-18): `skill_meta` in the product store, created by the one schema step both open paths share; `SkillRegistry` mutations are one `.immediate()` transaction each, event included; legacy sidecars imported once by the first mutation or `reconcilePlatformSkills`, then retired as `_meta.imported.json`; the folds re-key rows with the folders they move; `save` zeroes the row when it CREATES a body, and the projection zeroes on `skill-drop`/`skill-merge`, so a folder that outlives its row can neither inherit nor contradict trust; backup takes the store LAST so rows are never older than bodies | — | Every counter, promotion and demotion mutation is one statement in one transaction with its ledger event (T6, R4). Gate 0 decides dialect and transaction mode, not placement — T6 already forces the counters into the store holding `lifecycle_events`. `save`, `promoteToScript`, `demoteToLlm` and `merge` become file+DB pairs no transaction covers, so the crash ordering must be re-derived, not ported. |
| **W4a** | Registry write-transaction correctness | **done** (`8a4f2ff`) | — | All eleven registry write transactions are `.immediate()`; both product-store open paths set `busy_timeout` explicitly instead of inheriting the driver default; a regression allocates ordinals across connections and processes. This is R8 for the STORE, owed under either Gate 0 branch. It does NOT close `_meta.json` file concurrency — that is W4. |
| **W5** | Durable payer ledger for every run | **done** (`5154832`): `project_run_payers`, three immutable rows per run, written in the queued→running transaction; the coordinator resolves payers through `payerForSelector` | — (the org-scoped cost READ surface waits on decision 3) | The three-row `RunPayerLedger` is persisted for API-key-only runs too, in the same transaction as the queued→running transition (T10). The coordinator resolves payers THROUGH `payerForSelector`, the contract's canonical rule. The synthetic benchmark control (`retrievalProjectAttempt`) transitions its accounting run directly and records no payer; it spends nothing. |
| **W6** | Scoped lifecycle attribution | **done** (2026-09-18): `lifecycle_events` carries `org_id`, `project_id`, `run_id`, `actor_type`, `actor_id` and `entity_id`; one `ensureLedgerSchema` on both open paths; the runner, the MCP writes and the CLI set the scope; `ledger check` compares types by `atom_id` | — | Backfill rule taken by the owner: resolve each label against the current store, leave NULL what does not resolve, rewrite nothing. The ordering constraint held: the migration is one function called from `openDb` and from the cached handle, and `tests/ledger.test.ts` drives a legacy-shaped store through each path first, then a pre-column store through the backfill. A read-only reader on an unmigrated snapshot still reads it, without scope or id. |
| **W7** | Web, launcher images and a reference stack | **implemented; W13 stack acceptance passed (2026-09-20):** web image with Haystack, Linux Compose with TLS gateway, shared paths, worker pin propagation, digest checker and `.dockerignore`; [setup and limitations](packaged-stack.md) | W1–W3 runtime acceptance; real published image refs, Linux Engine 28+, runsc, OAuth and TLS provisioning | Image builds, clean isolated Compose boot and W13 mechanical acceptance passed; [scope and limits](saas-stack-acceptance-2026-09-20.md). |
| **W8-a** | A restore drill valid on the deployed shape | **done for the fixture** (`bdb6bf9`); NOT yet run against a snapshot from the real host | — | The drill distinguishes a tier NOT APPLICABLE to a deployment from one expected and lost — ignoring `skipped` wholesale would make it falsely reassuring. It passes on a production-shaped fixture, which proves the fix; a real snapshot from the host is verified separately and proves more. The manifest records that `store.db` needs an externally held `ATOMA_SECRET_ENCRYPTION_KEY` to yield usable organisation keys, without containing it. |
| **W8-b** | Hosted backup and disaster recovery | `npm run backup` (dated, pruned, off-machine); the 2026-09-14 drill ([recovery-drill-2026-09-14.md](recovery-drill-2026-09-14.md)) covers the local store only | W8-a, W7 | A restore drill on the packaged stack and documented RPO/RTO. Proving recovery requires retrieving the encryption key separately and decrypting under control; documenting the dependency is not that proof. Secret ROTATION is distinct from restoration and is its own work: there is no re-encryption implementation in `src/auth/`, and the AAD binds the key identity, so rotation means decrypt-under-old then re-encrypt-under-new for every row plus the GitHub token wrapping key. |
| **W9** | Trace and workspace retention | **done; regressions passed in CI at `4788dfd`** | W8-a; real purge requires a verified host backup | Operator-run 90-day retention, dry-run default, offline apply under the global lease, canonical path checks, durable deletion receipts and retained run metadata. Current project seeds and unfinished publications are held. [Contract and commands](project-maintenance.md). |
| **W10** | Per-organisation run admission | **done; regressions passed in CI at `4788dfd`** | Decision 3: concurrency only, no financial budget | Persistent per-org limit (one by default, zero suspends), checked before the global lease and inside reservation; idempotent retries preserved. Operator CLI and organisation settings display. [Contract and commands](project-maintenance.md). |
| **W11** | Audited cross-organisation admin read | **done; regressions passed in CI at `4788dfd`:** all five widening paths share a durable per-admin/per-org one-hour receipt, security journal row and owner notification; missing audit refuses the read. [Design and executed checks](cross-org-read-audit.md) | Decision 1 taken; HTTP/MCP regression checks passed | Retained platform-admin read is attributable and journaled without per-poll flooding. No temporary grant or expiry column, per decision 1. |
| **W12** | Platform terms | [Commons terms drafted](platform-commons-terms.md) | Operator identity/contact and publication | Terms of use covering what a run contributes to and consumes from the commons; separate from AGPL-3.0. |
| **W13** | Packaged-stack acceptance | **done for the deterministic assembled boundary (2026-09-20)**: [scenario, regression and report](saas-stack-acceptance-2026-09-20.md) | — | Boots the stack; proves founder login, invitation, role enforcement, Element-workload isolation, delivery, restart, backup/restore and denied control-plane reachability from the worker network. |
| **W14** | Shared-learning acceptance | **Shared arm passed in CI at `4788dfd`:** `tests/shared-learning-acceptance.test.ts` covers A distillation/promotion → B deterministic dispatch with shared counters and B attribution; [scope and limits](shared-learning-acceptance.md). Corpus and stack isolation remain separate evidence | W13 for the isolation half only | Two organisations on one stack: no cross-org trace/workspace/corpus read. The SHARED half — a recipe learned by one organisation dispatched by the other's next run — is assertable in one process since 2026-09-15 and needs no stack; it is the only mechanical proof that the decision was implemented and not merely documented. |

Order: ~~W8-a~~ → ~~W4a~~ → ~~W5~~ → ~~W6~~ → ~~Gate 0~~ → ~~W4~~ → ~~W0~~ → ~~W1~~ →
~~W2~~ → ~~W3~~ → ~~W7~~ → ~~W13~~ → W14. W8-a and W4a landed on 2026-09-17, W5, W6 and W4 on
2026-09-18, and Gate 0 was decided the same day on what they measured. The launcher line (W1–W3, W7) is implemented locally on 2026-09-19, with
service/worker/volume runtime proof recorded on 2026-09-20. W13 subsequently passed;
W14 corpus/trace isolation acceptance remains; this
does not close the other operational items in the table or constitute a migration.

What W4a measured, and what Gate 0 should read from it: reverting only the
eleven `.immediate()` calls, with the explicit `busy_timeout` left in place,
kills a writer with `SQLITE_BUSY` in
`tests/registry-concurrent-writers.test.ts`. Four processes contending on one
store file is not a future topology to design for — it is the one that runs,
and SQLite serialises it correctly once the write lock is taken before the
read.

Outside that sequence: decision 1 was taken on 2026-09-18 (retained,
journaled). W9/W10/W11 and the shared-learning arm of W14 passed CI at
`4788dfd`. W12 now has a terms draft. The [acceptance receipt](saas-acceptance-2026-09-20.md)
is the current list of remaining evidence; completed checks do not need repeating
without a relevant code change.

### Owner decisions, taken 2026-09-18

Taken together under one mandate: stabilise the instance that runs; no
storage migration, no new heavy mechanism. Each decision names what it
unblocks and what it deliberately leaves for later.

1. **Platform-admin cross-organisation read is retained, and every such read
   must be journaled.** The exposure is real but the power is the operator's
   own on the operator's own host; removing it would remove support. What
   changes is that it stops being silent: W11 becomes "journal each of the
   five widening paths as a `security`-severity platform event naming the
   admin and the organisation read, and notify the organisation through the
   one notification source". NOT designed in this session: the run index is
   polled every second by the admin's own browser, so a naive journal row per
   read would flood the 50 000-row journal in a day. The de-duplication rule
   (per admin, per organisation, per session, or per window) is designed
   once, against a measured poll rate, as one reviewed commit — the
   cooling-off rule. No expiry column and no time-bound grant for now: the
   `grant-admin`/`revoke-admin` CLI is the bound.
2. **Retention: 90 days for run traces and workspaces of finished runs,
   aligned with platform events; `lifecycle_events` is never swept.** It is
   the integrity record `ledger check` folds over, and a fold over a
   truncated history is exactly the false IMPOSSIBLE the ledger exists to
   rule out. W9 is an operator-run, audited job; the preview TTL is its
   shape precedent.
3. **BYO-key only.** The platform does not meter or rebill API keys it
   holds; an organisation spends its own keys or its members' subscriptions,
   and the host's keys are the operator's cost. W10 therefore has no
   financial half: it is per-organisation concurrency, on the model
   `PreviewManager.assertCapacity` already applies to previews. The payer
   ledger (W5) stays the record of who paid, for the operator's own books.
4. **Gate 0: hardened SQLite**, recorded above with its evidence.
5. **Terms: the commons is the product.** A run contributes what it learns
   and consumes what others learned, with organisation boundaries on
   projects, workspaces, traces and corpora only (the 2026-09-15 decision).
   W12 is a legal text stating exactly that, separate from AGPL-3.0; no
   engineering, and the text is the owner's to write or commission.
6. **The launcher stays stateless.** Leases and TTLs persist in a
   machine-local file, as the MCP run lease already does, never in the
   product store. W3 is thereby un-gated and the launcher arm never becomes a
   store writer.

Decision 1 was the one the owner had asked to take without waiting; its
journaling design is the one piece of engineering here that is scoped but
deliberately not built in the session that scoped it.

Closed since the previous review, by the 2026-09-15 decision: who approves
global bodies (nobody — there is no gate); whether a dynamic atom can become a
platform atom (it already is one); whether the prefilter existence oracle is
accepted (yes); whether instruction-text bodies get a lighter admission path
(moot). Reopening any of them means reopening the decision itself.

## 4. Historical evidence

Evidence, not a second contract. The complete pre-reconciliation document is
preserved verbatim as
[pre-reconciliation evidence](incidents/saas-architecture-evidence-through-2026-08-28.md).
Older code comments and dated reviews that cite former §3, §4.2, §5, §7, T2,
T3, Track A or Track B resolve through the legacy map below.

### Evidence chronology

| Date | Finding or decision | Disposition | Evidence |
|---|---|---|---|
| 2026-08-09–14 | In-process `ToolSandbox` was not an OS boundary; an allowlisted shell child could traverse or use absolute paths. | Worker isolation and egress topology implemented; production launcher still missing. | [engineering record](incidents/engineering-record-2026-08-14.md#saas--multi-tenancy--docssaas-architecturemd), `tests/workspace-outside-repo.test.ts`, `tests/container-isolation.test.ts` |
| 2026-08-09–14 | A global skill body plus global trust could transfer execution rights or sabotage counters across tenants. | Led to the body/trust split premise, later withdrawn (2026-09-15). The threat is unchanged and is why mutually distrusting organisations are unsupported. | [archived attack chain](incidents/saas-architecture-evidence-through-2026-08-28.md#41-the-evidence); [offer review](platform-skill-offer-review-2026-08-23.md) |
| 2026-08-09 | `scanScriptBody` accepted 8 of 9 concat-obfuscated payloads; one host class skipped the external-URL check. | Hygiene filter only; never an authorization gate (R5). | [archived reproduction](incidents/saas-architecture-evidence-through-2026-08-28.md#41-the-evidence); `tests/script-scan.test.ts` |
| 2026-08-09 | An all-dot atom/skill component escaped the skills root; removed ordinals could resurrect a namespace. | Both fixed at persistence/path boundaries. | `tests/atom-name-path-escape.test.ts`, `tests/registry-remove.test.ts` |
| 2026-08-17–18 | Identity audit mapped 221 sites; 163 would break on a blind name→id flip. | UUID identity, one namespace derivation and display resolution landed. | [archived identity audit](incidents/saas-architecture-evidence-through-2026-08-28.md#92b-what-the-nameid-flip-actually-requires-mapped-2026-08-17); [code review 2026-08-18](code-review-2026-08-18.md), `tests/atom-identity.test.ts` |
| 2026-08-17–18 | Provider auth mutated ambient env and killed the process; tier pins could escape the snapshot. | Per-run snapshot, `RunnerConfigError`, tier-pin application landed. | `src/run/auth.ts`, `tests/provider-selection.test.ts` |
| 2026-08-20 | Auth/projects/GitHub gate landed while registry and trust remained instance-global. | Multi-org control plane is current. | commit `4459dc0` |
| 2026-08-23 | Four-post offer workflow proposed: pre-screen, script attestation, powerless dossier, human approval. | Design only; obsolete since 2026-09-15 — there is no boundary for a body to cross. | [platform skill offer review](platform-skill-offer-review-2026-08-23.md), [session snapshot](decided-not-built-2026-08-23.md) |
| 2026-08-27–28 | Encrypted BYO keys and per-tier model precedence landed; narrow operator host-subscription exception decided and implemented. | Current behaviour; no consumer-subscription passthrough. | [subscription decision](subscription-per-tier-design-2026-08-28.md), commit `6a033b3` |
| 2026-08-28 | Deployment selected Docker images plus one in-house launcher; Kubernetes deferred behind the interface. | Closed contract and in-process backend implemented; separate service, images, stack and volumes missing (W1–W3, W7). | [launcher decision](deployment-docker-launcher-2026-08-28.md), [launcher contract](../src/launcher/AGENTS.md) |
| 2026-09-02 | PostgreSQL migration analysis. | Input to Gate 0, not a decision. | [analysis](postgresql-migration-analysis-2026-09-02.md) |
| 2026-09-04 | Principal-scoped Codex device login, private profiles, personal payer rows. | Current; extended to L1 later. Personal Claude login unavailable. | `src/auth/subscriptionProfiles.ts`, `src/contracts/runPayers.ts` |
| 2026-09-06 | Premise: skills are a commons; the organisation bounds trust and execution rights, not knowledge. | Superseded 2026-09-15: the organisation bounds neither knowledge nor trust. | [public release record](public-release-2026-09-06.md) |
| 2026-09-08 review | Codex on all tiers, three-row payer ledger, compiled auth/MCP OAuth smoke. | Reconciled state at the time. | `scripts/auth-release-smoke.mjs`, `tests/project-coordinator.test.ts` |
| 2026-09-09 | Per-owner registry: `atom_types` keyed by `operator` or `(orgId, projectId)`; each project bootstrapped and trusted its own copies. Downstream privacy audit of retrieval paraphrase. | Folded back 2026-09-15 with backup (`*.before-platform-registry-<uuid>.db`, `atom_id_merges`). The privacy risk is unchanged; its partition answer is withdrawn. | [ownership record](project-registry-ownership-2026-09-09.md), [retrieval record](incidents/project-retrieval-record-2026-09-09.md) |
| 2026-09-14 | Offline recovery drill on the local store; acceptance-contract proposal. | Local evidence only; W8 needs the hosted equivalent. | [recovery drill](recovery-drill-2026-09-14.md), [acceptance contract](acceptance-contract-2026-09-14.md) |
| 2026-09-15 morning | Per-project skill trust (`.trust/<project>/<sha>/`), project runs unable to promote/dispatch/drop/merge. | Folded back the same day (`reconcilePlatformSkills`). | commit `9e1d670` → `2911881` |
| 2026-09-15 | **A run is a run.** One registry, one catalogue, one trust, one lifecycle. Promotion, dispatch and the prefilter cache at host defaults for tenant runs. Recoverable atom trust. | Current design. Mutually distrusting organisations on one instance are not a supported shape. | [platform trust](platform-trust-2026-09-15.md), [recoverable trust](recoverable-trust-2026-09-15.md), commits `2911881`, `63f5317`, `418b25d`, `5d0e0ac` |
| 2026-09-16 review | This reconciliation: Track A/B retired, T2/T3/R1 rewritten, remaining work listed as W1–W14. | No new acceptance run; no closure of Gate 0. | this document at `76c041f` |
| 2026-09-17 → 18 | W8-a, W4a, W5, W6 landed; Gate 0 and owner decisions 1–6 taken under a stabilisation mandate (hardened SQLite, no migration). | Current design. W11's journaling design and W4 remain the next engineering. | commits `bdb6bf9`, `8a4f2ff`, `5154832`, `437c713`, and this document |

<a id="3-prerequisite-f1-the-sandbox-is-not-an-isolation-boundary"></a>

### Isolation evidence

The original reproduction launched an allowlisted shell with only `cwd` as a
filesystem constraint and read a marker outside the workspace. Moving the
default build workspace out of the repository reduced accidental blast radius;
it did not create a security boundary. The container worker then proved the
required shape: workspace-only mount, no direct host/control-plane
reachability, loopback inside the workload, optional outbound access only
through the per-run proxy topology.

The lasting conclusion is T1 plus D1–D4: isolation is a workload and
deployment property, not a repository-layer `WHERE org_id = ?`. The
2026-09-15 decision makes this literal: there is no `org_id` on the registry
to filter by, and the only isolation the platform claims is the one the
container provides.

### Shared-learning threat evidence

The historical attack chain established five facts that remain true:

1. bodies are distilled from tenant-influenced tasks and outputs;
2. a script skill's first injection is already execution, before deterministic
   dispatch trust;
3. static scans are intentionally incomplete and bypassable;
4. output envelopes prove what a script reports, not everything it did;
5. pooled failures are also an availability attack.

Between 2026-08-14 and 2026-09-15 the answer was a partition: bodies travel
only through a human gate, and trust restarts per organisation. The owner
withdrew that answer on 2026-09-15 after reading the Registry as a freshly
invited member with zero runs: an empty registry per organisation defeats the
product. Container isolation now carries the whole security claim — it bounds
what a hostile body can reach, not who wrote it — and the product claim is
correspondingly narrowed to organisations that accept pooling.

### Identity and cache evidence

The 221/163 identity audit explains why the UUID flip required one namespace
derivation and display resolution before changing the key. It also records a
deleted migration harness whose database stamp and filesystem rename were not
atomic; that failure is evidence for Gate 0's migration-ownership and cutover
requirements. The 2026-09-15 fold (`migrateRegistryToPlatform`) applied the
lesson: one immediate transaction, a whole-file backup first, and a fold that
cannot complete leaves the partitioned store untouched.

The prefilter cache analysis found that a byte-identical content-addressed key
does not reveal input content the requester lacks, but a hit exposes a weak
existence/volume oracle through timing and observability. The project path
disabled the shared cache during the partitioned period; since 2026-09-15 the
oracle is accepted as a consequence of the commons.

### Accepted, rejected and deferred

- **Accepted and implemented:** UUID atom identity; one platform registry,
  catalogue and trust; recoverable atom trust; per-run credential snapshots;
  BYO keys; narrow per-tier host subscription; Element-worker isolation and
  per-run egress topology; the closed launcher contract with an in-process
  egress/preview backend; principal-owned Codex on all tiers and the three-row
  payer contract.
- **Implemented and accepted in the W13 deterministic scenario (2026-09-20):** separate launcher service, worker transport and managed volumes (W1–W3), plus web image and reference stack (W7); see [launcher setup](launcher-service.md) and [stack setup](packaged-stack.md).
- **Also implemented:** atomic skill counters, the durable payer ledger and scoped lifecycle attribution (W4, W5, W6).
- **Superseded:** the body/trust split, organisation-local trust, the
  platform body offer/approval workflow, the per-owner registry and the
  per-project skill trust. Their records stay as evidence.
- **Rejected:** cross-org trust corroboration as a trust tier; static scan as
  authorization; raw Docker options at the launcher boundary; `docker.sock`
  in the web container; a standalone bucket-directory re-key.
- **Deferred:** Kubernetes until multi-node scheduling, platform-enforced
  quotas or launcher ownership becomes the larger operational cost.

### Legacy section map

| Former reference | Current home |
|---|---|
| §1 target and provider identity | Layer 1 current state; Layer 2 identity, T10 |
| §2 resource classification | Layer 1 scopes; Layer 2 resource ownership |
| §3 sandbox prerequisite (F1) | Layer 2 T1, D1–D4; Layer 4 isolation evidence |
| §4.1 attack chain | Layer 4 shared-learning threat evidence |
| §4.2 safe construction, T2/T3 (pre-2026-09-15), shared-learning construction | Superseded; Layer 4 threat evidence and chronology 2026-09-15 |
| §5 invariants | Layer 2 T1–T10 |
| §6 repository changes, Track A / Track B, phase table | Layer 3 work items W1–W14 |
| §7 rules for today | Layer 2 R1–R11 |
| §8 open/rejected questions | Layer 3 open decisions; Layer 4 dispositions |
| §9 build order and migration audit | Layer 3 order; Layer 4 identity evidence |

### Verification and release evidence

```bash
npm run docs:check
npm run check
npm run release:check
npm run doctor -- --container
```

Release acceptances [v0.1.1](release-acceptance-v0.1.1.md) and
[v0.1.3](release-acceptance-v0.1.3.md) prove packaged MCP, worker/egress and
compiled lifecycle properties from their dates; they predate the multi-org,
BYO and host-subscription control plane. `release:check` runs
[`scripts/auth-release-smoke.mjs`](../scripts/auth-release-smoke.mjs) against
the compiled viz server and auth CLI — founder login, CLI invitation, member
admission, PKCE, MCP OAuth, session gating, logout — with a loopback identity
provider and a temporary store. That verifies the packaged auth path, not a
hosted container stack or live inference funding. W13 subsequently passed a
deterministic assembled-stack scenario; W14 corpus/trace isolation remains. See the
[current evidence receipt](saas-acceptance-2026-09-20.md).
