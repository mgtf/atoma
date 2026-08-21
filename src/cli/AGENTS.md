# CLI — AGENTS.md

`src/cli/` owns the operator commands: doctor, auth, registry, ledger, skills,
burn-in, curriculum, benchmark, backup and friction.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
The command list and the release contract live at the root.

Neighbours:

- [`src/run`](../run/AGENTS.md) — the run shells these commands drive
- [`src/skills`](../skills/AGENTS.md) — skill lifecycle semantics
- [`src/registry`](../registry/AGENTS.md) — registry identity

## Conventions

- CLI unknown commands print help and exit non-zero; `--help` exits zero.

## Doctor

`atoma doctor` is quota-free. It proves configuration and local prerequisites,
not that a provider will accept the next billable request. Local Docker failures
are warnings; container/egress modes make them hard failures. Egress implies
container. A pre-T4 store (no `atom_id` column) is a hard failure — the schema
is the schema and `CREATE TABLE IF NOT EXISTS` will not migrate it. Do not add
remote completion calls to doctor.

## Burn-in and friction

- Burn-in CSVs belong to exactly one writer/schema. Refuse foreign headers
  before append. Measurements committed to the repo must remain parseable.
- The friction report is offline and includes recency. Fix recurring real tool
  errors at their source; do not erase successful recovery evidence.
- Act on friction signatures only when they recur across two consecutive batches
  and their root cause lives inside the sandbox. Host, repository, and harness
  defects require structural fixes rather than learned workarounds.
