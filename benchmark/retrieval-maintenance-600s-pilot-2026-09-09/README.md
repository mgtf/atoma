# Maintenance diagnostic and usage display, 2026-09-09

All three attempts passed every unchanged executable scorer for `northstar-13`,
with a 600-second budget per attempt and a 1,800-second campaign ceiling:

- Frontier reference: 94.722 s, one LLM completion, run
  `15293dd0-b6d8-4ce3-8c55-d563cb88e0ad`.
- Atoma with Haystack available: 223.079 s, 22 LLM completions, run
  `b736bff5-bf2f-488c-b1f5-11d2e1e6c6e2`.
- Agentic Atoma: 152.503 s, 14 LLM completions, run
  `62776e55-d6c9-41a3-b464-1dd1d39c1567`.

Each workspace contains the required answer with exact citations and the
correct pricing change: EUR 19 monthly, EUR 190 annually, 14-day refunds.
The protected documentation and preview code remain unchanged. The earlier
missing-answer and off-by-one citation failures did not recur in this sample;
no prompt, scorer or citation gate was changed to obtain these results.

**The Haystack-equipped agent did not invoke retrieval.** It read files
directly. This run therefore establishes successful maintenance with the
backend available, not a retrieval quality or efficiency benefit. Both Atoma
arms pass; the registered improvement screen is unmet. One development
question and one repetition do not establish production reliability. Orchard
remains held out. Do not compare these timings as a population estimate.

The Haystack arm attempted `sha256sum` directly through `run_shell`, received
the existing allowlist refusal and recovered. That event remains in the raw
trace. No infrastructure failure or timeout occurred. There were 37 recorded
LLM completions, USD 1.0233 subscription price equivalent (rounded runner
receipts), and zero paid API spend.

## Usage display correction

Source `26da163` fixes a misleading GPU display, not missing final accounting.
The frontier transport returns usage at the end of its single tool-bearing
completion. Until then the trace has tools but zero completed-call totals.
The GPU summary now displays `Awaiting usage`; known totals with outstanding
receipts are marked partial, and a closed run without its receipt displays
`Usage unavailable`. Final totals retain their existing accounting.

This does not add streaming token measurements or fabricate live estimates.
The previous completed reference already contained its tokens and USD
0.55138 estimate. The new reference receipt contains 28 uncached input tokens,
6,089 output tokens, 571,744 cache-read input tokens, 13,663 cache-creation
input tokens and USD 0.52363075 price equivalent. Cached inputs are separate
from the summary's input/output figures.

Validation: 171 targeted rendering/polling tests, both TypeScript projects,
lint, docs checks, build, real Chrome MCP OAuth and GPU smokes passed. The
GPU test exercises pending, interrupted, partial and completed receipt states
through the production Runs renderer. The browser smoke includes live polling
and WebGL fallback. The first sandboxed browser attempt could not bind its
loopback socket; the authorized rerun passed. Logs are included below.

## Execution and replay

The pre-registered order was frontier, Haystack Atoma, agentic Atoma, using the
same source, models, budgets and isolation policy. This is a fresh same-day
comparison through `atoma_benchmark_start` on the existing authenticated viz.
Task `e8e98de3dd3c4756c6c1b9f4b07c0b74` completed. Original traces remain in
`runs/benchmarks/haystack-mcp-maintenance-600s-20260909` and visible in Runs.
The global lease was empty and the worker containers were gone after completion.
The existing pinned worker was reused: this source change touches only GPU
rendering and its English catalog, not the worker's compiled import closure.

`evidence.tar.gz` preserves the source, frozen instruments, workspaces,
starting/ending stores, logs and traces. A fresh extraction reproduced all
scores, runner receipts and retrieval observations in `replay-results.json`.
MCP lifecycle files contain no bearer token.

With the pinned Node and repository dependencies:

```bash
cd benchmark/retrieval-maintenance-600s-pilot-2026-09-09
shasum -a 256 -c SHA256SUMS
mkdir /tmp/atoma-maintenance-replay
tar -xzf evidence.tar.gz -C /tmp/atoma-maintenance-replay
cd ../..
node --import tsx benchmark/retrieval-haystack-agent-pilot-2026-09-09/replay.mjs /tmp/atoma-maintenance-replay
```
