# Contracts — AGENTS.md

`src/contracts/` owns the shared runtime shapes: one schema per shape,
inferred types, and the merge semantics readers and writers agree on.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
Define a schema once and import it everywhere.

Neighbours:

- [`src/tools`](../tools/AGENTS.md) — the writers bound by these merge rules
- [`src/platform`](../platform/AGENTS.md) — the closed event-kind vocabulary
- [`src/atoms`](../atoms/AGENTS.md) — the plan and verdict shapes

## Schemas and examples

- Contract examples are parsed at module load. A schema/example mismatch must
  fail tests immediately.

## Probe manifests

- Probe manifests are structured records. Normalize paths before recognizing
  `.atoma-probes.json`; machine writers merge entries, and model hand-edits are
  refused.
- Manifest MERGE semantics have one definition: `src/contracts/probeManifest.ts`
  owns entry identity per shape (shell by `cmd`, web by `file`+`smoke`, http =
  ordered append) and documents the three writers' corrupt-input policies side
  by side. Never re-implement a merge in a tool.
