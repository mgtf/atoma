# Hybrid skills — one recipe, a mechanical half and a judgment half

**Status: REFUTED, 2026-08-11. Do not build it.** Written after round 8,
adversarially reviewed the same day, and the review killed it: two of three
independent lenses returned `do-not-build` and the third's headline is that
the design's central safety claim is false. The document is kept because the
measurements underneath it are worth having and because the way it failed is
the most useful thing in it. **§9 is the refutation; read it before §1-§8,
which are preserved as written and are wrong where §9 says so.**

## 1. The problem, measured

Across rounds 5-8 the zero-token dispatch path fired **10 / 1 / 1 / 0** times
on the primary task series (**11 / 1 / 1 / 0** including held-out rows).
Only the first round had substantial dispatch volume, and its deliverables
were wrong (2 of 9 correct). Every fix since has been real and each made the mechanism more
correct; none made it pay.

Round 8 says why, and it is not the mechanism. The catalogue split correctly —
`surgical-single-behavior-edit` (llm, 12✓) alongside a compiled
`reverify-recorded-probes-after-edit` (script, 3✓). The script was then
**offered 14 times to subtasks it could not serve** and refused every time,
because those subtasks name a file to change:

| subtask names | refusals |
|---|---|
| `README.md` | 4 |
| `wclite.js`, `README.md`, `.atoma-probes.json` | 4 |
| `wclite.js`, `README.md` | 3 |
| `README.md`, `.atoma-probes.json` (± `wclite.js`) | 2 |
| `wclite.js` | 1 |

**The bottleneck is MATCHING, not compilation.** A subtask like

> *"Using the verdicts from the previous phase, update README.md so that only
> the invocations whose behaviour legitimately changed are corrected"*

contains two jobs of different kinds: replay the recorded invocations and diff
them (mechanical, derivable from a manifest the run already read), then decide
which README lines legitimately changed and rewrite them (judgment). Today two
sibling recipes compete for ONE match, so one job or the other gets help,
never both.

**The prize.** In round 8, `record_probe` alone is **42% of all tool calls**
(120 of 288) and the mechanical half (`record_probe` + `run_shell`) is 42-60%
per run. Those probes arrive in **2-3 batches of 5-10** — `[10,10,6]`,
`[5,5,5]`, `[10,10,4]` — i.e. the same documented invocations replayed two or
three times in one run, one LLM round-trip per probe. The manifest is read
before the first probe in **all seven runs**, so these are REPLAYS, not the
irreducible act of choosing what counts as evidence.

## 2. The change in one sentence

Let one skill carry both halves, and have the harness run the mechanical half
**before** the L1 starts, injecting its output as facts — so the script stops
competing with the recipe for a match and becomes a tool the recipe uses.

## 3. Shape on disk

```
skills/<l1>/<id>/
    SKILL.md        kind: hybrid    — frontmatter + the JUDGMENT body (markdown)
    script.mjs                      — the MECHANICAL body (executable)
    _meta.json                      — counters, unchanged
```

A sidecar file rather than a second fenced section in `SKILL.md`, for the
reason `SKILL.md` is a file at all: it stays greppable, hand-editable, and
readable by `grep -r`. `.mjs` here is cosmetic — the file is never executed in
place. The EXECUTION name stays `_skill_<id>.mjs` via `scriptScratchFilename`,
where the extension IS load-bearing (the workspace's `package.json` is written
by the task, so a bare `.js` has semantics we do not control).

`kind: 'script'` is unchanged and stays: it is the case where the judgment
half is empty.

## 4. What happens at match time

The harness performs the mechanical half itself, in `matchSkill`, **before**
the supervise loop — the same two tool calls `runScriptSkillDirect` already
makes:

1. `write_file _skill_<id>.mjs` with the script body verbatim
2. `run_shell node _skill_<id>.mjs '<JSON subtask description>'`
3. delete the scratch file
4. inject `== MECHANICAL RESULTS ==` + stdout, then `== ACTIVE SKILL ==` + the
   judgment body
5. the supervise loop runs normally from there

**The harness, not the L1.** This is the load-bearing choice. If the L1 were
instructed to run the script (as the current untrusted path does), the
mechanical half would cost one LLM round-trip plus two tool calls, and the
gain over today would be marginal. Run by the harness it costs **zero LLM
calls**, and the L1 never sees the script body — a smaller prompt, and no
opportunity to paraphrase code that is supposed to be canonical.

**On script failure — non-zero exit, tool error, empty output — inject
nothing and continue.** The L1 then does the whole subtask as it does today.
Nothing is claimed, so nothing is at risk; the cost is two wasted tool calls.

## 5. What this REMOVES, and why each is safe to remove

Every guard below exists because a `runScriptSkillDirect` dispatch **returns
before the supervise loop**, so no validator ever sees its output. In a hybrid
the script never claims to have finished the subtask, and the normal validator
still judges the final result. So:

| guard | why it can go |
|---|---|
| strict envelope parse as the RESULT | stdout is context, not a deliverable; malformed output is merely less useful |
| deliverable gate (named files must exist) | the script does not claim to have produced them |
| before/after content snapshot | same — the L1 does the writing, and is validated for it |
| anti-redispatch memo | re-running yields the same facts, which is harmless; the L1 still adapts |
| trust gating before the script may run | the script never runs unwatched, so 3 clean runs buy nothing — **this is the change that makes it pay from run 1** |

**KEPT, deliberately:**

- `scanScriptBody` — this is executed code in the sandbox. Non-negotiable.
- The compile-refusal machinery and its generation stamps.
- A consecutive-failure counter, but with a different consequence: after N
  failures the script half is **disabled** (the skill degrades to pure llm)
  rather than the body being rewritten. A script that always fails still costs
  two tool calls per match, so it must be stoppable — but it is no longer a
  correctness risk, only a waste one.

## 6. Where the cut is made

`compileSkillToScript` today returns **a script OR a refusal**. It would
return **a script AND the remaining recipe**:

> Identify the steps that are MECHANICAL — fully derivable from the workspace
> and argv, with no judgment. Emit those as the script. Return the REMAINING
> steps as the new recipe body. If no step is mechanical, refuse. If EVERY
> step is mechanical, emit the script with an empty recipe (that is today's
> `kind: script`).

This is a change to an existing call, not a new subsystem, and the compiler
already demonstrates it can draw this line: its refusal reasons are persisted
(`promotionRefusedReason`) and name exactly what it judged irreducible — e.g.
*"designing bespoke CLI business logic from a free-form natural-language spec
is an irreducible LLM reasoning step"*.

**The hardest open question is here**, and it should not be waved past:
"compile the mechanical part only" is a harder ask than "compile or refuse". A
bad cut yields a script that does 10% while the recipe redoes it anyway. The
pre-registration below measures the cut's quality indirectly (tool calls per
run) rather than trusting it.

## 7. Pre-registration — the bar, fixed before building

This is the fifth attempt at this mechanism. Rounds 2, 3 and 4 each repaired a
genuinely broken link and none paid, so the discipline applies to this design
too: what would refute it is written down first.

**H9 — moving the mechanical half out of the LLM loop removes roughly half the
tool round-trips, on nearly every match instead of nearly none.**

1. **The script half fires in ≥ 5 of 6 runs.** Round 7's lesson is that a fix
   which cannot be observed is not a fix; round 8's predicate had to prove it
   fired at all. If this fails, the problem is STILL matching and no further
   patch of this kind is warranted.
2. **Tool calls per atoma run fall from ~40 to ≤ 28** (round 8: 32-57,
   mean 41).
3. **Correctness holds at ≥ 5 of 6** on `verify-maint.mjs`.

**Refuted if 1 or 3 fails.** Condition 2 failing while 1 passes means the cut
is bad, not the design — that is a compile-prompt problem and is fixable.

**Cost is not a condition.** The control arm has swung $0.82-$1.68 across
rounds and one mechanism moved round 7's mean by $0.325; a ratio on six runs
cannot separate this from that. Reported, not decided on.

**What this does NOT restore.** The claim "cost trends to zero with
experience" stays dead. This moves runs from "one free phase, almost never" to
"half the round-trips gone, almost always". Cheaper, not free — and the
outward-facing docs must say the one and not the other.

## 8. Risks

- **A new skill kind is real surface**: registry, CLI, viz, export, the
  shareability review, the static scan. Much is reusable, none is free.
- **The cut quality is unproven** (§6).
- **One task family, one L1, one compiled script** — the standing limitation
  of every round so far, and this design does not address it.
- **It could make matching worse, not better.** A hybrid is a bigger, vaguer
  target for the prefilter than two sharp siblings; if `when_to_use` blurs,
  match rate could fall. Condition 1 is the detector.


## 9. REFUTATION — what the adversarial review found

Three independent reviewers, each measuring against the archived round-8
traces rather than arguing. Verdicts: `do-not-build`, `do-not-build`,
`build-with-changes`. Six high-severity findings survive, and each one alone
is close to fatal.

### 9.1 The arithmetic is wrong by 4-5×, in the unit that matters

§1 asserts "one LLM round-trip per probe". **False.** The model emits probes as
PARALLEL `tool_use` blocks inside a single assistant turn
(`src/core/llm.ts:173-197` collects every block from one response and executes
them all before the next round-trip). The 120 `record_probe` calls occupy
**26 model turns, not 120**; total round-trips across the seven atoma runs are
**146 = 20.9/run — already below this design's own ≤28 target.**

Found independently by two reviewers, with the same evidence: the intra-batch
gap between consecutive probes has median **283 ms** (n=99) against **3690 ms**
(n=169) for every other adjacent tool pair. Two clean modes, two orders of
magnitude apart. The design counted tool CALLS and reasoned about TURNS.

### 9.2 The probes are evidence PRODUCTION, not information intake

**96 of 120 probes (80%) re-derive a value the same L1 had already read
verbatim from `.atoma-probes.json` earlier in the same run.** They are not
there because the model needs the data; they are there because its own
contract demands first-hand provenance — *"the supervisor validator REJECTS
results that read as self-reported"*, *"USE record_probe, DO NOT TRANSCRIBE BY
HAND"*.

The natural experiment already exists and already failed: `previousStepSummary`
threads facts between sequential phases today, and the L1 probes anyway. A
design premised on "inject facts and the L1 stops re-deriving them" has to
explain why a richer injection succeeds where that one does not. It cannot.

**So the redundancy this design read as waste is the ground-truth discipline
being honoured.** The lever, if there is one, is the record_probe contract —
and loosening that reopens the #F9 fabrication hole this repo already closed
at real cost.

### 9.3 On the flagship subtask the mechanical half produces nothing

The compiled verifier's contract is "exit non-zero if anything changed". A
maintenance task's premise is that exactly one thing legitimately changed. So
at the moment §1 quotes — `wclite.js` edited, manifest not yet refreshed — it
**exits 1 with zero bytes of stdout**, and §4's rule ("non-zero exit → inject
nothing") throws away the only phase the mechanism exists to serve.

Worse in the other direction: simulated at the start of every round-8 L1 loop,
8 loops exit 0 while certifying *"0 regressions detected"* against the
**PRE-edit** binary. Injecting that at the top of an edit phase asserts the
change is already safe before it has been made.

And the script prints **exit codes, never observed VALUES** — while the README
documents outputs (`prints lines 3, words 6, chars 35`). A verdict is what a
validator needs; a value is what a writer needs, and §4 injects into a writer.

### 9.4 The prize is $0.02-0.036/run

Removing every one of the 26 probe-bearing turns saves **$0.0357/run**; the
structurally reachable subset saves **$0.0205/run — 6.7% of the $0.3066 mean
run**. The reason is the one §1 never checked: probe results are tiny (~44
tokens each, ~5.2k tokens across all seven runs) against **5.6M cache-read
tokens at a 93.5% cache rate**, so removing them barely moves the transcript
that gets re-read.

For scale: round 7's already-satisfied validator cascade cost
**~$0.325/run** — roughly ten times this prize — and was fixed in the existing
verdict layer. Against that, a new skill kind touching ~13 files plus a sidecar that save / load / promote /
demote / drop / merge / export must all learn is not a trade worth making.

### 9.5 The central safety claim is false on the majority path

§5 removes five guards on the premise that "the normal validator still judges
the final result". In round 8's own traces, RESULT validations took the **trust
fast-path 30 times against 13 validator LLM calls**, and **four of the six
atoma runs made ZERO validator LLM calls**. On that path `validateResult`
returns `trustedApproval()` after only `checkGroundTruth` — which is a real
check, and the reason this is "false" rather than "catastrophic", but it is not
the validator the design invoked.

And the guards being removed are exactly the ones covering that path. Two
compounding specifics: the only compiled script **writes `.atoma-probes.json`**
(so the "read-only fact provider" premise is false, and under §4 the harness
runs it before the L1 exists with the snapshot removed), and injected stdout
would enter the SYSTEM prompt with **no trust boundary and no cap** —
`LEARNED_CONTENT_TRUST_BOUNDARY_LINES` covers llm bodies, script blocks skip it
because "the scan is their gate", and `scanScriptBody` audits what a body DOES,
never what it PRINTS.

### 9.6 The pre-registration could not have caught any of this

Condition 1 ("the script half fires in ≥5 of 6 runs") is **tautological**: once
`surgical-single-behavior-edit` becomes a hybrid it matched 12 of 17 times and
in all 7 runs, so firing is guaranteed by construction — and §7 pre-commits to
reading a pass as "matching is solved". Round 7's registered lesson was that a
fix which cannot be observed is not a fix; this is its inversion, a fix that
cannot fail its own detector.

Condition 2 is stated in tool calls but justified in round-trips (§9.1), so it
can pass by removing 30% of calls while removing ~7% of turns. Condition 3 is
blind to manifest destruction (fixed separately — see below).

## 10. What survives

- **The measurements.** §1's census is correct (`record_probe` is 41.7% of
  tool calls); only the inference from it was wrong.
- **A cheap test of the premise, if anyone revisits this.** Hand-inject a
  `== MECHANICAL RESULTS ==` block into one L1 subtask prompt and count whether
  probes drop. Costs one run. If they do not drop, the lever is the
  ground-truth contract and no dispatch-path work can help.
- **A real defect in the scorer**, found by a reviewer and independent of this
  design: `verify-maint.mjs` never opened `.atoma-probes.json`, which the goal
  text explicitly names. Manifest destruction, a whitewashed regression or a
  stale merge all scored full marks. Fixed.
- **The standing conclusion.** This was the fifth attempt at making the
  compiled path pay, and the best remaining idea has a measured ceiling of
  ~$0.03/run. The saving comes from tiering, earned trust and recipe reuse.
  Treat compilation as a correct mechanism that does not pay on the families
  measured so far, and stop spending rounds on it.
