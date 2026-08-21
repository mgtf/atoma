# Registry — AGENTS.md

`src/registry/` owns the tier-keyed atom-type table: identity, names,
ordinals, versions, provenance and trust counters.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
Identity changes are whole-system operations; the root states which halves
must move together.

Neighbours:

- [`src/skills`](../skills/AGENTS.md) — namespaces keyed by atom id
- [`src/atoms`](../atoms/AGENTS.md) — branching and escalation
- [`src/cli`](../cli/AGENTS.md) — the operator commands

## Descriptions and bootstrap

- Registry descriptions are reusable capability labels, never task narratives.
  Route creation descriptions through `resolveCreationDescription`.
- Canonical bootstrap is idempotent and bucket-specific. Prompt/tool changes
  patch and reset trust only when content genuinely differs.

## Trust counters

- Patching or rolling back a type resets its trust counters.

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
  also cover a name squatted ACROSS tiers (`atom_types.name` is UNIQUE over
  the whole table while the pools are per-tier) and a store that already
  contains a squatter. Reserving the pool against `branch` instead was tried
  and reverted: it closed one tier of three and renamed branches to orphan
  `-2` names whose unsuffixed twin could never be issued.

## Intentional choices and rejected shortcuts

- Registry rollback is roll-forward-to-old-content and resets trust.
