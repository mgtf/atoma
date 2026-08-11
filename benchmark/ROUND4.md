# Round 4 — the zero-token path targets a phase this task shape never produces

Run 2026-08-11, hypothesis
[registered before the first run](PROTOCOL.md#round-4--pre-registration-2026-08-11-written-before-any-round-4-run).
12 runs from an empty registry and empty skill store, thresholds lowered to 2/2
(a deliberate, pre-registered deviation). Data:
[`results-round4.csv`](results-round4.csv).

## Verdict: H4 refuted — and the machinery is no longer what fails

| | round 2 | round 3 | round 4 |
|---|---|---|---|
| Compilations | 1 | 2 | 1 |
| Successful dispatches | 1 | 0 | **0** |
| Dispatch contract failures | 3 | 2 | **0** |
| Demotions | 1 | 1 | **0** |

**Zero contract failures, zero demotions.** The fixes did what they were built
for. The compiled script was simply **never called**: 0 matches across 9 runs.

Everything upstream worked, for the first time:

- the compiler **refused** both irreducible recipes (build, and README prose)
  with well-argued reasons — the same class it wrongly accepted in rounds 2
  and 3, and whose acceptance caused both demotions;
- it **compiled the right one**: `recheck-documented-cli-invocations`, a pure
  verifier, the genuinely mechanical half;
- `record_probe` produced clean manifests with no `bash -c` wrappers.

## The actual cause, re-derived from the traces

The protocol registered that a third consecutive refutation should stop the
patching and go back to the traces. Reading what the plans actually emit:

| plan | phase 1 | phase 2 | phase 3 |
|---|---|---|---|
| A | write the CLI | *"**Exercise** the CLI … and **record** each"* | write the README |
| B | write the CLI | harden the error paths | write the README |
| C | create the skeleton | extend the interface | write the README |

One plan of three contains a verification-shaped phase at all, and even that
one asks to **exercise and record** — to *produce* the manifest. The compiled
verifier advertises for *"re-verify that … previously recorded invocations
**still** produce the same exit codes"* — a **re-check**.

**The task decomposes into build → record → document. It never decomposes into
re-verify.** And it should not: a re-check only means something if the artefact
changed *after* the recording. That is maintenance work. A from-scratch build
does not contain it.

So the zero-token path aims at a phase shape this family does not produce, by
construction. The three fixes across rounds 2-4 — `when_to_use` phrasing,
manifest truncation, the command-line API — each repaired a real broken link,
and none of them was this one. They were necessary; they were not sufficient,
and no fourth patch of the same kind would help.

## Economics: four rounds, one stable number

| | control arm | atoma | ratio |
|---|---|---|---|
| round 1 | $0.8198 (n=5) | $0.5314 | 1.54× |
| round 2 | $1.0140 (n=3) | $0.5358 | 1.89× |
| round 3 | $1.6847 (n=3) | $0.5061 | 3.33× |
| round 4 | $1.0976 (n=2) | **$0.4678** | 2.35× |

The frontier control arm is **volatile**, not drifting: $0.82 → $1.01 → $1.68 →
$1.10. atoma sits at $0.531 / $0.536 / $0.506 / $0.468 across four independent
empty-store starts. atoma exposes **one frontier call in about fifteen**; a
single-agent baseline is exposed end to end, so frontier variance passes
straight through it and is damped in atoma.

That is the most reproducible result of the whole exercise, and it was never
the hypothesis — it fell out of a confounder the protocol registered in
advance. Round 4's ratio rests on n=2 with a 1.64× internal spread and is
indicative only; the pattern across four rounds is not.

**Generalisation reproduced a fourth time**: $0.3961 / $0.4007 / $0.3518 /
$0.5480 on a never-seen task, zero new recipes learned every time.

## What follows, and it is a choice rather than a patch

1. **Test the family where dispatch would mean something.** A maintenance task
   — "this CLI changed, check the documented invocations still hold" — produces
   exactly the re-verification phase the compiled script advertises for. That
   would test the zero-token path where it can actually fire, instead of
   measuring its absence for a fifth time.
2. **Or accept the scope and say so.** If atoma's use is from-scratch builds,
   the compiled-script path serves them rarely, and the README should say the
   saving comes from tiering and earned trust — which four rounds support —
   rather than from compilation, which none of them demonstrated.

Deferred deliberately: the deviation to 2/2 thresholds shortened the round as
intended (first compilation at run 5 rather than 8) and cost nothing visible,
but it also means round 4's run-index timings do not compare with rounds 1-3.

## Threats to validity

- Control arm n=2 with a 1.64× internal spread — the weakest drift check of the
  four rounds, as registered in advance.
- Lowered thresholds mean less evidence before trusting; the demotion rule was
  unchanged.
- One task family throughout. The conclusion above is *about* that family's
  decomposition, so it is a statement about scope, not a defect.
- Nine atoma runs. A dispatch could still have occurred later.
