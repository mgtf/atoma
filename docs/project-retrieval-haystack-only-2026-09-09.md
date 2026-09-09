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
`ATOMA_HAYSTACK_CONFIG`: an explicit Python executable, pipeline
settings and Python/package metadata digest. Missing or malformed configuration
fails before acquiring the run lease or reserving a run. Read-only server
startup, publication retries and idempotent reads of existing runs remain
available without this configuration.

There is no activation switch or child activation marker. Every new project run archives its
admitted source documents, records its receipt and initializes Haystack before
model execution. A first run still exposes search with an empty corpus. The
corpus remains the previous delivered run's manifest-admitted Markdown/text
artifacts; mandatory search does not expand which documents a tenant can read.

The child reads the recorded receipt directly from the product store after
validating project authority. An existing receipt requires Haystack even when
configuration is absent, the receipt is revoked or its contents are corrupt;
these cases refuse startup rather than silently removing search. Only the
engine configuration travels in `ATOMA_HAYSTACK_CONFIG`. It describes the
Python runtime and pipeline settings, not whether search is enabled.
The runtime settings and source/store paths never reach the worker.
Preparation and warmup consume the existing run deadline. Failures stop the
run; there is no fallback to a search-free project run.

The element is always available to L1. The molecule chooses queries when they
are relevant; no forced empty query or new model call is added. Ordinary file
and shell tools remain available. Standalone operator tasks have no tenant
project corpus; trusted library bindings remain supported.

For a lexical-only deployment, provision a host Python environment using
`scripts/requirements-haystack.txt`. No embedding model, reranker weights or
paid retrieval API is needed. From the repository root, after provisioning:

```bash
export ATOMA_HAYSTACK_CONFIG="$(/absolute/venv/bin/python - <<'PY'
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

To store the generated value in a checkout `.env`, print the literal line:

```bash
printf "ATOMA_HAYSTACK_CONFIG='%s'\n" "$ATOMA_HAYSTACK_CONFIG"
```

Copy that output into `.env`, replacing any existing entry for this key.
Do not put the command substitution itself into `.env`: dotenv does not
execute shell commands. `.env.example` includes the corresponding template.
Compiled services read the process environment, so their service environment
must receive the same value; placing it in `.env` alone does not configure them.

These are host settings for the compiled projects CLI or viz coordinator;
restart a long-running coordinator after changing them. The Python path is
a placeholder for the operator's provisioned environment. Hybrid settings
still require the local models and content pins described in the
[Haystack implementation](incidents/project-retrieval-record-2026-09-09.md#haystack-retrieval-experiment). Startup
validates runtime identity and consumes the run budget before any model
completion. Failure or cancellation closes Python and preserves accounting.

## Benchmarks and verification

### Host configuration and diagnostics

After provisioning the Python environment and model directories, generate
configuration with the supported CLI (from the repository root):

```bash
npm run --silent haystack:config:dev -- \
  --python /absolute/venv/bin/python \
  --embedding /absolute/models/embedding \
  --reranker /absolute/models/reranker \
  --query-prefix 'Represent this sentence for searching relevant passages: '
```

The prefix above belongs to the tested BGE English model; supply the prefix
required by your chosen model, including an explicit empty string when needed.
Omit all three model options for BM25. The command prints JSON only, computes
content pins with the production reader, and checks runtime imports offline.
It never downloads models or rewrites `.env`. Paste its JSON into the quoted
`ATOMA_HAYSTACK_CONFIG` entry in `.env` for development. For production, use
`npm run --silent haystack:config -- ...` from the built release on the target
host and put the entry in `/home/atoma/config/atoma.env` for the supplied systemd
service. Restart the coordinator while idle after changing configuration.

`npm run doctor:dev` loads the checkout environment; `npm run doctor` checks
the process environment of a compiled deployment. Configured search is checked
for importability, runtime identity and model content pins without inference,
downloads or provider calls. Missing configuration fails a gated project host
and warns an ungated operator host. A passing check does not prove model weights
can load or answer correctly; use the real runtime smoke for that proof.

Package installation still uses `scripts/requirements-haystack-hybrid.txt`.
This pins direct dependencies, not a complete platform-specific dependency
lock or an immutable runtime image. Those packaging steps remain outstanding.

Semantic retrieval and reranking receive the original NFC query; only BM25
receives the normalized lexical terms. Historical benchmark results predate
this correction and must not be attributed to the new query path.

### Citation assembly and incomplete delivery

Every returned passage now includes a `citation` object with `path`, `sha256`,
`startLine`, `endLine` and `quote`. The host derives it from the admitted passage,
preserving blank lines, CRLF and the final newline. Copy it as a whole reference;
it does not claim which individual line proves a fact. Narrower citations need
an explicit source read and exact-line verification. Backend-supplied citations
that disagree with the passage are refused. Citation bytes count toward the
existing response cap, so fewer passages may fit; no response budget is raised.

The [archived pilot](../benchmark/retrieval-haystack-agent-pilot-2026-09-09/README.md)
shows two different failure paths. On question 05 the source was retrieved but
its lines were misquoted. On question 13 the frontier explicitly reported tool
budget exhaustion after its configuration edit; Atoma's later answer-writing
phase was never reached before the deadline, while retries repeated discovery.
There is no evidence that a missing-file gate alone would complete either run.

L1 execution now sees the same effective tool-iteration limit sent to its
transport, with guidance to reserve capacity for all deliverables and resume
from current state. This does not increase budgets or preserve provider sessions
between retries. No new validation gate, automatic search injection or line
reranking is introduced. These changes require a fresh registered pilot to
establish any task-success benefit; the historical scorer remains unchanged.

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
runtime tests enabled. Coordinator regressions cover launch without an activation switch,
missing configuration before reservation, an empty first corpus,
preparation inside the original deadline, cancellation and idempotent retries.
The compiled `--container --haystack` smoke also passes against a worker image
built from this output; it checks source retrieval, live revocation and absence
of host source paths, store configuration and retrieval settings in the worker.
No live model calls were made for this change.

The launch marker and the old configuration prefix have been removed from
source, tests and authored documentation. The runner also refuses a recorded
receipt without engine configuration and a revoked receipt with or without
configuration. Synthetic benchmark controls remain identifiable by their
absence of a receipt; they cannot inherit the host engine configuration.
