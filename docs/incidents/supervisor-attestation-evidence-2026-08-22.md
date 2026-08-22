# Supervisor attestation — evidence inventory, 2026-08-22

Status: **evidence-only cooling-off packet; no A1 design accepted or
implemented**. This record follows the A3+ rollback documented in
[`phase-redundancy-scoping-2026-08-22.md`](phase-redundancy-scoping-2026-08-22.md).
It records the boundaries the later supervisor-owned-attestation review must
reason against. It does not add a gate, witness shape, replay rule, trust rule
or validator instruction during the live incident session.

The cold run rows and dispositions are in
[`phase-redundancy-a3-measurement-2026-08-22.csv`](phase-redundancy-a3-measurement-2026-08-22.csv).
The immutable traces, workspaces and skills remain outside the repository in
the archived cold state and its verified ending backup.

## What the browser tool actually observes

[`validate_html`](../../src/tools/builtin.ts) accepts an `interactions` list
and a `smoke` expression. Its runtime result includes both the executed
`interactionLog` and the later `smokeResult` (`builtin.ts:1276-1352,
1530-1681`). Those are different observations:

- each interaction-log entry is appended only after the corresponding
  Puppeteer mouse or keyboard operation succeeds;
- the smoke runs separately with `page.evaluate`, after the remaining
  interactions;
- the final `ok` combines console/page errors, failed requests and the smoke
  result, but does not require a non-empty interaction log;
- warnings do not make the result fail.

Before the page opens, `smokeDrivesOwnState()` lexically recognises calls such
as `.increment()`, `.advance()`, `.click()` and `.reset()`. When it matches,
the runtime removes every external interaction and emits a warning that the
smoke drives its own state (`builtin.ts:1365-1374, 1800-1804`). This preserves
one coherent state-transition path, but it means `ok:true` can establish an
internal test-hook path without establishing the user-input path named by the
task.

The tool's TypeScript boundary is still `unknown`; `interactionLog` is
declared only in tool-description prose. Local, worker and container
executors forward the returned value, but do not parse it into a shared
contract ([`src/core/types.ts`](../../src/core/types.ts),
[`src/tools/worker.ts`](../../src/tools/worker.ts),
[`src/tools/containerProtocol.ts`](../../src/tools/containerProtocol.ts)).

## Where the observation is retained or lost

The full tool event is retained in the viz trace. `VizToolEvent` carries the
event id, actor, branch, arguments, raw result/error and duration, and the
recording client observes the untruncated result
([`src/viz/trace.ts`](../../src/viz/trace.ts),
[`src/viz/recordingLlm.ts`](../../src/viz/recordingLlm.ts)). This is the only
current persisted **structured** surface that contains requested clicks,
executed-click logs, direct hook calls, warnings and the resulting state
together. The cold text log also permits an operator to infer the split: it
records eight requested interactions, while the post-filter tool log says
only `(+smoke)` and never `(+8 interactions)`.

That recorder is an observability path, not a correctness boundary: recording
failures are swallowed, and supervisor-owned probes invoked directly through
`ctx.tools.execute` do not pass through the LLM tool callback. The raw trace
therefore cannot silently become an execution gate without a separately
reviewed ownership contract.

The production L1 result keeps much less:

- `Result.toolCallResults` receives at most 64 content-free `{name, ok}`
  observations. The callback reads neither the invocation arguments nor
  `interactionLog` ([`src/atoms/L1Atom.ts`](../../src/atoms/L1Atom.ts),
  lines 328-390 and 433-446).
- The L1's `output.probes` is model-authored final JSON. It is not copied from
  the observed tool event.
- `Result.evidence` is populated by `witnessesFromPayload()`, which recognises
  only entries carrying a shell `cmd`. Web and HTTP probe objects are ignored
  ([`src/contracts/witness.ts`](../../src/contracts/witness.ts), lines 18-89).
- N=1 aggregation returns the child result unchanged, but result validation
  passes only `{output, summary}` plus `evidence` to the verdict. For N>1,
  aggregation also drops `toolCallResults` and only flattens `evidence`
  ([`src/atoms/L2Atom.ts`](../../src/atoms/L2Atom.ts), lines 1684-1757;
  [`src/atoms/L3Atom.ts`](../../src/atoms/L3Atom.ts), lines 941-1013).

The current `Witness` has one source variant, `recorded-probe`, and contains a
shell command plus optional textual outcomes. It has no event id, actor,
branch, phase, observed subject, artifact revision or validity window. The
runtime tag therefore makes a child declaration typed; it does not make it a
transport-observed attestation.

## Probe-manifest trust boundaries

[`src/contracts/probeManifest.ts`](../../src/contracts/probeManifest.ts) owns
three on-disk shapes, but they have different producers:

- `record_probe` executes and writes shell observations itself;
- `fetch_url` writes the observed HTTP method, path, status and bounded body;
- the web worker is instructed to write the file, requested interactions,
  smoke and expected result after `validate_html` returns. `validate_html`
  itself does not persist its warning, `interactionLog` or `smokeResult`.

The manifest health check proves shape and limited replayability, not that a
web entry corresponds to an executed tool event. Entries carry no content
digest or mutation generation. A later `write_file`, `edit_file` or
`run_shell` mutation does not mechanically expire an earlier entry.

There is also a measured discriminator split:

- the canonical web L1 result example says `"probe":"validate_html"`
  ([`src/atoms/capability.ts`](../../src/atoms/capability.ts), lines 543-548);
- the manifest schema and the web ground-truth health-check expect the
  literal `"probe":"web"` (`probeManifest.ts:82-107` and
  [`src/atoms/groundTruth.ts`](../../src/atoms/groundTruth.ts), lines
  288-330).

The cold counter result followed the first convention, so the supervisor's
web-manifest check did not activate even though a manifest existed. This was
an observed one-concept/two-definitions boundary, recorded here without a fix.

**Disposition, 2026-08-22 (after the cooling-off period).** Closed separately
from A1, as a factual vocabulary defect rather than a new gate. The
discriminant now has one taught literal owned by
[`probeManifest.ts`](../../src/contracts/probeManifest.ts)
(`WEB_PROBE_DISCRIMINANT`), the web canonical prompt's `output.probes`
example is generated from that constant, and the ground-truth detector reads
it through `isReportedWebProbe`, which also recognises the historical
`validate_html` spelling that archived recipes still carry. The on-disk
manifest checker stays single-valued, because a compiled script dispatches on
that discriminator. Two regression tests pin the boundary: the taught
vocabulary must be a subset of the read vocabulary and must never be an
alias, and a legacy-spelling envelope must still activate the manifest check.
Behavioural consequence, stated explicitly: a web RESULT that reports the old
spelling now has its manifest health-checked, so a malformed manifest sets
`manifestMalformed` and forces validator review where it was previously
silent. Nothing else in the A1 inventory below is addressed.

## What the supervisor independently checks

`GroundTruthFacts` is one of the current supervisor-owned structured inputs to
result validation. It can report missing or empty files, a browser-tool
failure, a child-declared mismatch, malformed manifests, durable ports and
quoted spans absent from files
([`src/atoms/groundTruth.ts`](../../src/atoms/groundTruth.ts), lines 94-168).
The other structured input is the result-gate finding set, which L2 computes
before the verdict from bounded workspace and result observations. Those
findings are review leads with explicit dispositions, not attestations of
claim coverage ([`src/atoms/resultGates.ts`](../../src/atoms/resultGates.ts),
lines 53-91).

For a web child, the independent browser check is deliberately a conservative
clean load: `validate_html({url, waitMs:1500})`, with no interactions and no
smoke (`groundTruth.ts:333-350`). It can disprove reachability or clean-load
claims, but cannot establish task-specific button behavior. The resulting
facts are local to that verdict call. They are rendered to validator prose,
not attached to `Result.evidence`, carried into a later phase or referenced by
the verdict.

The verdict shape itself contains approval, reasoning, optional modification
scope and skill-adherence state. It has no evidence reference, claim-coverage
set or artifact revision ([`src/core/types.ts`](../../src/core/types.ts),
lines 170-194; [`src/atoms/json.ts`](../../src/atoms/json.ts), lines 879-921).

## Cold adversarial case: `web-counter`

Trace `2026-08-22T13-36-08-997-2dd12a14.json` required verification in a real
browser that the buttons actually change the displayed count. Its one worker
browser call provides the following exact separation:

- the model requested eight external clicks across increment, decrement and
  reset;
- its smoke directly invoked
  `window.__counter.reset/increment/decrement`;
- the runtime warning says all eight external interactions were ignored;
- `interactionLog` is empty;
- `smokeResult` proves that the internal methods changed the state, text,
  negative class and computed red color;
- the source contains click listeners wired to those methods, which is static
  code evidence but not an executed DOM interaction;
- the overall tool result is `ok:true` because the warning and empty
  interaction log are not failure conditions.

The model then wrote a web manifest listing the eight requested interactions.
That record contains no marker that none ran; replaying it with the same smoke
would make the current filter ignore them again.

Both result validators received the child's direct-hook narration plus their
own clean-load observation. Neither received `interactionLog`. L2 approved on
the reasoning that the embedded API proved all affordances; L3 approved on
the same internal smoke values. The raw tool event preserved the explicit
warning and empty log; the cold text log also exposed the requested/executed
split indirectly.

## Positive control: `web-stopwatch`

Trace `2026-08-22T13-38-18-931-7f73a79d.json` distinguishes a genuine browser
interaction path. Each L1 browser attempt asked Puppeteer to click
`#startStopBtn` and `#lapBtn`; each result logged both executed clicks. The
first two calls failed their own assertions. The final call returned
`ok:true` only after the smoke observed elapsed time and a visible positive
lap following those interactions.

The counter and stopwatch therefore demonstrate that the existing tool result
already distinguishes internal hook execution from executed browser input.
The loss occurs after the tool returns, across result, witness, manifest,
ground-truth and verdict boundaries.

## Observed trust and skills consequences

An approved RESULT on the normal supervision path is a lifecycle event, not
just a display status. It calls `onApproved`; PLAN approvals and the terminal
fallback return do not:

- the child atom type gains a success;
- an active skill gains credit unless the validator explicitly emits
  `activeSkillFollowed:false`;
- that credit can immediately trigger promotion checks;
- a novel approved run with any successful observed tool action can trigger
  skill distillation;
- L3 separately credits the L2 type.

The content-free action guard treats any successful tool as demonstrated
action; a successful `read_file` in a no-op phase is sufficient. For an LLM
skill, trust-path approval normally has no evaluated adherence signal, and
`undefined` deliberately keeps skill credit enabled. A script skill whose
scratch execution was not transport-observed is the existing exception: L2
forces `activeSkillFollowed:false`. These semantics are in
[`src/atoms/L2Atom.ts`](../../src/atoms/L2Atom.ts), lines 1495-1602 and
1954-2071, and [`src/skills/lifecycle.ts`](../../src/skills/lifecycle.ts),
lines 314-378.

The cold incident shows the propagation concretely. Approval of
`web-counter` distilled `build-interactive-html-widget`, whose recipe says to
simulate interactions through the exposed `window` object. The next
`web-stopwatch` run matched and injected that recipe. It actually used
Puppeteer clicks, but the adherence validator received the result narration,
its independent clean-load block and the active recipe—not the raw tool event
or `interactionLog`. It declared the recipe followed and credited it. The
archived skill ended at one match, one success and zero failures.

Deterministic script dispatch has another evidence boundary: it bypasses the
L1 plan/execute validators, directly credits the skill, increments the
deterministic run statistic, and returns no `evidence` or `toolCallResults`.
The compile prompt already says browser-only recipes are not promotable, but
that refusal does not make their preceding LLM-skill credits evidence-aware.

Run accounting has no attestation, invalidation, proof-reuse, generic probe
count or L3 phase-count signal. It does count `deterministicPhases` for the
direct script-skill path. Supervisor probes invoked directly outside an LLM
completion add no model call or model dollars but still consume wall time;
worker probes inside an LLM tool loop can add continuation turns and tokens.
Distillation and promotion calls remain part of the run's LLM cost. The final
persisted result omits `evidence` and `toolCallResults`; branch and tool events
survive separately in the trace, where phase/probe counts can be derived.

## Facts the later A1 review must reconcile

This list is a boundary inventory, not an architecture proposal:

1. Requested browser interactions and executed interactions are different
   facts, already observable in the tool result.
2. A model-authored result or web manifest is replay intent, not proof that
   the runtime executed that intent.
3. The strongest current web-interaction observation is trace-owned and
   fail-open; the correctness protocol has no equivalent machine-owned web
   transport. Shell `record_probe` and recorded HTTP fetches already have
   machine-owned manifest writers and are a different trust boundary.
4. No current witness binds an observation to an artifact revision, so later
   mutation and stale proof are mechanically unrelated.
5. Evidence is neither phase-addressed nor mapped to the task claim it covers.
6. Clean-load ground truth is intentionally conservative and cannot be
   reinterpreted as task-specific behavioral proof.
7. Any future approved RESULT inherits atom trust, skill credit, learning,
   promotion and run-stat consequences unless those semantics are addressed
   explicitly. Negative/escalation paths separately govern failures and
   script demotion.
8. Any run-scoped state must cross real branch/fork context construction; the
   repository has a prior incident where an omitted context field disappeared
   only after nested forks.
9. Shell, HTTP and web manifests have different machine/model ownership; a
   single trust label over all three would be factually false.

The reserved A1 direction therefore still spans tools, contracts, dispatch,
ground truth, verdicts, trust, skills, traces and accounting. No subset has
been accepted here, and A3+ remains rolled back.
