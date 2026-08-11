# Round 6 — the gate buys correctness with most of the saving, and points upstream

Run 2026-08-11, maintenance task, hypothesis
[registered before the first run](PROTOCOL.md#round-6--pre-registration-2026-08-11-written-before-any-round-6-run).
9 runs from an empty store, **`PROMOTE=1` with `TRUST=3` restored** — round 5
moved both knobs together and could not say which caused what.

## Verdict: two parts met, the third only by the letter

| | round 5 (1/1) | round 6 (1/3) |
|---|---|---|
| Zero-token dispatches | **10** | **1** |
| Gate fallbacks | 0 | **5** |
| Demotions | 0 | 0 |
| Cost per run | $0.1981 | $0.2825 |
| Ratio vs same-day control | 4.69× | **2.05×** |
| Deliverables correct | **2 of 9** | **5 of 6** |

1. **The gate fix works.** Correctness went from 2 of 9 to 5 of 6.
2. **`promote=1` survives with validators on.** Compiled at run 1, armed at
   run 3, no demotion, no contract failure.
3. **Dispatch stayed above zero — barely.** 10 → 1, with five gate fallbacks.
   The registered wording was *"if correctness returns only because every
   dispatch now falls back, the gate is too strict and that is a refutation of
   the fix, not a success"*. One dispatch is not zero, so this is not a
   refutation; it is close enough that calling it a success would be dishonest.

**So round 5's 4.69× was inflated by work that did not happen.** The honest
figure on this family, with correct deliverables, is about **2×**. That is the
main correction this round delivers, and it only exists because an independent
scorer was run outside both arms.

## Where the real defect is: matching, not the gate

The gate fired five times. What it caught:

| subtask naming | times |
|---|---|
| `README.md` | 3 |
| `wclite.js` | 1 |

A read-only verifier was matched to three documentation subtasks and, once, to
the **code-edit** subtask. And its `when_to_use` is not the problem this time —
it reads:

> *"Task asks to confirm a CLI still behaves as previously recorded, or to
> verify which specific invocations' outputs changed after an edit"*

That is a correct verification clause. The mechanism is a documented trade-off
turning into a defect: `SKILL_PREFILTER_SYSTEM_PROMPT` deliberately DROPS the
"no force-matching a single candidate" rule that the atom prefilter carries,
because *"a young skill library usually has exactly ONE recipe, and it exists
precisely because a task like this one succeeded before"*. With one compiled
script in the catalogue, that permissiveness routes every subtask to it —
including the ones that must write files.

**The gate is therefore catching downstream what should be prevented
upstream.** Each catch costs a wasted dispatch (two tool calls and a scratch
write) before falling back.

## The fix this points to, not yet built

A `kind: script` recipe whose body never writes should not be *matched* to a
subtask that asks for a file to change. Both halves are already available:
`subtaskMutatesFiles` (added for the gate) and a static read of the script body.
Refusing the match is strictly cheaper than refusing the dispatch, and more
precise — it leaves the verifier free for the verification subtasks it is
actually for, which is where the 10 dispatches of round 5 came from.

Deliberately not built in this round: it changes MATCH behaviour, whose blast
radius is wider than a post-dispatch gate, and round 6 is one round of
evidence. The counter-argument to weigh first is the one the permissive prompt
was written for — a single-recipe catalogue that never matches anything learns
nothing.

## What is still not right

One of six deliverables still shipped a stale README, so the gate does not
close the class on its own. The fallback path did the documentation work in
five cases and not in the sixth; why is unexamined.

## Threats to validity

- Six atoma runs, one compiled recipe, one task.
- Control arm n=2 ($0.6548, $0.5010), 18% below round 5's — within this
  model's observed swing, so the cross-round cost comparison here is usable but
  not strong.
- The correctness scorer is bespoke to this task; it checks the nine things the
  goal actually asked for, which is more than the pipeline's own validators saw
  at these thresholds, but it is not a general oracle.
