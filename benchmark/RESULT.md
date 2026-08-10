# Cost-amortisation benchmark — result

Run 2026-08-10. Protocol and falsification conditions were fixed in
[`PROTOCOL.md`](PROTOCOL.md) **before** the first run. Every number below
recomputes from [`results.csv`](results.csv); every deliverable is scored by
[`verify-deliverable.mjs`](verify-deliverable.mjs) and recorded in
`scores.json`.

**Starting state: empty registry, empty skill store** — as after `git clone`.

![cost curve](../docs/benchmark-cost-curve.svg)

## Verdict

**H1 is supported. N\* = 2.** The cumulative cost of atoma runs drops below
the frontier baseline's at the second run, and stays below.

| Primary task — `csvstat` | frontier direct | atoma |
|---|---|---|
| Runs | 5 | 10 |
| Cost per run (mean) | **$0.8198** | **$0.5314** |
| …excluding the cold start | — | **$0.4945** — 1.66× cheaper |
| Cumulative over 10 runs | $8.1982 | **$5.3138** — **−35.2%** |
| Break-even | — | **run 2** |
| Trend, first half → second half | flat by construction | $0.6170 → $0.4458 (**−27.7%**) |
| LLM calls per run | 1 | 29 → 13 |
| Wall clock (mean) | 209s | 449s |
| Deliverable correctness | **10/10 × 5** | **10/10 × 10** |

Neither pre-registered falsification condition was met: a break-even exists
within N ≤ 10, and the series trends down.

## The memorisation control

A novel task in the same family (`logdigest` — log summarisation, not CSV
statistics), run on both arms after the primary series.

| Held-out task | frontier direct | atoma |
|---|---|---|
| Runs | 2 | 2 |
| Cost per run (mean) | $1.1810 | **$0.3961** — 2.98× cheaper |
| Recipes learned | — | **0** |
| Correctness | 8/8 × 2 | 8/8 × 2 |

`learned = 0` is the load-bearing number: atoma distilled **no new recipe** for
a task it had never seen, reusing what it learned on `csvstat`. The learning
generalised to the family rather than memorising the goal text.

**But the control arm's n=2 here spans $0.68 to $1.68 — a 2.5× spread.** The
held-out baseline mean is a weak estimate and the 2.98× ratio should be read as
indicative, not measured. atoma's own two runs ($0.35, $0.44) are consistent
with its primary-task steady state, which is the part of this comparison that
does not depend on the thin baseline.

## What actually produced the saving — and what did not

**Deterministic dispatch contributed nothing. `det = 0` on all 19 runs.**

The entire 35% came from two mechanisms:

1. **Earned trust.** Both atom types reached 9✓/0✗, above the trust threshold,
   so validator LLM calls stopped firing. This is most of the drop from 29
   calls to 13.
2. **Recipe reuse.** Learned recipes are injected into later runs at no
   additional cost, removing rediscovery.

The zero-token compiled-script path — the project's most striking claim — never
engaged, and the reason is a structural defect this benchmark surfaced:

| recipe | matches | successes | outcome |
|---|---|---|---|
| `harden-cli-errors-and-document` | 10 | 10 | **compile refused** |
| `build-parser-stats-cli-fixture` | 10 | 9 | **compile refused** |
| `replay-cli-probe-manifest` | 1 | 1 | frozen below threshold |
| `verify-cli-against-probes-manifest` | 1 | 1 | frozen below threshold |

Both refusals are correct and well-argued. Verbatim, from the second:

> *"designing a hand-written state-machine parser and type-inference/stats
> engine tailored to whatever edge cases a given spec names … is an
> irreducible per-task design/reasoning act that cannot be replaced by a fixed
> deterministic script without hardcoding one particular grammar."*

The defect is what happens next. `harden-cli-errors-and-document` is
**monolithic**: step 1 edits source code (irreducible), steps 2–5 are pure
mechanical verification (compilable). It wins the prefilter match on
verification phases and takes the credit, leaving the two genuinely compilable
recipes matched exactly once each — in the first run — and never again. They
are frozen two successes short of the threshold and will not advance, not in
ten runs and not in a hundred.

`CLAUDE.md`'s "verification split at learn time" exists to prevent exactly
this. The split *happened* — both pure-verification recipes were created — but
nothing stops the monolithic recipe from out-competing them at match time.

**This is the actionable finding of the benchmark**, and it is worth more than
the headline number: on this family the compilation path is blocked by recipe
competition, not by the compiler.

## Threats to validity, as registered

- **Wall clock is not a fair comparison on this transport.** Every LLM call
  spawns a subprocess costing 2–5s; atoma makes 13–14 calls per run against
  the baseline's 1. Part of the 449s vs 209s gap is that tax and would
  disappear on the direct API; part is real. This run cannot separate them.
- **Costs are API-price equivalents**, not invoices — the provider is a
  subscription. Both arms are priced by the same table, so the comparison
  holds; the absolute dollars do not.
- **One task family.** CLI-plus-documentation is where atoma's machinery is
  most developed — its best case, stated in advance. The web family, where the
  compiler refuses browser-validation recipes by design, cannot reach zero cost
  today and was out of scope.
- **Small n.** 5 and 10 runs. No significance test is claimed.
- **The instrument was corrected twice, both times in atoma's favour** — see
  the amendments in `PROTOCOL.md`. Both were verified false negatives
  (`stdev` with one `d`; `Elapsed Time` for a time span), and all seven
  control deliverables scored full marks before and after every revision, so
  no correction lifted the baseline or narrowed the gap by inflating a side.

## Reproducing

```bash
ATOMA_LLM=claude-cli npm run benchmark -- --dry-run   # protocol, spends nothing
ATOMA_LLM=claude-cli npm run benchmark                # ~2h, machine to itself
node benchmark/score-all.mjs                          # score every deliverable
node benchmark/plot.mjs                               # regenerate the chart
```

Artefacts: `results.csv` (19 rows), `scores.json`, `logs/` (full stdout per
run, gitignored), and a JSON trace per run under `runs/`.
