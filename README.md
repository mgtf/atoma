<div align="center">

# ⚛️ atoma

### An AI agent platform whose cost per task goes **down** with use.

*Most agent systems run every task on the most expensive model, forever. atoma spends
expensive reasoning once, then progressively compiles the repeatable parts of the work
into steps that run with no model call at all.*

![tests](https://img.shields.io/badge/tests-1030_passing-brightgreen)
![typescript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![runs](https://img.shields.io/badge/measured_runs-156-blue)
![delivery](https://img.shields.io/badge/delivery_rate-96%25-success)
![providers](https://img.shields.io/badge/LLM_providers-Anthropic_·_Claude_subscription_·_Ollama_·_Z.ai-8A2BE2)

**[→ How it works, in detail](docs/how-it-works.md)**

</div>

---

## The problem this addresses

An AI agent that writes software costs money every time it thinks. Today that bill has an
uncomfortable shape:

- **It does not improve.** The thousandth invoice-parser looks exactly as expensive as the first.
  Nothing the system learned on task 999 makes task 1000 cheaper.
- **It is unpredictable.** The same task, run twice on a frontier model, can differ 3–5× in cost
  depending on how long the model chooses to think. That is hard to put in a client proposal.
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
that keeps working gets compiled into a deterministic script — and from then on that step of
the work runs with **zero model calls**. Crucially, the compiler *refuses* patterns that need
judgment, and records why:

> *"…designing bespoke CLI business logic from a free-form natural-language spec is an
> irreducible LLM reasoning step, not a deterministic recipe."*
> — verbatim refusal from a live run, persisted to disk

Creative work stays on the expensive path. Mechanical work stops costing money. The system
knows the difference and writes down its reasoning.

## What the numbers actually say

Every figure below is recomputed from `burnin/results.csv` — 156 real runs of real deliverables,
regenerable with `npm run burnin`. **Claims that could not be reproduced from stored artefacts
have been removed from this README**, including a head-to-head benchmark whose baseline runs no
longer exist.

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

**The zero-cost mechanism is real, but it applies to *phases*, not whole runs.** No complete run
has ever cost $0.00, and none can today: every run still pays for one top-level planning call.
What genuinely reaches zero is the verification and packaging work — 45 runs contain at least
one phase that executed with no model call at all.

**The batch average does not fall over time, and that is expected.** Runs get cheaper on a
*fixed* task as the system matures — re-running six identical HTTP tasks after compilation cut
their average 27%. But the overall curve is flat-to-rising, because the task generator
deliberately proposes harder, novel work each round. Cost per unit of *difficulty* falls; cost
per *run* does not, because the runs keep getting harder on purpose.

**Failure handling improved measurably; raw cost did not.** The rate at which runs need
corrective intervention fell from roughly half of early runs to one in the last thirty. That is
a learning curve being paid down, and it is the clearest evidence the loop works.

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
npm run typecheck && npm test     # 1030 tests, fully mocked — no API key needed

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

**Working research system, honestly labelled.** ~25,000 lines of strict TypeScript, 1030 tests,
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
