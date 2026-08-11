<div align="center">

# ⚛️ atoma

### An AI agent platform whose cost per task goes **down** with use.

*Most agent systems run every task on the most expensive model, forever. atoma spends
expensive reasoning once, then progressively compiles the repeatable parts of the work
into steps that run with no model call at all.*

![tests](https://img.shields.io/badge/tests-1104_passing-brightgreen)
![typescript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![benchmark](https://img.shields.io/badge/vs_frontier_direct-1.5–3.3×_over_4_rounds-success)
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

Creative work stays on the expensive path; mechanical work stops costing money. **This pays off
on maintenance work and barely at all on from-scratch builds** — five controlled rounds pinned
that down, and the reason is that a build never produces the re-verification phase a compiled
script serves. On the tasks where it applies it cut cost about 2×; on the ones where it does not,
mechanisms 1 and 2 carry the result alone.

## The controlled experiment

The same task, from an **empty registry and empty skill store**, given to atoma
and to a single frontier agent — same sandbox, same tools, same budget, same token
accounting, [registered before each run](benchmark/PROTOCOL.md). Repeated four times.

![cost curve](docs/benchmark-cost-curve.svg)

| | frontier direct | atoma |
|---|---|---|
| Cost per run, round by round | $0.82 · $1.01 · $1.68 · $1.10 | **$0.53 · $0.54 · $0.51 · $0.47** |
| Ratio, each against its own same-day control | — | 1.54× · 1.89× · **3.33×** · 2.35× |
| Break-even on a repeated task | — | **run 2** |
| Deliverable correctness (executing scorer) | 19/19 | **19/19** |
| A *novel* task in the same family | $1.18 | **$0.35–0.55, zero new recipes needed** |
| A *maintenance* task, where compilation applies | $0.58 | **$0.28 — 2.05×, with deliverables verified correct** |

**The frontier baseline is volatile; atoma is not.** Its cost swung by 2× across
four rounds a week apart, while atoma's stayed inside $0.47–0.54. atoma exposes one
frontier call in about fifteen — a single-agent baseline is exposed end to end, so
frontier variance passes straight through it. That was never the hypothesis: it fell
out of a confounder the protocol registered in advance, and it is the most
reproducible result of the four.

**The compiled-script path works — on maintenance, not on from-scratch builds.** Across
four build rounds it fired **once in 52 runs**; the cause was the task shape, not the
machinery. A build decomposes into *build → record → document* and never produces the
*re-verification* phase a compiled verifier serves — that is maintenance work. Given a
maintenance task it fires from run 2 and holds, cutting cost about **2×** against a
same-day control. [Round 4](benchmark/ROUND4.md) diagnosed it,
[round 5](benchmark/ROUND5.md) demonstrated it, [round 6](benchmark/ROUND6.md) priced it
honestly.

**That last part is worth reading, because the first number was wrong.** Round 5
measured 4.7× — and an independent scorer, run outside both arms, found 7 of 9
deliverables shipping a README that contradicted the artefact it documented. The
compiled verifier had been handed an *"update README.md"* subtask, replayed its manifest,
reported success and written nothing; the guard meant to catch that only checked whether
named files *exist*, which is inert when every file was seeded. With the guard fixed,
correctness went to 5 of 6 and the ratio fell to **2.05×**. Half of the original headline
was work that had not happened.

## The longer-run picture

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
npm run typecheck && npm test     # 1104 tests, fully mocked — no API key needed

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

**Working research system, honestly labelled.** ~25,000 lines of strict TypeScript, 1104 tests,
seven runtime dependencies, Node 20+.

What exists: the full three-tier loop, the learning and compilation lifecycle, sandboxed
execution with opt-in container isolation and proxied egress, an append-only audit ledger with
integrity checking, a web console, and a measurement harness.

What does not: any notion of tenants, users or authentication, and no hosted service. This is a
private repository, shared deliberately rather than published. The target multi-tenant design is
written up in
[`docs/saas-architecture.md`](docs/saas-architecture.md) and explicitly marked as not built.

**[→ How it works: components, flows and diagrams](docs/how-it-works.md)**

---

<div align="center">
<sub>TypeScript · SQLite · Node 20+ · every number above regenerates with <code>npm run burnin</code></sub>
</div>
