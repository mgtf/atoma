# BM25 development pilot — 2026-09-09

The registered development screen was **not met**: A passed 0/2 tasks, B
passed 0/2, and the frontier reference C passed 2/2. Both A/B pairs completed
with no infrastructure failure. FTS5 returned the required evidence, but the
Atoma runs failed citation or task-completion requirements. This sample does
not justify enabling BM25 by default.

## Results and diagnosis

[report.json](report.json), [results.jsonl](results.jsonl) and
[metrics.json](metrics.json) preserve the exact observations:

- Pricing retrieval: A reached its deadline without the required answer
  file (183.493 s). B found the correct price but wrote invalid source line
  references (183.507 s). C passed the answer and citation checks (40.701 s).
- Pricing maintenance: A (183.546 s) and B (185.538 s) reached their deadlines
  with no required answer and failed the executable maintenance probe. C
  passed both the cited answer and maintenance behavior (73.972 s).
- B made one search on the first task and five on maintenance: six successful
  calls, 23 returned passages including repeats, no empty result or invalid
  source passage, and 34 ms of recorded tool duration in total. Returned
  passages covered 1/1 and 3/3 golden fact obligations respectively. These
  repeated obligations are not four independent tasks.

The pricing citation failure is specific: the final B answer cited
`docs/billing.md:5` for text on line 6, and `docs/decisions.md:9-10` for text on
lines 11-12. The returned source passages contained the needed evidence.
In maintenance, the trace records extraction work followed by exhaustion of
child tool-iteration budgets, supervisor rejections and more reading; the
required change and answer remained unfinished. This identifies observed
failures after retrieval. It does not prove that another model or a larger
budget would fix them.

The paired full-pass difference is 0 (required: at least 0.5), with zero wins
and zero losses. B/A total elapsed time is 1.0055 and subscription price
equivalent is 1.0430, both inside the registered 1.25 ceilings. Passing resource
ceilings without a correctness gain does not pass the screen. C provides a
broader reference: its architecture and model allocation differ, so C versus
B is not a retrieval-only causal comparison.

Each B attempt indexed four documents, 2,171 source bytes and 11 passages.
Fresh preparation took 6.800 ms and 4.422 ms, with CPU user/system totals
5,407/2,020 and 3,445/1,567 microseconds. Its whole store was 385,024 bytes;
completion RSS snapshots were 139,165,696 and 135,086,080 bytes. These tiny
fixtures cannot justify a service-scale or memory-capacity claim.

The six compared attempts recorded 85 client completions: A 42, B 41, C 2.
A client completion can contain several internal CLI/model/tool turns; these
are not vendor HTTP request counts. Trace totals record 45,162 input tokens,
49,293 output tokens, 1,199,777 cache-read input tokens and 595,651 cache-creation
input tokens. Remote cache state was not controlled. Requested/served model
labels, individual costs and per-attempt totals remain in the metrics.

No API-funded transport was selected. Runner-reported subscription price
equivalent is USD 2.1567 for the comparison and USD 2.4457 including the
preserved aborted attempt (98 client completions in all). These are accounting
equivalents, not an incremental API bill or remaining subscription quota.

## Registration and scope

The repeated comparison uses host source `63d61b5`, pinned Node 24.20.0, the
worker identity in [registration-r2.json](registration-r2.json), and the
unchanged retrieval instrument lock. All measured attempts run on one UTC day.
The earlier A/C pilot is historical context, not the control.

Two development questions are repeated: `northstar-01` (an exact pricing fact
with an original-source citation) and `northstar-13` (pricing maintenance plus
a cited answer). The registered order is A/B/C, then C/B/A, with one repetition.
A is ordinary Atoma, B adds host `search_project_docs` backed by SQLite FTS5,
and C is the shared frontier-direct runner. All use independent synthetic
project authorities, stores, workspaces and empty starting registries/skills.
Learning, promotion, direct dispatch, event skills and the prefilter cache are
disabled. Normal within-run registry/trust writes remain isolated per attempt.

The user's authorized host subscriptions select Haiku for L1, Sonnet for L2,
and Opus for L3 and C. These are selectors, not immutable provider weights;
actual served-model labels and provider cache usage are preserved in traces.
Every worker has network disabled. There is no API-funded retrieval service,
embedding, reranker, extra context-generation call, or query-result cache.

Each attempt has 180 seconds, including B's index preparation. The separately
registered continuation has a 900-second campaign cap after the initial
aborted attempt consumed three minutes. Teardown and read-only preflight can
extend wall time. The fixed screen requires a paired full-pass difference of
at least 0.5 and total B/A elapsed-time and subscription-price-equivalent
ratios no greater than 1.25. Missing attempts, missing accounting, aborted
campaigns or infrastructure failures make the screen inconclusive.

A favorable screen would justify only a separately registered confirmation
experiment. Two correlated tasks in one small synthetic project provide no
population confidence interval or evidence for production scale, abstention,
language coverage, or general RAG superiority. The held-out Orchard family
remains unevaluated. BM25 stays opt-in pending evidence and operational work.

## Preserved harness failure before the comparison

The original [registration](registration.json), on source `ddf7376`, stopped
after its first A attempt. The runner reached its timeout, with the correct
price and an incorrect citation. Completion persistence then threw
`failed requires an error`: the harness omitted the error field required by
the project store. No B or C attempt ran under that registration.

The original [aborted report](aborted.json) is preserved byte-honestly. It
incorrectly says zero recorded attempts and zero spend because the exception
preceded the row append. [Recovered evidence](recovered-aborted-attempt.json)
records the actual failed attempt: 13 client completions and USD 0.289 of
subscription price equivalent. This attempt is excluded from the new paired
comparison but included in total consumption. Its full archive is
[evidence-aborted.tar.gz](evidence-aborted.tar.gz).

Fix `63d61b5` supplies the store's required failure reason and appends the
stopped attempt before completion persistence. Regressions exercise failed,
cancelled, error and missing-epilogue outcomes through the real project store,
and retain accounting when completion persistence itself throws. Only this
harness correction and the reduced campaign cap changed; scoring, questions,
model selectors, attempt deadlines, retrieval settings and screen stayed fixed.
All three arms were newly registered and rerun on the corrected revision.

## Verification and evidence interpretation

Before the original registration, `release:check` passed 3,763 tests with
13 environment skips, both TypeScript configurations, lint, documentation,
audit (zero vulnerabilities), build and compiled smokes. The real compiled
retrieval/container smoke also passed. After the completion fix, all 29
campaign tests and both TypeScript configurations passed; the host bundle and
worker were rebuilt and the real container smoke passed again. No runtime
source changed during either live campaign.

`preparation.json` records index-only elapsed/CPU, process RSS at completion
(not peak), complete SQLite size (not marginal index size), source/passages
and payer attribution. The experiment builds a fresh index for each B attempt;
it makes no rebuild, reuse or amortization claim. Retrieval observations verify
original bytes and golden evidence coverage separately from task delivery.
They cannot alone distinguish lexical, ranking or truncation causes.

The archives contain synthetic authorities and fixture documents, not live
customer material. Only the selected workspace is mounted in a worker; raw
source archives, scorer, questions and gold remain outside that mount.

## Archive replay

[evidence.tar.gz](evidence.tar.gz) contains all six launch records, stopped
workspaces, logs, traces, initial/final SQLite backups, final stores, source
snapshots, retrieval receipts, exact dataset, registered source tar and scores.
The original aborted attempt is retained in its separate archive. The global
lease was released and no worker remained after the campaign.

[SHA256SUMS](SHA256SUMS) binds the archives and readable evidence. From this
directory run `shasum -a 256 -c SHA256SUMS`. From the repository root, with
pinned Node and installed dependencies:

```bash
retrieval_bm25_extract=$(mktemp -d /tmp/atoma-bm25-replay.XXXXXX)
tar -xzf benchmark/retrieval-bm25-pilot-2026-09-09/evidence.tar.gz -C "$retrieval_bm25_extract"
node --import tsx benchmark/retrieval-bm25-pilot-2026-09-09/replay.mjs \
  "$retrieval_bm25_extract/atoma-bm25-evidence-20260909-r2"
```

The script asserts that executable scores, runner epilogues and retrieval
observations reproduce the archived results, then prints metrics. It exits
zero when replay matches, even when the original task failed. All six scores
and observations were reproduced after fresh extraction; the initial aborted
attempt was also rescored. Model execution is a new registered campaign and
consumes quota; this replay makes no provider calls.

## Follow-up decision

Keep agentic search as the default and BM25 opt-in. The next development work
is to investigate exact citation assembly and completion of the answer/artifact
obligations under the existing tool budgets, using both failed tasks together.
Keep the fixed scorer and the raw failures. Any changed strategy or model needs
a new registration and fresh paired controls. This pilot supplies no evidence
that embeddings, reranking or a vector service would resolve these failures.
Operational lifecycle and broader project-family evaluation remain prerequisites
for production rollout.
