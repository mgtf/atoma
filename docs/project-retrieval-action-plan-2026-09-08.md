# Project retrieval — implementation action plan

Date: 2026-09-08, progress updated 2026-09-09. Status: evaluation instruments,
A/C characterization driver, archived development pilot and the typed host
retrieval boundary delivered.
Production retrieval and retrieval-provider integrations remain unimplemented.

## Implementation progress

The [evaluation instruments](../benchmark/retrieval/README.md) contain 26
questions across development and held-out project families, two maintenance
tasks, and separate sibling-project/foreign-organisation isolation fixtures.
Source hashes and evidence spans are checked before preparation or scoring.
The existing benchmark CLI provides `retrieval validate`, `prepare`, and
`score`, without provider calls. Typed contracts and executable scorer tests
cover both source and compiled-module paths.

This delivers the fixture portion of Steps 1–2 and the characterization driver
in Step 3. Registration pins source/instruments/models/image and alternates
Atoma/frontier-direct attempts. Execution uses `spawnRun`, the shared runner,
the global lease, mandatory containers and independent fresh state. Its first
supported mode is development characterization through host subscriptions.
No project snapshot ingestion or production search element is implemented.
The [four-attempt development pilot](../benchmark/retrieval-pilot-2026-09-09/README.md)
completed on one source revision and UTC day. Frontier-direct passed both
tasks; Atoma reached both registered deadlines, with correct pricing facts or
maintenance behavior but incomplete source-supported delivery. This tiny
sample identifies development failure cases, not a retrieval benefit. The
[retrieval protocol](../benchmark/retrieval/PROTOCOL.md) still requires a new
paired control when the search treatment exists.

Steps 4–5 now have a [reviewed host contract](project-retrieval-host-contract-2026-09-09.md)
and an opt-in `startTask` library binding. `search_project_docs` is intercepted
before the worker, with strict query-only arguments, pre/post authorization,
bounded exact-source results, cancellation and run-owned cleanup. The worker
handshake and default tool list remain unchanged. Mocked service, L1 transport,
runner and container integration tests exercise the boundary. Production
corpus ingestion, the current-access store resolver, cross-process coordinator
activation and FTS5 are still to implement; the CLI does not enable search.

## Objective and implementation order

Help Atoma's molecules find project constraints and cite the exact documents
that support their work. Measure the improvement against the existing
`list_files`, `read_file`, and `run_shell` workflow before adopting more
expensive retrieval components.

The sequence is corpus → executable evaluation → agentic baseline → scoped
host execution → SQLite FTS5/BM25 → evaluation → operational rollout.
Embeddings, reranking, generated passage context, and Qdrant are conditional
extensions, each with its own measurement. They are not prerequisites for
the first useful implementation.

The stable product boundary is one L1 search element with interchangeable
backends. It returns bounded, versioned source excerpts as data. It neither
generates the task's answer nor makes trust, validation, or execution
decisions. Atoma retains its existing supervision loop.

This plan specifies work to perform. Proposed filenames, element names, and
configuration fields below are design targets unless linked as implemented
above. Checked items in Phase A refer to evaluation fixtures, not product
ingestion or a deployed search element.

## Contracts to read before implementation

- [Root contract](../AGENTS.md): isolation, one product store, benchmarks,
  source verification, release requirements, and preservation of live state.
- [Tools](../src/tools/AGENTS.md), [run](../src/run/AGENTS.md), and
  [contracts](../src/contracts/AGENTS.md): element execution and shared shapes.
- [Projects](../src/projects/AGENTS.md) and [auth](../src/auth/AGENTS.md):
  project identity, run admission, and current access rights.
- [Core](../src/core/AGENTS.md): stores, metrics, cost, and branch context.
- [Atoms](../src/atoms/AGENTS.md) and [registry](../src/registry/AGENTS.md):
  capability scopes, canonical bootstrap, trust, and validation.
- [CLI](../src/cli/AGENTS.md): benchmark, doctor, backup, and deployment.
- [Skills](../src/skills/AGENTS.md) and the
  [SaaS boundary](saas-architecture.md#skills-are-a-commons): shared recipes
  do not make tenant documents shared knowledge.
- [Existing benchmark protocol](../benchmark/PROTOCOL.md): historical
  experiments remain unchanged; register retrieval as a new experiment.

## Phase A — establish the question before building the index

### Step 1 — freeze the first corpus contract

**Purpose:** define what the search element can know and what a benchmark
result will actually establish.

- [x] Select versioned textual documentation from the target project's
  supplied repository snapshot: README files, Markdown documentation,
  specifications, and architecture/product decisions stored as files.
- [x] Start with Markdown and UTF-8 plain text. Record the supported formats,
  inclusion paths, byte limits, and exclusions in a corpus manifest.
- [x] Exclude raw run traces, logs, skill bodies, executable source indexing,
  generated dependency trees, secrets, binaries, PDFs, and external connectors
  from this first corpus. Their evaluation and ingestion are separate work.
- [ ] Use the repository snapshot already supplied to the run. In the current
  project flow, a previous delivered workspace may provide that seed; do not
  imply that arbitrary GitHub repositories are already imported. A project
  with no supplied documentation has an empty corpus.
- [x] Identify every document by an internal project namespace, normalized
  relative path, content digest, and snapshot identifier. Record a commit SHA
  only when that SHA is known to describe the supplied bytes. A workspace
  derived from a delivery is not automatically a Git commit.
- [ ] Make the first search corpus the starting documentation snapshot of a
  run. Freeze membership and bytes for the run; expose the snapshot identity
  in every result. A run's new writes enter a later snapshot, not a background
  mutation of the index used by that run.
- [x] Specify that a snapshot citation proves what that snapshot contains.
  Claims about the current, modified workspace still require `read_file` or
  the existing ground-truth path. Revocation and deletion remain effective
  even while an older snapshot is pinned.
- [x] Record document counts, bytes, languages, expected update cadence, and
  project sizes from the selected fixtures. Do not invent production scale.

**Deliverable:** a corpus specification and reproducible, non-sensitive
fixtures under a proposed `benchmark/retrieval/` directory. Both experimental
arms must receive the same documents through their sandbox inputs. Expected
answers and scorer code must stay outside those inputs.

**Exit condition:** each included document has an authoritative source,
membership rule, version, and access scope. No index implementation starts
until this specification and Step 2's instruments are frozen.

### Step 2 — build the golden questions and executable scorers

**Purpose:** define success independently of any particular retriever.

- [x] Create a development split and a held-out split separated by project or
  document family, not merely by rephrasing the same questions.
- [x] Cover exact identifiers, paraphrases, French/English queries, nearby
  conflicting statements, superseded decisions, questions requiring several
  passages, and questions whose answers are absent.
- [x] Include repeated filenames and similar documents across projects and
  organisations in a separate isolation fixture set.
- [x] Give each question an ID, corpus snapshot, required facts, acceptable
  source documents and spans, and an explicit answerability label. Bind golden
  evidence to source bytes and offsets, not to the first chunker's chunk IDs.
- [x] For answer tasks, use a small structured result with facts and citations
  that a deterministic scorer can check. No LLM judge is the primary authority;
  archive complete model outputs when the live runner lands in Step 3.
- [x] Build source-verification scorers that reject invented references,
  wrong snapshots, unsupported facts, and quotations absent from the cited
  bytes. Distinguish no answer from infrastructure failure.
- [x] Add maintenance tasks where a documented constraint changes the correct
  implementation. Their fixed scorer must execute against the deliverable,
  catching both omission of the requested change and unrelated regressions.
- [x] Prove the scorers discriminate: a reference answer/fix passes; an empty
  answer, wrong version, fabricated citation, unchanged seed, and plausible
  but incorrect implementation fail the applicable checks.
- [x] Record fixture provenance and permission to publish. No live tenant
  documents or private traces enter the repository benchmark archive.

**Implemented files:** `benchmark/retrieval/corpus.json`, `questions.json`,
`instruments.lock.json`, `snapshots/` and `references/`;
[contracts](../src/contracts/retrievalBenchmark.ts),
[scorer](../src/cli/retrievalScorer.ts), and
[behavioral tests](../tests/retrieval-benchmark.test.ts).
The first live characterization registration is linked in Step 3.

**Exit condition:** the questions, held-out split, and executable scoring
rules exist before the first line of production index code.

### Step 3 — register the comparison and run the agentic baseline

**Purpose:** measure the existing capability rather than assume a retrieval
deficit.

- [ ] Register sample size, repetition count, model selectors, budgets, corpus
  hashes, source revision, cache policy, ordering, timeouts, and stopping
  rules before the measurement. Select the sample size from the question
  coverage and experiment budget, not from favorable early results.
- [ ] Register three arms: A is Atoma with existing agentic search; B is the
  same Atoma configuration plus the proposed search element; C is the
  repository's frontier-direct reference through the existing baseline runner.
  A versus B isolates retrieval's contribution. C preserves the broader
  benchmark reference and must not be mistaken for a retrieval-only ablation.
- [ ] Hold every A/B setting constant except retrieval availability, including
  the document corpus, model pins, tools other than search, sandbox, learning
  policy, trust starting state, cache treatment, and watchdog.
- [ ] Extend the existing benchmark driver and shared runner with an explicit
  retrieval condition. Do not replace the historical meaning of `--baseline`
  or build a second execution/supervision loop.
- [x] Implement A/C characterization registration and execution in the existing
  benchmark CLI using `spawnRun` and the shared runner. Treatment B and the
  confirmatory decision rule remain unimplemented.
- [x] Reset each paired run to independently copied starting state. Prevent
  skill learning, trust changes, answers, or caches from one arm contaminating
  the next. Fix the learning policy before running the experiment.
- [x] Preserve provider-cache behavior honestly: local reset cannot guarantee
  a provider-side cold cache. Balance run ordering, record cache usage, and
  avoid describing unobservable provider state as controlled.
- [ ] Run A and C initially to characterize errors. Once B exists, rerun the
  registered arms on the same revision and day. The earlier characterization
  is not a valid final control for a later treatment.
- [x] Complete and archive the initial two-question, four-attempt A/C
  development pilot, including failed task outcomes and the pre-model archive
  failure. See the [pilot report](../benchmark/retrieval-pilot-2026-09-09/README.md).
  Broader coverage, held-out confirmation and the later paired rerun remain.
- [ ] Register a primary decision rule: constraint-correct, source-supported
  outcomes on held-out tasks, with a minimum useful improvement and explicit
  cost/latency ceilings. Alternatively pre-register a cost-saving objective
  with a correctness non-inferiority margin. Choose before seeing B's data.
- [ ] Report sample size, paired differences and uncertainty, full-pass rates,
  citation validity, abstention accuracy, total tokens, calls, wall time,
  failed attempts, and actual API spend separately from subscription price
  equivalents. Retrieval recall is diagnostic, not proof of task success.
- [ ] Record indexing time, CPU, memory, disk and rebuild frequency separately;
  report first-use cost and amortization at declared reuse counts. Agentic
  search has no new index service but still consumes model time and tokens.
- [x] Run campaigns serially under the existing machine-wide lease. Archive
  starting/ending stores, skill state, traces, scorer outputs, configuration,
  and hashes outside ignored `runs/`, without disturbing live product state.

**Read/extend:** [benchmark driver](../src/cli/benchmark.ts),
[baseline executor](../src/run/baseline.ts),
[shared runner](../src/run/runner.ts), and existing benchmark tests.
Implemented characterization support:
[registration](../src/cli/retrievalRegistration.ts),
[campaign driver](../src/cli/retrievalCampaign.ts), and
[contracts](../src/contracts/retrievalCampaign.ts).

**Exit condition:** a registered experiment and baseline report identify the
failure classes worth testing. Paid campaigns are explicit experiment work;
ordinary tests use mocks and never call paid providers.

## Phase B — define the execution and data boundaries

### Step 4 — review the host execution contract before implementation

**Purpose:** add a narrow host capability without weakening worker isolation.

- [x] Document the actual process chain: project coordinator → host-side run
  process → `ToolExecutor` → container worker. The host run process already
  receives the selected product-store path; the worker does not.
- [x] Define a composite executor in `src/tools/`, assembled by
  `src/run/toolBackend.ts`. It routes exactly the new search name to an
  injected host implementation and existing names to the selected backend.
- [x] Keep local and container modes on the same search implementation and
  shared request/response schemas. No worker callback protocol is required
  for this design: intercept the L1 call before sending anything to the worker.
- [x] Preserve the worker's handshake as the authority for worker tools.
  Advertise host tools from a separate explicit declaration list and merge
  once. Reject duplicate names; never advertise host search as worker support.
- [ ] Bind organisation, project, run, caller, snapshot and permitted corpus
  to trusted run construction. Pass the necessary immutable metadata across
  `spawnRun`; do not derive authority from task prose or mutable workspace files.
- [x] Define how current access is rechecked before dispatch and before an
  in-flight result is returned. A launch snapshot alone is insufficient for
  revocation. Prefer the existing authorization/store seam; do not introduce
  an unauthenticated host HTTP service for the worker.
- [x] Define the operator-local case explicitly: it can search only its
  supplied local corpus. Absence of tenant identity must never become a
  wildcard over organisation documents.
- [x] Preserve tool-scope enforcement, branch identity, recording wrappers,
  call budgets, deadlines, and cleanup around the composite executor.
- [x] Review adversarial cases before coding: forged scope, host path inputs,
  duplicate tool names, calls originating from worker output, malicious source
  text, revocation races, and a backend unavailable during a run.

**Read/extend:** [tool backend](../src/run/toolBackend.ts),
[container executor](../src/tools/containerExecutor.ts),
[worker protocol](../src/tools/containerProtocol.ts),
[coordinator](../src/projects/coordinator.ts),
[process launcher](../src/cli/burnin.ts), and
[branch context](../src/core/branchCtx.ts).

**Exit condition:** the authority flow is explicit and reviewed. No new route
out of the worker, credential mount, store mount, or generic host execution
surface is part of the implementation.

**Implemented boundary:** [design and activation limits](project-retrieval-host-contract-2026-09-09.md),
[host element](../src/tools/projectRetrieval.ts),
[composite executor](../src/tools/projectRetrievalExecutor.ts), and optional
`startTask` injection. The trusted library caller must supply an explicit
matching run ID. The tenant coordinator/store resolver is not wired yet.

### Step 5 — define one typed search contract

**Purpose:** allow backend changes without changing what L1 agents invoke.

- [x] Define a runtime schema once in
  `src/contracts/projectRetrieval.ts`; infer types from it everywhere.
- [x] Register `search_project_docs` as the immutable invocation name, with
  a separate host element identity; never add it to the worker handshake.
- [x] Limit model input to a query and bounded result/excerpt requests.
  Tenant IDs, database paths, URLs, SQL, provider selectors, index names,
  credentials and raw backend filters are not model arguments.
- [x] Specify results with status, corpus/snapshot generation, truncation
  information, and passages carrying document ID, relative path, source
  digest, source span, heading context and original excerpt.
- [x] Separate `ok` with zero matches from `unavailable`, invalid input, and
  denied access. Denials reveal no existence or counts for inaccessible data.
- [x] Treat ranking scores as optional diagnostics. Do not expose them as
  correctness probabilities or make cross-backend scores a public threshold.
- [x] Enforce query, candidate, excerpt, total-response and execution limits.
  Resolve limits once through trusted configuration and record them in the
  experiment. Caller-requested limits can only narrow the configured bounds.
- [x] Specify query parsing, punctuation and Unicode behavior. Plain text
  queries must not become arbitrary SQL or an unrestricted FTS expression.
- [x] Define a host-only backend interface accepting the trusted scope,
  validated query, deadline and cancellation signal, returning the shared
  result shape. Lifecycle/index-building operations remain operator/runtime
  operations, not additional L1 elements.

**Exit condition:** mocked contract tests cover success, empty corpus,
unavailable index, malformed input, denial, cancellation and truncation.
No new proof obligation or trust fast path is introduced.

## Phase C — implement the first backend

### Step 6 — build deterministic ingestion and source provenance

**Purpose:** turn the frozen corpus into reproducible passages without LLM
calls.

- [ ] Enumerate only the paths admitted by Step 1's manifest. Resolve paths
  through the appropriate sandbox/source boundary; refuse traversal and
  symlinks escaping that boundary. Never execute repository code to ingest docs.
- [ ] Capture and digest the source bytes consistently. A file changing during
  ingestion must not produce a digest from one version and passages from another.
- [ ] Split Markdown on structural headings, preserving fenced blocks and
  related text where possible. Use a deterministic bounded fallback for long
  sections and plain text. Record overlap and normalization rules.
- [ ] Preserve exact offsets into original bytes despite normalization and
  line-ending differences. Display excerpts from original text, not a
  reconstructed or summarized version.
- [ ] Construct context from relative path, heading ancestry, source version
  and known source identity. No generated description and no per-chunk model
  call in this phase.
- [ ] Define a generation fingerprint containing source manifest hash,
  extraction version, chunker version/settings, context-builder version,
  tokenizer/index configuration, and storage schema version.
- [ ] Reserve explicit optional identity fields for embedding provider/model,
  dimensions and preprocessing. If generated context is later enabled, include
  its prompt, model and generation parameters too. Retrieval-only reranker
  changes version the query pipeline and result caches, not unchanged embeddings.
- [ ] Persist derived passages through the existing product-store mechanism.
  An immutable source snapshot or existing source archive remains authority;
  losing the index must never lose the only copy of a document.

**Files:** proposed `src/projects/retrievalCorpus.ts` and store helpers under
the existing projects/core ownership; use
[store handles](../src/core/stores.ts). If a new subsystem becomes necessary,
add its guidance and root-map entry deliberately rather than create an orphan.

**Exit condition:** identical input produces identical passages and IDs;
changes invalidate only the appropriate generation. Tests cover Unicode,
CRLF, headings, long sections, code fences, exclusions and path escape.

### Step 7 — implement tenant-private FTS5/BM25 in SQLite

**Purpose:** add useful lexical retrieval with no new service or API spend.

- [ ] Verify FTS5 availability in the pinned `better-sqlite3` runtime and
  packaged environment with an actual create/index/query exercise.
- [ ] Use the existing product SQLite file and explicit cache lifecycle.
  Do not create a second product database or silently migrate disposable rows.
- [ ] Build independent FTS indexes per project namespace and generation,
  within that SQLite file. This is stronger than organisation separation and
  keeps ranking statistics and candidates inside the permitted corpus.
  A single global FTS table plus a final `WHERE org_id = ...` is insufficient.
- [ ] Generate internal namespace/table identifiers from trusted internal IDs
  using a closed format; bind all query values. Never interpolate model input
  or user-facing project names into SQL identifiers or expressions.
- [ ] Index deterministic context and original passage text with development-
  set weights. Keep original evidence separate from searchable decoration.
- [ ] Perform bounded BM25 retrieval, deterministic tie-breaking and duplicate
  handling; preserve necessary multi-passage evidence. Freeze weights and
  candidate limits before the held-out run.
- [ ] Build a new generation in bounded transactions, then atomically publish
  its ready pointer. Readers must never see half an index or a generation from
  another namespace. Respect SQLite writer contention and event-loop latency.
- [ ] Invalidate access immediately on revocation/deletion. Garbage-collect
  unreferenced generations according to retention, without serving revoked
  passages while physical cleanup is pending.
- [ ] Fail with a typed unavailable result if the pinned snapshot has no valid
  index. Never substitute another project's index or an older snapshot while
  claiming to search the requested one.
- [ ] Measure index size, namespace/table count, query latency, rebuild cost,
  writer contention and memory. These measurements decide whether the chosen
  SQLite partitioning remains operationally acceptable.

**Exit condition:** isolated-index behavioral tests pass, including identical
queries in different tenants and projects, empty namespaces, atomic generation
switching, crashes, corrupt caches, deletion and revocation during a query.

### Step 8 — wire the element through the real Atoma execution path

**Purpose:** make retrieval reachable by authorized molecules without changing
the supervision protocol.

- [ ] Implement the composite executor and dedicated host element factory in
  `src/tools/`; inject the scoped retrieval service from run construction.
  Keep store construction and provider credentials out of worker imports.
- [ ] Thread the authorized corpus binding from project coordinator to host
  run process. Validate it at launch and at the lookup boundary; tenant mode
  with missing or inconsistent binding cannot fall back to operator scope.
- [ ] Wire declarations through `ToolBackend.toolDecls`, canonical bootstrap,
  capability descriptions, and runtime tool-scope enforcement together.
  Give the element only to the intended L1 scopes; do not silently append it
  to every persisted molecule or alter unrelated capability buckets.
- [ ] Add its metadata through
  [tool taxonomy](../src/contracts/toolTaxonomy.ts) while preserving every
  existing invocation identity. Test both a clean bootstrap and an existing
  registry upgrade; reset trust only for types whose actual contract changes.
- [ ] Keep the host element absent from the worker's builtins and handshake.
  Update declaration consistency tests to distinguish worker declarations
  from the composite runtime catalogue through one explicit ownership model.
- [ ] Integrate inside existing trace and branch wrappers. Search results are
  observed source data, not proof that an artifact satisfies a requirement.
  Do not expand the closed attestation vocabulary just to record retrieval.
- [ ] Preserve normal validation and usage-conditioned skill credit. A
  retrieved document never grants earned trust or deterministic dispatch.
- [ ] Audit downstream distillation and catalogue offers with tenant-document
  fixtures. Source excerpts, private facts and tenant-specific references must
  not escape through a learned skill, shared cache or catalogue export. Reuse
  the skills' generalization and sharing contracts; search authorization alone
  does not establish that a derived recipe is safe to share.
- [ ] Ensure cached queries/results include tenant/project scope, snapshot,
  generation and retrieval settings, and recheck authorization on a cache hit.
  Do not reuse the strategy prefilter cache or add semantic fast-path caching.
- [ ] Bound cancellation and cleanup of queries and index builds on success,
  failure, deadline, SIGTERM and shutdown. The run must not outlive its budget
  because a search is pending.

**Relevant tests:** `tests/tool-backend-selection.test.ts`,
`tests/tool-scope-enforcement.test.ts`, `tests/project-coordinator.test.ts`,
`tests/container-executor-lifecycle.test.ts`, `tests/proof-attestation.test.ts`,
and new focused retrieval tests under `tests/`.

**Exit condition:** a mocked L1 call reaches host retrieval in both backend
modes; undeclared calls fail; ordinary file/shell calls retain their original
execution boundary; branch recording has no duplicate observations.

### Step 9 — prove the container and compiled-process boundaries

**Purpose:** test the boundary that the implementation actually crosses.

- [ ] Run the packaged host process against a real worker image built from
  packaged `dist/`, with `network none` and the ordinary allowlisted worker
  environment. Exercise the normal coordinator/launcher binding in a compiled
  process test, not only direct constructor calls.
- [ ] With mocked LLM decisions, prove that L1 search returns authorized
  fixture passages while file/shell operations still execute in the worker.
- [ ] Prove the worker cannot read the product store, host credentials, other
  workspaces, or another tenant's documents, and cannot reach host services.
- [ ] Submit forged organisation/project fields, table names, source paths,
  malformed protocol output and undeclared tool names; assert refusal at the
  production dispatch boundary without any host handler being invoked wrongly.
- [ ] Test authorization revocation with a queued query, an in-flight query,
  and a cached result. A revocation cannot be repaired by retrying an old binding.
- [ ] Verify timeout, process cancellation, unavailable FTS, corrupt index,
  restart and cleanup behavior. Recoverable retrieval failure may leave the
  existing agentic tools usable; it must be visible and must not widen access.
- [ ] Include malicious instructions inside source fixtures. The search result
  must remain data, with no mechanism that executes its commands or changes
  permissions. Behavioral agent evaluations supplement mechanical isolation;
  labels alone are not proof of prompt-injection resistance.

**Exit condition:** source and compiled tests demonstrate isolation. Image
existence and an in-memory executor mock alone do not satisfy this step.

## Phase D — decide and operate the first release

### Step 10 — run the registered BM25 comparison

- [ ] Freeze the treatment revision, protocol, scorer and parameters. Perform
  the paired A/B comparison and registered frontier reference on that revision
  and day, following Step 3's isolation and ordering rules.
- [ ] Measure retrieval coverage separately from answer and artifact quality.
  Classify misses as ingestion, scope, lexical mismatch, ranking, context
  truncation or failure to use retrieved evidence.
- [ ] Publish all runs, including timeouts, tool errors, unavailable retrieval,
  failed deliveries and negative results. Do not silently discard bad pairs.
- [ ] Apply the pre-registered decision rule. If the interval is inconclusive,
  report that result; additional runs require a separately registered extension.
- [ ] Keep BM25 if it earns its registered benefit. If it does not, retain
  agentic search as the default and diagnose the measured failure class before
  proposing another component. BM25's failure is not evidence that embeddings
  or Qdrant will succeed.

**Deliverable:** a dated report, raw machine-readable results, exact configs,
scorer outputs and replay instructions under the new benchmark directory.
Historical benchmark files and claims remain unchanged.

### Step 11 — add operational lifecycle and observability

- [ ] Provide status, rebuild and purge through the existing operator CLI
  conventions, with help and non-zero exits on invalid commands. Only status
  is read-only; rebuild and purge are explicit mutations.
- [ ] Add quota-free doctor checks for FTS availability, configuration,
  namespace/generation consistency and local prerequisites. No embedding,
  reranking or completion request may be used as a health probe.
- [ ] Coordinate index builds with deployment preflight and shutdown. Reuse
  existing run admission/lease mechanisms for active builds where possible;
  any new tracked activity needs one defined owner and restart reconciliation.
  Deployment may wait or refuse, never kill active work to activate a release.
- [ ] Define retention and backup behavior: source snapshots are recoverable
  evidence, index rows are disposable. Restore/rebuild procedures must also
  respect deleted tenants and revoked documents. A database backup containing
  derived passages is still tenant data.
- [ ] Record invocation ID, branch/run, backend and generation, outcome,
  candidate/result counts, durations and resource limits through existing
  observability surfaces. Traces containing excerpts remain tenant-scoped;
  logs and notifications do not dump document bodies or host paths.
- [ ] Keep index generation state and its ready pointer authoritative in one
  place. Doctor, preflight and the lookup service read that state rather than
  invent their own index-readiness heuristics.

**Exit condition:** an operator can diagnose, rebuild, disable and recover
retrieval without paid calls, cross-tenant exposure or loss of source evidence.

### Step 12 — release with a reversible activation path

- [ ] Expose one explicit retrieval configuration through trusted project/run
  configuration. Document inheritance and failure behavior; do not invent a
  fourth LLM tier or overload a subscription selector to enable BM25.
- [ ] Default the first release to opt-in while collecting real-project
  evidence. Promotion to default follows the registered result and operational
  checks, with a separate recorded decision.
- [ ] Update each changed subsystem's contract in its own `AGENTS.md`, keeping
  one rule in one home. Update derived documentation through its generators,
  never by hand-editing the README's generated facts block.
- [ ] Verify from a clean checkout with the pinned Node version: `npm ci`,
  `npm run release:check`, worker build from the resulting `dist/`, and the
  applicable compiled/container isolation smokes. Both TypeScript configs,
  lint, docs checks and behavioral tests must pass.
- [ ] Read the viz/platform/launcher contracts if those surfaces change. Run
  the real-machine `viz:smoke` when changing the client bundle. UI copy belongs
  only in `en.json`; target locales follow the existing translation workflow.
- [ ] Exercise rollback: disable the element for new runs, let admitted work
  settle under its bound policy, retain sources, and reclaim only disposable
  index generations. Document database compatibility with the previous release.
- [ ] Track every required new source, test and benchmark fixture before
  claiming a passing implementation. Preserve unrelated worktree changes.

**First-release definition of done:** the golden corpus and baseline are
replayable; one scoped L1 element works through the production boundary;
BM25's result is documented; operational recovery and release verification
pass; no vector service or paid retrieval provider is required.

## Phase E — optional extensions, each requiring evidence

### Step 13 — extend payer and usage accounting before paid retrieval

**Entry condition:** a documented failure class justifies testing an external
embedding/reranking service, with a registered experiment budget.

- [ ] Define a shared billable-operation shape for document embedding, query
  embedding, reranking and optional context generation. Record provider,
  requested/served model, billable units, pricing revision, payer, project,
  job, run when applicable, outcome and usage certainty.
- [ ] Keep the three tier payer rows meaningful. Add an explicit contract for
  non-tier operations alongside them; do not hide indexing spend in L1 or
  pretend that ingestion before a run belongs to a fabricated run.
- [ ] Resolve the actual payer from permitted credentials: organisation key
  when explicitly supported, or explicitly authorized host funding. A
  subscription-only deployment cannot silently start charging the host API.
- [ ] Extend the one core pricing authority to handle provider billable units
  without representing requests or document pairs as fake completion tokens.
  Adapters report usage; they do not implement independent cost formulas.
- [ ] Bound initial ingestion, re-embedding, queries, reranking, retries and
  context generation with preflight spend checks. Account for failed/partial
  usage, distinguish unknown usage from zero, and avoid double-counting retries.
- [ ] Keep credentials in the trusted host boundary. Define the external data
  processing configuration explicitly; local BM25 remains usable without it.
- [ ] Record warm-query and first-use costs separately, including index builds
  that never lead to a successful run. Extend the runner summary, trace and
  benchmark projections together through their shared contracts.

**Read/extend:** [metrics and pricing](../src/core/metrics.ts),
[payer contract](../src/contracts/runPayers.ts), project credential resolution,
run accounting, and the relevant auth/platform contracts.

**Exit condition:** mocked tests prove all billable paths and payer choices,
including interrupted ingestion and absent credentials, before any paid probe.

### Step 14 — evaluate semantic embeddings without changing the element

- [ ] Register BM25 versus BM25 plus dense retrieval, keeping corpus, chunking,
  deterministic context and agent configuration fixed. Use development data
  for model/configuration selection and a fresh held-out comparison for claims.
- [ ] Start with a locally served open-weight candidate such as
  `Qwen3-Embedding-0.6B`. Verify its exact revision, license, runtime support
  and resource needs at implementation time. Local inference has compute
  costs even when there is no per-call API bill.
- [ ] Keep `voyage-4-large` as an optional external comparator only if local
  results justify it and Step 13 is complete. No API subscription is required
  for the initial implementation; verify provider terms and pricing before use.
- [ ] Evaluate bounded exact cosine search over a scoped SQLite-backed vector
  cache first. Consider `sqlite-vec` only with measured benefit and native
  packaging/portability checks. Do not assume a universal corpus-size cutoff.
- [ ] Apply tenant/project/snapshot selection before vector candidate search.
  Reuse no cross-tenant embedding or query cache containing private material.
- [ ] Batch document embedding, persist progress, reuse unchanged embeddings
  only under the exact same generation identity, and activate only complete
  indexes. A model/dimension/preprocessing change requires a new generation.
- [ ] Fuse lexical and semantic rankings with a registered method such as RRF.
  Preserve the same bounded, cited result shape and source bytes.
- [ ] Count local inference time and resource use, or document/query API
  embedding spend in Step 13's budgets, including reindexing and failed
  batches. Compare task outcomes as well as recall.

**Exit condition:** retain dense retrieval only if its measured incremental
benefit meets the pre-registered rule within operating and spend limits.

### Step 15 — evaluate reranking and generated context independently

- [ ] First compare the retained retrieval backend with and without a local
  reranker on the same candidate sets; `Qwen3-Reranker-0.6B` is an initial
  candidate, subject to revision/license/runtime checks. Keep `rerank-2.5` as
  an optional paid comparator after Step 13, with verified API and billing
  units. A candidate model is not a measured winner.
- [ ] Bound candidate count, document length, latency and spend. A reranker
  cannot recover a source absent from its candidates, so distinguish ranking
  errors from ingestion or recall failures.
- [ ] Specify a visible, tested fallback to the underlying ranked results on
  provider failure, subject to the same access and snapshot rules. Never
  relabel a failed rerank as a successful provider call.
- [ ] Only then consider generated passage context as a separate ablation
  against deterministic path/heading/version context. Freeze the context
  prompt, model, cache strategy and accounting before ingestion.
- [ ] Keep generated context labeled and separate from original evidence.
  It can improve retrieval but cannot become an authoritative quotation.
- [ ] Rebuild when context-generation identity changes; invalidate rerank/result
  caches when query-pipeline identity changes. Avoid re-embedding unchanged
  text merely because an unrelated reranker version changed.

**Exit condition:** each retained component has its own measured contribution.
A combined improvement is not sufficient to justify every included component.

### Step 16 — consider Qdrant only after measuring a storage bottleneck

- [ ] Record the concrete SQLite limitation: p95/p99 latency, memory, writer
  contention, namespace count, ingestion throughput, or required concurrency.
  Set an operational target before benchmarking a replacement.
- [ ] Implement Qdrant behind the existing backend contract, with explicit
  private organisation/project index boundaries and trusted scope binding.
  Do not add worker access to Qdrant or expose its API to the L1 model.
- [ ] Keep SQLite/source snapshots authoritative. Rebuild the candidate service
  from those sources; compare result authorization and provenance before an
  atomic namespace switch. Provide rollback to the preceding backend.
- [ ] Include service authentication, capacity, readiness, restart recovery,
  version compatibility, quota-free doctor probes, deployment preflight,
  retention/deletion and recovery time in the comparison.
- [ ] Decide whether service snapshots are worth retaining as a recovery-time
  optimization; they must never replace source backups or become the only
  copy of tenant knowledge. Test recovery from total index loss.
- [ ] Retain Qdrant only if it meets the measured operational need after
  accounting for hosting and maintenance costs.

GraphRAG, raw-run memory, code search, PDF/multimodal ingestion, and shared
skill retrieval remain separate corpus/product proposals. Each begins again
with a defined question set and an appropriate agentic baseline.

## Reviewable implementation increments

1. Corpus contract, fixtures, golden questions and discriminating scorers
   (Steps 1–2).
2. Retrieval experiment support in the existing benchmark runner and baseline
   report (Step 3).
3. Reviewed host authority design, schemas and composite dispatch with mocks
   (Steps 4–5).
4. Deterministic ingestion and isolated FTS generations (Steps 6–7).
5. Production element registration, process binding, scope enforcement and
   compiled/container proof (Steps 8–9).
6. Paired experiment and decision report (Step 10).
7. Operational lifecycle, release checks and opt-in rollout (Steps 11–12).
8. Only if justified: non-tier accounting, embeddings, reranking/context and
   external index service as separate increments (Steps 13–16).

Documentation must distinguish planned, implemented, measured and enabled
behavior at every increment. A mock-backed interface is not a working RAG;
a passing retrieval test is not evidence of better delivered applications.

## Reference material for conditional components

These describe candidate mechanisms, not benchmark evidence for Atoma:

- [Anthropic — Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval).
- [Voyage — model/tokenization catalogue](https://docs.voyageai.com/docs/tokenization)
  and [reranking API](https://docs.voyageai.com/docs/reranker).
- [Qdrant — hybrid and multi-stage queries](https://qdrant.tech/documentation/search/hybrid-queries/).
- [Microsoft — GraphRAG query overview](https://microsoft.github.io/graphrag/query/overview/).
