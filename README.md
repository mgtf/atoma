<div align="center">

# ⚛️ atoma

### An AI agent platform whose cost per task goes **down** with use.

*Most agent systems run every task on the most expensive model, forever. atoma spends
expensive reasoning once, then progressively compiles the repeatable parts of the work
into steps that run with no model call at all.*

![tests](https://img.shields.io/badge/tests-1051_passing-brightgreen)
![typescript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![benchmark](https://img.shields.io/badge/vs_frontier_direct-−35%25_over_10_runs-success)
![breakeven](https://img.shields.io/badge/break--even-run_2-gold)
![providers](https://img.shields.io/badge/LLM_providers-Anthropic_·_Claude_subscription_·_Ollama_·_Z.ai-8A2BE2)

**[→ How it works, in detail](docs/how-it-works.md)**

</div>

---

## The problem this addresses

An AI agent that writes software costs money every time it thinks. Today that bill has an
uncomfortable shape:

- **It does not improve.** The thousandth invoice-parser looks exactly as expensive as the first.
  Nothing the system learned on task 999 makes task 1000 cheaper.
- **It is unpredictable.** Identical runs of the same task on a frontier model differed by 1.5×
  across five measurements here, and by 2.5× on a second task — depending on how long the model
  chooses to think. That is hard to put in a client proposal.
- **It cannot prove its work.** The agent that did the job is usually also the one that certifies
  it. For anything billable, self-certification is not evidence.

For a consultancy or a product team, this makes agent automation a variable cost that scales
linearly with delivery — the opposite of the software economics that justified building it.

## The approach

Three mechanisms, each ordinary on its own. The compounding is the point.

**1. The cheapest model that can answer, answers.**
Work is split across three tiers: an expensive model decomposes the goal into phases, a
mid-tier model routes each phase, and a cheap model does the actual file-writing and
command-running. This is structural, not a guideline — only the bottom tier is even given
tools. A yes/no check never runs on a reasoning model.

**2. Components earn trust, and can lose it.**
Every reusable component carries a success/failure record. Once one has a clean track record,
the system stops paying a model to review its output. One failure revokes that status
automatically. Nothing is permanently trusted.

**3. What proves repeatable gets compiled away.**
When the system solves a novel task, it writes down the pattern as a reusable recipe. A recipe
that keeps working is compiled into a deterministic script that then runs with **zero model
calls**. The compiler *refuses* patterns that need judgment, and records why — verbatim, from a
run in the benchmark below:

> *"designing a hand-written state-machine parser and type-inference/stats engine tailored to
> whatever edge cases a given spec names … is an irreducible per-task design/reasoning act that
> cannot be replaced by a fixed deterministic script without hardcoding one particular grammar."*

Creative work stays on the expensive path; mechanical work stops costing money. **This third
mechanism is also the least proven of the three** — in the controlled experiment below it never
engaged, for a reason the experiment diagnosed. Mechanisms 1 and 2 carried the measured result
on their own.

## The controlled experiment

The same task, given to atoma ten times and to a single frontier agent five times — same
sandbox, same nine tools, same budget, same token accounting. atoma started from an **empty
registry and empty skill store**, as after `git clone`. The hypothesis, the metric and the
falsification conditions were [registered before the first run](benchmark/PROTOCOL.md).

![cost curve](docs/benchmark-cost-curve.svg)

| Same task, repeated | frontier direct | atoma |
|---|---|---|
| Cost per run | $0.8198 | **$0.4945** once warm — 1.66× cheaper |
| Cumulative over 10 runs | $8.1982 | **$5.3138 — −35.2%** |
| **Break-even** | — | **run 2** |
| Deliverable correctness | 10/10 × 5 | **10/10 × 10** |
| A *novel* task in the same family | $1.1810 | **$0.3961**, and **zero new recipes needed** |

The last row is the one that matters most: on a task it had never seen, atoma reused what it
had learned instead of learning again. That separates generalisation from memorisation.

**What produced the saving was earned trust and recipe reuse — not compilation.** Zero
deterministic phases fired in all nineteen runs. The reason turned out to be a one-line
defect worth more than the headline number: the compilable recipes described themselves by
what was on disk ("a probe manifest already exists"), and the matcher only ever sees the
task's wording — so they were picked twice in nineteen runs and ended one success short of
compiling. Diagnosed, fixed at the generator, and written up in
[the full result](benchmark/RESULT.md).

Honest limits, stated in the protocol before the data existed: one task family (atoma's best
case), n of 5 and 10, wall clock biased against atoma by a per-call subprocess tax on this
transport, and costs that are API-price equivalents rather than invoices.

## The longer-run picture

Beyond the controlled experiment, `burnin/results.csv` holds 156 runs across 8 task families,
regenerable with `npm run burnin`. **Claims that could not be reproduced from stored artefacts
have been removed from this README**, including an earlier head-to-head table whose baseline
runs no longer existed.

| | |
|---|---|
| Runs recorded | **156** across 8 task families |
| Delivered successfully | **150 — 96.2%** |
| Cost per delivered run | median **$0.33**, mean $0.37 |
| A "warm" run (a mature pattern where a compiled script fires) | median **$0.26 · 227s** — 45 such runs |
| Cheapest run recorded | **$0.126 · 132s** |
| Runs containing at least one zero-model-call phase | **45 of 156** |
| Expensive-model calls per run | **1** on the normal path (148 of 150 delivered runs) |
| Input tokens served from prompt cache, at 10% of list price | **90%** — median 0.8M tokens/run |
| Learned recipes in the catalogue | **24**, of which **5 compiled to deterministic scripts** |

### Three honest readings

**The batch average across those 156 runs does not fall, and that is expected.** It is not the
same measurement as the experiment above. Cost falls on a *repeated* task; the batch curve is
flat-to-rising because the task generator deliberately proposes harder, novel work each round.
Cost per unit of difficulty falls; cost per run does not, because the runs keep getting harder
on purpose. Read the controlled experiment for the amortisation claim and this corpus for
breadth — not the other way round.

**The zero-cost mechanism applies to *phases*, and it is not what makes atoma cheaper.** No
complete run has ever cost $0.00, and none can today: every run still pays for one top-level
planning call. Across the corpus, 45 of 156 runs contain at least one phase that executed with
no model call at all — but in the controlled experiment above, *none* did, and atoma was still
35% cheaper. The saving came from earned trust and recipe reuse.

**Failure handling improved measurably.** The rate at which runs need corrective intervention
fell from roughly half of the early runs to one in the last thirty. That is a learning curve
being paid down.

## What it builds today

Verified across 156 runs: **single-page web applications**, **zero-dependency HTTP JSON APIs**,
**command-line tools**, and **technical documentation** — each delivered into an isolated
workspace with a machine-readable record of every command that was run to verify it.

It is a **framework for building such systems**, not a finished product. There is no hosted
service, no user accounts, no multi-tenancy — see [Status](#status) below.

## Why a technical buyer should look closer

- **Every claim is auditable.** Each run leaves a full JSON trace: every model call with its
  prompt, response and token count, every file written, every trust decision. A built-in web
  console replays any run end to end.
- **Verification does not trust the worker.** Before accepting a result, the supervisor re-reads
  the files from disk, loads the page in a real browser, or re-runs the recorded commands. This
  costs no tokens, and it runs *even on the most-trusted path* — on the principle that the
  component nobody watches any more is exactly the one that needs watching.
- **The engineering record is unusually explicit.** `CLAUDE.md` documents not only what the
  system does but which observed failure motivated each mechanism, and a "considered and
  rejected" section records optimisations that were designed, measured, and refused. Reversals
  are recorded rather than quietly deleted.
- **Vendor-flexible.** The same code runs against the Anthropic API, a Claude subscription, local
  models via Ollama, or Z.ai — and can mix vendors per tier, e.g. a cheap third-party model for
  the execution tier while planning stays on a frontier model.

## Evaluate it in ten minutes

```bash
npm install
npm run typecheck && npm test     # 1051 tests, fully mocked — no API key needed

# one real task, pick your auth:
ANTHROPIC_API_KEY=... npm run run:build "a Node CLI that converts CSV to JSON"
ATOMA_LLM=claude-cli  npm run run:build "…"    # Claude subscription, no API key

npm run viz                       # replay that run: every call, every cost, every decision
npm run skills -- list            # what it learned, and what it refused to compile
npm run burnin                    # regenerate the economics table above
```

A fresh clone starts with **no learned state at all** — the catalogue, the recipes and the
traces are runtime data, deliberately not committed. What you clone is the framework; the
experience is earned on your own machine, which is what makes the cost curve verifiable rather
than asserted.

## Status

**Working research system, honestly labelled.** ~25,000 lines of strict TypeScript, 1051 tests,
seven runtime dependencies, Node 20+.

What exists: the full three-tier loop, the learning and compilation lifecycle, sandboxed
execution with opt-in container isolation and proxied egress, an append-only audit ledger with
integrity checking, a web console, and a measurement harness.

What does not: any notion of tenants, users or authentication; a hosted service; a published
license (the repository currently carries none — treat it as all-rights-reserved until one is
added). The target multi-tenant design is written up in
[`docs/saas-architecture.md`](docs/saas-architecture.md) and explicitly marked as not built.

**[→ How it works: components, flows and diagrams](docs/how-it-works.md)**

---

<div align="center">
<sub>TypeScript · SQLite · Node 20+ · every number above regenerates with <code>npm run burnin</code></sub>
</div>
