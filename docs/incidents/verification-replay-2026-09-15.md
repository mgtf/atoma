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
  phase 1 had just verified (event 36): 62 s and six calls of the sixteen. The
  open planning-shape item above stands, now measured twice.

An independent Puppeteer check outside any run
([pointer-check.mjs.gz](verification-replay-2026-09-15/pointer-check.mjs.gz),
result in [pointer-check.json](verification-replay-2026-09-15/pointer-check.json))
served each delivered file from a throwaway loopback server and clicked with
real pointer events, asserting after every click: the fresh counter read
0→1→2→3, the seeded counter 0→1→2→3→0→1, with zero page errors and the file
digests above. This is functional evidence about the two artefacts, not
credit for the runs. The workers were confirmed removed after each run; the
live state remains under `/tmp/atoma-ledger-campaign-20260915` on this machine.
