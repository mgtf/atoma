# Recoverable atom trust and equivalent creation

## Decision

The owner requested an immediate correction of permanent trust exclusion and
automatic clone creation on 2026-09-15. This authorizes implementation in this
session despite the usual cooling-off rule. The proposed mechanism received
an adversarial review before construction and was checked against migration,
patches, rollbacks, compensation, merges, branching and task-local context.

## Evidence and limits

The reported production counts (15 successes / 9 failures for three web workers,
1 / 0 for four full-stack workers) are incident context supplied by the owner;
this change does not independently query that production store. The source
confirmed that `failures === 0` permanently excluded a type after one failure,
patches erased both counters, and automatic creation did not compare behavior.
Tool identity alone does not prove equivalent workflows: instructions and
parameters can distinguish useful specialists sharing the same elements.

The store was queried on 2026-09-16, before any run executed against this
change: [the production catalogue, measured](incidents/registry-catalogue-2026-09-16.md).
It confirms the counts above, records that the ledger and the store agree
exactly (no credit is lost at any rank), and shows the reuse rule collapsing
one group of three while four historical molecules keep distinct prompts under
a shared description. That last point is the limit this change did not reach
and the measurement states as an open design question.

## Contract

- Historical successes and failures survive future patches and rollbacks.
  Already erased historical counts cannot be reconstructed by this migration.
- Trust requires three consecutive credited, approved final results by default
  (`ATOMA_TRUST_THRESHOLD` remains the override). Multiple results may belong to
  one run. Repaired intermediate rejections are not final escalation failures.
- A failure or behavior change resets the streak. A description edit does not.
  Ground-truth checks and proof-coverage requirements continue to run before
  trust can bypass a model validation.
- Supervised credits and validation bypass are bound to the version the child
  loaded. An old parallel instance cannot certify a newly patched version.
  Its approved result remains in the historical success total. A description
  edit preserves the stored streak but older instances are conservatively
  reviewed until reconstructed from the current version.
- Old rows with no failures initialize from their recorded successes. Mixed
  histories start at zero because totals alone do not establish order. The
  platform fold derives this only after all histories have been absorbed.
- Counter compensation and history merges reset the streak conservatively;
  neither can create trust from unordered evidence. Ledger totals still replay
  the old reset events and preserve totals across the new `type-trust-reset`.
- Automatic creation and escalation reuse exact behavior: same tier, complete
  tool declarations, parameters and prompt, ignoring only the leading persona
  name and JSON object-key/tool ordering. Different prompts remain distinct.
  Task-specific coaching stays on the execution instance.
- Planning sees one oldest identity per equivalent behavior, without selecting
  a fresh clone for its clean counters. An excluded member excludes its whole
  equivalent group. Existing names, IDs, traces and skill namespaces remain.

This is an atom trust change. Script-skill promotion and direct dispatch retain
their existing contract. There is no paid semantic deduplication call, no
tool-only automatic merge and no production-data deletion in this change.

## Regression evidence

`tests/trust-recovery.test.ts` drives real L2/L3 validation with historical
failures, recovery and another failure. It also verifies patch/rollback history,
ledger totals, compensation/merge revocation and migration across file reopen.
The registry platform tests cover folding mixed and clean histories. Creation
tests drive planning and execution, keeping task-local instructions and distinct
behavior intact while checking catalog size.

`tests/trust-version-binding.test.ts` checks stale instances, local changes and
revocation during asynchronous ground-truth probes. It also crosses the runner's
`RecordingRegistry` wrapper: obsolete and locally changed instances retain their
historical success without certifying the current version.
