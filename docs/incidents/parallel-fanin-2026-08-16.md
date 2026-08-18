# Fan-out + join: the first live parallel lanes — 2026-08-16

> Evidence, not normative guidance. The active rules live in
> [`../../AGENTS.md`](../../AGENTS.md); this file records what three live runs
> measured and why `L3Atom`'s decomposition prompt now says "one phase per
> orthogonal GROUP, not one phase per artefact".

## What was tested

A build-family task shape the repo had never exercised: **two or more parts
that can be built independently, followed by one or more parts that consume
their results**. The point was to find out whether atoma DECIDES the
parallelism itself — the goals never say "in parallel", never name a tool, and
never name a phase.

Six tasks landed in [`burnin/tasks-fanin.json`](../../burnin/tasks-fanin.json),
in two families:

- `fanin` — two modules with exact contracts (`lib/parse.mjs` +
  `lib/render.mjs`, …) that do not import each other, then an entry point that
  imports both. The parts are orthogonal but belong to one coherent project.
- `fanin-orth` — three deliverables sharing no directory, no fixture and no
  import, then an aggregator that consumes all three.

## Baseline

Across the 244 traces retained in `runs/` before this session:

| shape | occurrences |
|---|---|
| L3 `sequential` (n=1..3) | 34 |
| L2 `concat` **n=1** (degenerate fan-out) | 74 |
| lanes genuinely overlapping in wall time | **0** |

`Promise.all` dispatch was proven by `tests/fanout-parallelism.test.ts` under a
mocked LLM, but no live run had ever reached it.

## Results

Provider `claude-cli`; costs are estimated API-price equivalents, not
subscription billing. Measurements in
[`burnin/results-fanin.csv`](../../burnin/results-fanin.csv).

| task | shape produced | cost | duration |
|---|---|---|---|
| `fanin-logsum` | L3 seq×3 → L2 `concat` n=1 · no parallelism | $0.4335 | 314 s |
| `fanin-orth-catalog` | L3 seq×5 → L2 `concat` n=1 · no parallelism | $0.5421 | 629 s |
| `fanin-orth-digest` | L3 seq×3, **phase 1 = L2 `concat` n=3 with overlapping lanes**, then the join | $0.7503 | 774 s |

All three delivered a working artefact.

### The run that parallelised

`runs/2026-08-16T18-25-26-039-d1f176c9.json`:

1. L3 prefilter returned `escalate`, naming the target shape outright:
   *"parallel L1 spawns → sequential digest → README documentation"*.
2. The L3 (Opus) plan emitted `sequential` × 3 and put **all three generators
   into a single phase** — "Create the three independent generator scripts,
   each in its own subdirectory".
3. The L2 prefilter answered `decomposable: true` (*"Three generators are
   genuinely orthogonal … so can be parallelized"*), which is what disables the
   single-subtask short-circuit in `L2Atom.plan`.
4. The L2 (Sonnet) plan emitted `concat` over three orthogonal subtasks →
   `Promise.all` → three L1 lanes started at 57.6 / 59.0 / 59.2 s and ended at
   173.7 / 147.5 / 158.3 s. Their `write_file` calls interleave at 77.2 / 78.1
   / 84.9 s.
5. Phases 2 and 3 are the join: `digest.mjs` reads all three `out.json`, then
   the README.

No concurrency defect appeared. `.atoma-probes.json` ended up holding the
entries recorded by all three lanes plus the join: the merge in
`recordProbeTool` reads, merges and writes in one synchronous block, so
in-process lanes cannot interleave it. No file collision, no tool error.

### Why the other two did not

Both other plans identified the orthogonality correctly in their own reasoning
and then flattened it. `fanin-orth-catalog` emitted **one phase per tool**, so
each L2 received a single artefact and had nothing to fan out — `concat` n=1,
three times. `fanin-orth-digest`'s L3 said it plainly:

> "The three generators are genuinely independent … but the digest and README
> consume all three, so the whole thing must land in one shared workspace. Use
> PHASED/sequential: three parallel-in-spirit but workspace-sharing build
> phases would risk lane splits, so run them as sequential phases"

That is a correct reading of the contract it was given. `planSchema` carries a
**single `aggregation.mode` for the whole plan** (`src/atoms/json.ts`), and
`subtaskSpecSchema` has no dependency field, so "3 orthogonal + 1 that consumes
them" is not expressible at one tier. `sequential` is the only mode that is not
wrong. The parallelism is therefore only reachable FRACTALLY — one grouped L3
phase that an L2 splits — and whether a run gets it comes down to L3's phase
granularity.

Segment timings for the two `fanin-orth` runs, over the fan-out portion only:

- `catalog`, serialised: three build phases, **362.7 s**
- `digest`, grouped: one build phase, **145.5 s** (longest lane ≈ 116 s)

**This is not a controlled comparison** — two different tasks, and `catalog`'s
argv-handling CLIs are somewhat heavier than `digest`'s generators. It fixes an
order of magnitude, not a ratio. Note also that `digest` cost MORE in total
($0.75 vs $0.54): its README phase ran 379 s with one retry cycle (2 plan + 2
execute, $0.339), consuming the fan-out saving. Parallelism here buys wall
clock on one segment, not tokens.

## The change

`L3Atom`'s DECOMPOSITION DISCIPLINE block now states that one phase may — and
should — carry a whole orthogonal group, and that one phase per orthogonal
artefact forfeits the L2 fan-out. The same edit removed the ORTHOGONAL example
`"research topic A" + "research topic B" + "summarise both"`, which taught
exactly the structurally-broken plan the validator is written to reject: a
fan-in step inside a parallel plan, where the lanes cannot see each other's
results.

This is a prompt change to the tier-3 PLAN call, not to the persisted
`MERISTEM_SYSTEM_PROMPT` in `src/run/profiles/build.ts`, so no registry patch
and no trust reset is involved.

## After the change

Same two `fanin-orth` tasks, same provider, immediately after the edit:

| task | before | after |
|---|---|---|
| `fanin-orth-catalog` | seq×5, no fan-out, $0.5421, 629 s | **seq×3, grouped phase 1 → L2 `concat` n=3 with overlapping lanes**, $0.5196, 442 s |
| `fanin-orth-digest` | seq×3 grouped → fan-out n=3, $0.7503, 774 s | seq×3 grouped, L2 kept ONE lane, $0.2258, **timed out at 900 s** |

`catalog` is the case the change targeted, and it moved: its L3 reasoning now
repeats the rule back — *"Three utilities are fully orthogonal … so they go in
ONE phase the L2 can split into parallel lanes; catalog.mjs consumes all three
and must come after"* — and its three lanes ran at 51→224 / 52→268 / 53→165 s.
30% less wall clock, marginally cheaper.

`digest` shows the change is not sufficient on its own, and that fan-out is not
always the win. Its L3 grouped correctly, but the L2 prefilter answered
`decomposable: false` and one L1 wrote all three generators in a single tool
loop — 103 s for the phase against 145 s for the fanned-out version of the same
work, at a third of the whole-run cost (12 calls vs 23). A learned skill,
`sibling-modules-with-checks` — distilled from the first run of this session —
matched and was injected, which is what made the single loop competent. **Three
lanes cost three plan/validate cycles**; below some artefact size that overhead
dominates whatever the parallelism saves. Neither shape is universally right,
and nothing in the current contract lets a supervisor weigh them.

What the change does and does not buy is worth stating precisely, because a
later `catalog` run makes the loose reading untenable: grouped phase 1, L3
reasoning correct, and NO fan-out — 407 s, faster than the 442 s run that did
fan out. **The change makes the parallel shape REACHABLE; it does not decide
it.** Before it, a plan that spread orthogonal work across phases left the L2
nothing to split, so fan-out was impossible. After it, the L2's `decomposable`
call decides, run by run, and both answers deliver.

## No regression on coupled work

The four `fanin` tasks — two mutually independent modules plus an entry point
importing both — all delivered after the change, and **none of them was
parallelised**: `fanin-logsum` 181 s, `fanin-csvreport` 175 s, `fanin-mdtoc`
154 s, `fanin-taskapi` 248 s, every one L3 `sequential` × 3 with a grouped first
phase run by a single L2 lane. That is the correct outcome, not a miss. Two
small modules are not worth two plan/validate cycles, and the change only ever
claimed that a group SHOULD live in one phase — the L2 still decides whether
splitting it pays. Attribution caveat: `fanin-logsum` also moved 314 s → 181 s,
which is NOT this change — its plan was already grouped before. That gain is
the skill pipeline reusing `sibling-modules-with-checks`.

## The documentation phase, and a fix that made things worse first

`digest` failed on its README phase, and the cause is INDEPENDENT of the
grouping change — the same phase took 379 s in the pre-change run. Last-phase
share of total wall clock across the first five runs: 68 s (22%), 150 s (24%),
379 s (49%), 97 s (22%), 598 s (66%, killed).

The failing phase ran **one L1 execute call for 567 s**. Instead of replaying
`.atoma-probes.json`, it re-ran all three generators, re-ran `digest.mjs`,
staged the failure case by `mv gen/primes/out.json gen/primes/out.json.bak`,
restored it, re-read every source and every output, and only wrote README.md at
741 s — then kept verifying until the budget died. The L3 phase description had
invited exactly that: *"re-run each command to capture its actual output if
needed, and make sure all three out.json files still exist at the end"*. The
trust fast-path (33 successes / 0 failures) approved the plan without
validation, so nothing bounded the loop.

The first repair said two things: don't hand a documentation phase
re-verification duties or workspace invariants, AND *"error cases belong to the
phase that BUILT the artefact, where they are exercised and recorded once"*.
The first half worked — the documentation phase fell 598 s → 117 s. The second
half backfired: it RELOCATED the destructive experiment instead of removing it.
For a writer whose only error path is "cannot write its output", manufacturing
the failure means deleting its own output, so the build phase issued four `rm`
calls, every one correctly refused by the shell allowlist, then tried to
hand-edit `.atoma-probes.json` (also correctly refused). The build phase went
103 s → 506 s and the whole run cost $1.1331 — five times the cheapest version
of the same task.

Two things were wrong, one in the prompt and one in the task, and both were
ours:

- The relocation sentence is gone. What replaced it names the real cost driver
  rather than its location: *an error path that can only be evidenced by
  destroying state is not worth a phase of either kind — prefer the artefact's
  non-destructive failure inputs.*
- `fanin-orth-digest` itself specified error paths reachable only by deleting
  files ("exits 1 … when it cannot write its file", "naming the first missing
  out.json"). `digest.mjs` now takes a base directory as `argv[2]`, so its
  failure case is `node digest.mjs /nonexistent` — no state destroyed, the
  fan-out + join shape untouched.

The allowlist refusal was the SANDBOX BEHAVING CORRECTLY. Nothing about `rm`
was changed; the prompt and the task were what pushed a worker into the
boundary.

### `fanin-orth-digest` across the loop

| version | outcome | cost | total | build phase | doc phase | fan-out |
|---|---|---|---|---|---|---|
| baseline | delivered | $0.7503 | 774 s | 145 s | 379 s (49%) | n=3 parallel |
| + grouping | **timeout** | $0.2258 | 902 s | 103 s | 598 s (66%) | none |
| + doc rule (with relocation) | delivered | $1.1331 | 763 s | 506 s, 5 tool errors | 117 s (15%) | none |
| + relocation removed + task fixed | **delivered** | $0.4774 | **245 s** | 93 s | 65 s (27%) | **n=3 parallel** |

The final run is the target shape and the best measurement on this task: three
lanes at 54→120 / 54→117 / 54→121 s, then the join, then the README, no tool
errors. `node digest.mjs` prints the four expected lines and exits 0;
`node digest.mjs /nonexistent` exits 1 naming the file it could not read.

### How often does the L2 actually fan out?

The `catalog` reversal made this the question worth measuring, so the fixed
`fanin-orth-digest` goal was run three more times UNCHANGED, and read together
with the repaired run that preceded them — four runs, one identical input:

| run | fan-out | build phase | total | cost |
|---|---|---|---|---|
| repaired | yes, n=3 | 93 s | 245 s | $0.4774 |
| rep1 | yes, n=3 | 156 s | 312 s | $0.4235 |
| rep2 | **no** | 215 s | 370 s | $0.3656 |
| rep3 | yes, n=3 | 106 s | 277 s | $0.4580 |

All four delivered. **Three of four fanned out** — the majority behaviour, not
a coin flip, but not a guarantee either: the same goal, the same code and the
same provider produce either shape depending on one Haiku `decomposable` call.

The trade-off is consistent in direction across these four: fan-out buys wall
clock and spends tokens. Mean 278 s / $0.453 with three lanes against 370 s /
$0.366 with one. With n=1 in the single-lane arm, treat the magnitudes as
indicative only — what the repetitions establish is the SIGN of the trade and
the fact that both shapes are viable, not a ratio.

## Closed: one phase can outlive the whole run

Underneath the documentation incident sat a budget mismatch: the L1 tool
loop was bounded by ITERATIONS (40 when a validator is present,
`src/atoms/L1Atom.ts`), never by the run's remaining wall clock. At the ~26 s
per iteration this transport actually costs, 40 iterations is ~1040 s — more
than the 900 s the whole run had. One phase could legally consume the entire
budget. The per-call guard did not help: `DEFAULT_CLI_CALL_TIMEOUT_MS` is a
10-minute IDLE timeout, and a loop producing a tool call every 26 s never goes
idle.

**Closed 2026-08-18.** `RunContext.deadlineAt` is the run abort timestamp.
`capToolIterations` shrinks the 40/24 iteration cap against remaining wall
clock using this 26 s floor. The abort signal still stops the in-flight
call; the cap only stops a phase from *scheduling* more iterations than
the deadline can pay.

## Open: a hung transport costs the whole batch

Twice during this session `npm run burnin` aborted with *"the runner's process
group survived SIGKILL — spawnRun still unsettled"*. The message is misleading:
both times `ps` showed a clean machine seconds later. The actual condition is a
`spawnRun` promise that never settles — its `exit` handler returns early when
`waitForRunProcessGroupGone` times out, and nothing settles it afterwards even
though the group does die.

What wedged the second run was upstream of that: its trace holds **one
`llm-start` with no completion** — an L2 `plan` call issued at 22.3 s that never
returned, leaving the run silent for ~1058 s. That is the claude-cli hang
signature `src/viz/trace.ts` already documents. `DEFAULT_CLI_CALL_TIMEOUT_MS`
did not save it: 10 minutes is an IDLE timeout.

Two consequences worth separating from the provider flakiness itself:

- The batch aborts on the FIRST wedged task, so the remaining tasks never run.
- The wedged run's burn-in log is never written at all, because
  `writeFileSync(logPath, …)` lives inside `settle()`. The textual evidence is
  discarded exactly when it would be most useful; only the trace survives.

Workaround used here, no code changed: one burn-in invocation per task.

## Not done

Making the shape directly expressible — e.g. an optional `parallelGroup` on
`subtaskSpecSchema` so a `sequential` plan can mark consecutive subtasks as one
parallel group — was considered and deferred. It touches
`dispatchWithAggregation`, `planSchema`, the validator's FAN-OUT rules, the viz
lane model and their tests, and it should be designed once against more
evidence than three runs.
