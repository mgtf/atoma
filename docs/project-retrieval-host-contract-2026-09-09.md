# Project retrieval host boundary — design and implementation contract

This is the boundary for Steps 4–5 of the
[action plan](project-retrieval-action-plan-2026-09-08.md). The first increment
is an injected library capability with mocked backends, not tenant rollout or
an index implementation. The author reviewed the adversarial cases below
before implementation; this is not an independent security review.

## Process and authority

Today `ProjectRunCoordinator` resolves identity/payers and starts a host run
process through `spawnRun`. That process owns `startTask`, the product-store
handle, the LLM client and `ToolExecutor`. Container mode forwards element
invocations over stdin to a worker with only the workspace mounted. The worker
has no product-store handle or provider credential.

The new composite executor intercepts exactly `search_project_docs` on the
host. Other declared names go to the existing executor. The worker handshake
remains the authority for worker tools; one separate host declaration is
merged once, with duplicate names rejected. Worker responses are returned as
data: they are never dispatched as requests. There is no worker callback,
host HTTP endpoint, new mount or change in egress.

`startTask` accepts an optional trusted `projectRetrieval` binding. It requires
an explicit matching `ATOMA_RUN_ID` before workspace/store setup. A binding
contains a parsed immutable scope, bounded settings and a host service. The
service must recheck current authorization before search and again before
returning its result, including empty or unavailable results. Denial and
authority lookup failure reveal no corpus identity, counts or error detail.
The final authorization check is the access decision's linearization point;
it does not promise to erase bytes delivered before a later revocation.

Tenant scope requires organisation, project, requesting principal, run,
corpus, snapshot digest and index generation. Operator scope binds one
explicit corpus/snapshot/run and carries no tenant IDs. Neither form permits
an omitted scope or wildcard. An operator binding is refused for a child
marked as a tenant run. The backend must enforce the entire bound scope in
its storage queries; a generation match alone is not tenant isolation.

The service is owned by this run after backend assembly. Shutdown aborts its
pending work, disposes it once within a bounded wait and cleans up the worker
even if disposal fails. Calls after shutdown cannot restart that worker.
It must implement cooperative cancellation and release its resources on
disposal. A bounded response timeout cannot preempt synchronous JavaScript or
kill arbitrary host work; no generic shell/process backend is accepted.

The existing L1 transport scope check, call budget, branch wrapper and trace
recorder surround the composite unchanged. No supervisor gains a tool-bearing
planning/validation call, and no proof obligation or trust bypass is added.

## Request and source evidence

Model arguments contain only plain-text `query`, optional `limit` and optional
`maxExcerptBytes`. JSON Schema is derived from the same runtime request schema.
Unknown fields, including tenant IDs, paths and SQL/filter arguments, fail.
Queries are NFC-normalized, split into Unicode letter/mark/number runs and
lowercased; punctuation is a delimiter, operator-looking words are literal
terms, repeated terms collapse, and an empty or overlong term list is invalid.
Backend adapters receive these terms as data and must use parameterized SQL
and quoted FTS terms, never interpolate the original query as an expression.

Successful results bind the corpus, snapshot and generation and carry exact
UTF-8 excerpts, source SHA-256, zero-based half-open byte spans, one-based
inclusive line spans, relative paths and deterministic heading ancestry.
Document IDs identify sources, not tool names or executable instructions.
Excerpts and headings remain untrusted tenant data even if their text looks
like a system message or tool request. The
[ingestion/backend](project-retrieval-sqlite-2026-09-09.md) constructs spans and
quotes from the same immutable bytes; schema validation alone cannot prove that
a quote exists in an original document.

The wrapper never cuts a quote and leaves its old coordinates attached.
Overlong passages and passages beyond the serialized-response budget are
omitted whole and set `truncated: true`. UTF-8 bytes include JSON escaping in
the total budget. The ceiling is below the existing model-facing tool-result
truncation ceiling so that a valid result remains valid JSON.

`ok` with zero passages means no matches. `denied`, `invalid_request`,
`unavailable`, `cancelled` and `timed_out` are distinct content-free outcomes.
Ranking scores, when present, are diagnostics and never correctness scores.

## Adversarial review and required tests

- Forged scope or host paths in arguments: strict schema rejection before
  service dispatch. Modifying the caller's original binding cannot retarget
  the frozen scope or expand its limits.
- Duplicate worker/host names: refuse assembly and clean up the allocated
  backend. Never silently shadow a worker declaration.
- Revocation during search: discard the result after the second access check.
  Missing, throwing or non-boolean authorization fails closed.
- Wrong corpus/snapshot/generation or malformed backend output: return
  unavailable without provider error strings or source data.
- Malicious source text or request-shaped worker results: preserve data
  verbatim, never execute it or promote it to trusted instructions.
- Missing index, empty results, punctuation/Unicode, cancellation during
  authorization/search, deadline expiry and resource disposal: distinct,
  bounded outcomes through the same implementation in both backend modes.
- Concurrent branches: retain their existing transport trace IDs and avoid
  ambient mutable caller/branch state in the service.

## Activation still required

The CLI, project coordinator and benchmark do not construct this binding yet.
Existing canonical molecule declarations are not widened automatically; only
an L1 explicitly declaring the capability may invoke it.
No environment variable or model-authored manifest activates it. Before tenant
activation, the coordinator must pass immutable scope through its existing
allowlisted launch snapshot; the child must resolve it against the current
project/run/principal and immutable corpus records in the existing product
store. The authoritative resolver must enforce revocation/deletion again on
each query. A stored launch grant is insufficient. The SQLite FTS5 backend now
exists as a host library; authoritative store/corpus records and their resolver
remain later increments, with process-boundary tests before enabling any tenant
launch. Operator activation likewise requires
an explicitly supplied immutable corpus, never a scan of arbitrary host files.

## Verification of this increment

`release:check` passed, including both TypeScript configurations, lint, the
full mocked-provider suite, audit, build and compiled smokes. After
`build:worker`, the container suite ran with `CI_REQUIRE_DOCKER=1`, including
`tests/project-retrieval-container.test.ts` and the existing isolation/import
closure/lifecycle tests. It verifies host dispatch, absent worker capability,
inaccessible host source files/environment and no dispatch from worker data.
The L1 transport tests also preserve branch-labelled tool traces and reject
off-scope calls. These checks originally certified the host boundary alone.
The [subsequent backend record](project-retrieval-sqlite-2026-09-09.md) covers
ingestion and FTS5; the tenant store resolver remains unimplemented.
