# Comparison reruns — decision and contract, 2026-09-25

Owner request: for every run, know the models it was pinned to, then rerun
the same run on other models and compare cost, time and quality. The first
half shipped as `7374572` (the launch pins on every trace, the served models
per pin, and each project run's per-tier `models` from its payer ledger). This
record is the second half.

## What a rerun is

A comparison rerun B of an origin run A is a project run started with
`{ rerunOf: A, models: { l1, l2, l3 }, idempotencyKey }` through either door
(`POST /api/projects/:id/runs`, MCP `atoma_run_start`). It answers one
question — what would A have cost and produced on these models? — so
everything except the models is A's:

- **the goal**: A's, copied by the host; the request cannot carry one;
- **the acceptance list**: the one A was judged against, copied verbatim into
  B's `project_run_acceptance` row. A user-approved list stays a user list. A
  list A DRAFTED for itself is recovered from A's trace (the response of its
  one `draft-checklist` call, parsed by the same functions the run used) and
  carried with `ATOMA_ACCEPTANCE_SOURCE=drafted`, so B is judged as a draft is
  judged, with no second drafting call from its own models;
- **the starting workspace**: the run A was seeded from (R0), never A's own
  output and never the project's latest run. Every project run now records
  its seed once (`project_runs.seed_json`); a row from before that column is
  resolved through its retrieval receipt, which named the same seed;
- **the protocol**: B is launched exactly as A was — no `--depth`, no
  `--comparison` — so it takes the same supervision default and root
  acceptance.

## Decisions taken with the owner

1. **A run-level model REFUSES rather than falls through.** Stored
   preferences fall through within a payer when a vendor key is missing; a
   rerun whose `api:` model has no credential would otherwise run on models
   nobody asked for. `sub:`/`own:` at the run level take the same authority
   checks as an account pin, re-asked per run.
2. **Only a `delivered` or `partial` origin.** A failed or cancelled run has
   nothing comparable to judge.
3. **A drafted origin list is inherited, not redrafted**, for the reason
   above: two drafts from two model sets are two yardsticks.
4. **Projects imported from GitHub are refused for now.** Their seed is a
   snapshot of the default branch taken at launch; re-taking it would compare
   against a different head. It needs its own design.

## Outside the project's line

B is a measurement beside the project, never part of it:

- it never seeds a later run (`previousSeedRun` skips it), which also keeps it
  out of the retention hold and the retrieval source;
- it never publishes: `finish()` skips it, `retryPublication` refuses it, and
  `reservePublication` — the choke point every path passes — refuses it;
- the CLI staleness count ignores it.

It keeps a preview. One side effect, accepted and stated: hosts its preview
requests become approvable for the project like any run's.

## Refusals, and their status

| Condition | Error | HTTP |
|---|---|---|
| `rerunOf` unknown, or in another project | `project run not found` | 404 |
| origin not delivered/partial; imported project | `ProjectStateConflict` | 409 |
| origin's seed unrecorded, missing, expired or off disk | `ProjectStateConflict` | 409 |
| origin trace over `MAX_TRACE_BYTES`, unreadable, gone or its bytes expired, while the origin has no stored list | `ProjectStateConflict` | 409 |
| a run-level model it cannot honour | `ProjectRunConfigurationError` | 400 |
| goal, checklist, partial `models`, or null tiers alongside `rerunOf` | schema | 400 |

The origin is resolved before any row or lease exists, so a refused rerun
leaves nothing behind. The trace read is the fifth disposition above
`MAX_TRACE_BYTES` ([src/contracts](../src/contracts/AGENTS.md)).

## What the comparison cannot control

- **Shared learning.** Skills, trust and the prefilter cache are one platform
  commons ([platform trust](platform-trust-2026-09-15.md)). B runs after A
  and inherits what A and every run since taught the registry, so B can be
  cheaper for reasons unrelated to its models. Alternate the order of arms
  for a measurement that must be clean.
- **The drafting call.** A drafted origin paid for one L1 `draft-checklist`
  call that B does not make.
- **An origin judged without a list** (it predates the checklist, or its
  draft came back empty) is rerun without one: the coordinator sets
  `ATOMA_ACCEPTANCE_SOURCE=none` and the child drafts nothing, rather than
  judging B against a list A never had (2026-09-25 review, 2.1).
- **Host settings not recorded per run**: the run budget
  (`ATOMA_PROJECT_TIMEOUT_MS`) and the family's supervision default.
- **Retention.** R0's bytes are not held for future reruns; after 90 days a
  rerun of A is refused rather than seeded from something else.

## Storage

Additive columns on `project_runs` (`rerun_of_run_id`, `model_overrides_json`,
`seed_json`) and on `project_run_acceptance` (`source`, NULL = user), each
immutable by trigger once written. `model_overrides_json` is READ BACK by
spelling only (`storedRunTierModelsSchema`): a model a later deploy retires
must not make the row, the project's run list, the seed resolver or offline
retention throw; whether the model is still offered is asked at launch, where
it refuses (2026-09-25 review, 1.1). The payer ledger's `source` CHECK gained
`'run'` through the documented SQLite table rebuild, the same procedure as the
`'partial'` status; rows and the immutability trigger survive it.
