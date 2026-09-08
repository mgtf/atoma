# Project retrieval: deterministic ingestion and SQLite backend

Date: 2026-09-09. Status: host library implementation; tenant/CLI activation
remains pending. This extends the [host contract](project-retrieval-host-contract-2026-09-09.md)
and implements the lexical backend in [Steps 6–7](project-retrieval-action-plan-2026-09-08.md#phase-c--implement-the-first-backend).

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

The [mechanical capacity measurement](../benchmark/retrieval-index-capacity-2026-09-09.json)
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
