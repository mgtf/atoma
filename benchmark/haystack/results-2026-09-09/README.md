# First Haystack component screen

Registered and executed on 2026-09-09, source commit
`d76859e` (`26e8714` introduces the experiment). Raw registration and all 39
query responses are archived beside this report. No rerun or query tuning was
performed. The framework/model boundary was first smoke-tested on a separate
two-document fixture; this screen uses the existing locked development set.

## Observed result

All arms searched the same 4 documents (2,171 bytes), split into 11 passages,
with five returned passages at most. Of 13 questions, 11 have expected facts
and 2 are intentionally unanswerable.

- **FTS5:** complete golden evidence for 8/11 answerable questions; 11/16 facts.
  Median query wall time 0.45 ms; cold preparation 1.54 ms.
- **Haystack BM25:** complete golden evidence for 8/11; 12/16 facts.
  Median query wall time 0.58 ms; cold preparation 667 ms.
- **Haystack hybrid + reranking:** complete golden evidence for 9/11; 13/16 facts.
  Median query wall time 131 ms; cold preparation 2,674 ms.

All 39 calls succeeded; no invalid source excerpt was returned. Every arm
returned passages for both unanswerable questions. This measures search
behavior, not hallucination or correct abstention by an answer model.

The hybrid arm adds the evidence for `northstar-05` (French question about the first-payment refund window),
which the lexical arms miss in their first five passages. Both Haystack arms
also recover one of the two facts for `northstar-10`. `northstar-06` remains
uncovered in all three arms; `northstar-10` remains only partially covered.
There is no fully covered question lost relative to FTS5 in this sample.

The pre-registered screen returns **candidate-for-agent-evaluation**. This is
one additional completely covered question on a tiny, previously used
synthetic development corpus. There is no confidence estimate, held-out
result, capacity result or state-of-the-art quality claim. The compact English
reference weights were not selected through a model competition. Timings are
one local pass, with fixed arm order and normal OS caches; no latency ratio is
presented as a scaling prediction.

## What this does and does not decide

Keep the Haystack host library binding available experimentally and evaluate
it in a later registered shared-runner comparison against agentic search.
Neither coordinator activation nor the default search policy changes here.
No provider quota, paid model API, answer generation or agent execution was
used. CPU/RAM are still real deployment costs; only wall time was measured.

This cannot be compared to the prior BM25 agent pilot's 0/2 task success:
that pilot measured delivered answers/artifacts, while this screen measures
whether golden evidence appears in returned passages. Haystack has not yet
shown that it fixes Atoma's downstream citation assembly or task completion.

## Replay and validation

From the repository root, after building the compiled modules:

```bash
node benchmark/haystack/evaluate.mjs replay benchmark/haystack/results-2026-09-09
(cd benchmark/haystack/results-2026-09-09 && shasum -a 256 -c SHA256SUMS)
```

Replay reads the recorded host responses and executes the unchanged golden
scorer; it needs neither Python nor model weights. `report.json` also records
start/end times. `registration.json` pins source/compiled hashes, package
versions, model content digests and instruments; `models.json` records the
upstream model revisions. Weight files are not included. A fresh measurement
uses a new output directory and the register/run commands in the parent README.

Final implementation verification: `npm run release:check` completed with
3,818 passing tests and 13 environment-dependent skips, no npm audit findings,
and compiled MCP/auth/retrieval smokes. Both real Haystack runtime tests ran
with the optional Python/model environment set. The first full check attempted
inside the filesystem/network sandbox was stopped after local-server test
failures; the successful verification ran with host loopback permissions.
