# atoma hosted architecture

> **CURRENT REVIEW: 2026-09-16.** Reconciled against source at `76c041f`
> after the owner decision of 2026-09-15 (*a run is a run*,
> [`platform-trust-2026-09-15.md`](platform-trust-2026-09-15.md)). This review
> records implementation state and available verification coverage, not a new
> test run or a hosted deployment acceptance.
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

## 1. Current state — 2026-09-16

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

- production hosted SaaS (no separate launcher, no web/launcher images, no
  reference stack, no packaged-stack acceptance);
- isolation between mutually untrusted organisations;
- a dedicated one-organisation deployment (self-signup creates organisations);
- durable payer attribution for runs funded by API keys only;
- platform-enforced quotas, metered rebilling, or a retention policy for
  traces and workspaces.

### Ownership model

`Principal` is the internal actor. Provider subjects and email snapshots stay
in the auth plane; product rows use `principal_id`. The schema supports human,
service and system principals, although not every non-human writer has been
migrated to a first-class principal yet.

`Organisation` is the authorization boundary for projects and execution
rights, and the billing boundary. `Project` is optional as an organisation
resource but **mandatory for every persisted product run**.

```text
Platform — shared by every run
├── Atom registry (atom_types, atom_type_versions, trust counters)
├── Skill catalogue (skills/<atom-id>/…, counters in _meta.json)
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
| Traces, workspaces, manifests | project/run | `projectRunHostLayout` stores them below `orgs/<org>/projects/<project>/runs/<run>`. |
| Retrieval corpus | project | Only the project's own passages are searchable (`ownPassages` stays 0 for another project). A validator's paraphrase of a passage, written into a prompt or a description, is platform knowledge. |
| Atom bodies and trust | platform | `atom_types` has no owner column; `AtomRegistry` takes a database and nothing else, and refuses an unfolded store. Readers keep `unfoldedRegistryPredicate` as a guard. |
| Skill bodies and counters | platform filesystem | Learning, promotion, deterministic dispatch, drop and merge are available to every run. Counters live in `_meta.json`, read-modify-write, single writer by construction (one run at a time). |
| Lifecycle ledger | platform SQLite table | `lifecycle_events(seq, at, kind, entity, detail)`. Type counters are keyed by name again; the atom-id-keyed project events of the partitioned period stay as byte-honest history and are not compared. |
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
L1, L2, L3 — each with selector, transport and payer. That ledger is journaled
when a run touches the host or requesting principal's subscription
(`onSubscriptionTransport` in `ProjectRunCoordinator` and the viz server);
pure organisation-key or host-key attribution remains transient.

Provider login is identity only and never grants inference entitlement.
Personal Claude subscription login remains unavailable pending the third-party
approval Anthropic requires.

Atom trust is recoverable since 2026-09-15
([`recoverable-trust-2026-09-15.md`](recoverable-trust-2026-09-15.md)):
historical counters survive patches and rollbacks, one failure no longer
excludes a type permanently, and automatic creation compares behaviour before
cloning.

### Missing production substrate

The model-authored Element worker has an OS boundary. The
control-plane/launcher boundary does not. `ContainerLauncher` is a closed
typed contract and `DockerLauncher` implements it for egress and preview
profiles, with workspace issuance and orphan-removal primitives — but the
backend runs **inside the viz server process**, workspace handles are host
directories, and the worker's attached stdio transport stays in
`src/tools/containerExecutor.ts`, outside the contract
([`src/launcher/AGENTS.md`](../src/launcher/AGENTS.md), *What is IN-PROCESS
today*). "The launcher owns the images and the flags" is a code-organisation
property, not yet a security boundary.

Decided target ([launcher decision](deployment-docker-launcher-2026-08-28.md)):
Linux, Docker images, one separate launcher service. The web container never
mounts `docker.sock`; the launcher is the only Docker API holder; callers use
closed profiles; workspaces are launcher-managed volumes; leases, TTLs, orphan
reconciliation and reverse teardown live behind the launcher; the same boundary
launches Element workers, egress sidecars and preview workloads. Images that
exist: `worker`, `preview`, `mender`. Images that do not: `web`, `launcher`.
There is no reference stack.

### The next code decision

**Gate 0: hardened SQLite versus PostgreSQL.** The dated analysis and the
recommended migration shape are in
[PostgreSQL migration analysis — 2026-09-02](postgresql-migration-analysis-2026-09-02.md);
it is an input, not an accepted owner decision. What it gates has narrowed
since 2026-09-15: there is no trust split to build on it. It gates (a) moving
skill counters out of `_meta.json` into atomic statements, (b) durable payer
attribution for API-key runs, (c) scoped lifecycle attribution, and (d) any
second writer — a separate launcher service, a second control-plane node, or
concurrent runs. Every table created before the choice adds a second schema,
migration, fixture set, backup story and cutover path.

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
- If platform-admin cross-org read survives, it is break-glass: explicit,
  attributable, audited and subject to a product decision on customer
  notification. Today it is ordinary operator power.

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
  commons are platform terms still to be written (decision 5, Layer 3).

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
`DockerLauncher` runs in the viz server process.*

**D2 — The launcher accepts closed profiles, not Docker syntax.** A caller
cannot choose an image, mount, network, command, capability or arbitrary
environment entry. *Satisfied at the contract level for egress and preview;
the worker path bypasses the contract for its stdio transport.*

**D3 — Every run's model-authored Element workload receives its own boundary.**
Its only writable product mount is its workspace. Stores, skills,
credentials, other workspaces and the control plane are unreachable from it.
Egress is deny-by-default. *Satisfied for the worker container; workspaces
are host directories, not launcher volumes.*

**D4 — Lifecycle ownership follows workload ownership.** The launcher owns
heartbeat, deadlines, bounded stop, reverse teardown and orphan
reconciliation. *Partially satisfied: primitives exist in-process; the worker
lifecycle is in `containerExecutor.ts`.*

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
ids. *Deviation: `lifecycle_events.entity` is name-keyed for type counters.*

**T5 — No control-plane path or identity is derived from model output.**
Model-authored names, branch labels, task text and verdict prose never become
a control-plane filesystem component, primary key or persistent namespace.
Model-authored artifact paths are relative, `ToolSandbox`-mediated and confined
to the workspace.

**T6 — Every counter mutation is one atomic statement inside the required
transaction.** *Deviation: skill counters in `_meta.json` are whole-object
read/modify/write, safe only while one run at a time is the enforced
topology (the MCP run lease). Closing it is Gate 0 work.*

**T7 — Every lifecycle event is attributable.** It carries a stable entity id
plus project, run and actor when it arises in those scopes. *Deviation: the
table has `at/kind/entity/detail` only.*

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

Next, and blocking items W3, W4, W5 and W8 below.

| Criterion | Hardened SQLite | PostgreSQL |
|---|---|---|
| Topology | one control-plane node, explicitly bounded writers | multiple processes/nodes, database-mediated concurrency |
| Allocation | `BEGIN IMMEDIATE`, explicit `busy_timeout`, bounded retry | row/advisory locks, serializable allocation where required |
| Schema lifecycle | one migrator, migration separate from ordinary open | versioned migrations, controlled rollout |
| Skill counters | move out of `_meta.json` into atomic tables | same, in the transactional schema |
| Backup/restore | coordinated file/WAL snapshot with restore drill | logical/physical backup with restore drill |
| Failover | process/node recovery; no multi-node claim | explicit pool, failover and reconnection policy |
| Development | local file stays simple | provisioned dev/test database, isolated fixtures |
| Fit | a one-node product with one launcher process as the only other writer | a separate launcher service plus web node, or any horizontal growth |

The decision record must state: (1) maximum control-plane nodes and writer
processes; (2) migration ownership and rollback/cutover policy; (3) allocation
and counter transaction semantics; (4) backup, restore and disaster-recovery
test; (5) local developer and CI provisioning; (6) the migration path for the
existing store and skill sidecars. The separate launcher (W1) is a second
writer of run state and must be counted in (1).

### Work items

| # | Item | Status | Blocked by | Done when |
|---|---|---|---|---|
| **W1** | Separate launcher service | contract + in-process backend done | — | `DockerLauncher` runs in its own container behind a permissioned socket; the web image holds no `docker.sock` (D1). |
| **W2** | Worker transport behind the launcher | not started | W1 design | The Element worker speaks a socket/network protocol issued by the launcher; `containerExecutor.ts` no longer owns attach/remove; `workerRunArgs` isolation assertions still pass (D2, D4). |
| **W3** | Launcher-managed workspaces | not started | W1, Gate 0 | Workspace handles are volumes, not host paths; lease, TTL, bounded stop, reverse teardown and orphan reconciliation are launcher operations (D3, D4). |
| **W4** | Skill counters out of `_meta.json` | not started | Gate 0 | Every counter, promotion and demotion mutation is one statement in one transaction with its ledger event (T6, R4, R8). |
| **W5** | Durable payer ledger for every run | subscription-touching runs only | Gate 0 | The three-row `RunPayerLedger` is persisted for API-key-only runs too, queryable per organisation and per run (T10). |
| **W6** | Scoped lifecycle attribution | not started | Gate 0 | `lifecycle_events` carries stable entity id, project, run and actor; type counters stop being name-keyed; integrity projections group by the same keys (T4, T7). |
| **W7** | Web, launcher images and a reference stack | worker/preview/mender images exist | W1 | Two more image definitions, one compose/stack file, digest pins; boots on a clean Linux host. |
| **W8** | Backup, restore, disaster recovery for a hosted store | `npm run backup` (dated, pruned, off-machine) | Gate 0 | A restore drill on the packaged stack, documented RPO/RTO, secret rotation procedure. The 2026-09-14 drill ([recovery-drill-2026-09-14.md](recovery-drill-2026-09-14.md)) covers the local store only. |
| **W9** | Trace and workspace retention | platform events only (90 d) | decision 2 | A retention window for `orgs/<org>/projects/<project>/runs/<run>/` traces and workspaces, enforced by a job the operator can run and audit. |
| **W10** | Quotas and cost ceilings per organisation | none | decision 3 | Per-organisation budget and concurrency limits enforced at run admission, visible in the console. |
| **W11** | Break-glass cross-organisation read | ordinary `platform:admin` power | decision 1 | Explicit, attributable, journaled, time-bounded, with the customer-notification policy the owner chooses. |
| **W12** | Platform terms | none | decision 5 | Terms of use covering what a run contributes to and consumes from the commons; separate from AGPL-3.0. |
| **W13** | Packaged-stack acceptance | `auth-release-smoke.mjs` (loopback IdP, temp store) | W1, W7 | Boots the stack; proves founder login, invitation, role enforcement, Element-workload isolation, delivery, restart, backup/restore and denied control-plane reachability from the worker network. |
| **W14** | Shared-learning acceptance | `tests/project-retrieval-privacy.test.ts` characterises the leak | W13 | Two organisations on one stack: no cross-org trace/workspace/corpus read, and a recipe learned by one is dispatched by the other's next run. |

Order: Gate 0 → W1 → W2 ∥ W4 ∥ W5 ∥ W6 → W3 → W7 → W13 → W14. W8–W12 depend on
owner decisions and can be prepared in parallel; W9 and W10 need only the
decision, not Gate 0.

### Open owner decisions

1. Is platform-admin cross-organisation read retained? If so, is customer
   notification mandatory, and at what latency? (W11)
2. Retention periods for traces, workspaces, platform events and lifecycle
   events. (W9)
3. Is the platform BYO-key only, or will it meter and rebill platform API
   keys? Quotas depend on the answer. (W10, W5)
4. Gate 0 itself: SQLite or PostgreSQL, with the six-point record above.
5. Under which terms does an organisation's run contribute to and consume the
   commons? These are platform terms, separate from the repository's
   AGPL-3.0 licence. (W12)

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
- **Accepted, not implemented:** the separate launcher service, worker
  transport migration, launcher-managed volumes, web/launcher images and a
  reference stack (W1–W3, W7); atomic skill counters, durable payer ledger and
  scoped lifecycle attribution after Gate 0 (W4–W6).
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
hosted container stack or live inference funding. W13 and W14 are the
acceptances this document still lacks.
