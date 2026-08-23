# The sentinel's blind spot, measured on a real run — 2026-08-23

Status: **measurement, not a design.** No rule was added. The
[cooling-off rule](../../AGENTS.md#safe-working-rules) says a new mechanical
gate is never designed during the session that surfaced the incident; this
file is the collection half of that contract.

## What happened

The fourth run of the `stopwatch-e2e-two` project (a tenant project run, in a
container, on the host subscription) asked for a dark-mode toggle on a page two
earlier runs had built. It FAILED, and the failure was clean and correct: the
`internal-validation-failed` result gate refused the L1's result because the
L1 itself reported its final `validate_html` call as failed.

What it cost, from `ATOMA_RUN_STATS`:

```
outcome failed · $1.1002 · 41 LLM calls (1 opus, 3 sonnet, 37 haiku)
escalations 3 · refusals 0 · learnedSkills 0
```

And from the trace (171 events, 56 tool calls):

```
validate_html 25 · write_file 10 · read_file 8 · start_static_server 7
list_files 4 · edit_file 2
14 tool failures, every one of them validate_html
```

Twenty-five browser validations, fourteen of them failing, three escalations,
and a dollar spent — on one page.

## What the sentinel said

Nothing. Zero `run.anomaly` rows, zero `security.flagged`.

That is not a wiring defect. The watch was armed in the viz server throughout
(lease held, heartbeat 20s), and the rules were replayed over the run's own
trace afterwards to be sure:

```
cost-alert disarmed -> 0 findings
cost-alert 0.50 USD -> 1 finding (cost-alert)
```

## Why — and this is the finding

**All four content rules key on IDENTITY.**

- `identical-tool-streak` needs byte-identical arguments, ≥4 in a row.
- `recurring-tool-error` needs the same error text ≥3 times for one tool.
- `slow-tool-outlier` needs one call 3× the median of that tool name.
- `injection-signature` needs a payload match.

This run repeated the *shape* and changed the *content* every time: a new smoke
script, a new assertion set, a new error string per attempt —

```
smoke check failed: class/style/color values were returned but the aggregate ok…
smoke check failed: {"ok":false,"checks":{"stoppedInitially":true,…
smoke rejected pre-flight: do not compare getComputedStyle output to a literal…
smoke check failed: {"ok":false,"checks":{"initialStateValid":true,…
```

So a model that keeps *varying* a failing attempt is invisible to every rule
that asks "is this the same as last time". The only rule that would have spoken
is the cost threshold, and it is disarmed by default because the product has no
per-run budget and naming one would invent a contract nothing enforces.

## What NOT to conclude

- Not "add a rule for repeated tool names". The obvious shape — *N calls to one
  tool in one run* — has no calibrated threshold: a legitimate build/validate
  loop is a repeated tool name too, and the 2026-08-14 review measured
  same-day gates as the main source of vocabulary-frozen detectors.
- Not "arm the cost threshold by default". A default budget is exactly the
  contract the product does not have, and $1.10 is not obviously wrong for a
  three-escalation run.
- The honest next step is a burn-in batch: several runs, healthy and broken,
  giving each candidate rule a false-positive rate before it decides anything.
  This run is one data point and it belongs in that pile, not in a new `if`.

## What it also proved, on the way

- Skill learning inside a tenant project WORKS. Run 3 distilled
  `build-interactive-html-widget` into `<projectRoot>/skills/<atom-id>/`, and
  run 4 matched it twice at plan time ("exact structural match to Water's
  single-file web builder + local-serve + headless validation loop"). The
  injection is real; it did not save this run.
- The result gate did its job. A failed browser validation reached
  `internal-validation-failed` and the run failed instead of delivering a page
  that does not work. The expensive part is upstream of the gate, not in it.
