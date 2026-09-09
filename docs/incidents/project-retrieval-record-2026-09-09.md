<!-- agents-archive: project-retrieval-record-2026-09-09 -->

# Project retrieval — implementation record, 2026-09-08 → 2026-09-09

> Historical archive, not normative guidance. The current contracts are
> [one retrieval backend: Haystack](../project-retrieval-haystack-only-2026-09-09.md)
> and [project registry ownership](../project-registry-ownership-2026-09-09.md).
> This file concatenates, verbatim apart from link targets, the seven dated
> records written while project retrieval went from an action plan to the
> Haystack-only launch contract. Present-tense status claims below are frozen
> at their original dates; the supersession banners each record carried are
> preserved. Benchmark artefacts live under `benchmark/`.

Contents:

1. [Implementation action plan](#project-retrieval--implementation-action-plan) (2026-09-08, progress through 2026-09-09)
2. [Host boundary — design and implementation contract](#project-retrieval-host-boundary--design-and-implementation-contract)
3. [Deterministic ingestion and SQLite backend](#project-retrieval-deterministic-ingestion-and-sqlite-backend) (superseded)
4. [Opt-in coordinator activation](#project-retrieval-opt-in-coordinator-activation) (superseded)
5. [Downstream privacy audit](#project-retrieval-downstream-privacy-audit) (corrected by registry ownership)
6. [Haystack retrieval experiment](#haystack-retrieval-experiment)
7. [Haystack in the shared agent runner](#haystack-in-the-shared-agent-runner) (archived pilot)


---

# Project retrieval — implementation action plan

Date: 2026-09-08, progress updated 2026-09-09. Status: evaluation instruments,
A/C characterization driver, archived development pilot, typed host boundary,
deterministic document ingestion, SQLite FTS5 backend and opt-in project-run
activation delivered. The paired BM25 development pilot is archived and did
not meet its benefit screen. Broader evaluation, operational rollout and
production retrieval-provider integrations remain pending. An experimental
Haystack backend is now available for component and shared-runner evaluation.
Its six-attempt agent pilot is archived and did not meet its benefit screen.

**Current backend decision:** [Haystack is the only product retrieval backend](../project-retrieval-haystack-only-2026-09-09.md),
with BM25 and hybrid pipeline modes. SQLite FTS5 remains only in the development
component comparator. Source preparation no longer builds its unused cache.
The earlier steps below record implementation history; retrieval activation
now requires explicit Haystack host configuration for every new project run.
Search is mandatory by owner decision; the old activation switch has been
removed. Read the current backend decision above for the supported launch
contract. The earlier opt-in steps and negative measurements remain history.

## Implementation progress

The [evaluation instruments](../../benchmark/retrieval/README.md) contain 26
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
The BM25 development mode now activates the project search element only for
treatment B; all A/B/C arms use the same synthetic project runner path. It
freezes retrieval settings and a screening rule before model execution.
The [four-attempt development pilot](../../benchmark/retrieval-pilot-2026-09-09/README.md)
completed on one source revision and UTC day. Frontier-direct passed both
tasks; Atoma reached both registered deadlines, with correct pricing facts or
maintenance behavior but incomplete source-supported delivery. This tiny
sample identifies development failure cases, not a retrieval benefit. The
[new paired BM25 pilot](../../benchmark/retrieval-bm25-pilot-2026-09-09/README.md)
now supplies that same-revision control and records no full-task gain.

Steps 4–5 now have a [reviewed host contract](#project-retrieval-host-boundary--design-and-implementation-contract)
and an opt-in `startTask` library binding. `search_project_docs` is intercepted
before the worker, with strict query-only arguments, pre/post authorization,
bounded exact-source results, cancellation and run-owned cleanup. The worker
handshake and default tool list remain unchanged. Mocked service, L1 transport,
runner and container integration tests exercise the boundary.

Steps 6–7 now have a [deterministic ingestion and private FTS5 backend](#project-retrieval-deterministic-ingestion-and-sqlite-backend).
It reads only manifest-admitted immutable sources, preserves exact byte spans,
builds independent project indexes in the existing product store and publishes
them atomically. Tests cover cancellation, revocation, corruption, writer
contention and a crashed builder process. Compiled smokes and a reproducible
20,000-passage capacity probe exercise the real SQLite runtime.

Steps 8–9 now have [opt-in project coordinator activation](#project-retrieval-opt-in-coordinator-activation):
an immutable source archive and receipt, a read-only child resolver against
current project/principal/run state, and a dedicated L1 canonical scope.
`ATOMA_PROJECT_RETRIEVAL=1` on the coordinator host enables this path for new
project runs. The compiled process smoke covers coordinator → child → L1 →
FTS5, live revocation and the real isolated worker. The benchmark treatment is
implemented and its development pilot is archived; operational lifecycle remains pending. This is not default activation or
evidence of an A/B gain. The [downstream privacy audit](#project-retrieval-downstream-privacy-audit)
reproduced a common-registry disclosure. [Project registry ownership](../project-registry-ownership-2026-09-09.md)
now contains those prompts, descriptions, names, tools and history. Registered
treatment evaluation and operational lifecycle remain before rollout.

A [Haystack framework experiment](#haystack-retrieval-experiment) now
adds native BM25 and local embeddings/fusion/reranking behind the same L1
element. The [shared-runner integration](#haystack-in-the-shared-agent-runner)
now measures timed initialization, source admission and the complete agent
treatment. Its [six-attempt pilot](../../benchmark/retrieval-haystack-agent-pilot-2026-09-09/README.md)
records 0/2 full tasks for A and B, versus 1/2 for the frontier reference.
Haystack returned the needed evidence on its one search; a wrong final
citation and missing answer files still prevented completion. The second
treatment task did not invoke retrieval. The component screen and this agent
campaign are separate evidence; neither authorizes production activation.

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

- [Root contract](../../AGENTS.md): isolation, one product store, benchmarks,
  source verification, release requirements, and preservation of live state.
- [Tools](../../src/tools/AGENTS.md), [run](../../src/run/AGENTS.md), and
  [contracts](../../src/contracts/AGENTS.md): element execution and shared shapes.
- [Projects](../../src/projects/AGENTS.md) and [auth](../../src/auth/AGENTS.md):
  project identity, run admission, and current access rights.
- [Core](../../src/core/AGENTS.md): stores, metrics, cost, and branch context.
- [Atoms](../../src/atoms/AGENTS.md) and [registry](../../src/registry/AGENTS.md):
  capability scopes, canonical bootstrap, trust, and validation.
- [CLI](../../src/cli/AGENTS.md): benchmark, doctor, backup, and deployment.
- [Skills](../../src/skills/AGENTS.md) and the
  [SaaS boundary](../saas-architecture.md#skills-are-a-commons): shared recipes
  do not make tenant documents shared knowledge.
- [Existing benchmark protocol](../../benchmark/PROTOCOL.md): historical
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
[contracts](../../src/contracts/retrievalBenchmark.ts),
[scorer](../../src/cli/retrievalScorer.ts), and
[behavioral tests](../../tests/retrieval-benchmark.test.ts).
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
  failure. See the [pilot report](../../benchmark/retrieval-pilot-2026-09-09/README.md).
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

**Read/extend:** [benchmark driver](../../src/cli/benchmark.ts),
[baseline executor](../../src/run/baseline.ts),
[shared runner](../../src/run/runner.ts), and existing benchmark tests.
Implemented characterization support:
[registration](../../src/cli/retrievalRegistration.ts),
[campaign driver](../../src/cli/retrievalCampaign.ts), and
[contracts](../../src/contracts/retrievalCampaign.ts).

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

**Read/extend:** [tool backend](../../src/run/toolBackend.ts),
[container executor](../../src/tools/containerExecutor.ts),
[worker protocol](../../src/tools/containerProtocol.ts),
[coordinator](../../src/projects/coordinator.ts),
[process launcher](../../src/cli/burnin.ts), and
[branch context](../../src/core/branchCtx.ts).

**Exit condition:** the authority flow is explicit and reviewed. No new route
out of the worker, credential mount, store mount, or generic host execution
surface is part of the implementation.

**Implemented boundary:** [design and activation limits](#project-retrieval-host-boundary--design-and-implementation-contract),
[host element](../../src/tools/projectRetrieval.ts),
[composite executor](../../src/tools/projectRetrievalExecutor.ts), and optional
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

- [x] Enumerate only the paths admitted by Step 1's manifest. Resolve paths
  through the appropriate sandbox/source boundary; refuse traversal and
  symlinks escaping that boundary. Never execute repository code to ingest docs.
- [x] Capture and digest the source bytes consistently. A file changing during
  ingestion must not produce a digest from one version and passages from another.
- [x] Split Markdown on structural headings, preserving fenced blocks and
  related text where possible. Use a deterministic bounded fallback for long
  sections and plain text. Record overlap and normalization rules.
- [x] Preserve exact offsets into original bytes despite normalization and
  line-ending differences. Display excerpts from original text, not a
  reconstructed or summarized version.
- [x] Construct context from relative path, heading ancestry, source version
  and known source identity. No generated description and no per-chunk model
  call in this phase.
- [x] Define a generation fingerprint containing source manifest hash,
  extraction version, chunker version/settings, context-builder version,
  tokenizer/index configuration, and storage schema version.
- [ ] Reserve explicit optional identity fields for embedding provider/model,
  dimensions and preprocessing. If generated context is later enabled, include
  its prompt, model and generation parameters too. Retrieval-only reranker
  changes version the query pipeline and result caches, not unchanged embeddings.
- [x] Persist derived passages through the existing product-store mechanism.
  An immutable source snapshot or existing source archive remains authority;
  losing the index must never lose the only copy of a document.

**Files:** proposed `src/projects/retrievalCorpus.ts` and store helpers under
the existing projects/core ownership; use
[store handles](../../src/core/stores.ts). If a new subsystem becomes necessary,
add its guidance and root-map entry deliberately rather than create an orphan.

**Exit condition:** identical input produces identical passages and IDs;
changes invalidate only the appropriate generation. Tests cover Unicode,
CRLF, headings, long sections, code fences, exclusions and path escape.

The first backend explicitly reserves disabled `embedding: null` and
`generatedContext: null` identity slots. Detailed non-null provider/model/prompt
schemas remain with the future backend; no unsupported configuration is accepted.
Source roots must be host-owned immutable snapshots, not live worker workspaces.

### Step 7 — implement tenant-private FTS5/BM25 in SQLite

**Purpose:** add useful lexical retrieval with no new service or API spend.

- [x] Verify FTS5 availability in the pinned `better-sqlite3` runtime and
  packaged environment with an actual create/index/query exercise.
- [x] Use the existing product SQLite file and explicit cache lifecycle.
  Do not create a second product database or silently migrate disposable rows.
- [x] Build independent FTS indexes per project namespace and generation,
  within that SQLite file. This is stronger than organisation separation and
  keeps ranking statistics and candidates inside the permitted corpus.
  A single global FTS table plus a final `WHERE org_id = ...` is insufficient.
- [x] Generate internal namespace/table identifiers from trusted internal IDs
  using a closed format; bind all query values. Never interpolate model input
  or user-facing project names into SQL identifiers or expressions.
- [x] Index deterministic context and original passage text with explicit initial
  weights (1:1, not yet relevance-tuned). Keep original evidence separate from
  searchable decoration; evaluation must precede any tuning or gain claim.
- [ ] Perform bounded BM25 retrieval, deterministic tie-breaking and duplicate
  handling; preserve necessary multi-passage evidence. Freeze weights and
  candidate limits before the held-out run.
- [x] Build a new generation in bounded transactions, then atomically publish
  its ready pointer. Readers must never see half an index or a generation from
  another namespace. Respect SQLite writer contention and event-loop latency.
- [ ] Invalidate access immediately on revocation/deletion. Garbage-collect
  unreferenced generations according to retention, without serving revoked
  passages while physical cleanup is pending.
- [x] Fail with a typed unavailable result if the pinned snapshot has no valid
  index. Never substitute another project's index or an older snapshot while
  claiming to search the requested one.
- [x] Measure index size, namespace/table count, query latency, rebuild cost,
  writer contention and memory. These measurements decide whether the chosen
  SQLite partitioning remains operationally acceptable.

The backend implements bounded BM25 candidates, stable tie-breaking, whole-span
excerpt limits, invalidation and bounded garbage collection. The unchecked
items retain the evaluation freeze and live revocation/retention integration:
the host must still connect lifecycle methods to authoritative project records.
Only the active generation is served; older pinned runs receive unavailable
after replacement. Native SQLite statements are synchronous and cannot be
preempted mid-statement, although late results are discarded. The capacity probe
covers one local host, not concurrent production deployment.

**Exit condition:** isolated-index behavioral tests pass, including identical
queries in different tenants and projects, empty namespaces, atomic generation
switching, crashes, corrupt caches, deletion and revocation during a query.

### Step 8 — wire the element through the real Atoma execution path

**Purpose:** make retrieval reachable by authorized molecules without changing
the supervision protocol.

- [x] Implement the composite executor and dedicated host element factory in
  `src/tools/`; inject the scoped retrieval service from run construction.
  Keep store construction and provider credentials out of worker imports.
- [x] Thread the authorized corpus binding from project coordinator to host
  run process. Validate it at launch and at the lookup boundary; tenant mode
  with missing or inconsistent binding cannot fall back to operator scope.
- [x] Wire declarations through `ToolBackend.toolDecls`, canonical bootstrap,
  capability descriptions, and runtime tool-scope enforcement together.
  Give the element only to the intended L1 scopes; do not silently append it
  to every persisted molecule or alter unrelated capability buckets.
- [x] Add its metadata through
  [tool taxonomy](../../src/contracts/toolTaxonomy.ts) while preserving every
  existing invocation identity. Test both a clean bootstrap and an existing
  registry upgrade; reset trust only for types whose actual contract changes.
- [x] Keep the host element absent from the worker's builtins and handshake.
  Update declaration consistency tests to distinguish worker declarations
  from the composite runtime catalogue through one explicit ownership model.
- [x] Integrate inside existing trace and branch wrappers. Search results are
  observed source data, not proof that an artifact satisfies a requirement.
  Do not expand the closed attestation vocabulary just to record retrieval.
- [x] Preserve normal validation and usage-conditioned skill credit. A
  retrieved document never grants earned trust or deterministic dispatch.
- [x] Audit downstream distillation and catalogue offers with tenant-document
  fixtures. The [audit](#project-retrieval-downstream-privacy-audit) reproduces
  private facts in learned bodies, confirms their project-directory containment,
  and exposes the independent common-registry channel across a process reload.
- [x] Close the audited common-registry disclosure. Source excerpts, private
  facts and tenant-specific references must not escape through persistent
  metadata, learned skills, shared caches or catalogue export. Reuse the skills'
  generalization and sharing contracts; search authorization alone does not
  establish that a derived recipe is safe to share. Follow the audit's coherent
  ownership correction instead of adding a lexical privacy detector.
- [ ] Ensure cached queries/results include tenant/project scope, snapshot,
  generation and retrieval settings, and recheck authorization on a cache hit.
  Do not reuse the strategy prefilter cache or add semantic fast-path caching.
  Current implementation adds no query/result cache and requires the existing
  project strategy prefilter cache to remain off.
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

**Implemented increment:** [activation and current limits](#project-retrieval-opt-in-coordinator-activation).
The downstream audit and its [registry ownership correction](../project-registry-ownership-2026-09-09.md)
are implemented. Sharing admission, retention and measured treatment value remain
separate conditions; no production environment was enabled.

### Step 9 — prove the container and compiled-process boundaries

**Purpose:** test the boundary that the implementation actually crosses.

- [x] Run the packaged host process against a real worker image built from
  packaged `dist/`, with `network none` and the ordinary allowlisted worker
  environment. Exercise the normal coordinator/launcher binding in a compiled
  process test, not only direct constructor calls.
- [x] With mocked LLM decisions, prove that L1 search returns authorized
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

- [x] Freeze the treatment revision, protocol, scorer and parameters. Perform
  the paired A/B comparison and registered frontier reference on that revision
  and day, following Step 3's isolation and ordering rules.
- [x] Measure retrieval coverage separately from answer and artifact quality.
  Classify misses as ingestion, scope, lexical mismatch, ranking, context
  truncation or failure to use retrieved evidence.
- [x] Publish all runs, including timeouts, tool errors, unavailable retrieval,
  failed deliveries and negative results. Do not silently discard bad pairs.
- [x] Apply the pre-registered decision rule. If the interval is inconclusive,
  report that result; additional runs require a separately registered extension.
- [x] Keep BM25 if it earns its registered benefit. If it does not, retain
  agentic search as the default and diagnose the measured failure class before
  proposing another component. BM25's failure is not evidence that embeddings
  or Qdrant will succeed.

**Deliverable:** a dated report, raw machine-readable results, exact configs,
scorer outputs and replay instructions under the new benchmark directory.
Historical benchmark files and claims remain unchanged.

**Development pilot completed:** [six-attempt report and raw archives](../../benchmark/retrieval-bm25-pilot-2026-09-09/README.md).
A and B each passed 0/2 tasks; C passed 2/2. B returned valid source evidence
for every required fact but failed final citations or task completion. The
predeclared screen was not met, so agentic search stays the default. The
harness's first failure and accounting are also archived, with a regression
fix before the separately registered continuation. This closes the bounded
development comparison, not project-family confirmation or production rollout;
the correlated two-task sample has no population confidence interval.

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

**Read/extend:** [metrics and pricing](../../src/core/metrics.ts),
[payer contract](../../src/contracts/runPayers.ts), project credential resolution,
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

---

# Project retrieval host boundary — design and implementation contract

This is the boundary for Steps 4–5 of the
[action plan](#project-retrieval--implementation-action-plan). The first increment
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
[ingestion/backend](#project-retrieval-deterministic-ingestion-and-sqlite-backend) constructs spans and
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

## Subsequent activation

The [SQLite backend](#project-retrieval-deterministic-ingestion-and-sqlite-backend) and
[opt-in project activation](#project-retrieval-opt-in-coordinator-activation) now
implement source admission, authoritative receipts and a child resolver against
current project/run/principal state in the existing product store. The host
switch alone grants nothing; live authority is checked again on each query.
A dedicated L1 scope receives search while existing unrelated canonical
scopes stay unchanged. Operator/benchmark CLI activation, downstream privacy
evaluation and operational rollout remain pending. Explicit library callers
must still supply an immutable corpus, never a scan of arbitrary host files.

## Verification of this increment

`release:check` passed, including both TypeScript configurations, lint, the
full mocked-provider suite, audit, build and compiled smokes. After
`build:worker`, the container suite ran with `CI_REQUIRE_DOCKER=1`, including
`tests/project-retrieval-container.test.ts` and the existing isolation/import
closure/lifecycle tests. It verifies host dispatch, absent worker capability,
inaccessible host source files/environment and no dispatch from worker data.
The L1 transport tests also preserve branch-labelled tool traces and reject
off-scope calls. These checks originally certified the host boundary alone.
The [subsequent backend record](#project-retrieval-deterministic-ingestion-and-sqlite-backend) covers
ingestion and FTS5; the [activation record](#project-retrieval-opt-in-coordinator-activation)
covers the current-access resolver and coordinator/child process tests.

---

# Project retrieval: deterministic ingestion and SQLite backend

**Historical implementation:** [Haystack is now the only product retrieval backend](../project-retrieval-haystack-only-2026-09-09.md).
The SQLite implementation and measurement scripts now live under
`benchmark/haystack/` for development comparison only.

Date: 2026-09-09. Status: host library implementation, subsequently connected to
[opt-in project activation](#project-retrieval-opt-in-coordinator-activation).
This extends the [host contract](#project-retrieval-host-boundary--design-and-implementation-contract)
and implements the lexical backend in [Steps 6–7](#phase-c--implement-the-first-backend).

## Ownership and use

The host supplies an explicit admitted-document manifest and a host-owned,
immutable source directory to `prepareProjectRetrievalCorpus`. It then supplies
the resulting generation and exact run scope to `ProjectRetrievalIndex.build`.
`ProjectRetrievalIndex.open` uses the existing product store path and handle
owner in `src/core/stores.ts`; tests may inject an in-memory handle. No second
product database, provider, network path or worker capability is introduced.

`index.createService(scope, currentAuthority)` adapts the backend to the existing
`startTask` retrieval binding. The host element still checks current authority
before lookup and before returning the result. The adapter also pins the exact
principal and run, and disposal closes that run's service without closing the
shared database. A low-level `index.search` is a host storage operation and does
not itself grant document access. Tenant documents remain private to their
organisation and project; the skills commons premise does not apply.

## Source and passage identity

Only explicitly listed `.md` and `.txt` files are read. The initial limits are
200 documents, 256,000 bytes per document, 8,000,000 source bytes and 20,000
passages. Empty documents/snapshots are valid. Paths must be normalized relative
paths; every descendant symlink is refused, including an in-root target.
Non-regular files, executable mode bits, NUL, invalid UTF-8, unexpected sizes
and digest drift are refused. Errors returned by ingestion contain no host path.

Each descriptor is read with a manifest-sized buffer plus one overflow byte.
The digest and passages use that same capture, with metadata checked before
and after reading. Source directories must be owned by the host and immutable
during capture: these portable path checks are not an `openat` capability
boundary against a hostile process concurrently replacing parent directories.
Never use a live worker-writable directory as the authoritative snapshot.
The caller retains the immutable source/archive; the index is disposable.

The chunker recognizes ATX/setext heading ancestry and backtick/tilde fences.
It bounds chunks to 1,400 UTF-8 bytes and 16 lines by default. A bounded fence
is kept together when possible. Oversized lines/fences use deterministic byte
splits that preserve Unicode characters and CRLF pairs. There is no overlap,
Unicode rewriting, newline conversion or LLM-generated context. A fallback
split can cover part of a long line; its byte span remains authoritative.
This is a bounded documentation chunker, not a complete CommonMark renderer.

Quotes retain exact original bytes and coordinates. Paths, headings, corpus,
snapshot and source hashes form a separate searchable context column. Document
IDs hash the path and source digest; each stored evidence checksum hashes its
complete passage, including coordinates. Equal text at distinct source spans
remains distinct evidence. Rebuilds preserve the canonical row order for ties.

The canonical manifest sorts document paths. Its digest and the strict index
configuration determine the generation: source identity, extraction version,
chunker/version/settings, context builder, tokenizer and storage version.
The authority's `snapshotSha256` may cover non-indexed assets; it is retained
verbatim, while the derived manifest hash independently binds admitted docs.
Embedding and generated-context slots are explicitly `null`; unsupported
provider/model configurations are refused. Their eventual detailed schemas
belong to the future backend implementation, not this lexical version.

## Private indexes and publication

Each operator corpus or `(org, project, corpus)` namespace owns an independent
FTS5 table for each physical build. Logical generation identity remains stable;
a fresh physical table lets a rebuild replace the same generation atomically.
Table identifiers are host-created SHA-256 values validated before every SQL
interpolation. Queries bind quoted terms joined by a fixed OR. BM25 weights
are fixed at 1 for context and 1 for original text, with row order breaking ties.
These are initial lexical settings, not tuned or validated relevance claims.
SQLite computes BM25 statistics within an FTS table, which motivates this
partitioning. See [SQLite FTS5 BM25 documentation](https://www.sqlite.org/fts5.html#the_bm25_function).

Builds commit at most 64 passages per batch, yield to the event loop, and retry
SQLite writer contention asynchronously within their cancellation/deadline
budget. The shared connection's busy-timeout policy is restored after every
synchronous operation. Count and FTS integrity checks precede publication.
One transaction publishes the ready pointer and increments the namespace epoch.
A competing publication or invalidation makes a staged build ineligible.

Search reads the ready pointer, metadata and candidates in one SQLite read
transaction. It checks exact generation/source binding and evidence checksums,
schema, document identity, source bounds and original/decoration agreement.
Candidates and returned passages are bounded; oversized quotes are dropped
whole. Missing/incompatible/incomplete caches return `unavailable`, not an
empty successful result or an older-generation substitute.

There is one active generation per namespace in this increment. Publishing a
new generation makes an older pinned run's search unavailable; retained old
tables are not silently served. Run-held generation references and automatic
retention scheduling are not implemented. `invalidate` clears the ready pointer
before physical cleanup. `collectGarbage` drops at most 20 unreferenced old
tables, including abandoned builds; the host chooses the retention cutoff and
must connect these operations to the real project/snapshot lifecycle.
Deletion is logical SQLite deletion, not secure erasure of free pages/backups.

Native SQLite statements are synchronous. Queries avoid a blocking busy wait,
and a result produced after its deadline is discarded, but an executing native
statement cannot be preempted by an AbortSignal. Large/faulty stores may need an
isolated database thread before broader activation. The dataset limits bound
this first implementation; they are not a universal latency guarantee.

## Evidence and remaining work

The focused tests exercise original Unicode/CRLF spans, heading/fence boundaries,
admission failures, ranking independence across organisations/projects/operator,
literal query terms, bounded excerpts, atomic switching, competing/cancelled
builds, revocation, corrupt caches and garbage collection. A child process exits
with a committed partial index; a fresh handle recovers and rebuilds that same
on-disk store. A second SQLite connection exercises real writer contention.

`scripts/retrieval-index-smoke.mjs` exercises the compiled ingestion → FTS5 →
host element path using only production dependencies. `release-smoke.mjs`
imports it, including in packaged release checks. It verifies exact CRLF quotes
and revocation without a model call.

The [mechanical capacity measurement](../../benchmark/retrieval-index-capacity-2026-09-09.json)
is reproduced with `npm run build` followed by
`node scripts/retrieval-index-measure.mjs`. It records a deterministic synthetic
20,000-passage corpus, construction/reconstruction time, 30 queries per query
shape, store allocation, FTS table count, writer contention, sampled RSS and
event-loop delay. Measurements describe one macOS arm64 process, not deployment
capacity or an A/B retrieval improvement. Memory samples cover the whole probe,
including retained source passages, multiple builds and two project indexes.

The coordinator's authoritative snapshot registry, current membership/run
resolver, cross-process binding, intended molecule declarations and skill-data
containment checks remain prerequisites for tenant activation. The CLI and
live A/B benchmark do not activate this backend yet. No embedding/reranking API
calls or account spend occur in this increment.

Verification on 2026-09-09: `release:check` passed with 3,715 tests passed and
13 environment-dependent skips, both TypeScript configurations, lint, audit
(zero vulnerabilities), build and compiled release/auth/SQLite smokes. The
retrieval-focused source suite has 83 passing tests. The first full attempt was
interrupted after sandbox restrictions prevented local-server tests from
completing; the complete rerun with the required local access passed.

---

# Project retrieval: opt-in coordinator activation

**Historical implementation record. Current activation:** [Haystack-only configuration](../project-retrieval-haystack-only-2026-09-09.md#activation)
supersedes the SQLite launch described in this implementation record.
Every new project run now requires explicit Haystack host settings. The former
`ATOMA_PROJECT_RETRIEVAL` switch is removed; the opt-in behavior below describes
the earlier implementation, not the current launch contract.

Date: 2026-09-09. Implements the project launch portion of
[Steps 8–9](#step-8--wire-the-element-through-the-real-atoma-execution-path).
This follows the [host boundary](#project-retrieval-host-boundary--design-and-implementation-contract)
and [SQLite ingestion/backend](#project-retrieval-deterministic-ingestion-and-sqlite-backend).
Retrieval remains opt-in; no embedding, reranking or LLM context call is added.

**Subsequent audit:** the [downstream privacy audit](#project-retrieval-downstream-privacy-audit)
reproduces cross-project disclosure through common registry metadata. That
finding is now corrected by [project registry ownership](../project-registry-ownership-2026-09-09.md).
Continue with the registered evaluation and operational lifecycle before rollout. The query boundary passing its tests is not a tenant-rollout approval.

## Activation and source admission

Set `ATOMA_PROJECT_RETRIEVAL=1` in the host environment of the project
coordinator, including the compiled `projects` CLI or viz server that owns it.
The switch defaults to off; `0` disables it and any other defined value is a
configuration error. It applies to all new project runs of that coordinator;
there is no tenant-controlled switch or account/organisation inheritance yet.
Restart a long-running coordinator to change its captured host configuration.
Standalone operator runs and the benchmark CLI do not resolve project receipts.
The existing explicit `startTask` library injection remains available.

The coordinator selects the same previous delivered run used to seed the new
workspace. Only non-executable `.md` and `.txt` entries in that source run's
stored artifact manifest enter the corpus. The existing publishable-path
policy, hash/size validation and ingestion limits apply. Unlisted files,
traces, logs, arbitrary repository files and skills are not scanned. If there
is no previous delivered source, the admitted corpus is empty. Missing
documentation is therefore an empty search, not a claim about the whole project.

Before spawning the child, the host copies admitted bytes into a newly reserved
`retrieval-source/` directory beside the new run's `workspace/`. Files use mode
`0400`, directories `0700`. The archive is outside the worker mount. Each
document is captured with the existing bounded, symlink-refusing reader and
verified again by corpus preparation. Changed source bytes fail preparation.
The archive and source manifest preserve the consulted snapshot if the older
workspace later changes. Paths, source contents and receipt JSON do not enter
the launch environment.

The new run ID identifies the snapshot; its digest binds organisation, project,
source run, source manifest hash and admitted documents. Index generation also
binds the existing ingestion configuration. This version builds a fresh
generation per run, even when documents are unchanged. Preparation consumes
the project run's existing time budget and holds its normal global lease.
Cancellation or failed preparation prevents the child from spawning, records
the ordinary run failure/cancellation and releases the lease. Partial archives
and unpublished cache data are retained rather than overwriting evidence.

## Authoritative receipt and current access

`project_retrieval_launches` is an additive table in the existing product SQLite
file. It stores one immutable receipt per project run and a revocation flag;
a SQL trigger refuses updates to the receipt identity. Receipts are source
records, separate from reconstructible FTS tables. Their existence grants no
access by itself.

Only after preparation and publication succeed does the coordinator forward
the activation marker alongside the existing run ID. The child resolves that
ID in a separate read-only connection to the same product file. It checks:

- The exact run, organisation, project and requesting principal match.
- The run is running, its project active, and the requester currently holds
  at least the organisation member role.
- The receipt is unrevoked, its source binding and generation are consistent,
  and its source run is still delivered in the same project with the recorded
  artifact manifest hash.
- Workspace, trace directory and project-local skills directory match the
  registered run layout. Container isolation is selected, strategy prefilter
  caching is off, and skill promotion/direct dispatch are off.

These checks happen before provider or workspace construction. An absent,
forged, stale or unreadable receipt fails closed, without operator fallback or
host paths in the error. The preflight connection closes immediately; the
run-owned query connection opens lazily and closes on backend cleanup.

The host element rechecks current database authority before and after every
search. Revoking membership, archiving the project, ending the run, revoking
the receipt or deleting its source denies an already-open service. Bytes
returned before a later revocation cannot be recalled. Query/result caching
is not introduced. `ProjectRetrievalLaunchStore.revoke` is currently a host
library operation, not a new tenant API or operator CLI command.

## Runtime scope and downstream limits

The composite executor still intercepts only `search_project_docs` on the
host. File/shell tools retain their worker dispatch and ordinary isolation;
there is no worker protocol addition, extra mount or new network route.
The worker environment receives neither the product-store path nor the
retrieval activation marker.

Build bootstrap adds a dedicated document/maintenance molecule when the host
declaration is present. Existing web, HTTP and file-scribe scopes are not
widened. Repeated bootstrap preserves the dedicated type's trust if its
contract is unchanged. Disabling retrieval removes that declaration from the
dedicated molecule and current build root; runtime dispatch remains the final
boundary for persisted custom scopes. The fixed prompt treats returned text
as untrusted source data, requests citations, and requires reading the current
workspace before editing it. Supervisors, validation, observations and skill
credit retain their existing execution paths.

Existing project-local skill storage and lifecycle restrictions are preserved.
The subsequent [tenant-fixture audit](#project-retrieval-downstream-privacy-audit)
confirms skill-directory containment but reproduces disclosure through common
registry prompts, descriptions and branch names. Search isolation alone cannot
certify downstream confidentiality or prompt-injection resistance. Broader
activation still requires registered A/B treatment and operational
diagnostics/rebuild/retention. The [ownership correction](../project-registry-ownership-2026-09-09.md)
now contains registry data within its project. No production environment is
enabled by this code change.

## Verification and rollback

Focused source tests exercise coordinator preparation/cancellation, registered
path checks, empty corpora, source mutation, cross-project and cross-organisation
admission in one database, live revocation, canonical bootstrap/trust and real
`startTask` receipt resolution with mocked providers.

`scripts/retrieval-project-smoke.mjs` imports compiled modules and runs the real
coordinator and `spawnRun` across a child process. A mocked provider drives the
real L1 transport/dispatch through search and a file/shell call; the parent then
revokes access while the child is alive. It also exercises the compiled runner's
pre-provider refusal of a forged workspace. The default host smoke is included
in `release:check` on supported run hosts. `--container` runs the same probe with
the real worker in `network none`, checks inaccessible host source files and
absent control-plane environment, then cleans up the worker. This is a boundary
probe, not a three-tier delivery run or a retrieval-quality benchmark.

Verified on Node 24.20.0: `npm run release:check` passed (3,746 tests passed,
4 skipped, both TypeScript configurations, lint/docs checks, no npm audit
vulnerabilities, build and compiled smokes). The final `dist/` then passed
`npm run build:worker`, `node scripts/retrieval-project-smoke.mjs --container`
and `npm run release:container-smoke` (allowed external request returned 200;
control-plane access was blocked). Providers in these probes are mocked.

Disable the host switch for subsequent runs to roll back activation. Existing
admitted runs continue under their bound policy and live authority checks.
Receipts/archives remain evidence; old FTS generations can use the existing
bounded garbage collector. Automatic retention, coordinated source deletion,
operator rebuild commands and doctor/preflight reporting remain pending.
The additive receipt table is ignored by the preceding implementation; rollback
does not require deleting the table, source archives or the product store.

---

# Project retrieval: downstream privacy audit

**Correction implemented:** [project registry ownership](../project-registry-ownership-2026-09-09.md)
closes the registry channel characterized below. The original observations refer
to `3b0f4e5`; the executable fixture now asserts absence in other projects and
reuse within the owner, including L3 → L2 and planner-created tool metadata.
The historical finding is retained as evidence, not as the current code status.

Date: 2026-09-09. Source reviewed: `3b0f4e5`, with the executable audit fixture
introduced alongside this record. Status at audit: **audit complete; confidentiality
condition NOT satisfied. Real tenant-document rollout is blocked by the
common registry channel below.** This is an offline adversarial characterization,
not a live customer incident, an independent security review or a measurement
of how often a provider copies private information.

This closes the investigation promised by
[Step 8](#step-8--wire-the-element-through-the-real-atoma-execution-path),
not its confidentiality exit condition. It qualifies the earlier
[activation record](#project-retrieval-opt-in-coordinator-activation): query isolation
and passing release/container checks do not establish downstream data isolation.

## Reproducible finding: private facts cross through registry metadata

**Priority: P1.** A model-authored validator modification can move a private
source fact into `atom_types`, which is common to project runs. Another
organisation can receive that fact in a subsequent model request without
passing the first project's retrieval authorization boundary.

The audit fixture follows these production paths:

1. Create a private project and a delivered manifest containing one synthetic
   Markdown pricing document. Admit its snapshot through
   `ProjectRetrievalLaunchStore.prepare` and resolve the current run's receipt.
2. Drive `L2Atom.handleDirect`, the shared supervision loop, `L1Atom.execute`
   and the real `AnthropicLlmClient` tool dispatcher with mocked decisions.
   `search_project_docs` returns an exact passage from the real FTS index.
3. Make the mocked result validator copy the observed fact into a persistent
   modification. The model has no direct database tool: the supervision hook
   is the writer.
4. Register another organisation's run in the same product database, with its
   own paths and an explicitly admitted empty corpus.
5. Start a fresh Node process. It resolves the second run's receipt, successfully
   searches its empty corpus, loads the common registry and invokes the real
   L1 planner and L2 routing prefilter with mocked completions.
6. Observe the first project's fact in the second process's model request,
   although its search returned no passages. No skill file crosses projects.

Four metadata carriers are reproduced, under one missing ownership boundary:

- `systemPromptAppend` with scope `patch`: the next project's L1 planner
  receives the private sentence in its system prompt.
- `systemPromptAppend` with scope `branch`: a new persistent type carries the
  sentence and can be hydrated by the next project.
- `descriptionReplace`: the short synthetic private sentence passes
  `resolveCreationDescription` and enters another project's routing catalogue.
  Task-theme hygiene is not a confidentiality policy.
- `branchName`: a syntactically valid label containing synthetic tenant facts
  enters the common catalogue. Filename-safe characters do not make a label
  public information.

The corresponding ephemeral modification stays on the current instance and
does not appear after reload. `additionalContext` is also correctly separated
from persistent modifications in both supervisor hook implementations. These
are useful positive controls, but they cannot stop a model placing the same
fact into one of the persistent fields.

The relevant writers/readers are
[`L2Atom.makeL1Hooks`](../../src/atoms/L2Atom.ts),
[`L3Atom.makeL2Hooks`](../../src/atoms/L3Atom.ts),
[`AtomRegistry.patch/branch`](../../src/registry/atomRegistry.ts) and
[`resolveCreationDescription`](../../src/atoms/capability.ts).
The fixture reproduces L2 → L1 writes and subsequent L1/L2 reads. L3 → L2
writes share the inspected pattern; they are not independently exercised by
this new fixture. Planner-authored descriptions and tool metadata also need
coverage in the correction, rather than assuming these four examples exhaust
the writable surface.

This channel predates retrieval: a private fact obtained from workspace tools
can take the same route. The new source element provides another input to it.
The existing warning that local runtime trust is not a complete multi-tenant
architecture remains material.

## Skills: containment works; generalization is not enforced

The successful-run fixture deliberately makes the distiller return a recipe
containing the private fact. The real lifecycle passes the L1 summary to the
distillation call, includes its existing generalization instruction, then saves
the copied fact. A fresh `SkillRegistry` reads it back from the project's
skills directory with `distilled` provenance.

That body is visible to compatible donor/reader namespaces **inside the same
project root**. It is absent from another project in the same organisation,
another organisation and the operator skills root. The test first proves that
namespace sharing actually admits the donor in the owning root, so an empty
foreign result cannot be explained by disabling sharing or using incompatible
tools. Recovery-skill generation likewise preserves a deliberately copied
private fact inside the project root; its assessment is `not-shareable`.

`assessShareability` returns `review-required` with no mechanical blockers for
the ordinary recipe containing the private sentence. This is correct under
its existing contract: it is a hygiene assessment, not a redactor or an
authorization decision. Raising its regex sensitivity cannot establish that
private facts have been removed, especially when paraphrased.

`exportSkillToSpec` faithfully retains that sentence. It is an operator-invoked
format conversion, not a platform catalogue admission path; the fixture does
not send an export to another tenant. The
[catalogue-offer review](../platform-skill-offer-review-2026-08-23.md) remains a
design, not an implemented automatic distribution gate. The current MCP and
HTTP catalogues reserve operator skill/registry APIs to the platform tier.
Their API authorization does not protect the internal registry reuse channel
described above.

Source withdrawal is not automatic forgetting: removing a source or revoking
search cannot erase facts already delivered to a run or learned in its private
recipes. Coordinated retention/provenance remains an operational design item.

## Cache and execution controls

The fixture derives lifecycle settings from `projectRunEnvironment`, including
`ATOMA_PREFILTER_CACHE=0`. An existing common cache row is not read or credited
with a hit, and a new private decision is not written. This checks both sides
of the existing cache policy, rather than merely inspecting the environment.
Retrieval does not introduce a query/result cache.

Project-local skill paths, current receipt resolution, pre/post search
authorization, disabled promotion/direct dispatch and worker isolation retain
their earlier tests. This audit changes none of those policies, adds no LLM
call site, and does not disable learning. None of them partitions atom-type
metadata; a correct retrieval check cannot repair a separate store reader.

## Required corrective increment before real-document activation

Treat tenant-authored registry content as project data. Preserve reusable
platform knowledge through an explicit shared-body boundary; do not infer
public status from a prompt instruction, a keyword detector or a successful run.
Implement the correction as one coherent registry ownership change:

1. Define the trusted project ownership context at run construction, using the
   existing current run/project/principal resolver. It must reach every registry
   creation, patch, branch, reload and catalogue reader, including escalation.
2. Keep project-owned definitions and their history in the existing product
   SQLite store. Distinguish them from explicitly admitted shared definitions.
   Another project must not load a private prompt, name, description or tool
   definition merely because both runs use the same database file.
3. Preserve stable atom IDs, lineage, project skill namespaces, trace identity
   and per-owner trust. Follow the repository's complete identity/migration
   contract, including backups and rollback. Existing unscoped model-authored
   rows cannot silently be declared public; retain their evidence and define
   their admission policy explicitly.
4. Keep the shared supervision loop and project learning intact. Private
   coaching remains usable in its owning run/project. A model-generated
   sanitizer or disabling distillation would not close the reproduced registry
   channel and must not substitute for ownership.
5. Cover L1 and L2 creation, both supervisor mutation hooks, alternate metadata
   fields, forks, subsequent same-project reuse and foreign-project reload in
   a real child process. Convert the exposure characterizations below into
   absence assertions with that implementation; test useful same-project reuse
   as well as rejection.
6. Keep review/admission separate from export formatting and skill trust.
   Evaluate copied and paraphrased facts before any future shared-body offer.
   Define provenance/retention for derived content before promising deletion.
7. Re-run source, release and container checks, then register the fresh BM25
   A/B treatment and control on the corrected revision. Keep experiments on
   synthetic data and independently initialized state while this boundary is
   unresolved.

The current activation switch is unchanged and still defaults to off. This
audit does not enable a deployment, remove stored evidence or introduce a new
runtime gate. Until the correction lands, do not treat opt-in availability as
approval to use real private documents on a shared tenant host.

## Verification

Run with the pinned Node version:

```bash
npx vitest run tests/project-retrieval-privacy.test.ts
```

The eight tests include **exposure characterizations**, explicitly labelled
in the source. Their passing result means the audit is reproducible, not that
the confidentiality condition passes. All documents and provider decisions
are synthetic; real retrieval, supervision, persistence and process boundaries
execute, with no paid provider call. Existing `mcp-http`, `viz-auth-gate`,
skill lifecycle/shareability and retrieval tests cover the surrounding paths.

`npm run check` passed on Node 24.20.0: both TypeScript configurations,
documentation checks, lint and 3,745 tests passed; 13 conditional worker,
preview and mender tests were skipped. The eight new audit cases all executed,
including the real child-process reloads. This test/documentation increment
does not claim a new container-isolation certification.

---

# Haystack retrieval experiment

**Current runtime:** [Haystack is now the only project retrieval backend](../project-retrieval-haystack-only-2026-09-09.md).
The SQLite comparison below remains historical evidence and development tooling.

Date: 2026-09-09. Status: experimental host library integration; no default or
coordinator activation. This implements the owner's request to evaluate a
maintained retrieval framework after the negative BM25 agent pilot.

## Choice and scope

Use **Haystack 3.1.1** as the first framework candidate. Its native pipeline
supplies BM25, embedding retrieval, reciprocal-rank fusion and a cross-encoder
ranker. These are the components we otherwise would have to assemble and
maintain. Atoma keeps its L1 element, supervision, authorization, source
admission, exact citations and answer generation. We do not use Haystack's
agent loop, hosted platform or an additional database service.

This is a choice of an implementation to evaluate, not a claim that one
framework is universally best. Retrieval quality also depends on the corpus,
queries, models, chunking and context budget.

Maintenance was checked against upstream sources on the date above:

- [Haystack](https://github.com/deepset-ai/haystack) is maintained; the tested
  [package release](https://pypi.org/project/haystack-ai/3.1.1/) is 3.1.1. Its
  [retrievers](https://docs.haystack.deepset.ai/docs/retrievers),
  [fusion component](https://docs.haystack.deepset.ai/docs/documentjoiner) and
  [ranker](https://docs.haystack.deepset.ai/docs/sentencetransformerssimilarityranker)
  give this experiment a substantive retrieval pipeline.
- [LlamaIndex.TS](https://github.com/run-llama/LlamaIndexTS) was archived on
  April 30, 2026 and declares deprecation. This rules out its TypeScript
  implementation for a new integration; it says nothing about the separate
  Python LlamaIndex project, which was not benchmarked here.
- [LangChain.js](https://github.com/langchain-ai/langchainjs) remains maintained.
  Its former community package was
  [sunset on May 27, 2026](https://github.com/langchain-ai/langchainjs-community/issues/61).
  A thin `@langchain/core` retriever wrapper alone would not implement the
  embedding/fusion/reranking pipeline. Maintained individual integrations
  remain another candidate; this is not a rejection of LangChain as a whole.

The explicit tradeoff is an optional Python runtime on Atoma's host. Haystack
is not installed by `npm ci` and is not put into the isolated worker image.

## Implemented boundary

`createHaystackRetrievalBinding` takes an existing host-authorized binding,
its matching prepared immutable corpus, an absolute Python executable and
strict host settings. It returns the same `ProjectRetrievalBinding` accepted
by `startTask(profile, argv, { projectRetrieval: binding })`. The existing
`ATOMA_RUN_ID` and tenant/run checks still apply. The caller owns this binding
until it hands it to the runner; it must dispose it if launch is abandoned.

There are two settings modes:

1. `bm25`: Haystack's in-memory BM25Okapi retriever.
2. `hybrid-rerank`: BM25 plus local SentenceTransformers document/query
   embeddings, cosine retrieval, equal-weight reciprocal-rank fusion, then
   local cross-encoder reranking. Candidate counts use the existing bound.

The host hashes passage identities and supplies only admitted text decorated
with the same deterministic path/headings/source context as FTS5. Python
returns only IDs and finite scores. Atoma rejects unknown/duplicate IDs and
maps accepted hits back to the original source bytes. The existing element
applies result/excerpt budgets and checks live authorization before and after
search. No tenant-selected host path, model, endpoint or credential enters
this protocol. Each run has its own process and ephemeral in-memory store;
no corpus or statistics are shared across organizations or projects.

The subprocess has an allowlisted environment, no inherited credentials,
disabled Haystack telemetry, Hugging Face offline flags, and CPU-only model
execution. Model files must already exist. Downloads are an explicit operator
setup step, outside the run. These are library offline settings, not a new OS
network sandbox. Requests and replies are bounded; cancellation/deadline or
protocol failure kills the process group. Normal teardown reaps the process.

Hybrid settings include `embeddingPath`, `rerankerPath`, `queryPrefix`, and
`embeddingRevision`/`rerankerRevision`. The latter are SHA-256 content digests
returned by `haystackModelRevision`, not upstream Git SHAs. The digest covers
sorted non-hidden files; Hugging Face's hidden download metadata is excluded.
Symlinks and changed files are rejected. These model directories are trusted,
host-owned immutable inputs and must remain immutable while the process runs.

The existing generation pins admitted sources, chunker and deterministic
context. There is no persistent vector index: a new binding rebuilds embeddings
and checks its model digests. A later persistent cache must include model,
chunker, context and embedding settings in its own generation identity.

The [first archived component screen](../../benchmark/haystack/results-2026-09-09/README.md)
measured complete evidence for 9/11 answerable questions with the hybrid
pipeline, versus 8/11 with FTS5. It meets the screen for a later agent
experiment; it does not establish task success or authorize rollout.

The [shared-runner development integration](#haystack-in-the-shared-agent-runner)
now supports a registered Haystack treatment with timed initialization and
unchanged agent/scoring paths. Ordinary coordinator activation remains FTS5.

## Installation and verification

Use a dedicated Python environment (Python 3.10.16 was tested):

```bash
python3 -m venv /absolute/path/to/haystack-venv
/absolute/path/to/haystack-venv/bin/python -m pip install -r scripts/requirements-haystack.txt
# Optional local embeddings and reranking:
/absolute/path/to/haystack-venv/bin/python -m pip install -r scripts/requirements-haystack-hybrid.txt
```

The [observed dependency snapshot](../../benchmark/haystack/requirements-observed.txt)
records the tested macOS arm64 environment. It is not a cross-platform lock;
production packaging, dependency audit and operational sizing remain separate
work. The TypeScript/Python protocol asserts Haystack 3.1.1.

Ordinary tests use a real fake-provider child process, with no Python or model
requirements. Enable the actual framework checks explicitly:

```bash
ATOMA_HAYSTACK_TEST_PYTHON=/absolute/path/to/haystack-venv/bin/python \
ATOMA_HAYSTACK_TEST_MODELS=/absolute/path/to/models \
npx vitest run tests/project-retrieval-haystack.test.ts
```

The model root contains `embedding/` and `reranker/` directories. Without the
model variable, the real BM25 check still runs. No test downloads weights.
Tests cover exact citations, scope, live revocation, malformed/oversized
responses, version mismatch, missing runtime, cancellation/reaping, environment
isolation and model content pins.

## Evaluation plan and model provenance

The [component experiment](../../benchmark/haystack/README.md) compares FTS5,
Haystack BM25 and Haystack hybrid on all 13 Northstar development questions,
once per arm. It freezes the code, compiled modules, dependencies, source
snapshot, query settings and model digests before querying. It reuses the
unchanged golden evidence scorer and saves actual host element responses.
The Orchard held-out questions are not run.

The compact reference models used to validate the CPU pipeline are:

- [`BAAI/bge-small-en-v1.5`](https://huggingface.co/BAAI/bge-small-en-v1.5),
  upstream revision `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`, MIT;
  query prefix: `Represent this sentence for searching relevant passages: `.
- [`cross-encoder/ms-marco-MiniLM-L6-v2`](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2),
  upstream revision `233902d25c440f23af6f7d6e94d2946bac0bee0a`, Apache-2.0.

These are English reference weights, not current state-of-the-art or a model
selection result. Haystack and its SentenceTransformers integration declare
Apache-2.0. Atoma remains AGPL-3.0-only; model files and Python dependencies
are not vendored into this repository. No hosted model API is used. Local
CPU/RAM and installation costs still exist.

A positive component screen only justifies another registered experiment
against agentic search in Atoma's shared runner. It does not establish task
success or fix the citation-assembly failures from the prior pilot. Promotion,
coordinator configuration, doctor/preflight support, production packaging and
scale testing remain outside this experimental integration.

---

# Haystack in the shared agent runner

Date: 2026-09-09. Experimental development comparison; no rollout decision.

**Subsequent simplification:** [Haystack is now the only product retrieval backend](../project-retrieval-haystack-only-2026-09-09.md).
Source preparation no longer builds FTS5, and normal retrieval-enabled
coordinators require and forward explicit Haystack configuration. The pilot
description below records the exact earlier implementation that was measured.

## Change

A `haystack-development` campaign now compares ordinary Atoma (A), Atoma
with local Haystack retrieval (B), and the existing frontier-direct reference
(C). It reuses the registered campaign driver, synthetic tenant authority,
`spawnRun`, `startTask`, isolated worker, global run lease, source archiving,
accounting and unchanged executable scorers. Existing BM25 registrations keep
their original arm names, settings and policy.

The host-only `ATOMA_PROJECT_RETRIEVAL_HAYSTACK` JSON configuration contains
an absolute Python executable, Haystack settings and the SHA-256 of installed
Python runtime/package metadata. It is only admitted with the existing tenant
retrieval receipt and isolation/lifecycle checks. The benchmark injects it into
B after constructing the project environment; ordinary coordinator launches
still select FTS5. Model arguments, user goals and workers cannot set it.

Preflight resolves the same read-only source receipt and authority. Python
starts after `startTask` owns its teardown, trace and watchdog, before the first
model call. Preparation therefore consumes the same attempt budget, and a
preparation failure leaves a stopped trace with an `error` accounting epilogue
and zero model calls. The benchmark classifies it as infrastructure failure.
The source receipt currently also builds its small FTS cache; that cost is
included rather than hidden. A future receipt/cache split is not part of this
experiment.

The framework uses the already archived immutable source, never the live worker
workspace. Query authorization is still checked before and after delivery.
Shutdown cancels initialization and queries, then reaps Python. A dedicated
stdin reader exits Python on host EOF even when model computation is busy, so
an abruptly killed host does not leave a detached runtime working indefinitely.
Runtime identity is checked in preflight and on actual Python startup; model
content pins are checked before loading. No telemetry or paid retrieval API
is enabled, and model downloads remain an explicit setup action.

## Registered pilot design

Use `northstar-05` and `northstar-13`, one repetition in A/B/C then C/B/A order.
The first is a French refund-window question selected because the earlier
component screen recovered its evidence only with hybrid retrieval at five
passages. The second requires the maintenance artifact plus cited answers and
was a failure case in the prior agent pilot. This is a disclosed development
selection, not a held-out sample. Do not run the Orchard family.

Use the previous tier selectors: Haiku L1, Sonnet L2, Opus L3 and frontier,
all `sub:anthropic`. Each attempt has 180 seconds including preparation; the
six-attempt campaign has a 1,200-second cap. Learning, promotion, direct
execution, event skills and prefilter caching stay disabled. The worker uses
no egress. No model change, citation shortcut, new detector, larger tool budget
or scorer relaxation is included.

The shared screen requires a paired full-pass gain of at least 0.5 and total
B/A elapsed-time and subscription-price-equivalent ratios at most 1.25.
Incomplete accounting or any infrastructure failure makes it inconclusive.
Success would justify a new confirmation experiment only. The host subscription
permission continues the owner's existing choice; no API-funded transport is
selected. Subscription price equivalents are not an incremental API invoice.

## Prior failures and interpretation

The prior pilot's real harness persistence defects are already corrected and
covered by regression tests. Its remaining wrong citations and unfinished
maintenance artifacts are measured task failures. There is no runtime exception
to repair by weakening their requirements. This comparison asks whether the
retrieval treatment changes those outcomes under the existing budgets; it does
not presume that retrieval fixes downstream assembly.

Current framework weights remain the compact BGE-small and MiniLM references
from the component experiment. The full registration must include their actual
content hashes, the Python/package identity, source revision, instrument lock
and worker image digest before execution. The original failed tasks and the
component observations remain preserved independently.

## Verification and operation

Unit/integration tests exercise receipt admission, balanced arm selection,
controls without Haystack settings, the real runner's successful/failed warmup,
zero model calls on warmup failure, cancellation/reaping and original citations.
Optional tests exercise real Python and offline models. The existing compiled
`scripts/retrieval-project-smoke.mjs --container --haystack` also tests live
revocation and proves that neither source paths, store paths nor Haystack
configuration enter the real worker. Its explicit test environment provides
`ATOMA_PROJECT_RETRIEVAL_HAYSTACK` and optionally a pinned
`ATOMA_RETRIEVAL_SMOKE_IMAGE`.

Register and execute with the existing CLI:

```bash
npm run benchmark -- retrieval register --spec /absolute/pilot-spec.json --out /absolute/new-registration.json
npm run benchmark -- retrieval inspect --registration /absolute/new-registration.json
npm run benchmark -- retrieval run --registration /absolute/new-registration.json --out /absolute/new-evidence-directory
```

Only `run` consumes model quota. Save every attempt, stopped trace, initial and
final store, executable score and accounting before interpreting the screen.

## Completed development pilot

The [six-attempt report and replayable archive](../../benchmark/retrieval-haystack-agent-pilot-2026-09-09/README.md)
record A 0/2, B 0/2 and C 1/2 full tasks, with no infrastructure failure.
The pre-registered benefit screen was not met. Haystack's one search returned
the required evidence, but its final citation used the wrong line number.
The maintenance treatment did not invoke retrieval; all three maintenance
attempts made the correct change without delivering the required cited answer.
The framework remains experimental pending downstream completion work and
new evidence. All scores and the paired decision reproduced offline from a
fresh extraction; no additional model calls or scorer changes were needed.
