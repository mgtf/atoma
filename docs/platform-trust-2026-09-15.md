# One registry, one trust — a run is a run

Date: 2026-09-15. Owner decision, taken on the live platform after reading the
Registry as a freshly invited member of a new organisation with zero runs.

## The decision

There is no longer any distinction between the operator's runs, one
organisation's runs and another's. **A run is a run.** Every run on the
platform reads the same agent registry, the same skill catalog, and earns
trust on the same counters. What a run learns — a new molecule, a patched
prompt, a distilled recipe, a success or a failure — is platform knowledge and
platform trust the moment it is written.

This supersedes two earlier partitions:

- the **per-owner registry** of 2026-09-09
  ([project-registry-ownership-2026-09-09.md](project-registry-ownership-2026-09-09.md)),
  where `atom_types` rows were keyed by an owner (`operator` or
  `(orgId, projectId)`) and every project bootstrapped and trusted its own
  copies of the canonical types;
- the **per-project skill trust** of 2026-09-15 morning (commit `9e1d670`),
  where bodies were shared but counters lived under
  `.trust/<project-id>/<body-sha256>/` and project runs could not promote,
  dispatch, drop or merge.

The 2026-09-06 premise — *skills are a commons; the organisation bounds trust
and execution rights, never knowledge* — is amended: **the organisation bounds
nothing about the registry or the skills.** What remains organisation-scoped
is what was always organisation-scoped: projects, workspaces, traces, the
retrieval corpus a run may search, and who may start a run.

## What the code does

- `atom_types` and `atom_type_versions` have no owner column. `AtomRegistry`
  takes a database and nothing else. `openDb` folds a partitioned store back
  (`migrateRegistryToPlatform`): the file is backed up whole
  (`*.before-platform-registry-<uuid>.db`), operator rows are kept as they
  are, a project row with the same `(tier, name)` as an existing row is
  absorbed — counters ADDED, identity mapping recorded in `atom_id_merges` —
  and every other project row joins whole, taking a fresh ordinal or a `-<n>`
  name suffix only when it would collide. One immediate transaction; a fold
  that cannot complete leaves the partitioned store untouched beside its
  backup.
- `SkillRegistry` takes a root directory and nothing else. `reconcilePlatformSkills`
  (run by the coordinator at startup and by the runner before a run) folds the
  `.trust/…` sidecars into the public `_meta.json` (counters added, the tree
  set aside as `.trust-before-platform-<stamp>`) and moves the recipes of an
  absorbed atom identity under the kept one (duplicates summed, the absorbed
  copy set aside under `.merged-before-platform/`). `migratePlatformSkills`
  still imports the 2026-09-09 per-project trees, now adding their counters
  to the catalog's instead of keeping them in a private scope.
- A tenant run still has to prove it is the run the host launched, on the
  paths the host recorded (`assertProjectRunAuthority`). That check never
  selected rows; it says whether this process may run at all.
- Every reader — viz, MCP, CLI — reads the one table. The ledger keys type
  counters by name again; the atom-id-keyed project events of the partitioned
  period remain in the ledger as byte-honest history and are not compared.

## What changes for people

- A member's Registry and Skills tabs show what their own runs will start
  from and earn on. The counters they read are the platform's, and their runs
  move them.
- What a validator writes into a prompt, a description or a branch name during
  one organisation's run is visible to every organisation's next run. This
  includes text derived from that organisation's private retrieval corpus.
  The corpus itself does not travel (`ownPassages` stays 0 for another
  project); its paraphrase in a prompt does. `tests/project-retrieval-privacy.test.ts`
  characterises exactly this and no longer asserts containment.
- The 2026-09-09 downstream privacy audit
  ([incidents/project-retrieval-record-2026-09-09.md](incidents/project-retrieval-record-2026-09-09.md))
  described a risk and the partition that answered it. The risk is unchanged;
  the answer is withdrawn by this decision. Mutually distrusting organisations
  on one instance is therefore not a supported deployment shape, as
  [saas-architecture.md](saas-architecture.md) has always said.

## Execution follows: promotion, dispatch, cache

Same day, same owner: a tenant run also EXECUTES like any run. The coordinator
no longer pins `ATOMA_SKILL_PROMOTE`, `ATOMA_SKILL_DIRECT` or
`ATOMA_PREFILTER_CACHE` to `0` and sends no `--no-promote-skills` /
`--no-direct-skills` veto; the runner's tenant precondition is container
isolation alone. So a seeded project run promotes a recipe that has earned
it, a trusted compiled skill dispatches with zero model calls inside the
run's container, and the prefilter cache — planning decisions, reasoning
included — is read and written across every organisation's runs. A host that
wants a stage off sets it in its own environment, for every run alike.

## What did NOT change

- `/api/burnin`, the admin plane, skill analytics (`atoma_skills_stats`,
  `atoma_skills_review`) and the four lifecycle writes stay operator or
  platform-admin surfaces.
- Host paths of the store and the skills tree are still redacted for
  non-admins.

## Rollback

Restore the `*.before-platform-registry-*.db` backup over the store and the
`.trust-before-platform-*` / `.merged-before-platform/` trees into place, and
deploy the previous build. Counters earned after the fold are lost on
rollback; nothing else is.
