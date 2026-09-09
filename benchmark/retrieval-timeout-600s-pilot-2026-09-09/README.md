# Ten-minute retrieval diagnostic, 2026-09-09

The user requested a longer timeout after the 180-second pilot interrupted
otherwise useful work. This new registration changes the development budget
to **600,000 ms per attempt**, with the same limit for all three arms and a
1,800,000 ms campaign ceiling. The selected question is `northstar-05`, whose
previous Atoma attempt produced a fully correct artifact but timed out.

All three new attempts delivered and passed every unchanged executable
scorer, including exact citations:

- Agentic Atoma: **221.996 s**, 24 recorded LLM completions,
  run `432c53ab-1188-4ad0-9036-11eef75480f2`.
- Atoma with hybrid Haystack: **152.678 s**, 14 recorded LLM completions,
  run `00c9b115-f0a5-4357-9db5-72186f3e4a7f`.
- Single frontier reference: **104.968 s**, one recorded LLM completion,
  run `275e2736-cc03-445f-ba24-88bf624d3a0d`.

## What changed and what this establishes

The correction is to the benchmark budget. No runtime, prompt, scorer or
retrieval implementation was changed. Source revision
`7b86255ea105b9debb959acc0fafeb5e7917f113` has the same executable source hash
as the previous MCP pilot. The same worker digest, model selectors, Haystack
content pins, isolation and learning policy were retained. The tag had been
removed locally, but the exact registered image digest remained available;
no replacement image was built.

`capToolIterations` also derives the maximum tool rounds from the remaining
wall budget, using the existing 26-second estimate. Before planning, the
180-second budget allows at most six rounds; 600 seconds allows 23. The
first actual L1 execution in this diagnostic received 21 after planning.
Thus this intervention changes both the wall deadline and its derived tool
allowance; it does not isolate their individual effects.

The successful Atoma trajectory took more than 180 seconds. This is direct
evidence that the old budget was insufficient for this trajectory, not proof
that every earlier failure was a timeout defect. Both current Atoma arms
passed; one question and one repetition cannot establish a general Haystack
quality or efficiency benefit. The paired full-pass difference is zero, so
the pre-registered retrieval improvement screen remains unmet. Do not turn
the machine report's single-pair speed or price ratios into public claims.

The previous maintenance task's missing outputs and off-by-one citations
were not rerun or corrected here. Its failures remain in the previous
archive. Ordinary product project runs already default to 30 minutes through
`ATOMA_PROJECT_TIMEOUT_MS`; this diagnostic does not change that default.

## Execution and evidence

- MCP tool: `atoma_benchmark_start` on the existing authenticated local viz.
- MCP task: `7beb4ebc83104c2969c66fa85ac1856a`, completed.
- Task window: 13:02:17–13:10:19 UTC on 2026-09-09.
- Order: agentic Atoma, Haystack Atoma, frontier reference; serialized by the
  existing global lease, with fresh synthetic authorities and state.
- Selectors: L1 `sub:anthropic:haiku`, L2 `sub:anthropic:sonnet`, L3 and
  reference `sub:anthropic:opus`. Existing cheaper validator routing remains
  unchanged; served models are recorded in the replay output.
- Recorded accounting: 39 LLM completions, USD 1.103 subscription price
  equivalent, zero paid API spend. No infrastructure failures were reported.
- Original traces remain visible under the Benchmark prefix in Runs; the
  live archive is `runs/benchmarks/haystack-mcp-timeout-600s-20260909`.
- After completion, the global lease was empty and no worker container
  using the registered digest remained running.

`evidence.tar.gz` preserves the source snapshot, frozen instruments,
workspaces, starting/ending databases, logs, traces and score results.
The MCP lifecycle files contain no bearer token. `replay-results.json` was
generated from a fresh extraction and exactly reproduced the recorded
scores, epilogues, retrieval observations and paired decision.

With the repository's pinned Node and dependencies, from the repository root:

```bash
cd benchmark/retrieval-timeout-600s-pilot-2026-09-09
shasum -a 256 -c SHA256SUMS
mkdir /tmp/atoma-timeout-replay
tar -xzf evidence.tar.gz -C /tmp/atoma-timeout-replay
cd ../..
node --import tsx benchmark/retrieval-haystack-agent-pilot-2026-09-09/replay.mjs /tmp/atoma-timeout-replay
```

The protocol was schema-validated and registered before model execution.
The runtime and worker are unchanged from the preceding release/browser
verification, so no new full build or paid verification calls were added.
