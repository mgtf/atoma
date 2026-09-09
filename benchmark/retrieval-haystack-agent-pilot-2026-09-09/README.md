# Haystack agent development pilot — 2026-09-09

The registered screen was **not met**. Ordinary Atoma (A) passed 0/2 tasks,
Atoma with local Haystack hybrid retrieval (B) passed 0/2, and the shared
frontier-direct reference (C) passed 1/2. All six attempts completed with
accounting and no infrastructure failure. Haystack is integrated into the
shared runner as an experimental option; this result does not justify default
activation or production rollout.

## Results and observed failures

[report.json](report.json), [results.jsonl](results.jsonl) and the replayed
[metrics.json](metrics.json) preserve all scores, timings and observations.

- `northstar-05`, the French refund-window question: A reached its deadline
  without `retrieval-answer.json` (183.386 s). B wrote the correct value, 14,
  but an invalid citation and reached its deadline (183.095 s). C passed the
  complete answer and citation checks (56.235 s).
- `northstar-13`, pricing maintenance plus a cited answer: A (183.838 s),
  B (183.642 s) and C (42.067 s) all made the correct configuration change
  and passed the fixed executable maintenance probe. None produced the
  required answer file. A/B timed out; C's runner reported `delivered`, but
  the independent scorer correctly recorded a task failure.
- All six attempts preserved every document and protected asset required by
  their respective task. No scorer was weakened and no failed attempt was
  dropped or retried.

B invoked `search_project_docs` once on `northstar-05`, using the English
query `refund days payment first`. The 224 ms call returned five valid,
nonempty source passages and covered the one golden fact obligation. Its
first passage included `docs/billing.md:10-15`, with the refund statement on
line 13. The final answer instead attributed that statement to line 11,
which is blank. The model also read the whole document after retrieval.
The evidence was available; the final source-line assembly was wrong.

B did not invoke retrieval on `northstar-13`. Its trace records ordinary
file reading and the correct `annualCents: 19000` edit, followed by more
reading without the final cited answer. Its retrieval observation therefore
says `not-invoked`, not a ranking miss. This test includes whether an agent
uses an available element; it does not force every task through Haystack.

The paired full-pass difference is 0 (required: at least 0.5), with zero wins
and zero losses. Aggregate B/A elapsed time is 0.9987 and subscription price
equivalent is 0.9003, inside the registered 1.25 ceilings. A resource ceiling
alone does not satisfy the correctness requirement. Most A/B timing was
censored by the attempt deadline, so these ratios do not establish a speed
improvement. C uses a different architecture and model allocation; it is a
reference, not the retrieval-only causal control.

## Registration and resource accounting

The [registration](registration.json) was written at 08:28:56.783 UTC, before
the first attempt at 08:29:07.821 UTC. The last stopped trace ended at
08:43:02.717 UTC on the same day. All attempts used source `67c5bfe`, Node
24.20.0, the registered instrument lock and the same pinned worker image.
No runtime source changed during the campaign.

The two questions were deliberately selected development cases: question 05
had benefited from hybrid retrieval in the earlier component screen, and
question 13 had failed task completion in the earlier agent pilot. There is
one repetition in A/B/C then C/B/A order. These are correlated tasks from one
tiny synthetic project, not a held-out or representative sample. Orchard was
not run. Previous pilots are historical context, not this comparison's control.

A uses existing agentic file/shell tools. B adds the same host-authorized L1
element backed by Haystack BM25, dense retrieval, reciprocal-rank fusion and
local cross-encoder reranking. C uses the existing frontier-direct path. All
three run through the shared project runner with independent synthetic
authorities, fresh stores, registries, skills and workspaces. Learning,
promotion, direct dispatch, event skills and the prefilter cache are disabled.
Workers have no network. Provider cache state is uncontrolled.

The selectors are `sub:anthropic:haiku` for L1, `sub:anthropic:sonnet` for L2,
and `sub:anthropic:opus` for L3 and C. Recorded served-model labels are `haiku`
and `opus`, with null labels on some terminal events; they are not immutable
vendor weight identities. No Sonnet completion was recorded. There were 78
client completions: 38 each for A/B and two for C. A client completion can
contain multiple internal CLI/model/tool turns; these are not HTTP counts.

Trace totals contain 45,058 input tokens, 43,645 output tokens, 1,104,135
cache-read input tokens and 588,785 cache-creation input tokens. The runner
records USD 2.0710 of subscription price equivalent and USD 0 of API spend.
The more precise trace sum is USD 2.07101675; per-run epilogues are rounded.
These are accounting equivalents, not an incremental API invoice or a measure
of remaining subscription quota. Local retrieval makes no paid API calls.

Haystack 3.1.1 uses the compact BGE-small-en-v1.5 and MiniLM-L6-v2 reference
weights from the [component experiment](../haystack/results-2026-09-09/README.md).
The [launch settings](haystack-launch.json) pin their local content hashes;
[python-runtime.json](python-runtime.json) pins Python/package version metadata.
The models run offline on CPU, without telemetry. These weights were not
selected as state of the art. A/B evaluates the complete optional retrieval
treatment, not the isolated contribution of embeddings, reranking or the
framework. The French task's English search query also limits language claims.

Each attempt has 180 seconds including source preparation and Python warmup;
the campaign cap is 1,200 seconds. Teardown can extend an attempt's wall time.
Each B preparation admitted four documents, 2,171 bytes and 11 passages.
`preparation.json` records the source receipt and small FTS cache only:
8.947 ms and 4.540 ms, with whole-store sizes of 385,024 bytes. These are not
Haystack initialization times. Python initialization occurs inside the timed
child run and is included in its elapsed time; no isolated warmup duration or
Python peak memory was recorded here. Preparation RSS is a host snapshot, not
Python memory or peak usage. This fixture supports no capacity claim.

## Verification and archive replay

Before registration, `release:check` passed 3,825 tests with 13 environment
skips, both TypeScript configurations, lint, documentation, audit (zero
findings), build and compiled smokes. Real Python/offline model tests were
enabled. The dedicated worker was built from that compiled source, and the
compiled container/Haystack smoke passed source admission, live revocation and
worker isolation. Verification logs are archived beside this report.

The campaign released its global lease; no campaign Python process or worker
container remained. [evidence.tar.gz](evidence.tar.gz) contains all six launch
records, stopped workspaces, logs, traces, initial/final store backups, final
stores, immutable source snapshots, receipts, dataset, registered source tar
and scores. It contains synthetic fixture material, not customer documents.
Model weights and the Python environment are identified but not bundled.

Verify [SHA256SUMS](SHA256SUMS) from this directory with
`shasum -a 256 -c SHA256SUMS`. From the repository root, with pinned Node and
installed dependencies:

```bash
retrieval_haystack_extract=$(mktemp -d /tmp/atoma-haystack-replay.XXXXXX)
tar -xzf benchmark/retrieval-haystack-agent-pilot-2026-09-09/evidence.tar.gz -C "$retrieval_haystack_extract"
node --import tsx benchmark/retrieval-haystack-agent-pilot-2026-09-09/replay.mjs \
  "$retrieval_haystack_extract/atoma-haystack-agent-evidence-20260909"
```

Replay asserts the schedule, result rows, executable scores, runner epilogues,
retrieval observations and paired decision, then prints metrics. All six
attempts reproduced after fresh extraction. A zero exit means that the
recorded outcomes reproduced, including failures. Replay calls no provider,
requires no Python models, and executes only the evaluator-owned fixed probe.

## Follow-up decision

Keep agentic search as the default and Haystack experimental. Investigate
exact citation assembly and completion of all answer/artifact obligations
before another agent campaign, considering the full set of failures together.
Question 05 establishes available evidence followed by an invalid citation;
question 13 establishes successful maintenance with incomplete delivery and
no retrieval invocation. Neither supports adding another retrieval component
as the remedy. Any strategy, model or budget change requires a new registered
comparison with fresh controls and the unchanged scorer. No automatic
correction rule was introduced from this live session. Broader evaluation and
operational lifecycle remain prerequisites for production rollout.
