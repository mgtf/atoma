# Registry — AGENTS.md

`src/registry/` owns the tier-keyed atom-type table: identity, names,
ordinals, versions, provenance and trust counters. There is ONE table for the
whole platform; atom IDs are globally unique.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
Identity changes are whole-system operations; the root states which halves
must move together.

Neighbours:

- [`src/skills`](../skills/AGENTS.md) — namespaces keyed by atom id
- [`src/atoms`](../atoms/AGENTS.md) — branching and escalation
- [`src/cli`](../cli/AGENTS.md) — the operator commands

## One registry, one trust

- A RUN IS A RUN (owner decision 2026-09-15,
  [platform trust record](../../docs/platform-trust-2026-09-15.md)). The
  operator's runs, every organisation's project runs and the benchmarks read
  the same rows and bump the same counters. `AtomRegistry` takes a database
  and nothing else; there is no owner, no per-caller predicate, no fallback.
- What a tenant run still proves before any writable handle is that it IS the
  run the host registered, on the host's recorded paths
  (`assertProjectRunAuthority` in [src/projects](../projects/AGENTS.md)). That
  check gates the launch, never the rows.
- Names are unique across tiers in the one table; UUID atom IDs stay globally
  unique and skill namespaces stay keyed by that ID. Ledger entities are type
  names; the atom-id-keyed project events of the partitioned period stay in
  the ledger as history and are not compared by `ledger check`.
- `openDb` is the ONLY thing that folds, and a read-only handle never does.
  Anything that SERVES the store must fold it first — the viz server does it at
  startup — and every read-only reader keeps `unfoldedRegistryPredicate`, which
  is `'1'` on a folded store and the old owner filter otherwise. Without both,
  a reader that stopped filtering by owner publishes one row PER OWNER; that is
  how the production Registry came to list every type twice on 2026-09-15.
  `AtomRegistry` refuses an unfolded store rather than merge two catalogues.
- `openDb` folds a store still partitioned by owner (2026-09-09 layout) back
  into the platform: whole-file backup first, operator rows kept as they are,
  same-name project rows ABSORBED with their counters added and the identity
  mapping written to `atom_id_merges` (the skills catalog follows it), other
  project rows kept whole with a fresh ordinal or `-<n>` suffix only on
  collision. One immediate transaction; a failed fold leaves the store as it
  was beside its backup. Superseded record, kept as evidence:
  [ownership record](../../docs/project-registry-ownership-2026-09-09.md).

## Descriptions and bootstrap

- Registry descriptions are reusable capability labels, never task narratives.
  Route creation descriptions through `resolveCreationDescription`.
- OPEN, measured not designed: the prefilter routes on the DESCRIPTION while
  `atomBehaviorKey` deduplicates on the PROMPT, and they disagree. Same tool
  signature means the same description by construction, so identities with
  distinct prompts show the catalogue identical lines it cannot choose between,
  and a validator patch splits an equivalent group permanently. `createOrReuse`
  bounds the creation rate, not the catalogue. Evidence and the refuted
  credit-loss hypothesis:
  [the production catalogue, measured](../../docs/incidents/registry-catalogue-2026-09-16.md).
  Do not design the reconciliation in the session that hits it.
- Canonical bootstrap is idempotent and bucket-specific. Prompt/tool changes
  patch and reset trust only when content genuinely differs.

## Trust counters

- `successes` / `failures` retain historical totals; `consecutiveSuccesses`
  counts approved final results since the last failure or behavior change.
  These are result credits, not distinct runs. A failure resets only the streak.
- A prompt/tool/parameter patch or rollback resets the streak, preserving totals;
  a description-only patch and a no-op preserve both. `type-trust-reset` records
  the revocation without making the ledger erase historical totals.
- A supervised credit is bound to the instance's loaded registry version.
  Results from stale or locally modified behavior still count in history, but
  cannot grow the current version's streak or borrow its validation bypass.
- Merging histories or compensating counters resets the streak: unordered
  evidence must never manufacture consecutive successes. Old stores initialize
  clean histories from their success total and mixed histories from zero.
- Automatic creation and branching use `createOrReuse` / `branchOrReuse`.
  Equivalence includes tier, complete tool declarations, parameters and prompt
  (apart from the leading persona name), never merely the tools or description.
  `listCapabilities` presents one oldest identity per equivalent behavior and
  excludes an entire equivalent group if any member is excluded. It never
  deletes history, moves skill namespaces or transfers trust between identities.
  Explicit `create` / `branch` remain allocation APIs for deliberate new identities.
  Design and adversarial cases: [recoverable trust](../../docs/recoverable-trust-2026-09-15.md).

## Names and allocation

- Atom names are NOT all curated. `branch` accepts an LLM-authored
  `overrideName` (`verdict.branchName`) and takes only the ORDINAL from
  `nextAvailable`, so task-themed names enter the catalogue by design. That
  is why `registry dedupe` exists and why its fuzzy key is the only thing
  catching word-order variants the order-sensitive branch guard lets through.
  Do not delete the dedupe surface on the grounds that names come from a pool.
- `nextAvailable` takes the set of names already held and SKIPS pool entries
  whose name is taken: ordinals and names are separate namespaces, because an
  LLM `overrideName` occupies a name without consuming its ordinal. The check
  belongs on the allocator that inserts, not on `branch` — only there does it
  also cover a name squatted ACROSS tiers (`atom_types.name` is UNIQUE across
  tiers while the pools are per-tier) and a store that already
  contains a squatter. Reserving the pool against `branch` instead was tried
  and reverted: it closed one tier of three and renamed branches to orphan
  `-2` names whose unsuffixed twin could never be issued.

## Intentional choices and rejected shortcuts

- Registry rollback is roll-forward-to-old-content and resets the trust streak.
