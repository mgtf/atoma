# Project retrieval evaluation instruments

Status: instruments and characterization campaign driver implemented; no live
campaign registered or measured. These
fixtures and scorers implement the first increment of the
[retrieval action plan](../../docs/project-retrieval-action-plan-2026-09-08.md).
They do not enable search in Atoma or establish a retrieval benefit.

## Corpus contract

The first corpus is versioned project documentation supplied as a starting
repository/workspace snapshot. Only explicitly listed UTF-8 Markdown and plain
text files are searchable. Source code, executable assets, raw run traces,
logs, skills, secrets, generated dependencies, binaries, PDFs, and external
connectors are excluded. Maintenance configuration and preview programs are
separate task assets; they are never citation sources.

The checked-in data is synthetic, authored for this benchmark under Atoma's
AGPL-3.0-only license. It contains no tenant data. The original authority is
the committed fixture text. A document identity is its organisation, project,
snapshot, normalized relative path, and content SHA-256. A fixture ID is not
a Git commit. Updates require a new explicitly reviewed instrument lock;
there is no background refresh. Production snapshot ingestion is later work.

The manifest explicitly lists four independent snapshots:

- `northstar-v1`: development, subscription billing, four documents and two
  maintenance assets; 13 questions.
- `orchard-v1`: held-out, parcel collection, four documents and two maintenance
  assets; 13 questions.
- `sibling-v1`: another project in the Northstar organisation, one document
  sharing a filename with a Northstar document, with different private facts.
- `foreign-v1`: another organisation with the same project name as Northstar,
  one document sharing that filename, again with different private facts.

Run `validate` for document bytes, counts, and current hashes rather than
copying those measurements into results. This is a small correctness corpus,
not a model of production scale. Source documents are English; questions
include English and French. The expected update cadence is explicit fixture
revision, not ongoing ingestion. A later realistic scale corpus must be
registered before claims about latency, retrieval gains, or storage choice.

The loader permits at most 200 documents and 20 assets per snapshot, 256,000
bytes per file and 8,000,000 bytes per snapshot. It rejects invalid relative
paths, symlinks, non-files, mismatched digests, invalid document UTF-8 and NUL
bytes. The manifest and questions each have a 2,000,000-byte input limit.

`prepare` copies exactly one snapshot into a new directory, plus a public
`CORPUS.json` inventory. Neither answers, evaluator code, reference fixes, nor
other projects are copied. The goal reveals fact names and JSON types but no
expected values or evidence locations. These are fixture-scope checks, not
proof of production tenant authorization or container isolation. The future
runner must place the workspace inside its existing sandbox and keep the
gold/evaluator outside it.

A citation proves a statement in the supplied snapshot. It cannot attest to
a modified workspace. Future product ingestion must enforce current access
rights, revocation and deletion even for pinned snapshots; documents are
tenant data, not the platform's skill commons.

## Questions and scoring

Each primary snapshot has two questions for each of six categories: exact
facts, paraphrases, cross-language queries, superseded decisions, facts across
multiple sources, and absent information. Each also has one maintenance task.
The 26 questions are locked before any production index implementation.

Golden evidence uses zero-based UTF-8 byte offsets into original documents.
It does not depend on a chunker. Accepted equivalent source locations are
registered as alternatives. Draft and superseded statements cannot supply
the evidence for current policy merely because their quotations are real.

Candidates write `retrieval-answer.json` according to the goal emitted by
`prepare`. The shared schema is
[`retrievalBenchmark.ts`](../../src/contracts/retrievalBenchmark.ts).
Facts have explicit JSON types, exact scalar values and source citations.
Identifiers and categorical terms preserve their documented spelling. Each
citation supplies the source digest, 1-based inclusive line numbers and an
exact quote of those whole lines, including final newlines when present.
The limit is 16 lines per citation. The scorer checks the question, snapshot,
exact fact set, values, every citation's bytes, and evidence coverage per fact.

Correct abstention is an explicit `not_found` with no facts. A missing,
unparseable or malformed answer fails; it is never credited as abstention.
A live campaign must separately record transport and infrastructure failures
from the runner rather than infer their cause from a missing answer file.

Maintenance is deliberately bounded: change a JSON configuration to implement
documented pricing or collection policy. An answer alone cannot pass. The
scorer copies the candidate configuration into a disposable directory and
executes the locked evaluator-owned preview program with a timeout, bounded
output and an empty environment. It never executes the candidate's replacement
program or commands. The previews exercise the requested behavior and the
parameters that must remain unchanged. Configuration durations and amounts
are nonnegative integers. All supplied files except the designated maintenance
configuration must remain byte-identical. Scoring assumes the candidate run
has stopped; this file reader is not a replacement for the run sandbox.

Tests pass reference answers and both reference fixes, and reject missing
answers, incorrect facts, false citations, stale evidence, wrong snapshots,
other-project sources, unchanged seeds, altered preview programs and unrelated
configuration regressions. These results validate the instruments, not an
agent's ability to solve the questions.

## Operator commands

From the source checkout, using the pinned Node version:

```bash
nvm use
npm run benchmark -- retrieval validate
npm run benchmark -- retrieval --dry-run
npm run benchmark -- retrieval prepare --question northstar-01 --out /tmp/atoma-retrieval-example
npm run benchmark -- retrieval score --question northstar-01 --workspace /tmp/atoma-retrieval-example
npx vitest run tests/retrieval-benchmark.test.ts tests/benchmark.test.ts
```

The example output directory must not already exist; its parent must exist.
`prepare` prints a JSON object containing the workspace and goal. Use that goal
as the task input, then score the completed, stopped workspace. The scorer
returns structured checks and `full`. It exits 0 on full success, 1 on a failed
answer/deliverable, and 2 on broken instruments or invalid arguments. A fresh
workspace without an answer is expected to fail scoring.

The offline commands above accept `--dataset <directory>`. They require no
model pins or credentials, call no providers, and use no product store. `node --import tsx
src/cli/benchmark.ts retrieval validate` is the equivalent source invocation
when a restricted environment prevents the `tsx` wrapper's IPC socket.
The fixtures remain external to emitted TypeScript; compiled-module behavior
is tested with an explicit dataset path. These are contributor benchmark
commands, not a new release entrypoint or MCP API.

`instruments.lock.json` freezes corpus and question bytes, transitively binding
sources, maintenance probes and reference fixes. It does not register a live
campaign, pin evaluator source code or report any model results. There is no
automatic lock repair: a changed corpus or score rule needs review and a new
registration before measurement. See [the protocol](PROTOCOL.md) for that next
step. The characterization driver below performs that registration and runs
the existing agentic paths; it does not add a search backend.

## Registered characterization campaigns

Start from [campaign.example.json](campaign.example.json) in a separate file.
Its selectors illustrate the syntax, not an endorsed or measured model
choice. Replace the zero worker digest with an installed worker image's actual
ID, and set all four model selectors explicitly. The first driver supports
host subscription selectors (`sub:`) only, through the existing provider
router. API-funded and personal-subscription campaigns are not implemented.
The frontier selector must use a transport constructed by the three tiers.

```bash
docker image inspect --format '{{.Id}}' atoma-worker:latest
npm run benchmark -- retrieval register --spec /tmp/retrieval-spec.json --out /tmp/retrieval-registration.json
npm run benchmark -- retrieval inspect --registration /tmp/retrieval-registration.json
npm run benchmark -- retrieval run --registration /tmp/retrieval-registration.json --out /tmp/retrieval-campaign-result
```

Only `run` executes models and consumes subscription quota. Registration needs
committed, tracked runtime/scorer source and the pinned Node version. It fixes
the instrument hash, source revision and bytes, Node/platform identity, exact
question/repetition order, model selectors, worker digest, thresholds, deadline
and infrastructure stopping rule. `inspect` is offline and prints the registered
schedule; it does not certify that credentials, the image or the host are ready.
The example is a four-attempt development pilot, not a sample-size justification.

Execution admits development questions only and alternates A/C ordering for
adjacent pairs. A is normal Atoma; C is the existing `--baseline` runner.
Every attempt uses `spawnRun` and the build profile with container isolation,
no worker egress, a new seed/workspace and empty pre-bootstrap store/skills.
Learning, promotion, direct skills, event skills and the prefilter cache are
off. The runner still performs its normal per-arm bootstrap and may write
within-run trust state; those changes never enter another attempt. Tool and
supervision budgets otherwise come from the registered source revision.

The optional shared runner flag `--worker-image <sha256:digest>` pins the exact
image selected by the campaign. It requires container mode; ordinary run
defaults are unchanged. The campaign verifies source bytes and image/CLI
versions between runs and source bytes after each run. Host CLI versions are
observed in `host.json`; remote served-model identities and cache usage remain
trace evidence. Provider cache/profile state is not claimed to be reproducibly
cold or frozen by this harness.

The whole campaign holds the existing machine-global run lease. An occupied
slot is refused without stale recovery, and each child's PGID is attached.
Cancellation uses the launcher's existing process-group teardown. A surviving
child keeps the lease and its PGID for operator recovery. Do not edit source
or run another live workload during the campaign.

`maxWallMs` aborts the active attempt and prevents the next one; mandatory
teardown and read-only preflight may extend total wall time past that budget.
Campaigns stop at a UTC day boundary and at the registered count of consecutive
infrastructure failures. Missing epilogues, missing/mismatched completed
traces and runner errors are infrastructure failures. Failed or cancelled
runner outcomes cannot earn a full task pass, even if an answer file exists.

The output directory must be new. It contains the registration, host versions,
committed source archive, exact dataset, append-only result rows, report and
per-attempt seed, workspace, state, log, trace and executable score. These are
host-side evidence; only the workspace is mounted into the worker. Preserve
the archive outside temporary/ignored paths before citing a measurement.
Reports distinguish planned and attempted runs, failed scores, infrastructure
failures and subscription price equivalents. They make no retrieval gain
claim. Aborts preserve an `aborted.json` report and all preceding evidence;
there is no overwrite or resume mode.
