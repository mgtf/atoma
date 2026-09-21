# Verification replays on standing proof — the seeded counter, 2026-09-15

Status: root cause located in code, one contract designed against the full
trace and the prior incidents, regression landed, live campaign recorded
below. This closes the item the
[14 September live exercise](recovery-live-2026-09-14.md) and the
[production audit](production-audit-2026-09-14.md) left open: "the local
seeded counter's verification retry failure remains open".

## The evidence

Trace `2026-09-14T13-37-04-998-6f81b406`, preserved without rewriting as
[seeded.trace.json.gz](recovery-live-2026-09-14/seeded.trace.json.gz)
(SHA-256 `9896bf52…debd`, 107 events, 30 LLM calls, 0.4229 USD estimated,
aborted at the 300 s budget). Goal: modify a working single-file counter to
add a `#reset` button and verify increment and reset through real browser
clicks. Every line below is reproducible from the trace's `events` array;
indices are positions in that array, times are relative to the first event.

| # | t | actor | event | fact that matters |
|---:|---:|---|---|---|
| 24–26 | 58–66 s | Water/L1 | three `edit_file` on `index.html` | the last write to the document in the whole run |
| 28 | 72 s | Water/L1 | `validate_html`, 5 interactions incl. `#reset` | REFUSED pre-flight (erased intermediate state); no page opened |
| 29 | 78 s | Water/L1 | `validate_html`, self-driving smoke | ok; document `index.html` bound, sha256 `9fd27f64…2ad7b`; 0→3→0→1 proven |
| 34–44 | 100–117 s | Tracheid/L2, Meristem/L3 | validate-result ×2 | phase 1 approved; Water credited |
| 45 | 117 s | Meristem/L3 | phase 2 starts | "prove with selector interactions, not test hooks" — a second verification phase over the same file |
| 61 | 152 s | Water/L1 | same 5-interaction shape | REFUSED, identical message |
| 62 | 159 s | Water/L1 | self-driving smoke | ok; same digest; 0→3→0→1 |
| 63 | 164 s | Water/L1 | 3 real `#increment` clicks | ok; same digest; `interactionLog` has 3 entries; value 3 |
| 64 | 168 s | Water/L1 | 4 interactions ending in `#reset` | REFUSED — the LAST call of the execution |
| 65 | 141–188 s | Water/L1 | execute ends: "reached the tool iteration budget" | summary rewritten to `[INTERNAL VALIDATION FAILED — last validate_html: …]` |
| 66 | 182 s | Tracheid/L2 | coaching | "Your last validate_html result was not ok … re-run validation until ok:true" |
| 68–74 | 182–208 s | Water/L1 | replan, validate-plan, `read_file`, `start_static_server`, `validate_html` | full replay; the one probe is the refused shape again |
| 75–76 | 196–221 s | Water/L1, Tracheid/L2 | banner again, coaching again | second mechanical rejection |
| 78–84 | 221–252 s | Water/L1 | replan, validate-plan, `read_file`, `start_static_server` | budget exhausted before any probe; no banner |
| 86 | 254 s | Tracheid/L2 | validate-result | approved on transport evidence (`e2598777`, 3 executed clicks) and its own re-run |
| 94 | 270 s | Meristem/L3 | validate-result | rejected: the child's own "UNFINISHED WORK" self-report contradicts the standing proof |
| 97–105 | 280–300 s | Tracheid/L2, CarbonDioxide/L1 | a fresh molecule is spawned | deadline |

The document digest `9fd27f64…2ad7b` is identical in events 29, 62 and 63,
and no write touches `index.html` after event 26. Three executed
observations of one unchanged document stood when the run was failed.

## Root cause

[`L1Atom.execute`](../../src/atoms/L1Atom.ts) kept one bit about browser
proof: the `ok` flag of the LAST `validate_html` call. That bit decided the
`[INTERNAL VALIDATION FAILED` banner on the result summary; the banner is the
trigger of the `internal-validation-failed` row in
[`resultGates.ts`](../../src/atoms/resultGates.ts), whose disposition is an
outright mechanical rejection with coaching; the rejection is the supervision
loop's normal retry — a new L1 plan, a validate-plan call, a new execution.

A pre-flight refusal returns `ok: false`. It is a statement about the REQUEST
(the interaction order would erase the state the smoke needs), made before
any browser runs, and it carries no `document` binding for that reason
([tools contract](../../src/tools/AGENTS.md#browser-observation)). Reading it
as the artefact's last observation is what discarded events 62 and 63.

The prior incidents show the same bit in the same role. The
[7 September Notes app](notes-app-browser-phase-2026-09-07.md) records
"2× `internal-validation-failed`" in one run and, in its third repeated
attempt, "rejection restarted tool work and rewrote the files again". The
gate row itself was introduced for the opposite failure — a model declaring
success after an EXECUTED `ok:false` — and that case must keep failing.

## The contract

One ledger replaces the bit: [`validationLedger.ts`](../../src/atoms/validationLedger.ts),
fed the tool events in transport order, zero LLM calls, zero file reads. It
applies the doctrine [`proofCoverage.ts`](../../src/atoms/proofCoverage.ts)
already holds for supervisor-held attestations — evidence is bound to the
document it observed, and only a contradiction retires it:

| disposition | when | banner |
|---|---|---|
| `none` | `validate_html` never called | no |
| `standing` | last EXECUTED observation ok, its document not written since | no |
| `failed` | last EXECUTED observation not ok | yes — unchanged wording |
| `refused-only` | every call refused pre-flight | yes — "never executed: N call(s) refused pre-flight" |
| `stale` | successful `write_file`/`edit_file` on the OBSERVED path after its last ok observation | yes — "modified after its last successful validate_html and not re-validated" |

A refusal is recognised by the contract's own predicate,
`isPreflightRefusal` over `SMOKE_PREFLIGHT_REFUSAL_PREFIX`
([attestation.ts](../../src/contracts/attestation.ts)); the tool now writes
that prefix from the same constant. A write to a path other than the observed
document does not retire anything — a digest over a guessed file set is the
false staleness proof coverage refuses to produce, and the supervisor's own
ground-truth probe re-runs the browser regardless. An observation with no
document binding cannot be shown stale and stands.

What this does NOT change: the gate row and its disposition; the supervisor's
independent re-run; proof coverage; the erased-intermediate-state refusal
itself. Nothing that failed a result before passes now, except the case where
the failure was a refusal over a fresh observation of the unchanged artefact.
`stale` is stricter than before: a model that rewrote the page after its last
green probe and returned without re-validating used to pass this gate.

## Regression

[`tests/l1.test.ts`](../../tests/l1.test.ts) drives the real `L1Atom.execute`
path with the trace's event sequence (ok bound observation, ok observation
with three executed clicks, pre-flight refusal, final envelope) and asserts no
banner. Against the pre-fix source it fails with the incident's exact banner:

```text
AssertionError: expected '[INTERNAL VALIDATION FAILED — last va…' not to match /INTERNAL VALIDATION FAILED/
Received: "[INTERNAL VALIDATION FAILED — last validate_html: 1 console error(s), smoke: interactions repeat a state-changing control and then reset BEFORE smoke runs] Counter verified: 0→3→0→1 and three real clicks"
```

The same file pins `refused-only` and `stale` through the execute path, and
[`tests/validation-ledger.test.ts`](../../tests/validation-ledger.test.ts)
covers the ledger with the trace's result shapes: refusal after failure does
not launder it, failure after ok still fails, a write elsewhere keeps the
proof, a fresh observation supersedes staleness, an unbound observation
cannot go stale. The existing three banner tests and the result-gate,
trust-fast-path, smoke pre-flight and sentinel suites are unchanged and green.

## What remains outside this contract

- The L3 planned a SECOND verification phase over a file the first phase had
  already verified (event 45). That is planning shape, not proof handling; it
  is recorded here and not gated (cooling-off).
- The model sent the refused interaction shape four times across two phases.
  The refusal text already carries the accepted shape; the L1 tool budget at a
  300 s deadline left one probe per retry. Neither is changed here.
- Whether the L3 should reject on a child's "UNFINISHED WORK" self-report when
  transport evidence and its own probe both stand (event 94) is a validator
  judgement, left to the acceptance-contract review.

## Live campaign

Two local operator runs, one at a time, on WSL Debian with Node 24.20.0 and
Docker Engine 28.3.2: the same two goals as 14 September, the same worker
image by immutable ID (`sha256:9fc3d789…5715`), source `8f442d1` plus this
change, pins `sub:anthropic:haiku|sonnet|opus`, `ATOMA_BUILD_TIMEOUT_MS=300000`,
fresh isolated store, skills and runs directories, container mode. The
harness ([campaign.sh.gz](verification-replay-2026-09-15/campaign.sh.gz))
polls the log for the runner's own banner and then interrupts the parked
process; it preserves the exact local paths and is dated evidence, not a
product command. The traces are compressed without rewriting.

| Case | Entry | Outcome | Duration | LLM calls | Estimated USD | `validate_html` calls | refused pre-flight | executed ok | L1 execute rounds |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| Fresh counter ([trace](verification-replay-2026-09-15/fresh.trace.json.gz), `89c2ec5d`) | default short, L2 | delivered | 75.9 s | 6 | 0.1373 | 1 | 0 | 1 | 1 |
| Add reset, `--seed` from the fresh workspace ([trace](verification-replay-2026-09-15/seeded.trace.json.gz), `f9fd3d8b`) | L3 seed path | delivered | 150.2 s | 16 | 0.2372 | 5 | 2 | 3 | 2 |
| 14 September seeded run, for the record | L3 seed path | failed, deadline | 300 s | 30 | 0.4229 | 7 | 4 | 3 | 4 |

Uncompressed SHA-256: fresh trace `b5476f71…6760`, seeded trace
`3e8c8fac…08f7`, fresh `index.html` `2b1276a5…176b`, seeded `index.html`
`1c6ea109…b53f`. Costs are subscription API-list equivalents, not invoices.
Two runs with changing learned state are not a controlled comparison and
establish no cost ratio; the 14 September row is context, not a baseline arm.

What the seeded trace shows, event by event:

- The erased-intermediate-state refusal fired twice (events 24 and 52),
  once per phase, on the same interaction shape as 14 September. The
  requirement was not relaxed; both refusals were refused.
- In each phase the model then sent an admissible probe and ENDED on it: a
  self-driving smoke proving 0→2→0 (event 25), then three real `#increment`
  clicks (53) and one real `#reset` click (54), all bound to one digest
  `1c6ea109…b53f`, which no later write touched. The ledger's disposition
  was `standing` in both phases; so would the old last-call bit have been.
  **The incident's exact ordering — a refusal as the last call over standing
  proof — did not recur in this run.** The live evidence for the contract's
  decisive branch therefore remains the regression, which fails against the
  pre-fix source with the incident's banner; this campaign shows the fixed
  loop delivering the same seeded goal within budget with no mechanical
  rejection, no replan and no replayed verification.
- Phase 1's credit was WITHHELD (`credit-withheld`, `uncoveredObligations: 1`):
  its only executed observation drove its own state, so the declared
  `dom-interaction` obligation had no transport-observed click. Proof coverage
  kept working exactly as specified; phase 2 covered the obligation with real
  clicks and was credited.
- The L3 again planned a second, read-only verification phase over the file
  phase 1 had just verified (event 36, branch start 87.9 s → end 150.2 s):
  62.3 s, seven of the sixteen LLM calls (two prefilters, plan, validate-plan,
  execute, two validate-results) and 0.0758 USD of the 0.2372. Its purpose was
  real, though: it is where the `dom-interaction` obligation phase 1 had left
  uncovered was covered with executed clicks. The open planning-shape item
  above stands, now measured twice; the cheaper remedy is for phase 1 to
  cover the obligation itself.

An independent Puppeteer check outside any run
([pointer-check.mjs.gz](verification-replay-2026-09-15/pointer-check.mjs.gz),
result in [pointer-check.json](verification-replay-2026-09-15/pointer-check.json))
served each delivered file from a throwaway loopback server and clicked with
real pointer events, asserting after every click: the fresh counter read
0→1→2→3, the seeded counter 0→1→2→3→0→1, with zero page errors and the file
digests above. This is functional evidence about the two artefacts, not
credit for the runs. The workers were confirmed removed after each run; the
live state remains under `/tmp/atoma-ledger-campaign-20260915` on this machine.

## Second correction, 2026-09-15: teach the shape that covers

Owner-approved scope, same day: a GUIDANCE-ONLY correction, its regression,
then a live campaign. No new gate, no acceptance-contract change, no
refusal relaxed.

**What the traces settle.** In both seeded runs the erased-intermediate-state
refusal handed out exactly one accepted shape — a self-driving IIFE with
`interactions: []` — and the model adopted it on its very next call, 3.5 to
7.1 s later (14 September events 28→29 in 5.9 s and 61→62 in 7.1 s;
15 September events 24→25 in 3.5 s). That shape
passes every guard and executes no real interaction, so the phase's declared
`dom-interaction` obligation stayed uncovered and credit was withheld (event
30, 15 September); the L3 then planned the second verification phase measured
above. The model later found, unaided and one phase late, the shape that
satisfies both the guards and the obligation: real clicks up to the milestone
under a read-only smoke (event 53), then the reset under a read-only smoke
(event 54). The tool knew that shape was admissible and never said so.

**The correction.** One constant, `SMOKE_TWO_CALL_SHAPE`, in
[probeManifest.ts](../../src/contracts/probeManifest.ts) — the layering-clean
home, since the tool's refusal and the shared smoke guidance both render it
and `src/atoms` may not import `src/tools`. Call 1 replays the state-changing
control up to the milestone under a read-only smoke; call 2 changes state
ONCE and resets under a read-only smoke, because a reset on a fresh page
proves nothing, and `[control, reset]` keeps the reset below the detector's
threshold. The erased-state refusal
([builtin.ts](../../src/tools/builtin.ts)) keeps its first sentence
byte-identical (the validation ledger summarises a refusal by it) and now
presents both shapes, the covering one first, stating that the self-driving
one "executes NO real interaction (interactionLog stays empty), so it does not
cover a dom-interaction obligation". The shared guidance
([prompts.ts](../../src/atoms/prompts.ts)) renders the same lines from the
same constant and says the same thing before its canonical self-driving
shape; the `smoke` parameter description no longer names `interactions: []`
as the only remedy; and the L1's obligation lines, which reach the FIRST call
of a phase that declares `dom-interaction`, name the two-call split.

**Regression.** [tests/smoke-two-call-coverage.test.ts](../../tests/smoke-two-call-coverage.test.ts)
feeds both taught calls to the real guards with their own interactions kept,
proves the collapsed list and the traces' own shape are still refused, checks
the refusal and the guidance render the constant verbatim with the covering
shape first, then drives both calls through the production seam — a
browserless executor built from the tool's own exported predicates,
`forkBranch` → `attestingExecutor` → `checkProofCoverage` — and proves
`dom-interaction` COVERED by two executed observations bound to the unchanged
document; that the same non-empty logs stop covering once the document moves
(necessary, not sufficient); that the self-driving shape never covers, as
taught and as the traces sent it beside real clicks (discarded, not refused);
and that the real tool hands the shape out on a refused call without opening
a browser. The pre-flight and guidance suites pin the new halves beside the
existing example. The constant did not exist before this change, so the
regression cannot compile against the previous source.

**Known limit, recorded and not gated.** The detector labels ANY interaction
whose selector or key contains `reset` or `clear` as the reset, so a
state-changing control whose own id carries those letters (`#presetPicker`,
`#clearLine`) clicked three times under a read-only smoke is refused as
call 1 even though the taught shape says both calls are accepted. The review
of this change reproduced it against the real guard. It is a false positive
of the token match, not of the teaching, and the detector is not relaxed
here (cooling-off); it joins the erased-state items in
[decided, not built](../decided-not-built-2026-08-23.md) for the next
contract designed against the full corpus.

**Campaign 2, invalid for the tool half — and what it taught anyway.** Same
goals, budgets and protocol as above, source `332380f` plus this change,
worker image `sha256:9fc3d789…5715` (the 14 September image). The fresh
counter delivered in 6 calls, 0.1505 USD, obligation covered
([trace](verification-replay-2026-09-15/guidance-fresh.trace.json.gz),
`64391083`). The seeded run FAILED at the 300 s budget: 28 calls, 0.3924 USD,
phase 1 alone 275 s
([trace](verification-replay-2026-09-15/guidance-seeded.trace.json.gz),
`6ae34c04`; SHA-256 of the uncompressed traces `11612490…b6e` and
`320e15c8…7ecc`). Both delivered files pass the independent pointer check,
0→1→2→3 and 0→1→2→3→0→1
([result](verification-replay-2026-09-15/guidance-pointer-check.json)):
once more a verification-workflow failure, not broken code.

Reading the seeded trace settled three facts:

1. **The tool half of the change never ran.** `validate_html` executes inside
   the worker container, whose image carries its own compiled `dist/tools`.
   The image predates the change; inside it `grep -c "Two shapes are
   accepted" /app/dist/tools/builtin.js` returns 0 and the old sentence
   returns 1. Every refusal the model received (events 34, 51, 62) was the
   OLD text, teaching the self-driving shape alone. The host half did run:
   the two-call lines and "executes NO real interaction" are present in the
   L1's system prompt on every plan and execute call of both runs. A
   campaign of a tool-side text needs the image rebuilt from the patched
   `dist/`; campaign 3 below does that.
2. **The L1 planned the taught shape first, and the L2 plan validator
   rejected it.** Event 16, verbatim: "proposes TWO separate validate_html
   calls, but the child's only declared tools are … validate_html (singular)
   … Restructure to one coherent validate_html call with all interactions
   (increment, reset verification) in a single smoke payload", with the
   coaching "Combine the initial smoke and interaction smoke into ONE
   validate_html invocation … click #increment multiple times, then #reset".
   The validator coached exactly the list the tool refuses. The shared
   validation prompt's TOOLSET SCOPE rule now states that a declared tool may
   be called as many times as the plan needs, that the two-call verification
   is the taught shape, and that merging it must never be coached
   ([verdict.ts](../../src/atoms/verdict.ts), pinned in
   `tests/validation-prompt-l1-plan-shape.test.ts`). Text again, no gate.
3. **The rest of the budget went to a different class.** Two results were
   rejected by the `non-json-envelope` gate (the L1 narrated instead of
   emitting the final JSON), one plan was rejected for its `subtasks` shape,
   and the L1 ended one execution on a refusal, which fired the banner
   (`refused-only`, the ledger working as specified). Phase 2 started at
   274.7 s and the deadline fell 25 s later.

This phase also declared no `dom-interaction` obligation on its subtasks (the
L3 plan carried none), so the L1 obligation lines never rendered; the fresh
run's root floor did.

**Campaign 3 — the text under test, in the worker.** Same goals, budgets and
protocol, source `332380f` plus this change including the validator text of
fact 2, worker image REBUILT from the patched `dist/`
(`sha256:2fe27823…380b`, created 08:24:08 UTC; inside it the new sentence
returns 1 and `SMOKE_TWO_CALL_LINES` is present in `dist/contracts`), fresh
isolated state, one run at a time
([campaign3.sh.gz](verification-replay-2026-09-15/campaign3.sh.gz)).

| Case | Outcome | Duration | LLM calls | Estimated USD | `validate_html` | refused (new text) | ok with executed clicks | Phase 1 obligation |
|---|---|---:|---:|---:|---:|---:|---:|---|
| Fresh ([trace](verification-replay-2026-09-15/guidance2-fresh.trace.json.gz), `79a14135`) | delivered | 66.5 s | 6 | 0.1252 | 1 | 0 | 1 | covered (root floor) |
| Seeded ([trace](verification-replay-2026-09-15/guidance2-seeded.trace.json.gz), `d167815f`) | delivered | 279.7 s | 29 | 0.4254 | 6 | 2 (2) | 4 | COVERED, credited |

Uncompressed SHA-256: fresh trace `3c7696bf…4e1b`, seeded trace
`98c80911…2c2`; fresh `index.html` `d59f5ae1…5c3d`, seeded `9e5c29b3…7235`.
Both pass the independent pointer check, 0→1→2→3 and 0→1→2→3→0→1, zero page
errors ([result](verification-replay-2026-09-15/guidance2-pointer-check.json)).

What the seeded trace shows, event by event:

- **The teaching works at the tool.** The model's first probe was again the
  collapsed list `[#increment ×3, #reset]` (event 30); the refusal it
  received was the new text. Its very next call, 2.9 s later (event 31), was
  call 1 of the taught shape: three real `#increment` clicks under a
  read-only smoke asserting `'3'`, `interactionLog` of three, document bound.
- **The validator speaks the same shape.** The L1 returned after call 1
  alone; the L2 result validator rejected on the merits — reset unverified —
  and its coaching (event 34) is the two-call shape verbatim: "(1) click
  #increment N times, read #value === milestone; (2) click #increment once,
  click #reset, read #value === '0'". It cited the refusal it had read in the
  transport record. On 14 September the same validator, reading the old
  refusal, had coached merging.
- **The retry is the taught shape, and it covers.** Events 43 and 44: call 1
  (`[#increment ×3]` → `'3'`) and call 2 (`[#increment, #reset]` → `'0'`),
  both executed, both bound to `9e5c29b3…7235`, manifest written. The
  supervisor-held coverage block reads COVERED with executed interactions;
  phase 1 was approved at 143 s and credited — no `credit-withheld`,
  `uncoveredObligations: 0`. **Target met: the obligation covered in phase 1,
  by phase 1.**
- **Phase 1 cost 137 s and 14 calls, phase 2 another 124 s and 13.** The L3
  planned the read-only re-verification phase a third time (event 59). In it
  the model opened with the collapsed list again (75, refused), sent call 1
  (76), then narrated instead of emitting the envelope (`non-json-envelope`,
  event 78); the plan validator then rejected a correct replan with a
  self-contradicting toolset reading — "validate_html is absent from the
  child's declared tools … Wait — validate_html IS declared … the child has no
  tool to invoke validate_html" (event 82) — and the phase ended on ground
  truth with no new probe. **Target not met: 29 calls against fewer than 16.**

What the three campaigns settle, and what they do not:

- The two texts now agree and the model follows them within one call: the
  taught shape was executed in two runs out of two that reached it (campaign
  1 found it unaided one phase late; campaign 3 was handed it and used it in
  phase 1). This is the measured effect of the correction, on two runs.
- The remaining budget goes to costs this chantier did not touch and now has
  three measurements of: the L3's second verification phase (62 s / 7 calls,
  then 124 s / 13, over a file phase 1 had just proven); the L1 narrating
  instead of emitting the final envelope (two runs, three occurrences); and
  the L2 plan validator misreading the toolset (three distinct wordings in
  two runs). Each is recorded here for its own contract, none is gated.
- Two runs with changing learned state are not a controlled comparison. The
  14 September failure, the 15 September 16-call delivery and the 29-call
  delivery here are three observations of one goal under three sources; no
  cost ratio is claimed.

Worker teardown after the operator interrupt took minutes on this host: 30 s
after the seeded run ended both workers were still listed, and both were gone
when inspected two minutes later. Removal happened; its latency is recorded,
not diagnosed. Two `atoma-preview-proxy-network-check` / `atoma-proxy-test-loopback`
containers left by an earlier full test-suite run (eight hours old) were
removed before campaign 3; a test leaving containers behind is a separate
observation for the tools suite.
