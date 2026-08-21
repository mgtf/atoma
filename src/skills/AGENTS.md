# Skills — AGENTS.md

`src/skills/` owns persistent task patterns: learn, match, inject, earn credit,
compile, dispatch — and the operator lifecycle actions over them.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
This file is the whole skills contract.

Neighbours:

- [`src/atoms`](../atoms/AGENTS.md) — dispatch and credit in the supervision loop
- [`src/contracts`](../contracts/AGENTS.md) — manifest merge identity
- [`src/cli`](../cli/AGENTS.md) — the operator commands

## Lifecycle

Skills follow learn → match/inject → earn credit → compile → trusted dispatch.

- Skills live under owner namespaces on disk, keyed by atom id
  (`skills/<atom-id>/`). Operator and MCP arguments go through
  `resolveMoleculeRef` (name or id → `{ atomId, name }`). Metadata
  sidecars are data: read them strictly before mutation and write
  atomically. Never turn corruption into valid zero counters.
- Match against reusable `when_to_use` capability language, not task theme or
  hidden workspace state the prefilter cannot inspect.
- The skill prefilter runs only when candidates exist. Injection is guidance;
  it never guarantees adherence or credit.
- Credit is usage-conditioned. Atom-type counters move with child outcomes;
  skill counters move only when the skill demonstrably drove the attempt.
- Updates after failure are opportunistic. Invalid skill JSON must not fail an
  otherwise valid run, and an unchanged body is not a revision.
- Auto-created/revised skill bodies must stay within the owner's toolset and
  generalize beyond the triggering task. No task-specific literals.
- Promotion compiles an LLM recipe to a deterministic script only after earned
  successes. Promotion resets script trust; the new executable must earn trust.
- Promotion is frozen by default on from-scratch runs. A seeded workspace is
  the current maintenance-mode signal and enables promotion by default;
  `ATOMA_SKILL_PROMOTE=1` is the exact opt-in anywhere, while any other explicit
  value disables it. `--no-promote-skills` is the final veto over both env and
  seed. MCP `promoteSkills:true` maps to the same explicit env opt-in.
- Untrusted scripts run through the normal L1 tool loop. Trusted scripts may
  dispatch deterministically only after all preflight gates pass.
- Output intent is STRUCTURED first: plans declare `outputs` on every
  file-mutating subtask (threaded onto the child Task) and compilers declare
  `writes` in the promotion envelope, cross-checked once against the static
  resolver and persisted in `_meta.json`. The lexical grammar in
  `scriptTargets.ts` is the FALLBACK for legacy plans/scripts — never grow it
  a new clause for a phrasing the declared field would have carried.
- Script stdout ends with exactly one JSON envelope containing non-null `output`
  and string `summary`. Malformed envelopes and `FAILED`/`ERROR` summary prefixes
  fall back to the validated LLM path; do not invent a separate `ok` field.
- Compiled verification consumes `.atoma-probes.json`; if the manifest exists,
  it is the authority over prose. Preserve each entry's recorded semantics.
- Scratch Node scripts use `.mjs`. The workspace may define incompatible `.js`
  semantics and is fenced from the repository module system.
- Static scanning and compile/refusal stamps are generation-aware. Compare via
  `refusalStampIsCurrent`, never raw constants; fail closed on invalid config.
- Manifest entry shapes are bucket-specific. Shell commands are bare commands,
  not decorated exit-code wrappers. HTTP manifests are ordered sequences.
- `when_to_use` matches subtask text alone. State-on-disk requirements belong
  in the body/preflight, not the match trigger.
- Prefer a sibling compilable skill over overwriting a useful LLM recipe.
- The distiller SEES the visible namespaces' skill ids and `when_to_use` lines
  and is told not to re-learn them. The only mechanical guard is exact-id
  equality, so a SEMANTIC TWIN under a fresh name is the failure mode to
  design against: promotion needs the threshold successes on ONE id, and two
  half-credited twins never reach it while both compete for every match.
  Measured 2026-08-21: one 6-task batch learned 11 skills, 6 of them three
  twin pairs.
- `validateProbeManifest` gates malformed machine input before dispatch.
- Anti-redispatch state is run-scoped. A repeated deterministic output rejected
  for content must not earn credit or be dispatched again in a later phase.
- Deterministic failure streaks demote brittle scripts, but environment/executor
  failures are not evidence against the recipe.
- A deterministic dispatch must prove the deliverable, not merely that named
  files already exist. Mutating work needs relevant before/after change or
  equivalent evidence; pure verification may remain read-only.
- A script without `_fallback.md` is undemotable and must be refused before
  dispatch. Never manufacture a fallback after trust was already lost.
- Event-recovery skills match failure classes mid-run and carry zero LLM cost.
  Their triggers describe reusable failure classes, never task themes.
- `skills drop`, `merge`, `reset`, `forgive`, and review are operator-only
  lifecycle actions. Preserve provenance and emit ledger events. `forgive`
  retracts MISATTRIBUTED increments surgically (negative integer deltas,
  mandatory reason, floor at zero). It JOURNALS FIRST through the fail-closed
  `appendLedgerStrict` — for a negative delta the safe-loss direction
  inverts: mutate-then-lose-the-append leaves the store BELOW the ledger,
  the direction `check` reports as IMPOSSIBLE — and `projectCounters` folds
  the `skill-counter-compensation` event clamped at zero; refusal stamps
  stay untouched — clearing them remains `reset`'s job. Measured 2026-08-21:
  an environment failure is not evidence against a recipe, yet erasing 2
  budget-kill failures via all-or-nothing `reset` cost 7 earned successes. `registry remove` and
  `registry dedupe --apply` drop the deleted atom's skill namespace
  (`skills/<atom-id>/`); `mergeInto` itself does not touch the skill store.
- Compilation's measured value is maintenance verification, not from-scratch
  builds. Do not spend new rounds tuning it unless task decomposition changes.

## Intentional choices and rejected shortcuts

- Do not report compilation as the source of build-task savings. Eight rounds
  support tiering, earned trust, and recipe reuse; compilation dispatched mainly
  on maintenance and did not pay on from-scratch decomposition.
- Do NOT lower the `skills stats --sim` default to catch semantic twins.
  Measured 2026-08-21 against three known pairs: they score 0.41, 0.39 and
  0.26 while a build-vs-probe FALSE positive scores 0.31, so no threshold on
  matching-surface overlap separates them and the 0.5 default surfaces none of
  the three. The lexical metric cannot tell "build a Node http service" from
  "probe a Node http service" — same vocabulary. Prevention belongs at learn
  time, where the distiller judges each recipe's claim.
