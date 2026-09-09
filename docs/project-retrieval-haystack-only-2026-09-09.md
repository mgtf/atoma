# One retrieval backend: Haystack

Date: 2026-09-09. Owner-directed simplification after the development pilot.

Haystack is now the only project-document retrieval backend. It supports a
lexical `bm25` pipeline and a `hybrid-rerank` pipeline that adds local dense
retrieval, reciprocal-rank fusion and cross-encoder reranking. Both use the
same `search_project_docs` element. BM25 remains an algorithm inside Haystack;
SQLite FTS5 is no longer an alternative product backend.

This removes an actual duplicate: preparing a Haystack run previously also
built an unused FTS5 cache, and its access checker was constructed through
the SQLite search service. Source admission now creates only the immutable
source archive and receipt. The access checker reads current project authority
directly. Haystack builds the one search index in its run-owned process after
the runner owns cancellation, deadlines, traces and teardown.

SQLite remains Atoma's primary product store for identity, receipts, history
and other existing state. No product store is added. Existing FTS cache tables
are neither consulted nor silently migrated or deleted; source archives and
historical evidence are preserved. New runs create no FTS tables. Haystack's
current index is in memory and reconstructed for each run.

## Activation

Search is mandatory for every new project run launched through the project
coordinator (browser, MCP or `projects run`). The host must supply
`ATOMA_PROJECT_RETRIEVAL_HAYSTACK`: an explicit Python executable, pipeline
settings and Python/package metadata digest. Missing or malformed configuration
fails before acquiring the run lease or reserving a run. Read-only server
startup, publication retries and idempotent reads of existing runs remain
available without this configuration.

There is no activation switch. The former `ATOMA_PROJECT_RETRIEVAL` variable
has no effect, including when set to `0`. Every new project run archives its
admitted source documents, records its receipt and initializes Haystack before
model execution. A first run still exposes search with an empty corpus. The
corpus remains the previous delivered run's manifest-admitted Markdown/text
artifacts; mandatory search does not expand which documents a tenant can read.

The coordinator stamps `ATOMA_PROJECT_RETRIEVAL_RECEIPT=1` on the child after
preparation; this is an internal assertion, not host configuration. A stamped
child refuses a missing receipt or Haystack configuration. Neither that marker,
the runtime settings nor source/store paths reach the worker. Preparation and
warmup consume the existing run deadline. Failures stop the run; there is no
fallback to a search-free project run.

The element is always available to L1. The molecule chooses queries when they
are relevant; no forced empty query or new model call is added. Ordinary file
and shell tools remain available. Standalone operator tasks have no tenant
project corpus; trusted library bindings remain supported.

For a lexical-only deployment, provision a host Python environment using
`scripts/requirements-haystack.txt`. No embedding model, reranker weights or
paid retrieval API is needed. From the repository root, after provisioning:

```bash
export ATOMA_PROJECT_RETRIEVAL_HAYSTACK="$(/absolute/venv/bin/python - <<'PY'
import json, subprocess, sys
identity = json.loads(subprocess.check_output([
    sys.executable, '-I', 'scripts/retrieval-haystack.py', '--identity'
], text=True))
print(json.dumps({
    'python': sys.executable,
    'settings': {'mode': 'bm25'},
    'runtimeSha256': identity['sha256'],
}))
PY
)"
```

These are host settings for the compiled projects CLI or viz coordinator;
restart a long-running coordinator after changing them. The Python path is
a placeholder for the operator's provisioned environment. Hybrid settings
still require the local models and content pins described in the
[Haystack implementation](project-retrieval-haystack-2026-09-09.md). Startup
validates runtime identity and consumes the run budget before any model
completion. Failure or cancellation closes Python and preserves accounting.

## Benchmarks and verification

The former SQLite implementation lives only in
`benchmark/haystack/sqliteBaseline.ts`, for the component comparator. Its native
SQLite tests remain. This module is outside the product build and is not
imported by any `src/` module. Use
`node --import tsx benchmark/haystack/evaluate.mjs`; the benchmark README
documents its commands. Historical capacity/smoke scripts moved beside it.

Old SQLite agent registrations and archived scores remain readable and
replayable. New `bm25-development` execution is refused before acquiring a
lease; reproducing that old runtime requires its archived revision. New
registrations use `haystack-development`, including for a lexical-only
Haystack pipeline. Scientific controls are constructed by the registered
benchmark harness through the shared runner, outside the product coordinator.
Only treatment B receives a receipt and the pinned search runtime; controls
cannot inherit the host's retrieval settings. This is not a project rollout
switch. No historical result is relabeled as a Haystack result.

Regression coverage checks source freezing, live revocation, tenant isolation,
startup failure, cancellation and runner accounting. It also verifies that
no SQLite retrieval tables are created and that retained legacy cache data
cannot affect a Haystack run. The compiled process smoke uses a real child
with a ranking protocol fixture by default; `--haystack` selects the real
provisioned runtime, and `--container` verifies the worker boundary.

This is a maintenance and architecture decision, not a positive quality claim.
The [negative agent pilot](../benchmark/retrieval-haystack-agent-pilot-2026-09-09/README.md)
still stands. Correct citation assembly and complete answer/artifact delivery
remain the next evaluation questions. Mandatory project search is an explicit
owner decision; it does not turn that pilot into evidence of a quality gain.
No new live model campaign or scorer change is part of this change.

Verification of the preceding backend consolidation: `release:check` passed 3,828 tests with 13 environment
skips, both TypeScript configurations, lint, audit and compiled smokes. The
real local hybrid runtime passed `--container --haystack` using an image built
from the verified output. Both six-attempt agent archives and all component
observations replayed unchanged. The product build contains no SQLite retrieval
backend module; its historical comparator remains independently executable.

Mandatory-launch verification: `release:check` passes with the local Haystack
runtime tests enabled. Coordinator regressions cover an absent or obsolete off
switch, missing configuration before reservation, an empty first corpus,
preparation inside the original deadline, cancellation and idempotent retries.
The compiled `--container --haystack` smoke also passes against a worker image
built from this output; it checks source retrieval, live revocation and absence
of host source paths, store configuration and retrieval settings in the worker.
No live model calls were made for this change.
