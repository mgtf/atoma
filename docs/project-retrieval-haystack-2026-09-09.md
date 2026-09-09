# Haystack retrieval experiment

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

The [first archived component screen](../benchmark/haystack/results-2026-09-09/README.md)
measured complete evidence for 9/11 answerable questions with the hybrid
pipeline, versus 8/11 with FTS5. It meets the screen for a later agent
experiment; it does not establish task success or authorize rollout.

## Installation and verification

Use a dedicated Python environment (Python 3.10.16 was tested):

```bash
python3 -m venv /absolute/path/to/haystack-venv
/absolute/path/to/haystack-venv/bin/python -m pip install -r scripts/requirements-haystack.txt
# Optional local embeddings and reranking:
/absolute/path/to/haystack-venv/bin/python -m pip install -r scripts/requirements-haystack-hybrid.txt
```

The [observed dependency snapshot](../benchmark/haystack/requirements-observed.txt)
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

The [component experiment](../benchmark/haystack/README.md) compares FTS5,
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
