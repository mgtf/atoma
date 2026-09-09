# Haystack component evaluation

[First archived result](results-2026-09-09/README.md): hybrid retrieval covered
9/11 answerable development questions completely, compared with 8/11 for
FTS5. This meets the component screen for a later agent experiment.

Development retrieval experiment, separate from the shared-runner A/B/C agent
campaign. No answer model, subscription transport, API key or product store.
All three backends receive the same prepared passages and the original query
through `search_project_docs`, with its default five-result budget.

SQLite FTS5 now exists only as `sqliteBaseline.ts` in this development
directory. It is not compiled into `dist/` or selectable by a project run.
Haystack is the only product retrieval backend. The historical agent
registrations remain readable, while new agent treatments use Haystack.

Build compiled modules, then register before querying:

```bash
npm run build
node --import tsx benchmark/haystack/evaluate.mjs register /absolute/path/to/new-output /absolute/path/to/venv/bin/python /absolute/path/to/models
node --import tsx benchmark/haystack/evaluate.mjs run /absolute/path/to/new-output /absolute/path/to/venv/bin/python /absolute/path/to/models
node --import tsx benchmark/haystack/evaluate.mjs replay /absolute/path/to/output
```

The output directory must be new. `models/embedding` and `models/reranker`
must contain the local reference weights documented in the
[implementation record](../../docs/incidents/project-retrieval-record-2026-09-09.md#haystack-retrieval-experiment).
Run from a committed source tree; registration pins source and compiled
hashes, Python packages, model content, instrument lock and query limits.
`run` refuses identity changes and existing result files. Preserve any failed
attempt separately; do not edit the registration to disguise a retry.

Protocol: all 13 Northstar questions in registered order; FTS5, Haystack BM25,
then Haystack hybrid; one query per question, no rewriting, tuning or retries.
The 2,171-byte source corpus and default chunker/context are common. Haystack
uses BM25Okapi, cosine embedding similarity, default equal-weight reciprocal
rank fusion, then the cross-encoder. The existing host query normalization
(lowercased literal terms) also applies to the semantic arm.

Primary measurement: fully covered answerable questions at five returned
passages, using the existing `retrievalObservations` golden evidence scorer.
Also report covered facts, source validity, failed calls, unanswerable queries
returning hits, cold preparation and median query wall time. Cold preparation
includes Python/model loading and local indexing; no Python CPU/RAM measurement
is claimed. Tiny timings are descriptive, not a capacity result.

A candidate advances to an agent experiment only if it improves fully covered
answerable questions over FTS5 with zero failed calls and invalid source spans.
The screen never activates a product backend. Returned passages on an
unanswerable query are not equivalent to an agent hallucination. The corpus is
small, synthetic and already used for development; its results cannot establish
state-of-the-art quality. The English compact models are reference weights.
No Orchard held-out queries are executed.
