# PostgreSQL migration analysis — 2026-09-02

> **STATUS: recommendation for owner decision, not an accepted implementation
> contract. Repository state reviewed: `bcfc6d6`.**
>
> This note closes the investigation requested by
> [SaaS architecture decision gate 0](saas-architecture.md#decision-gate-0--hardened-sqlite-or-postgresql).
> It recommends PostgreSQL for a shared, multi-node, high-concurrency SaaS.
> It does not claim that changing the database alone makes the current product
> safe for mutually untrusted organisations.

## 1. Executive verdict

Choose **PostgreSQL as the authoritative product store** if atoma is intended
to become the Track B product described in `docs/saas-architecture.md`: several
mutually untrusted organisations, multiple control-plane processes or nodes,
and database-mediated concurrency.

Keep hardened SQLite only if the product deliberately remains Track A:

- one control-plane node;
- explicitly bounded writer processes;
- no transparent multi-node failover claim;
- one mechanically enforced organisation per deployment;
- local/offline operation as a first-class product property.

This is a topology and trust-boundary decision, not a query-syntax preference.
SQLite in WAL mode permits readers and a writer to proceed together, but it has
one writer at a time and its shared-memory WAL design expects all participants
on the same machine. PostgreSQL supplies database-mediated multi-writer
concurrency, row locks, advisory locks, transaction isolation, pooling and a
managed backup/failover path.

The migration is therefore justified for the stated SaaS target. It is not a
small driver replacement. The current implementation uses synchronous SQLite
APIs, applies schema at store open, relies on SQLite writer serialisation in
several critical sections, and still holds global trust state and filesystem
sidecars that are not tenant-safe.

Primary engine references:

- [SQLite write-ahead logging](https://www.sqlite.org/wal.html)
- [PostgreSQL explicit and advisory locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [`node-postgres` pooling](https://node-postgres.com/features/pooling)
- [`node-postgres` transactions](https://node-postgres.com/features/transactions)

## 2. What PostgreSQL solves — and what it does not

### 2.1 What it solves

For atoma's target control plane, PostgreSQL provides:

- concurrent writers without one database-file write lock serialising all
  domains;
- one authoritative store reachable from multiple service instances;
- row-level compare-and-set and locking for projects, runs, publications,
  preview generations and counters;
- transaction-scoped advisory locks for allocation and singleton work;
- bounded retry semantics for serialization failures and deadlocks;
- connection health, timeouts, pooling and failover policy;
- database roles and Row-Level Security as defence in depth;
- managed or operator-run logical/physical backup, point-in-time recovery and
  restore drills;
- standard visibility into active queries, transactions, locks and pool
  pressure.

There is no useful universal requests-per-second threshold at which SQLite
becomes wrong. The deciding load is the combination of writer concurrency,
transaction duration and node count. A single-node, read-heavy service may
remain healthy at substantial HTTP traffic. A much smaller workload can be a
bad SQLite fit when several processes contend on state transitions and
counters.

### 2.2 What it does not solve

PostgreSQL does not by itself provide:

- organisation-scoped atom or skill trust;
- safe cross-organisation body sharing;
- isolation of workspaces, traces or model-authored execution;
- a distributed launcher or admission queue;
- tenant quotas, retention or billing attribution;
- object storage for run artefacts;
- a safe platform-admin break-glass workflow.

The current catalogue, trust counters and lifecycle ledger remain
instance-global. Moving those rows byte-for-byte into PostgreSQL would make the
same unsafe trust signal available faster and from more nodes. The body/trust
split and scope migration must be part of the PostgreSQL programme before a
Track B deployment is exposed to mutually untrusted organisations.

## 3. Current persistence inventory

At the reviewed revision, the source contains approximately 30 tables in the
consolidated product store plus one separate operational SQLite table for the
machine-global MCP run lease.

| Domain | Current tables | Current scope or concern |
|---|---:|---|
| Authentication | 12 | Instance identities plus organisation membership, sessions, preferences and encrypted provider keys |
| GitHub | 4 | Principal authorization, organisation installations and webhook idempotency |
| Projects | 3 | Organisation-scoped projects, runs and publications |
| Preview | 3 | Organisation/project/run-scoped descriptors, instances and egress approvals |
| Push | 2 | Instance VAPID identity and principal subscriptions |
| Registry | 2 | Atom bodies, versions and global trust counters combined |
| Lifecycle ledger | 1 | Instance-global and still partly name-keyed |
| Platform events | 1 | Organisation/project/run-aware audit journal |
| Prefilter cache | 1 | Instance-global disposable cache; disabled for tenant project runs |
| Sentinel lease | 1 | Product-store singleton with local PID/fingerprint assumptions |
| MCP run lease | 1 separate DB | Deliberately machine-global operational lock |

The principal seams are:

- `src/core/stores.ts`: path resolution, synchronous handle cache, WAL setup
  and DDL-on-open;
- `src/registry/db.ts` and `src/registry/atomRegistry.ts`: registry schema,
  allocation, versions, trust counters and ledger coupling;
- `src/auth/store.ts`: the largest store, including convergence migrations and
  many immediate transactions;
- `src/projects/store.ts`: tenant-scoped data, state transitions and
  filesystem paths;
- `src/github/store.ts`, `src/preview/store.ts`, `src/platform/events.ts` and
  `src/viz/push/store.ts`: further DDL-owning stores on the same handle;
- `src/atoms/prefilterCache.ts`: a synchronous hot-path cache;
- `src/mcp/runLock.ts` and `src/sentinel/lease.ts`: two leases with different
  scopes that must not be conflated;
- `src/core/sqliteBackup.ts` and `src/cli/backup.ts`: WAL-safe file snapshots;
- direct read-only SQLite access in viz, MCP readers and operator CLIs.

Mechanical inventory at the reviewed revision found:

- 18 source files importing `better-sqlite3` directly;
- 24 test files importing it directly;
- at least 84 test files mentioning one or more affected store surfaces.

These counts are an impact indicator, not a migration acceptance criterion.

## 4. Recommended target boundary

### 4.1 PostgreSQL owns SaaS product state

PostgreSQL should become the source of truth for:

- principals, provider identities, organisations, memberships and sessions;
- invitations, OAuth states and platform-admin grants;
- model preferences and encrypted organisation credentials;
- projects, runs, publications and durable cost/payer attribution;
- GitHub authorizations, installations and webhook receipts;
- preview descriptors, preview instance state and egress approvals;
- platform events and push subscriptions;
- platform and organisation atom/skill identities and versions;
- organisation/project trust, counters and promotion/demotion state;
- attributable lifecycle events;
- distributed control-plane leases and job allocation.

The PostgreSQL service should be reached through one asynchronous product
database boundary. Domain repositories own their queries; callers do not
receive `pg.Pool` or `pg.PoolClient` directly.

### 4.2 SQLite remains only where locality is the contract

The MCP run lease should stay in SQLite. It is keyed by one machine and reasons
about PIDs, process groups and boot/process fingerprints. Moving it into
PostgreSQL would not turn those local identities into distributed ones.

If the offline/operator product remains supported, the owner must make an
explicit choice:

1. provision PostgreSQL locally for every product mode; or
2. retain an explicitly separate SQLite product adapter for the offline mode.

The second choice carries two implementations, two schema families and a
shared behavioural contract suite. A lowest-common-denominator SQL wrapper is
not recommended: it would obscure the different locking and migration
semantics without removing them.

### 4.3 Filesystem state gets a separate answer

PostgreSQL cannot make a host path visible on another node. In a multi-node
deployment:

- active workspaces belong to launcher-managed volumes;
- delivered traces and artefacts belong in object storage;
- PostgreSQL stores ownership, immutable storage keys, hashes, sizes and
  lifecycle state;
- skill body metadata and counters belong in PostgreSQL;
- large immutable skill bodies may live in object storage if storing them in
  PostgreSQL is not selected;
- `workspace_path`, `runs_path` and `log_path` must stop being portable
  identities or authorities.

This work is part of the hosted migration even though it is not SQL migration.

## 5. Database access and schema lifecycle

### 5.1 Replace the synchronous handle contract

`better-sqlite3` gives the application synchronous calls. A normal PostgreSQL
driver gives it asynchronous network operations. Store APIs and their callers
must therefore become asynchronous.

A minimal boundary is sufficient:

```ts
interface ProductDatabase {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
  transaction<T>(
    work: (tx: ProductTransaction) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T>;
  close(): Promise<void>;
}
```

Transactions must use one checked-out client for every statement from `BEGIN`
through `COMMIT` or `ROLLBACK`. The pool convenience query must not be used for
individual statements inside a transaction.

Expected propagation includes:

- auth gate, session resolution and OAuth callbacks;
- viz HTTP routes and bootstrap;
- project service, coordinator and publisher;
- preview and push services;
- registry reads, allocations and trust mutation in the supervision path;
- platform event emitters and listeners;
- sentinel readers and lease handling;
- MCP/CLI readers, commands, doctor and backup;
- shutdown paths, which must drain the pool.

The registry/supervision path is the highest-risk propagation. Long LLM work
must never hold a database transaction open. Reads may use bounded run-scoped
snapshots where appropriate; each allocation, state transition, counter/event
mutation or conflict resolution must remain a short database transaction.

### 5.2 Introduce versioned migrations

Schema construction and migration must stop happening in ordinary `open()`
methods. Add:

- ordered, immutable migration files;
- a `schema_migrations` table;
- one explicit migration command/process;
- a transaction-level advisory lock so only one migrator advances a database;
- a boot-time compatible-version check that does not mutate schema;
- expand/migrate/contract deployment rules;
- a failed-migration recovery and rollback policy.

The auth invitation rebuild, preview and push additive columns, project index
convergence and MCP repair loops cannot be copied as one generic mechanism.
Product schema changes become versioned PostgreSQL migrations. The MCP lock
database keeps its deliberately local repair behaviour.

### 5.3 Pool and connection policy

Add an explicit SaaS configuration such as `ATOMA_DATABASE_URL`, plus:

- TLS verification policy;
- connection timeout;
- query/statement timeout;
- lock timeout;
- idle-in-transaction timeout;
- bounded pool size;
- one total connection budget calculated across every service replica;
- health/readiness checks that distinguish process health from database
  readiness;
- graceful drain on shutdown;
- metrics for pool wait, checkout duration, active/idle clients and errors.

A single client serialises its queries. One unbounded pool per request or per
domain is equally wrong. The application should normally own one bounded pool
per database role and process.

## 6. SQL and type conversion

The first PostgreSQL schema must translate, rather than mechanically copy, the
following SQLite constructions:

| SQLite/current form | PostgreSQL target |
|---|---|
| `?` parameters | `$1`, `$2`, ... |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `bigint GENERATED ... AS IDENTITY` |
| ISO timestamps in `TEXT` | `timestamptz`, with one explicit API serializer |
| JSON strings plus `json_valid(...)` | `jsonb` |
| `BLOB` | `bytea` |
| integer booleans | `boolean` |
| `INSERT OR IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` |
| `INSERT OR REPLACE` | explicit `ON CONFLICT ... DO UPDATE` preserving intended fields |
| `lastInsertRowid` | `INSERT ... RETURNING` |
| `.changes` | `RETURNING` or driver `rowCount` |
| `rowid` ordering | an explicit identity/sequence column |
| `PRAGMA` / `sqlite_master` | versioned migrations and PostgreSQL catalog queries only where diagnosis requires them |
| `RAISE(ABORT, ...)` triggers | constraints, conditional updates, or PostgreSQL trigger functions |
| `.immediate()` | invariant-specific row/advisory locking or serializable retry |

Application ids can remain `text` in the first cut to minimise unrelated
identity churn. Converting them to PostgreSQL `uuid` should be a separate
decision backed by validation that every persisted production id is a UUID.

JSON conversion changes driver behaviour: PostgreSQL drivers normally return
decoded JSON values, while the current mappers expect strings and call
`JSON.parse`. Timestamp conversion likewise needs one policy so API payloads
remain ISO strings rather than leaking driver-specific `Date` behaviour.

## 7. Transaction semantics to preserve explicitly

There is no one-for-one replacement for `BEGIN IMMEDIATE`. Use the narrowest
primitive that states each invariant.

### 7.1 Atomic consume and compare-and-set

Use one conditional statement with `RETURNING` for:

- invitation consumption;
- OAuth state consumption;
- session organisation changes;
- run, publication and repository transitions;
- preview generation/state transitions;
- webhook deduplication and application;
- lease heartbeat/release by token.

For example, a state transition should update only where both ownership and
the expected prior state match, and determine conflict from the empty
`RETURNING` result. It must not become an unprotected read followed by a write.

### 7.2 Allocation

Registry ordinal/name allocation currently reads the held names and ordinals
and then inserts under SQLite's writer serialisation. In PostgreSQL it needs
one of:

- a transaction-level advisory lock keyed by allocation namespace/tier; or
- `SERIALIZABLE` isolation with a bounded retry of the entire transaction.

The selected mechanism must include version-history tombstones and cross-tier
name uniqueness exactly as the current allocator does.

### 7.3 Counters and their events

Every counter mutation must be one atomic SQL update, for example
`successes = successes + $delta`, and commit in the same transaction as the
required lifecycle event. Reset, promotion, demotion and compensation retain
their current safe-loss direction and audit requirements.

### 7.4 Error translation and retries

Repositories should translate PostgreSQL SQLSTATE codes into existing typed
domain errors, including at least:

- unique violation `23505`;
- foreign-key violation `23503`;
- serialization failure `40001`;
- deadlock detected `40P01`.

Only transactions declared retry-safe may retry. Retries are bounded, use
jitter, and replay the entire transaction callback. External effects such as
GitHub calls, container launch or push delivery must stay outside retryable
transactions.

## 8. Target tenant schema

The current `atom_types` row combines a body with global trust. Track B needs
separate identities and scopes. Exact names remain a design choice, but the
schema must express at least these resources:

- canonical platform atom body identity and immutable versions;
- organisation-scoped dynamic atom bodies;
- explicit body provenance, content hash and owner scope;
- organisation/project visibility or assignment;
- atom trust keyed by organisation or a stricter scope and stable body/entity
  id;
- skill body identity and immutable versions;
- organisation/project skill trust, match, direct-failure, promotion and
  demotion state;
- offer and human approval records bound to one exact body version and hash;
- lifecycle events keyed by store, organisation and stable entity id, plus
  project, run and actor where applicable;
- durable run payer attribution;
- an explicit organisation-scoped or explicitly accepted global prefilter
  cache policy.

An approved platform body arriving in an organisation starts at zero local
trust. Approval to see or inject a body is not permission for deterministic
execution.

### 8.1 Row-Level Security

RLS is recommended on tenant-owned tables as a second barrier behind existing
application filters and composite foreign keys.

Required operating rules:

- migrations run as a schema owner role;
- the normal runtime role neither owns tenant tables nor has `BYPASSRLS`;
- use `FORCE ROW LEVEL SECURITY` where the owning service role could otherwise
  bypass a policy;
- establish organisation context with transaction-local state on the same
  checked-out client;
- derive that context from the resolved authenticated session, never from a
  browser-supplied organisation id;
- no organisation context means default deny;
- retain explicit `org_id` predicates and composite foreign keys;
- use a separate narrowly privileged route/role for cross-organisation
  operator work;
- attribute and audit every break-glass access.

RLS is not the only boundary. PostgreSQL documents that superusers and
`BYPASSRLS` roles bypass it, table owners normally bypass it, and referential
integrity checks are not ordinary row-policy reads. Tests must exercise the
actual deployment roles, not only policy text.

## 9. Leases, scheduling and high traffic

### 9.1 MCP run lease

Keep `~/.atoma/mcp-run-lock.db` as SQLite. Its scope is one machine and its
recovery contract validates local PIDs and process groups. It remains outside
the product store.

### 9.2 Sentinel lease

The current Sentinel singleton lives in the product store but records a local
PID and process fingerprint. Rewrite it for multi-node operation with:

- stable deployment/node instance id;
- random ownership token and fencing generation;
- lease expiry based on database time;
- conditional heartbeat and release;
- atomic takeover only after expiry or an explicit operator-precedence rule.

An advisory lock alone is insufficient for a long-lived observable lease when
the application also needs incumbent metadata and fencing across reconnects.

### 9.3 Run allocation

High HTTP traffic does not justify unbounded LLM/container concurrency. The
control plane needs admission and backpressure independent of the database.
PostgreSQL may initially back a bounded job allocator using short transactions
and row locks, but the launcher remains the owner of workload lifecycle,
heartbeats, teardown and orphan reconciliation.

Do not hold a transaction while waiting for an LLM, GitHub, a worker, a
preview or user input.

## 10. Data migration and cutover

Prefer a controlled write freeze and verified import over application-level
dual-write. SQLite does not provide an existing change stream here, and a new
dual-write layer would create exactly the partial-commit ambiguity the
migration is meant to remove.

### 10.1 Importer responsibilities

Build an idempotent, versioned importer that:

1. reads a WAL-safe SQLite snapshot through the existing online backup helper;
2. validates the source schema before copying;
3. loads rows in foreign-key dependency order;
4. transforms timestamps, JSON, booleans and blobs explicitly;
5. copies encrypted envelopes byte-for-byte without decrypting or logging
   them;
6. maps global registry bodies and existing trust according to the accepted
   Track A/Track B policy rather than guessing an organisation;
7. imports skill sidecars with body hashes, owner ids and project/organisation
   attribution;
8. copies traces and artefacts to their selected storage and writes immutable
   storage keys/hashes;
9. records its own version, source snapshot identity and completion manifest;
10. is safe to rerun against an empty/recreated target.

Global trust and sidecars without an unambiguous owner are migration decisions,
not technical defaults. Refuse an ambiguous source instead of assigning it to
the first organisation.

The prefilter cache is disposable and should not be imported.

### 10.2 Cutover sequence

1. Provision PostgreSQL, roles, TLS, backups and monitoring.
2. Apply migrations with the release candidate.
3. Exercise the importer repeatedly on production-shaped snapshots.
4. Run the complete restore and adversarial acceptance before scheduling the
   cutover.
5. Stop admission of new runs and drain or cancel active work explicitly.
6. Freeze every SQLite product-store writer.
7. Take and retain a final WAL-safe snapshot plus skills/runs/archive backup.
8. Import the final snapshot and filesystem state.
9. Run structural, semantic and tenant-isolation verification.
10. Switch the control plane to PostgreSQL and run the packaged smoke.
11. Keep the SQLite snapshot immutable for the agreed retention period.

Rollback to SQLite is safe only until PostgreSQL accepts writes that do not
exist in the snapshot. The release plan must name that point of no return. A
post-write rollback requires a tested reverse export or a new forward repair;
changing the connection string alone would lose accepted state.

### 10.3 Migration verification

Verification must include:

- row counts by table and organisation;
- foreign-key and unique-constraint validation;
- identity and repository-target collision reports;
- byte equality for encrypted envelopes and hashes for immutable bodies;
- manifest, trace and artefact presence and hash checks;
- lifecycle projection compared with migrated counters;
- no trust assigned across an organisation boundary;
- no orphaned running/preview/publication state without an explicit
  reconciliation outcome;
- an import manifest retained beside the source snapshot and target backup.

## 11. Backup, restore and disaster recovery

The current backup command snapshots one SQLite file and archives local
directories. The PostgreSQL contract must instead state:

- managed or operator-owned physical/logical backup mechanism;
- point-in-time recovery policy if selected;
- RPO and RTO;
- retention and off-region/off-machine location;
- encryption and credential rotation;
- how object storage and PostgreSQL are restored to one consistent product
  point;
- a recurring restore drill into an isolated environment;
- integrity and packaged application smoke after restoration.

`backup` and `doctor` should report the configured backend and invoke or verify
the selected backend-specific contract. They must not present a copied SQL
dump as a complete product backup when skills, traces, artefacts or workspaces
are missing.

## 12. Test and release changes

PostgreSQL behaviour must be tested against PostgreSQL. A SQLite test adapter
cannot prove SQL dialect, lock, isolation, RLS or pool behaviour.

### 12.1 Test infrastructure

Add:

- a pinned PostgreSQL version for local development and CI;
- one isolated database or schema per parallel test worker;
- migration application before fixtures;
- shared typed fixture factories;
- deterministic cleanup that never targets a non-test database;
- a compiled/release smoke against the provisioned database.

Unit tests may mock domain repositories. Store and concurrency tests use the
real engine.

### 12.2 Required regressions

Use at least two independent connections or processes to prove:

- concurrent login and first-organisation creation;
- one-use invitation and OAuth state consumption;
- project slug and case-folded repository uniqueness;
- request-key and webhook idempotency;
- run/publication/repository transition compare-and-set;
- preview generation monotonicity;
- registry name/ordinal allocation;
- counter plus lifecycle-event atomicity;
- Sentinel lease takeover and fencing;
- serialization/deadlock retry boundaries;
- RLS isolation for organisation A, organisation B, absent context and
  platform operator;
- no DB credential or reachable control-plane endpoint inside an Element
  worker.

Migration tests must start from a real-shaped SQLite fixture, cross the process
and filesystem boundary, and verify the PostgreSQL result through production
repositories.

### 12.3 Load and operational acceptance

Test the intended mix rather than a synthetic read-only endpoint:

- auth/session reads;
- concurrent project/run admission;
- event and counter write bursts;
- run state transitions;
- Sentinel and preview heartbeats;
- retention sweeps;
- pool saturation and database restart/failover.

Record p50/p95/p99 latency, pool wait, lock wait, transaction retries,
deadlocks, statement timeouts and database CPU/I/O. Provider and launcher
capacity remain separate limits.

Do not partition tables pre-emptively or create one partition per tenant.
PostgreSQL's own guidance reserves partitioning for sufficiently large tables
and warns that excessive partitions increase planning and memory costs. If
measurement later justifies it, time-based partitions are plausible for large
append-heavy event/ledger tables.

## 13. Recommended implementation order

1. **Accept the decision record.** State target topology, maximum nodes and
   writers, offline-mode policy, RPO/RTO and cutover ownership.
2. **Build the PostgreSQL foundation.** Pool, roles, timeouts, asynchronous
   database boundary, migrations and CI provisioning.
3. **Port the existing tenant control plane.** Auth, projects, GitHub, preview,
   push and platform events, preserving typed domain conflicts.
4. **Remove direct SQLite reads.** Viz, MCP readers, CLIs, doctor, backup and
   registry projections go through explicit repositories/read models.
5. **Land the Track B data model coherently.** Separate bodies from scoped
   trust, redesign lifecycle attribution and move skill counters out of
   sidecars.
6. **Add RLS and deployment roles.** Prove default deny and operator paths
   using the real roles.
7. **Replace distributed assumptions.** Sentinel lease, run allocation,
   launcher volumes and object storage.
8. **Build and rehearse the importer.** Include sidecars and filesystem data,
   not only SQL rows.
9. **Prove recovery and isolation.** Restore drill, two-organisation
   adversarial acceptance and workload-shaped load test.
10. **Cut over under a write freeze.** Preserve the final SQLite evidence and
    explicitly cross the rollback point.

Steps may be developed behind non-production configuration boundaries, but no
intermediate release may expose a PostgreSQL copy of global trust to mutually
untrusted tenants. The Track B data work remains one coherent deployable
change.

## 14. Risks and mitigations

| Risk | Why it matters here | Required mitigation |
|---|---|---|
| Async propagation changes behaviour | Store calls sit on auth, HTTP, supervision and CLI paths | Typed async repository contracts and incremental production-path tests |
| Incorrect replacement for `BEGIN IMMEDIATE` | Current safety sometimes comes from one SQLite writer | State each invariant and select CAS, row lock, advisory lock or serializable retry individually |
| Pool context leaks between tenants | Session-level state can survive client reuse | Transaction-local tenant context, strict release, default deny and adversarial tests |
| RLS is treated as complete isolation | Owners, privileged roles and other mechanisms can bypass it | Separate roles, forced RLS where needed, composite FKs and application predicates |
| Long transactions exhaust pool/locks | LLM and external calls are long-lived | No external or model call inside a DB transaction |
| DB/filesystem partial migration | Current product state spans both | One import manifest, immutable hashes and cross-store verification |
| Ambiguous global trust migration | Existing counters have no tenant owner | Explicit reset/operator-scope decision; never assign by convenience |
| Dual-write divergence | SQLite has no existing CDC contract | Prefer bounded write freeze and verified import |
| Rollback loses accepted writes | PostgreSQL becomes authoritative after cutover | Declare point of no return and test reverse recovery if rollback after writes is required |
| Premature partitioning/replicas | Adds complexity without measured value | Start with indexes and one write primary; add from evidence |

## 15. Owner decisions required before implementation

1. Is the target Track B shared SaaS, or Track A dedicated deployments?
2. Must the released local/offline product continue to operate without a
   PostgreSQL service?
3. What are the maximum control-plane nodes and writer processes for the first
   hosted release?
4. What RPO, RTO and maintenance window are acceptable?
5. May existing instance-global atom trust be reset at cutover, or must it be
   retained under an explicit operator-only scope?
6. Where do immutable skill bodies, traces and artefacts live?
7. Is the prefilter existence oracle accepted, or is every cache key scoped or
   salted by organisation?
8. Is platform-admin cross-organisation access retained; if so, what
   break-glass and customer-notification contract applies?

The recommended answers for the stated goal are: Track B; PostgreSQL for all
SaaS product state; SQLite retained only for deliberately machine-local
operational state; scoped/reset trust rather than guessed ownership; object
storage for durable run bytes; organisation-scoped prefiltering by default;
and a separately privileged, attributable break-glass operator path.

## 16. Acceptance statement

The PostgreSQL programme is complete only when all of the following are true:

- ordinary application startup never creates or migrates schema;
- all SaaS product writes use PostgreSQL through bounded pools;
- no tenant-owned body, trust signal, run, trace, workspace metadata,
  credential, preview or event is visible or mutable across organisations;
- counter changes and required lifecycle events are atomic;
- no long-running model/external operation holds a database transaction;
- the machine-local MCP lease remains local and the distributed leases have
  explicit fencing semantics;
- a production-shaped SQLite store plus skill/run state migrates through the
  supported importer;
- backup restore, packaged startup and one post-restore run succeed;
- two mutually untrusted organisations pass the Track B adversarial
  acceptance;
- workload-shaped load and database recovery tests meet the owner-approved
  service objectives.

Until then, PostgreSQL work may improve the storage substrate, but it is not
evidence that atoma is a production multi-tenant SaaS.
