# Project registry ownership

Date: 2026-09-09. Corrective increment for the
[downstream retrieval audit](incidents/project-retrieval-record-2026-09-09.md#project-retrieval-downstream-privacy-audit).
Retrieval remains opt-in. No provider, embedding or reranker call is added.

## Storage and authority

`atom_types` remains the one tier-keyed registry table in the existing product
SQLite file. Its key is now `(owner_key, tier, ordinal)`; names are unique
across tiers within an owner, and atom IDs remain globally unique. History
uses the same owner key. The two ownership kinds are operator and project
(`orgId` plus `projectId`), defined once in `registryOwner.ts`.

Every registry query binds its instance's immutable owner, including lookup by
ID, allocation, catalogue, patch, branch, version history, rollback, removal,
merge and counters. Supervisor creation and escalation use that same instance.
There is no fallback to another owner's rows or automatic commons admission.
Code-defined canonical types bootstrap independently in each project.

For every marked project child, `startTask` resolves the registered running
run, active project, current requesting member and exact host workspace,
trace and skill paths before opening a writable registry or constructing a
provider. This applies with retrieval disabled too. Each registry access
rechecks that authority; cancellation or membership withdrawal refuses later
reads and writes. Already delivered context is not retroactively erased.

Project counters remain private. Their ledger entity is the globally unique
atom ID; event detail carries owner, name and existing provenance. Legacy
operator events keep their existing entities. Counter changes and ledger
writes retain the same transaction. CLI ledger checks compare each owner's
correct identity; operator catalogue/skill readers exclude project types.
The platform audit journal remains an operator surface.

## Migration, existing learning and rollback

1. Drain runs and previews with the existing deployment preflight and stop old
   writer processes before activating the new build. Do not run old and new
   binaries concurrently against this schema.
2. Preserve the ordinary complete backup of store, skills and run evidence.
   On first writable `openDb`, a legacy T4 store additionally gets a unique
   `*.before-registry-ownership-<uuid>.db` snapshot beside the product file.
   `VACUUM INTO` includes committed WAL pages and every product table. The
   snapshot is created with private file permissions before bytes are copied.
   Backup failure refuses migration.
3. One transaction rebuilds both registry tables with ownership keys, assigns
   every legacy row to operator ownership, preserves all original columns and
   reinstates global atom-ID uniqueness. Failure rolls back the complete schema.
   Subsequent opens are idempotent. Pre-T4 stores still require their existing
   atom-ID migration first. Read-only operator readers can inspect old archives.
4. No atom ID, skill namespace, trace, ledger event or disposable cache is
   rewritten. Legacy rows may contain facts from multiple projects; ownership
   cannot be inferred safely from `createdBy`, names or prompt prose. They are
   retained for the operator and never copied into a project.
5. Existing project skill files remain intact. Types newly bootstrapped in a
   project receive new IDs, so old recipes whose IDs belong to the unscoped
   legacy registry are preserved but are not automatically eligible as donors.
   Reattaching that learning requires explicit provenance/ownership attribution;
   no automatic attribution or shared-body publication is part of this change.
   Newly learned project recipes retain their identities and reuse across runs.
6. To roll back the binary, first stop writers and archive the current database,
   project skills and traces, including post-upgrade learning. Restore the
   matching pre-upgrade backup and its matching runtime-state archive, then start
   the old binary. Never point an old binary at the ownership schema: its
   unscoped SQL could read or update multiple owners. Do not delete evidence or
   downgrade just the SQL while keeping incompatible active runtime state.

This is containment of tenant-authored material, not a generalization detector.
An explicit reviewed body-admission mechanism remains necessary for sharing
reusable knowledge; project data cannot inherit the skills commons premise.
Source deletion and retrieval revocation do not forget facts already learned
inside a project's private metadata or recipes. Coordinated retention remains
part of the retrieval operational phase.

## Executable verification

- `tests/registry-ownership.test.ts`: all three tiers with colliding labels in
  sibling projects, foreign organisations and the operator scope; mutation,
  history, tombstones, counters, revocation, process reload, full WAL backup,
  migration idempotence and transactional failure recovery.
- `tests/project-retrieval-privacy.test.ts`: actual FTS passages and production
  L1/L2/L3 supervision with mocked providers; persistent and ephemeral coaching,
  planner-created descriptions/tools, branch names, source-derived skill bodies,
  and a new process reading its own empty corpus. Foreign requests must contain
  no private fact while owning-project reload retains eligible learning.
- `tests/project-retrieval-runner.test.ts`: the production launcher selects the
  project registry even with retrieval disabled, refuses missing/foreign paths
  before setup, and rechecks authority on later access.
- `scripts/retrieval-project-smoke.mjs`: compiled coordinator and child process,
  authoritative project ownership, private metadata/trust persistence and
  foreign-owner absence, plus the existing host retrieval and worker boundary.

Verification completed on Node 24.20.0:

- Focused ownership/privacy/runner suite: 31 tests passed.
- `npm run release:check`: passed; 3,759 tests passed, 13 environment-dependent
  skips, both TypeScript configurations, lint, docs, build, compiled MCP/auth
  smokes and npm audit (zero vulnerabilities).
- `npm run build:worker` followed by
  `node scripts/retrieval-project-smoke.mjs --container`: passed. The worker
  could not see the host source archive or control-plane environment; project
  registry separation also passed through compiled modules in the run child.

These are mocked-provider boundary checks, not a paid A/B campaign or proof of
retrieval benefit. No live customer store, document, subscription run or
production setting was changed by the tests.
