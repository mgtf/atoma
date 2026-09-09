# Copyable-citation development pilot — 2026-09-09

The registered screen was **not met**: ordinary Atoma (A) completed 0/2 tasks,
Atoma with Haystack (B) completed 0/2, and the frontier-direct reference (C)
completed 2/2. All six scheduled attempts were retained. The harness recorded
zero infrastructure failures; the four Atoma attempts ended at their deadlines.

## What was measured

[registration.json](registration.json) was written before execution. All arms
used source `88452af`, the same shared runner, unchanged executable scorers,
fresh synthetic tenant authorities and stores, and a pinned no-egress worker.
The two Northstar development questions and all model/budget settings match
the earlier development pilot: one repetition, A/B/C then C/B/A, Haiku at L1,
Sonnet at L2, Opus at L3 and for C, through host Anthropic subscriptions.
Each attempt has 180 seconds; the campaign cap is 1,200 seconds. Teardown may
extend an attempt's observed duration. Orchard remains held out.

The current runner exposes its effective tool budget to L1 and advises
completion of every deliverable and continuation from current disk state.
The Haystack arm additionally preserves semantic query text and returns exact
copyable citation objects inside the existing response-size cap. It uses the
same BGE-small-en-v1.5 / MiniLM-L6-v2 reference weights as before. Its persistent
host Python environment has its own registered package fingerprint.

This is a current A/B screen with a frontier reference, **not** a controlled
old-code/new-code comparison. Differences from the earlier campaign cannot
isolate the effect of a particular correction. These are two correlated,
deliberately selected synthetic development questions, not a population sample.

## Outcomes and direct observations

[report.json](report.json), [results.jsonl](results.jsonl) and
[replay-results.json](replay-results.json) preserve the measurements.

- **Refund question, A:** the answer file and all exact citations pass the
  scorer, but the runner fails at its deadline (181.548 seconds including
  teardown). Artifact correctness alone is not full campaign success.
- **Refund question, B:** the value 14 is correct, but the citation fails
  (182.027 seconds). Three retrieval calls returned the billing passage.
  The final answer cites lines 10–15 with a 244-byte quote; those source lines
  contain 245 bytes. The model dropped the final blank line (`\n`), although
  the returned citation contained it. Copyable metadata did not guarantee
  faithful final transcription.
- **Refund question, C:** complete success in 73.155 seconds.
- **Maintenance, C:** complete success in 87.651 seconds, including both the
  configuration change and the cited answer file.
- **Maintenance, B:** fails answer-schema and maintenance-behavior checks at
  the deadline (185.313 seconds). Its three tool events are file listing and
  reading; it never invokes retrieval.
- **Maintenance, A:** fails the same checks at the deadline (185.237 seconds).
  No tool event is recorded. Its prefilter/planning calls end without reported
  usage, so this attempt does not establish an execution-tool-budget failure.

The registered full-pass difference is zero, against a required 0.5. The
recorded B/A elapsed ratio is 1.0015; the recorded subscription-price-equivalent
ratio is 1.2639, exceeding the 1.25 ceiling. Deadline censoring and unreported
usage on interrupted CLI calls make these poor estimates of general speed or
cost. The report totals USD 1.6451 of **recorded subscription price equivalent**
and USD 0 of API spend; the former is not an invoice or complete quota measure.

## Evidence and replay

The stopped traces span 11:36:37–11:51:32 UTC on 2026-09-09. The archive contains
every attempt's initial/final stores, immutable document snapshots, workspaces,
source archive, trace, log, registration, score and accounting. No production
store was used. Model weights and the Python environment are pinned by identity,
not bundled. The registered runtime was not edited during the campaign.

Before execution, all 3,840 tests passed; typecheck, lint, audit, build, compiled
release/auth smokes and the real Haystack/container smoke passed. A dedicated
worker was rebuilt before registration because the earlier test image was no
longer present. Its build log is included; its content ID is in the registration.

Verify checksums from this directory with `shasum -a 256 -c SHA256SUMS`.
From the repository root, using the pinned Node and installed dependencies:

```bash
citations_replay_root=$(mktemp -d /tmp/atoma-citations-replay.XXXXXX)
tar -xzf benchmark/retrieval-citations-pilot-2026-09-09/evidence.tar.gz -C "$citations_replay_root"
node --import tsx benchmark/retrieval-haystack-agent-pilot-2026-09-09/replay.mjs \
  "$citations_replay_root/atoma-citations-pilot-evidence-20260909"
```

The existing replay checks the schedule, scores, runner epilogues, retrieval
observations and paired decision. It calls no model. A zero exit means the
archived outcomes reproduce, including failures.

## Decision

No task-success benefit is established. Do not loosen the exact-byte scorer,
force search, raise budgets or add a new validation gate from this live session.
Keep artifact correctness, run completion and unreported provider usage separate
when designing the next investigation. These results do not support replacing
the current weights or adding retrieval infrastructure as a remedy.
