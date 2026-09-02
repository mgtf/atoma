# atoma SaaS architecture

> **CURRENT REVIEW: 2026-08-28 · repository state `0a7104b`.**
>
> This document is the architecture boundary for hosted atoma. It is organised
> in four layers on purpose:
>
> 1. **Current state** is descriptive and dated.
> 2. **Normative invariants** are constraints every implementation must
>    satisfy; current deviations are named explicitly.
> 3. **Roadmap** separates the dedicated Track A product from the multi-tenant
>    shared-learning Track B product.
> 4. **Historical evidence** links the incidents, measurements and rejected
>    designs that established those rules.
>
> The short verdict is: atoma now has a locally implemented, opt-in
> multi-organisation control plane and an organisation-scoped project corpus.
> It is neither a production SaaS deployment nor the Track B shared-learning
> system. Do not use the existence of auth tables or projects as evidence that
> the atom catalogue, trust state or lifecycle ledger are tenant-safe.

## 1. Current state — 2026-08-28

### Status and claim boundary

The authenticated product surface is substantially beyond the original
dedicated-instance gate:

- `AuthStore` persists principals, provider identities, organisations,
  memberships, sessions, invitations, account model pins, organisation model
  defaults and encrypted organisation provider keys.
- An unknown provider subject logging in without an invitation creates a new
  personal organisation. An invitation joins its target organisation. A
  principal may belong to several organisations and select an active one.
  Therefore **one organisation per deployment is not mechanically enforced**.
- A persisted product run belongs to exactly one project, and that project
  belongs to exactly one organisation. Gated project, run, trace, workspace,
  GitHub installation and publication reads are scoped from the authenticated
  viewer, not from an organisation id supplied by the browser.
- Project learning is enabled and isolated under the project's own skills
  root. Promotion, deterministic skill dispatch and the shared prefilter cache
  are disabled for project runs.
- The atom catalogue, atom trust counters and lifecycle ledger remain
  instance-global. They are opened from the same product SQLite store for every
  project run.
- The platform event journal is organisation/project/run-scoped; it does not
  replace the unscoped lifecycle ledger.

The supported claim today is therefore:

> atoma has a multi-organisation control plane with an organisation-scoped
> project corpus and conservative, project-local learning.

The following claims are not supported:

- production hosted SaaS;
- isolation between mutually untrusted organisations at every decision point;
- safe or approved cross-organisation skill or atom-body sharing;
- organisation-local atom trust;
- an approved platform body catalogue;
- metered platform-key rebilling or end-user provider-subscription passthrough.

### Current ownership model

`Principal` is the internal actor. Provider subjects and email snapshots stay
in the auth plane; product rows use `principal_id`. The schema supports human,
service and system principals, although not every non-human writer has been
migrated to a first-class principal yet.

`Organisation` is the current authorization boundary and the target isolation
and billing boundary. `Project` is optional as an organisation resource, but it
is **mandatory for every persisted product run**. A future API may create a
default project for convenience; storage still records a `project_id`.

```text
Platform
├── Organisation
│   ├── Membership (principal × organisation × role)
│   ├── Provider keys and model defaults
│   └── Project
│       ├── Project skills
│       └── Run
│           ├── Workspace
│           ├── Trace
│           ├── Declared artifact manifest
│           └── Publication
└── Instance-global substrate — not Track B safe yet
    ├── Atom catalogue
    ├── Atom trust counters
    ├── Lifecycle ledger
    └── Prefilter cache table
```

Current resource scopes:

| Resource | Current scope | Current behavior |
|---|---|---|
| Principals, identities, sessions | instance control plane | Provider identities join on `(provider, subject)`, never email. A session names one active organisation. |
| Projects, project runs and cost | organisation | A run has one project and one requesting principal. `org:viewer` reads but cannot execute. |
| Traces, workspaces and manifests | project/run | `projectRunHostLayout` stores them below `orgs/<org>/projects/<project>/runs/<run>`. |
| Project skill bodies and counters | project filesystem | Learning is on. Promotion and deterministic dispatch are off. Nothing is offered to another project or organisation. |
| Atom bodies and trust | instance SQLite row | `atom_types.successes/failures` have no `org_id`. Dynamic atom types have no platform/org scope column. |
| Lifecycle ledger | instance SQLite table | `lifecycle_events` has `at/kind/entity/detail` and no `org_id` or `store_id`. Atom entities remain name-keyed. |
| Platform events | organisation/project/run-aware | The control-plane audit journal already carries nullable scope ids and retention. |
| Prefilter decisions | instance SQLite table | Content-addressed and transactionally stored, but disabled for project runs because policy on the cross-org existence signal is not settled. |
| Provider credentials | organisation or host, injected per run | Organisation keys are encrypted at rest. Selection follows account pin → organisation default → host default; the resolved run receives only its credential snapshot. |
| Host subscription | operator exception | Whole-run and per-tier regimes exist only through the platform-admin door; the per-tier form is limited to one operator-declared organisation and re-authorised per run. |
| Operator CLI/MCP run corpus | instance operator scope | It remains separate from the gated project corpus and is not exposed as tenant data. |

### Implemented safeguards

Project runs apply the current conservative tenant profile mechanically in
`projectRunEnvironment` and `ProjectRunCoordinator`:

- `ATOMA_REQUIRE_ISOLATION=1` and `ATOMA_CONTAINER=1`;
- `ATOMA_EGRESS=0` unless a future reviewed product policy changes it;
- a run-specific workspace, trace directory and artifact manifest;
- a project-specific skills directory;
- skill learning and skill events on;
- skill promotion and deterministic dispatch off, in both environment and CLI
  flags so a maintenance seed cannot silently re-enable them;
- the shared prefilter cache off;
- `ATOMA_TENANT_RUN=1` so the child process re-checks machine-bound transports.

The Element worker container mounts only the workspace, uses a deny-by-default
network, drops capabilities, sets `no-new-privileges` and applies resource
bounds.

The optional egress topology uses one internal network and one proxy sidecar per
run; the control plane is not directly reachable from that network.

Surrogate atom identity is implemented with a UUID `atom_id`. Skill namespaces
derive from that id through `namespaceOf`, while operator surfaces resolve a
display name. Path traversal through all-dot components and removed-identity
resurrection are both fixed and regression-tested.

Provider construction consumes a per-run environment snapshot. Configuration
errors throw `RunnerConfigError` instead of exiting the process. Machine-bound
transports are refused for tenant work unless the parent explicitly authorised
the platform-admin host-subscription exception and the child receives the exact
authorised tier set. `RunPayerLedger` computes the payer for base, L1, L2 and
L3. Today that full ledger is persisted only when a run touches the host
subscription; pure organisation-key or host-key attribution remains transient.

Provider login remains identity only. It never grants inference entitlement.
Per-run organisation or host API-key snapshots and the operator's deliberately
narrow host-subscription exception are inference funding mechanisms; an end
user's ChatGPT, Claude or other consumer subscription is not.

### Missing production substrate

The model-authored Element worker has an OS boundary. The production
control-plane/launcher boundary does not: Docker lifecycle and host-path
workspaces have not moved behind the separate launcher.

The decided deployment target is Linux and Docker images with a separate
launcher:

- the web/control-plane container never mounts `docker.sock`;
- the launcher is the only Docker API holder;
- callers use a closed typed interface, never raw image names, commands,
  environment maps, mount paths or Docker options;
- workspaces become launcher-managed volumes;
- leases, TTLs, orphan reconciliation and reverse-order teardown move behind
  the launcher boundary;
- the same boundary launches each run's Element worker and egress sidecar, and
  result-preview workloads.

That direction is recorded in
[the Docker launcher decision](deployment-docker-launcher-2026-08-28.md)
and is not implemented. There is a worker image, but no web image, launcher
image, reference stack or volume migration.

Other production gaps are:

- no accepted product-store backend for multi-writer tenancy;
- no trust split or platform body catalogue;
- no hosted backup/restore and disaster-recovery contract;
- no trace/workspace retention policy;
- no platform-enforced quotas or metered rebilling;
- no durable per-tier payer attribution for runs that touch only organisation
  or host API keys;
- `platform:admin` cross-org read is ordinary operator power today, not a
  break-glass flow with customer notification;
- no release acceptance covers the current auth/projects/BYO/host-subscription
  control plane.

### The next code decision

**The next code decision is hardened SQLite versus PostgreSQL.**

The dated analysis and recommended PostgreSQL migration shape are recorded in
[PostgreSQL migration analysis — 2026-09-02](postgresql-migration-analysis-2026-09-02.md).
It is an input to this gate, not an accepted owner decision by itself.

It precedes the trust split. `atom_trust`, `skill_trust`, platform body,
approval and scoped lifecycle-event tables must not be added under a
“temporary” backend assumption. Every table created before the choice adds a
second schema, migration, fixture set, backup story and cutover path.

Track A can justify hardened SQLite if it deliberately remains a one-node,
bounded-writer product. Track B, multiple control-plane nodes or database-level
tenant concurrency strongly favour PostgreSQL. This is a topology decision,
not a query-syntax preference; Layer 3 defines the decision gate.

## 2. Normative invariants

This layer defines the accepted constraints for either roadmap track; it does
not claim that the current implementation already satisfies them. Layers 1
and 3 name the gaps. New work must not deepen those gaps. A future design may
change an invariant only by naming the threat it replaces and providing
stronger evidence. “The code happens to work this way today” is not such
evidence.

### Tenancy, identity and authorization

- The organisation is the maximum trust and isolation boundary. A project may
  be stricter; no runtime trust signal may be broader.
- Product data references an internal principal. Provider subjects and email
  claims do not flow into domain keys or paths.
- Identities link only on `(provider, provider_subject)`. Email is a display
  snapshot, never an automatic join key.
- Provider login is an identity signal, never an inference entitlement.
- Read of costs is not authority to execute. `org:viewer` cannot start or
  cancel a run.
- If platform-admin cross-org read survives, it is break-glass: explicit,
  attributable, audited and subject to a product decision on customer
  notification.

### Resource ownership

| Resource | Normative target scope |
|---|---|
| Run record, trace, cost and publication | organisation/project |
| Workspace and artifacts | run-private, readable only through organisation policy |
| Canonical platform atom body | platform |
| Dynamic atom body | organisation until explicitly offered and approved |
| Atom trust | organisation or stricter |
| Organisation-authored skill body | organisation/project |
| Approved platform skill body | platform body with immutable approval provenance |
| Skill trust, matches and demotion state | organisation or stricter |
| Lifecycle event | store + organisation + stable entity; project/run/actor where applicable |
| Platform event | explicit audience and nullable organisation/project/run scope |
| Raw trace content | never platform-learning input |
| Prefilter decision | explicit policy: platform content-addressed with accepted oracle, or organisation-salted; never accidental sharing |
| Provider credential | organisation or platform/host owned; injected as a per-run snapshot and never inferred from login |

### Deployment invariants

**D1 — The web/control plane never holds the Docker socket.** The launcher is
the only component allowed to create or destroy workloads.

**D2 — The launcher accepts closed profiles, not Docker syntax.** A caller
cannot choose an image, mount, network, command, capability or arbitrary
environment entry.

**D3 — Every run's model-authored Element workload receives its own boundary.**
Its only writable product mount is its workspace volume. Other workspaces,
stores, skills, credentials and the control plane are unreachable from that
workload. Egress is deny-by-default.

**D4 — Lifecycle ownership follows workload ownership.** The launcher owns
heartbeat, deadlines, bounded stop, reverse teardown and orphan reconciliation.
Kubernetes may later implement the same interface; callers do not change.

### Ten testable invariants

**T1 — No store is reachable from a run's model-authored execution sandbox.**
An Element worker cannot read the atom store, skills belonging to another
scope, credentials, control-plane state or another workspace through a
relative or absolute path. Network policy also blocks direct control-plane
access. The supervisor child receives the product-store path by design and is
outside this invariant.

**T2 — Trust counters never cross an organisation boundary.** Successes,
failures, direct failures, matches, promotion state and demotion streaks are
keyed by `(org_id, stable_entity_id)` or a stricter project scope. No aggregate
over organisations may feed a fast path.

**T3 — A body crossing an organisation boundary passes an approval gate.**
Both `kind: llm` and `kind: script` require an explicit offer and a human
approval record bound to the exact body version and hash. The reviewer reads
the script source or instruction text. Static scans and any future behavioural
attestation may provide evidence; neither can authorise distribution.

**T4 — Identity uses stable surrogate ids; names are display labels.**
`atom_id` is a UUID. Identity-critical references, namespaces and future trust
rows use stable ids. A human-readable name may accompany an event but cannot be
the only identity when correctness depends on it.

**T5 — No control-plane path or identity is derived from model output.**
Model-authored names, branch labels, task text and verdict prose cannot become
a control-plane filesystem component, primary key or persistent namespace.
Model-authored artifact paths are relative, mediated by `ToolSandbox` and
confined to the run workspace.

**T6 — Every counter mutation is one atomic database statement inside the
required transaction.** Whole-object read/modify/write sidecars are not an
acceptable multi-writer trust store. Promotion, reset and their events commit
with the counters they change.

**T7 — Every lifecycle event is attributable.** It carries `store_id`,
`org_id` and a stable entity id, plus project, run and actor when the event
arises in those scopes. Integrity projections group by the same keys.

**T8 — Raw traces never become global-learning input.** Traces contain prompts,
tool I/O and workspace excerpts. Only a reviewed distilled body can cross an
organisation boundary.

**T9 — Execution rights are role-gated.** Reading a run, trace or cost does not
grant the right to spend budget or execute model-authored code.

**T10 — Outbound provider credentials and payer decisions are per-run values.**
They are never ambient mutable process state. A machine-bound transport is
operator-only except for the explicit platform-admin, declared-organisation
host-subscription path, re-authorised per run, re-checked by the child and
recorded in the payer ledger.

### Shared-learning construction

Bodies and trust are different resources:

1. Organisation learning starts local and validated.
2. An offer names one exact body version and hash. The existing mechanical
   pre-screen may reject or prioritise it; it cannot approve it.
3. A human operator reviews the script source or instruction text, is the only
   “yes”, and journals the decision against that version and hash.
4. The receiving organisation starts the body at zero trust and earns its own
   clean validated executions.
5. Cross-org corroboration is not a trust tier. Self-serve organisations make
   it a linear Sybil cost and give the attack a misleading provenance story.

The proposed behavioural-attestation and powerless-dossier workflow is a
design candidate, not an invariant. Track B must accept, amend or reject that
design before implementation.

The platform value that survives is substantial: distillation and compilation
can be paid once, and an approved LLM recipe can guide a receiving
organisation's first validated run. What never transfers is permission to
execute without a validator.

### Engineering rules to apply now

The identifiers R1–R11 remain stable because code and historical reviews cite
them.

**R1 —** Never design correctness around platform-global counters.

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

## 3. Roadmap — Track A / Track B

### Track definitions and present position

| | Track A — dedicated deployment | Track B — multi-tenant shared learning |
|---|---|---|
| Organisations served | exactly one, enforced mechanically | many mutually untrusted organisations |
| Cross-org body sharing | none | reviewed platform bodies |
| Trust scope | instance is one organisation | organisation or project |
| Runtime isolation | mandatory | mandatory |
| Review workflow | not required for cross-org sharing | required and staffed |
| Storage topology | one-node hardened SQLite may fit | PostgreSQL is favoured if nodes/writers scale |
| Product claim | dedicated hosted atoma | hosted shared-learning SaaS |

The current repository is between the tracks: its control plane permits several
organisations, while atom trust remains instance-global. Project-local skills
and disabled deterministic dispatch contain one attack path, but they do not
make global atom trust tenant-safe. **Do not deploy the current instance to
mutually untrusted organisations and call it Track B.**

### Decision gate 0 — hardened SQLite or PostgreSQL

This gate is next and blocks the trust split.

| Criterion | Hardened SQLite | PostgreSQL |
|---|---|---|
| Intended topology | one control-plane node, explicitly bounded writers | multiple processes/nodes and database-mediated concurrency |
| Allocation | `BEGIN IMMEDIATE`, explicit `busy_timeout`, bounded retry on busy | row/advisory locks, serializable allocation where required |
| Schema lifecycle | one migrator, migration separate from ordinary open | versioned migrations and controlled rollout |
| Skill counters | move out of `_meta.json` into atomic tables | move into the same transactional schema |
| Backup/restore | coordinated file/WAL snapshot with restore drill | managed or operator-run logical/physical backup with restore drill |
| Failover | process/node recovery; no transparent multi-node failover claim | explicit pool, failover and connection recovery policy |
| Development | local file remains simple | provisioned dev/test database and isolated fixtures |
| Track fit | Track A if the one-node limit is a product constraint | Track B or any multi-node target |

The decision record must state:

1. maximum control-plane nodes and writer processes;
2. migration ownership and rollback/cutover policy;
3. allocation and counter transaction semantics;
4. backup, restore and disaster-recovery test;
5. local developer and CI provisioning;
6. the migration path for the existing product store and skill sidecars.

No `atom_trust`, `skill_trust`, platform-body, approval or redesigned
`lifecycle_events` table lands before this gate closes.

### Reconciled phase status

| Phase | Current status | Remaining work |
|---|---|---|
| 0 — product decisions | partial | Storage backend is next. Reviewer staffing, dynamic-atom offers, break-glass, retention, quotas and platform-key rebilling remain open. |
| 1 — OS boundary | Element sandbox implemented | Move Element worker/egress lifecycle behind the launcher/images/volumes boundary and add a hosted acceptance. |
| 2 — credentials per run | implemented | Preserve snapshot and child gates; close or explicitly bound SDK profile/WIF fallback outside tenant project runs. |
| 3 — surrogate identity | implemented for atom and skill namespace | Move remaining identity-critical lifecycle attribution from names to stable ids during the trust/ledger schema change. |
| 4 — bodies separated from trust | containment only | Implement scoped trust tables, atom scope and uniform home/donor policy after Gate 0. |
| 5 — storage concurrency | not decided | Execute the chosen backend plan; remove filesystem trust counters. |
| 6 — control plane | advanced locally | Add hosted deployment, lifecycle attribution, retention, quotas and release acceptance. |
| 7 — body offer/review | design only | Decide the staffed review contract, then build its approval record and platform catalogue after the trust split. |

### Track A — dedicated deployment exit criteria

Track A is the shortest honest hosted product. It does not require cross-org
learning, but it does require the production boundary:

1. Choose the product-store backend. If SQLite wins, implement and test the
   one-node contract rather than relying on low traffic.
2. Build the launcher, web/launcher images, pinned worker image and reference
   stack. The web image has no Docker socket.
3. Move run workspaces to launcher-managed volumes and put lease, TTL, stop and
   orphan recovery behind the launcher.
4. Make “one organisation per deployment” true at the admission boundary, or
   stop calling the product dedicated. Open self-signup cannot silently create
   a second organisation.
5. Keep per-run credentials and the operator subscription door mechanical and
   attributable.
6. Define trace/workspace retention, backup/restore, secret rotation and
   platform-admin procedure.
7. Add a release acceptance that boots the packaged stack and proves founder
   login, invitation, role enforcement, Element-workload isolation, delivery,
   restart, backup/restore and denied control-plane reachability.

### Track B — multi-tenant shared learning build order

Track B depends on the Track A runtime boundary and Gate 0. Its data work is one
coherent change, not a sequence of temporary schemas:

1. Create platform body identity/provenance, organisation/project trust and
   dynamic-atom scope under the chosen backend.
2. Move skill counters and promotion/demotion state out of sidecars.
3. Key trust and lifecycle attribution on stable ids and organisation/store;
   keep display names as projections only.
4. Apply organisation/project visibility before the existing deterministic
   bucket/tool compatibility filters.
5. Decide the prefilter policy explicitly: accept and document the
   content-addressed existence oracle, or salt/partition by organisation.
6. Close the body-offer decision, then build a staffed workflow with human
   approval and immutable version/hash provenance. The current candidate adds
   a mechanical pre-screen, script attestation and powerless dossier.
7. Add break-glass support access, customer-notification policy, quotas,
   retention and billing attribution.
8. Run an adversarial acceptance with two mutually untrusted organisations:
   no cross-org store/trace/workspace read, no transferred trust, no implicit
   body visibility, and an approved body arriving at zero trust.

The launcher can be built in parallel with the selected database foundation.
The platform offer workflow cannot safely precede the trust split.

### Open owner decisions

The storage backend is first. The remaining decisions can be prepared in
parallel but do not block writing its decision record:

1. Who approves global bodies, at what latency, and with which reviewer-fatigue
   countermeasure?
2. Can a dynamic atom ever become a platform atom, and what evidence is
   required?
3. Is platform-admin cross-org read retained; if so, is customer notification
   mandatory?
4. What are trace, workspace, platform-event and lifecycle-event retention
   periods?
5. Is the platform eventually a BYO-key product only, or will it meter and
   rebill platform API keys?
6. Is the prefilter existence oracle accepted for Track B?

## 4. Historical evidence

This layer is evidence, not a second contract. The complete pre-reconciliation
document is preserved verbatim as
[pre-reconciliation evidence](incidents/saas-architecture-evidence-through-2026-08-28.md).
Older code comments and dated reviews that cite former §3, §4.2, §5 or §7
resolve through the legacy map below.

### Evidence chronology

| Date | Finding or decision | Disposition | Evidence |
|---|---|---|---|
| 2026-08-09–14 | In-process `ToolSandbox` was not an OS boundary; an allowlisted shell child could traverse or use absolute paths. | Worker isolation and egress topology implemented; production launcher still missing. | [engineering record](incidents/engineering-record-2026-08-14.md#saas--multi-tenancy--docssaas-architecturemd), `tests/workspace-outside-repo.test.ts`, `tests/container-isolation.test.ts` |
| 2026-08-09–14 | A global skill body plus global trust could transfer execution rights or sabotage counters across tenants. | Normative body/trust split; project runs currently avoid sharing and disable promotion/direct dispatch. | [archived attack chain](incidents/saas-architecture-evidence-through-2026-08-28.md#41-the-evidence); [offer review](platform-skill-offer-review-2026-08-23.md) |
| 2026-08-09 | `scanScriptBody` accepted 8 of 9 concat-obfuscated payloads in the recorded corpus, and one host class skipped the external-URL check. | Hygiene filter only; never an authorization gate. | [archived reproduction](incidents/saas-architecture-evidence-through-2026-08-28.md#41-the-evidence); `tests/script-scan.test.ts` |
| 2026-08-09 | An all-dot atom/skill component escaped the skills root; removed ordinals could resurrect a namespace. | Both fixed at persistence/path boundaries. | `tests/atom-name-path-escape.test.ts`, `tests/registry-remove.test.ts` |
| 2026-08-17–18 | Identity audit mapped 221 sites; 163 would break on a blind name→id flip. Namespace text also reached prompts and operator surfaces. | UUID identity, one namespace derivation and display resolution landed. The non-atomic migration harness was later deleted after the one store converged. | [archived identity audit](incidents/saas-architecture-evidence-through-2026-08-28.md#92b-what-the-nameid-flip-actually-requires-mapped-2026-08-17); [code review 2026-08-18](code-review-2026-08-18.md), `tests/atom-identity.test.ts` |
| 2026-08-17–18 | Provider auth mutated ambient env and killed the process; tier pins could escape the snapshot. | Per-run snapshot, `RunnerConfigError` and tier-pin application landed. | `src/run/auth.ts`, `tests/provider-selection.test.ts` |
| 2026-08-20 | Auth/projects/GitHub gate landed while registry and trust remained instance-global. | Multi-org control plane is current; it is explicitly not Track B. | commit `4459dc0` and current subsystem contracts |
| 2026-08-23 | Four-post offer workflow proposed: pre-screen, script attestation, powerless dossier, human approval. | Design only. Project-local learning, its independent first step, later landed. | [platform skill offer review](platform-skill-offer-review-2026-08-23.md), [session snapshot](decided-not-built-2026-08-23.md) |
| 2026-08-27–28 | Encrypted BYO keys and per-tier model precedence landed. A narrow operator host-subscription exception was decided and implemented. | Current control-plane behavior; no consumer-subscription passthrough. | [subscription decision](subscription-per-tier-design-2026-08-28.md), commit `6a033b3` |
| 2026-08-28 | SaaS deployment selected Docker images plus one in-house launcher; Kubernetes deferred behind the interface. | Decided, not implemented. | [launcher decision](deployment-docker-launcher-2026-08-28.md) |

<a id="3-prerequisite-f1-the-sandbox-is-not-an-isolation-boundary"></a>

### Isolation evidence

The original reproduction launched an allowlisted shell with only `cwd` as a
filesystem constraint and read a marker outside the workspace. Moving the
default build workspace out of the repository reduced accidental blast radius;
it did not create a security boundary. The container worker then proved the
required shape: workspace-only mount, no direct host/control-plane reachability,
loopback inside the workload, and optional outbound access only through the
per-run proxy topology.

The lasting conclusion is T1 plus D1–D4: tenant isolation is a workload and
deployment property, not a repository-layer `WHERE org_id = ?`.

### Shared-learning threat evidence

The historical attack chain established five distinct facts:

1. bodies are distilled from tenant-influenced tasks and outputs;
2. a script skill's first injection is already execution, before deterministic
   dispatch trust;
3. static scans are intentionally incomplete and bypassable;
4. output envelopes prove what a script reports, not everything it did;
5. pooled failures are also an availability attack, not merely a code-execution
   risk.

Container isolation bounds the blast radius of model-authored Element
execution; it does not authorise a body for another organisation. That is why
the construction needs both a platform body review and organisation-local
trust.

### Identity and cache evidence

The 221/163 identity audit is retained in the archived document because it
explains why the UUID flip required one namespace derivation and display
resolution before changing the key. It also records a deleted migration
harness whose database stamp and filesystem rename were not atomic. The code is
gone after the only pre-production store converged. That failure is evidence
for Gate 0's migration-ownership and cutover requirements, including tests at
the real process/filesystem boundary.

The prefilter cache analysis found that a byte-identical content-addressed key
does not reveal input content the requester lacks, but a hit exposes a weak
existence/volume oracle through timing and observability. The old target
accepted that tradeoff; the current project path disables the shared cache.
This evidence is why Track B step 5 requires an explicit choice rather than
inheriting either behavior by accident.

### Accepted, rejected and deferred

- **Accepted and implemented:** UUID atom identity; project-scoped learning;
  per-run credential snapshots; BYO keys; narrow per-tier host subscription;
  Element-worker isolation and per-run egress topology.
- **Accepted, not implemented:** Docker-image deployment with a sole launcher.
- **Designed, not accepted as a shipped gate:** platform body offer workflow.
- **Rejected:** cross-org trust corroboration; static scan as authorization;
  raw Docker options at the launcher boundary; mounting `docker.sock` in the
  web container; a standalone bucket-directory re-key.
- **Deferred:** Kubernetes until multi-node scheduling, platform-enforced
  quotas or launcher ownership becomes the larger operational cost.

### Legacy section map

| Former section | Current home |
|---|---|
| §1 target and provider identity | Layer 1 current state; Layer 2 identity/T10 |
| §2 resource classification | Layer 1 current scopes; Layer 2 target ownership |
| §3 sandbox prerequisite | Layer 2 T1/D1–D4; Layer 4 isolation evidence |
| §4.1 attack chain | Layer 4 shared-learning threat evidence |
| §4.2 safe construction | Layer 2 T2/T3 and shared-learning construction |
| §5 invariants | Layer 2 T1–T10 |
| §6 repository changes | Layer 3 phase status and track roadmaps |
| §7 rules for today | Layer 2 R1–R11 |
| §8 open/rejected questions | Layer 3 open decisions; Layer 4 dispositions |
| §9 build order and migration audit | Layer 3 roadmap; Layer 4 identity evidence |

### Verification and release evidence

The active local verification commands remain:

```bash
npm run docs:check
npm run check
npm run release:check
npm run doctor -- --container
```

Release acceptances
[v0.1.1](release-acceptance-v0.1.1.md) and
[v0.1.3](release-acceptance-v0.1.3.md) prove packaged MCP, worker/egress and
compiled lifecycle properties from their dates. They predate the current
multi-org/BYO/host-subscription control plane and are not its acceptance.
Track A requires a new packaged-stack acceptance; Track B requires a separate
two-organisation adversarial acceptance.
