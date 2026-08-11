# Round 8 — the cascade is closed, the predicate fires, and the zero-token path still contributes nothing

Run 2026-08-11, maintenance task, `PROMOTE=1` / `TRUST=3` — same scale and
thresholds as rounds 6 and 7, so all three compare directly.
[Registered before the run](PROTOCOL.md#round-8--pre-registration-2026-08-11-written-before-any-round-8-run),
and measured by [`measure-round8.mjs`](measure-round8.mjs), which was written
before the data existed and validated by reproducing round 7's four published
numbers.

## Verdict: H8 supported on all four conditions

| condition | target | round 7 | **round 8** |
|---|---|---|---|
| 1. already-satisfied rejections | 0 | 5, in 2 runs | **0** |
| 2. no cascade run | none > $0.90 | $1.09 and $1.38 | **max $0.5879** |
| 3. predicate fires / gate fallbacks | ≥ 3 / ≤ 1 | 0 / 5 | **14 / 0** |
| 4. deliverables correct | ≥ 5 of 6 | 6 of 6 | **6 of 6** |

Validator rejections of **every** kind went from 10 to **zero**, and with them
the three atom branches and two fallbacks that made round 7 expensive.

## The predicate: 14 refusals, every one of them right

The compiled `reverify-recorded-probes-after-edit` writes only
`.atoma-probes.json`. It was offered 14 times for subtasks asking to change
`wclite.js` and/or `README.md`, and refused every time:

| subtask names | refusals |
|---|---|
| `README.md` | 4 |
| `wclite.js`, `README.md`, `.atoma-probes.json` | 4 |
| `wclite.js`, `README.md` | 3 |
| `README.md`, `.atoma-probes.json` (± `wclite.js`) | 2 |
| `wclite.js` | 1 |

These are exactly the five-per-round gate fallbacks of rounds 6 and 7, now
prevented at match time instead of after a wasted dispatch. Gate fallbacks
fell to zero because there was nothing left for the gate to catch.

## What did NOT happen: zero dispatches

Round 7 had one. Round 8 has none, and the reason is not the predicate
misfiring — all 14 refusals are correct. The compiled script reached `3✓/0✗`
only at the end of the round, and while trusted it never met a pure
re-verification subtask. So the zero-token path contributed **nothing for the
fourth consecutive round**, and the simulation's prediction of break-even
(1 → 1) did not hold at n=6.

That is now the honest standing position on compilation: across rounds 5-8 it
fired 10 times in one round with broken deliverables, then 1, 1 and 0 with
correct ones. Every fix has been real and each has made the mechanism more
correct; none has made it pay.

## Economics, reported and not registered

atoma mean **$0.3132** (n=6), against $0.5854 in round 7 and $0.2825 in round
6. Within-round trend $0.3733 → $0.2532. Held-out task **$0.2667 with zero new
recipes learned** — generalisation reproduced for the sixth consecutive round.

**The control arm is n=1, and the reason is an infrastructure fault rather
than anything about the arm.** Its second run lost its LLM connection: the
last-resort watchdog fired at 960 s with *"the transport is wedged (dropped
connection?)"*, which is the mechanism built for exactly this and it worked.
The run was NOT slow and did NOT fail at the task — the log shows the edit
applied, all five documented invocations re-recorded through `record_probe`,
and the README rewritten, and its workspace scores 7/7. Only the accounting
was lost.

Why it was lost completely is a property of the control arm's SHAPE, worth
recording because it will recur: the baseline is ONE long-lived LLM call
wrapping the whole run, and usage is booked when a call returns. The partial
trace shows **1 call started, 0 completed, 20 tool events** — so a single
dropped connection takes the entire run's cost with it. An atoma run of the
same task makes 11-24 shorter calls, each booked on return, so the same fault
would cost one call's worth of accounting. That is a measurement asymmetry,
not a merit: the frontier agent's deliverable was complete and correct.

A ratio against a single control observation ($0.8197, giving 2.62×) is not
worth defending either way, which is precisely why cost was excluded from the
registered conditions in advance.

## Correctness, and a reproducibility gap closed

**9 of 9 deliverables at full marks**, both arms, on
[`verify-maint.mjs`](verify-maint.mjs) — which executes the CLI rather than
reading claims about it.

**Re-scored under a TIGHTER instrument after the fact, and the result held.**
An adversarial reviewer pointed out the scorer never opened
`.atoma-probes.json`, which the goal text explicitly names — so manifest
destruction, a whitewashed regression or a stale merge all scored full marks.
Three clauses were added (parses, entries preserved, every recorded entry still
replays byte-identically) and all nine deliverables score **10 of 10**. The
clauses discriminate: sabotaging a copy's manifest stdout drops it to 9/10,
deleting entries to 8/10.

That scorer is new, and it should have existed three rounds ago: rounds 5, 6
and 7 each reported a correctness figure from a scorer that was never
committed, so none of those numbers is reproducible from the repo. It is the
same hole that made an earlier benchmark worthless when `runs/` turned out to
be gitignored.

The workspace-to-run mapping was VERIFIED rather than assumed, because an
off-by-one anchor once produced a false 83.3%: `build.prev114` carries the
held-out task's semantics (`--chars` 36, "not a regular file"), which makes it
the pre-round-8 leftover and fixes the anchor. Runs 1-8 map to
`build.prev115`-`prev122`, run 9 to `build/`.

## The defect this round found in its own fix

`QUOTED SPAN` appeared 6 times as FOUND and **4 times as NOT FOUND — and all
four were false positives**:

- twice on `OLD: const chars = text.length;`, a diff's removed side, which is
  absent from the file *because the edit succeeded*;
- twice on `== GROUND TRUTH ==`, the evidence block's own header, which passes
  the code-shape test because it contains `=`.

None caused a wrong rejection — a contradiction forces a full LLM verdict, and
the validator approved all four — so the cost was four validator calls the
trust fast-path would otherwise have skipped. But the signal's stated design is
that it never fabricates a contradiction, and it fabricated four in nine runs.
Both classes are now excluded (`DIFF_OLD_SIDE_RE`, `SECTION_HEADER_RE`), with
regression tests verified to fail without the guards.

## Threats to validity

- Six atoma runs, one task, one compiled script, one L1.
- The control arm is a single usable observation, lost to a dropped
  connection rather than to anything the run did.
- Condition 1 going 5 → 0 is consistent with the fix, but a round whose plans
  happened not to duplicate the edit phase would also show 0. The mechanism is
  visible in the traces (6 QUOTED SPAN FOUND lines), which is why that
  observation was registered in advance; it is corroboration, not proof.
- `measure-round8.mjs` reads predicate refusals from per-run logs, whose
  filenames are keyed on the task id — a later round on the same task
  overwrites them. Measure before re-running.
