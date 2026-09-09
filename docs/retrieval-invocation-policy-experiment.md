# Retrieval invocation policy experiment

The maintenance diagnostic on 2026-09-09 passed with Haystack available but
without a retrieval call. Availability and actual use must be distinguished.

A Haystack development registration may now set `haystackInvocation` to
`available` (also the behavior when omitted) or `search-first`. The latter
appends a fixed instruction only to the Haystack arm's task: an L1 molecule
must search before reading source documents or changing files, then may read
files to verify or supplement the returned evidence. Failures and empty
results remain observations; they do not authorize invented evidence.

This is an instruction experiment, **not automatic runtime execution**. The
existing host trace establishes whether the agent followed it. No supervisor
invokes an element and no new result gate forces a passing run. Record actual
search count, failures, returned evidence coverage and call order alongside
the unchanged correctness scores. Never label a run that ignored the
instruction as successful systematic retrieval merely because it delivered.

Compare two newly registered campaigns on the same day and committed source,
with identical questions, budgets, model selectors, worker digest and Haystack
pins. Keep the single frontier reference and the agentic Atoma control in
both campaigns. Do not reuse an older run as a matched control. All runs use
the shared runner and existing MCP/viz surface, serialized by the global lease.

For each attempt report correctness, elapsed time, subscription price
equivalent, LLM completions and observed retrieval use. The campaign report
also exposes the subscription price equivalent per arm. Unknown accounting
remains null. These figures use the existing runner cost authority and do not
include subscription fees, local computation or amortized indexing costs.

The first pilot uses the development maintenance question `northstar-13`,
one repetition, 600 seconds per attempt. Its purpose is to test instruction
adherence and collect costs, not to establish a population benefit. The
held-out corpus remains unused. Preserve raw traces, recovered errors and
starting/ending stores; replay unchanged scorers from the archived evidence.

The companion tool correction admits direct `sha256sum` calls in the default
shell allowlist. Explicit narrower allowlists still prevail. The compiled
container smoke checks the known SHA-256 of `abc` through the real worker
protocol, alongside allowed egress and denied control-plane access. Operators
may select its image with `ATOMA_WORKER_IMAGE`; omission retains the existing
default. Rebuild the worker to pick up the command change.
