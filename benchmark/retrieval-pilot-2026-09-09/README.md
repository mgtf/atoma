# Agentic retrieval development pilot — 2026-09-09

The four-attempt pilot completed. Frontier-direct passed both tasks; Atoma
passed neither within the registered 180-second deadline. This characterizes
two synthetic development tasks with one repetition each. It does not measure
a retrieval treatment, establish a general ranking, or justify an index.

## Registration and execution

The local date was September 9 in Europe/Athens. All measured attempts ran on
September 8 UTC, from 21:14:10 to 21:22:01, on source revision
`9d3ac79` and one worker image. The complete identities and schedule are in
[registration-r2.json](registration-r2.json); observed runtime/CLI versions
are in [host.json](host.json).

The user authorized host Anthropic subscriptions. Selectors were Haiku for L1,
Sonnet for L2, and Opus for L3 and frontier-direct. These are aliases, not
immutable vendor model revisions: the trace reports `haiku` and `opus`, and
does not establish a more precise served model. No Sonnet call was observed;
the shared runner retains its existing cheaper validation/routing choices.

The driver used independent empty pre-bootstrap stores and skills, copied
seeds, isolated containers without egress, and disabled learning, promotion,
direct/event skills and the prefilter cache. Provider cache remained
uncontrolled; observed cache usage is preserved in [metrics.json](metrics.json).
The total campaign budget was 20 minutes, with a 180-second limit per attempt.
Elapsed attempt times include process setup and teardown.

The original [registration.json](registration.json) aborted before any model
attempt: Git archive rejected an absent optional `.dockerignore` path. The
[abort report](preflight-abort.json) is retained. Commit `9d3ac79` resolves
watched paths against the registered Git tree, with a real archive/extraction
regression test. A new registration preceded all four measurements; neither
questions, scorers, models nor deadlines were changed.

## Observations

The [result rows](results.jsonl) contain every executable check. The
[campaign report](report.json) counts all planned attempts, including failures.

- `northstar-01`, Atoma: failed after 183.549 seconds including teardown.
  The annual price was correct, but the exact source-evidence check failed.
  The run reached its 180-second deadline during supervision.
- `northstar-01`, frontier-direct: full pass in 50.500 seconds. The answer,
  source identity, quotations and unchanged supplied files all passed.
- `northstar-13`, frontier-direct: full pass in 51.917 seconds. Both the
  source-supported answer and the executable maintenance probe passed.
- `northstar-13`, Atoma: failed after 182.998 seconds including teardown.
  The maintenance probe passed: annual pricing was enabled and the preserved
  parameters were correct. `retrieval-answer.json` was absent when the run
  reached its deadline, so the required source-supported answer failed.

The logs and traces show repeated reads and validator exchanges in Atoma's
timed-out runs. In the maintenance trace, a validator also requested changing
configuration keys to the answer's fact-key spelling. That conflicts with the
actual fixture configuration and warrants investigation of task propagation;
it is not evidence that relevant documents could not be found. No new runtime
gate, scoring relaxation or timeout increase was introduced after observing
these outcomes.

The registered infrastructure-failure count was zero for all four attempts.
Timeouts remain failed task outcomes; they are not removed from the denominator.
Atoma recorded 42 client LLM completions across two attempts, frontier-direct
two. These counters describe Atoma's client calls, not vendor HTTP requests:
a CLI completion can contain several internal tool/model turns.

No API-funded transport was selected. The existing runner reports a total
subscription price equivalent of approximately USD 1.5361; this is neither an
incremental API bill nor a measurement of remaining subscription quota.
Raw token/cache totals and unrounded trace costs are in the metrics and archive.

Two paired tasks from one small project provide no useful precision estimate
for production effectiveness, abstention, another language, or scale. The
held-out Orchard family was not evaluated. Future A/B measurement must rerun
the control on the same revision/day as the retrieval treatment.

## Evidence and verification

[evidence.tar.gz](evidence.tar.gz) contains both launch records, full logs,
traces, all seeds and stopped workspaces, per-attempt stores and skills,
the locked dataset, and the registered source archive. The initial state is
explicitly empty before runner bootstrap; there is no fictitious starting DB.
Credentials and other projects were not mounted into candidate workspaces.
The campaign lease was released and no worker using the pinned image remained.

[SHA256SUMS](SHA256SUMS) binds the archive and readable result files. Verify it
from this directory with `shasum -a 256 -c SHA256SUMS` before extraction. To
inspect and rescore offline from the repository root, using pinned Node:

```bash
retrieval_pilot_extract=$(mktemp -d /tmp/atoma-retrieval-pilot.XXXXXX)
tar -xzf benchmark/retrieval-pilot-2026-09-09/evidence.tar.gz -C "$retrieval_pilot_extract"
npm run benchmark -- retrieval score \
  --dataset "$retrieval_pilot_extract/evidence-r2/dataset" \
  --question northstar-01 \
  --workspace "$retrieval_pilot_extract/evidence-r2/attempts/0001-atoma-northstar-01/workspace"
```

That first attempt must exit 1, retaining its failed evidence check. The two
frontier workspaces score fully; the last Atoma workspace fails answer-schema
and passes maintenance-behavior. All four scores were reproduced after fresh
archive extraction, without model calls. Reproducing model outputs is a new
quota-consuming campaign, not this offline check.

Before the pilot, `release:check` passed 3,631 tests plus build, audit and
compiled smokes. The actual worker image passed 42 container-focused tests.
After the archive fix, all 20 campaign tests, both TypeScript configurations
and targeted lint passed. No source changed during the measured campaign.

## Next work

Preserve these failures as development cases. Investigate source citation
assembly and task/answer obligation propagation without changing the frozen
scorer. The next retrieval increment remains a scoped host execution contract
and deterministic original-source citations before SQLite FTS5. Its value
must be tested against a newly measured agentic control; embeddings, reranking
and external providers remain conditional work.
