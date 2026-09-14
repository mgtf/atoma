# User acceptance contract — design, 2026-09-14

Status: proposed, not implemented. Companion:
[coverage and local value audit](value-audit-2026-09-14.md).
This document specifies a reviewable boundary before extending the runner.
It does not establish a measured improvement in delivery quality or cost.

## Existing owner and scope

The supervisor already owns independent ground-truth reads in
[`groundTruth.ts`](../src/atoms/groundTruth.ts): file read-back, workspace
evidence, and browser inspection, including a loopback-only hybrid-server
probe. Extend that owner. Do not give L2/L3 models tools or create another
plan/execute/validate loop beside `superviseLoop`.

Current load-and-look evidence and the depth profile's `dom-interaction`
floor are not a user acceptance specification. An executed interaction does
not establish that data persists or that the requested calculation is correct.
The current hybrid browser supplement is also best-effort; this proposal
does not silently turn every existing probe into a mandatory delivery gate.

## Immutable input and typed boundary

Define the eventual runtime schema once under `src/contracts/`, infer its
TypeScript types, and import it at the project API, coordinator, child launch,
runner and evidence readers. The following is a proposed field inventory,
not a second implementation of that schema:

| Shape | Required meaning |
|---|---|
| Acceptance specification | Version, stable ID, org/project scope, criterion list |
| Criterion | Stable ID, user-facing requirement, typed probe reference, typed expected result |
| Captured binding | Run ID, specification digest, captured artifact identity, attempt identity |
| Criterion observation | Criterion ID, probe version, binding, disposition, bounded evidence references |
| Run acceptance record | Run/specification version key, specification digest, artifact binding, criterion observations, verification timing and aggregate disposition |

The probe vocabulary and numerical budgets must be selected and reviewed
before implementation. They are not inferred from task words. A second proof
obligation also requires the review described in
[`src/contracts/AGENTS.md`](../src/contracts/AGENTS.md); this document does not
add one to `PROOF_OBLIGATIONS`.

The user submits or accepts the criteria before planning. A model may draft
them, but cannot activate its own draft as independent acceptance authority.
The host validates and captures the specification before paid work. Unsupported
criteria require an explicit revision or remain unverified; they must not be
silently omitted or presented as executable checks.

The planner sees every criterion and the behavior it will be checked against.
The host retains the authoritative captured version outside the writable
workspace. The planner cannot delete a criterion, weaken an expectation,
change the probe implementation or write an observation. Editing a project
specification creates a new version for a later run, not a mid-run mutation.
The captured binding must survive the coordinator-to-child process boundary.

### Authoring surface before launch

The starting point is the user's prose goal. A pre-run drafting surface shows
plain-language acceptance cards: what will be checked, a concrete example of
success, and any unsupported part. Typed HTTP/JSON/file details are an optional
inspection view. The user can edit, add or remove cards before accepting the
set; each edit must be compiled and validated again. An unsupported statement
is shown as unverified, never silently converted into a weaker assertion.

Drafting is a separate, explicit action before execution planning. A model may
produce the draft, but that call itself can cost money: the UI must disclose
and obtain authorization for its bounded drafting budget before calling it.
No hidden paid drafting is described as “before any paid work”. User-supplied
criteria or supported templates can instead be compiled without an LLM call.
Approving the displayed criteria and run budget activates the immutable set
and starts the paid execution run. Repeated model-assisted revisions have an
explicit cumulative drafting cap and retain their spend outside run statistics.
This is a proposed interaction, not a claim that this UI already exists.

## Probe capabilities and confinement

Start with bounded, independently observable properties: a named relative
file exists with an expected structured value; an application endpoint returns
an expected status or typed JSON value; a page exposes specified read-only
content. A concrete schema must define each supported expectation, rather
than accepting arbitrary assertion prose for a pass decision.

Probes remain loopback-only and operate through the existing sandbox/runtime
boundary. The host binds an opaque application service reference to THIS run's
isolated instance. A caller cannot select an arbitrary host localhost port:
loopback alone would otherwise allow access to the control plane. Navigation,
redirects and browser subrequests must obey the same confinement. No arbitrary
JavaScript, shell command, remote URL or replay of child-authored commands is
part of a criterion. Symlinks and path traversal retain the existing path jail.

Reuse the existing [`builtin.ts`](../src/tools/builtin.ts) server attribution
channel: server entry, tracked process and listening port belong to one tool
set/attempt. `fetch_url record:true` stamps the observed entry into the
[`probe manifest`](../src/contracts/probeManifest.ts); the listening-process
check and document binding already constrain attribution. Do not create a
second port registry. A persisted manifest alone is not an authorization
token: model writes and legacy entries remain possible, and attribution of
a Node entry is not proof of every resource it serves. Acceptance consumes
live host-owned attribution and the captured artifact binding.

Even GET or page loading may trigger application writes. Read-only describes
the verifier's capability, not a guarantee that generated application code has
no side effects. Probes must not execute against production application data.

A requirement such as “a saved note survives reload” needs a separate,
explicit scenario capability. It cannot be claimed from current read-only
probes. Reuse the existing [preview materialization and isolation runtime](../src/preview/AGENTS.md):
a filtered ephemeral workspace copy, fixed launcher, isolated instance and
teardown already exist. Do not build a second instance runtime. Acceptance
needs its own exclusive generation/ownership so an interactive preview cannot
mutate the test fixture, and a fixed host-owned harness with typed actions and
bounded inputs. It must perform a real reload and observe the value through the app,
without injecting the expected state. A browser reload only proves survival
of that reload; persistence across server restart needs another explicit check.
The preview delivery hook is intentionally fail-open and its in-flight copy
may be torn. Acceptance must instead capture a quiescent candidate, refuse a
torn or incomplete snapshot, and remain unverified on startup/readiness/probe
failure. Reuse lifecycle primitives, not the preview hook's success policy.
Fixture creation, scenario operations and exclusive ownership still need
review and behavioral tests; the existing preview does not implement them.

All verification has host-owned bounds on duration, request count, bytes and
evidence size. It must fit the run deadline and expose its cost and duration.
The initial executable vocabulary should need no extra LLM call. Preserve the
existing review path where appropriate; do not add a new judge by default.

### Host-owned verification reserve

At admission the host computes a verification reserve R from the activated
probe plan and bounded setup, copy, readiness, probes, evidence persistence
and teardown. With total budget B, generation/preparation receives at most
B - R. Refuse admission if B cannot fit R plus the supported minimum generation
budget. Numerical caps require measurement; this design invents no universal
percentage. The planner sees the reduced deadline and cannot borrow R.

Both short work and any deepening share this generation deadline. At its end,
cancel and drain model/tool work before freezing the candidate. Failure to
establish quiescence leaves acceptance unverified; never inspect a mutating
workspace to consume the reserve. Finishing early allows verification to start
early, within its own cap R and the overall deadline. Verification does not
extend B, and its capacity is not handed back to the model after a failed probe.
Cancellation remains effective during every stage. Record generation time,
reserved time, actual verification time and typed interruption reasons so a
capacity failure is distinguishable from a failed expectation.

## Evidence, decisions and attempts

Use structured dispositions: `passed`, `failed`, and `unverified`, the latter
with a typed reason such as unsupported capability or interrupted verification.
These are proposed acceptance dispositions, not replacements for existing
result-gate dispositions. A contradiction and unavailable evidence must remain
distinguishable. Neither an LLM's confidence nor missing evidence is a pass.

Each observation binds the criterion/specification version, run, attempt and
tested artifact identity. Existing single-file attestations retain their
documented scope; their hash must not be described as covering imported scripts
or server dependencies. A behavioral claim needs an isolated immutable snapshot
with a host-defined dependency boundary. If that boundary cannot be established,
the claim remains unverified rather than relying on guessed dependency hashes.

The candidate artifact is fixed before verification; publication must use that
same candidate or require fresh verification. A workspace mutation after a
probe invalidates its applicability. An earlier attempt's evidence cannot
satisfy the accepted attempt. Evidence references are host-written, bounded,
org-scoped, and exclude credentials or unnecessary user content.

Acceptance is an orthogonal record in the existing primary product store,
keyed by run and specification version, with its digest and criterion
dispositions. It introduces no new run status. Existing runner and project
finalization semantics remain: project finalization may already differ from
the runner epilogue, and acceptance must not collapse those two facts.

This record is evidence about one run's artifact, not atom/skill trust,
platform-body approval, execution rights or permission to reuse a recipe.
It cannot increment trust or admit a body to the commons. The
[SaaS storage decision gate](saas-architecture.md#the-next-code-decision)
still applies: “primary product store” names the logical owner, not permission
to add a temporary SQLite table before the hardened-SQLite/PostgreSQL decision.
This proposal authorizes no DDL or migration. The storage implementation must
be reviewed against that decision before coding; calling evidence “acceptance”
is not an exemption from the gate.

The aggregate is passed only for a nonempty activated set whose criteria all
pass; any failed criterion makes it failed, otherwise incomplete evidence is
unverified. A legacy run with no specification has no acceptance record or
badge, never a synthetic pass. Final records are immutable and all evidence
must cover the same captured candidate. Missing evidence is visible after a
crash rather than being filled with success by a reader.

Publication retains its current eligibility rules and records the acceptance
record's canonical digest (binding specification, artifact and observations),
or an explicit absence for legacy/unverified-without-record cases. That is
provenance, not a new publication gate. A delivered artifact can be published
with failed or unverified acceptance, but the UI must show that disposition
and cannot give it the acceptance badge. Freezing the referenced record at
publication prevents a later observation from changing what an old commit
claims. A future policy requiring acceptance for publication is a separate
explicit product decision. Do not rewrite historical commits or deliveries.

Keep user acceptance separate from phase trust and skill credit. This design
does not revoke credits already earned by an abandoned attempt or grant new
credits from a root acceptance badge. Any change there is a separate lifecycle
decision. Promotion and deterministic dispatch remain disabled for project runs.

## Implementation acceptance evidence

Before enabling this contract, tests must demonstrate these production paths:

- API input through coordinator, serialized child launch and runner retains
  the same immutable criterion set; malformed or unsupported shapes are visible.
- Model output and workspace files cannot erase a criterion, forge its result,
  or lower its expected value, including across branches and deepening.
- Probes cannot reach another run, the control plane, external redirects,
  symlink escapes or production application data.
- A passing candidate, a real failed expectation and an interrupted probe yield
  distinct observations. Changed artifacts and old-attempt evidence cannot pass.
- Publication binds the artifact that was checked, while legacy runs remain
  readable without receiving invented acceptance evidence.
- Generation reaching its reduced deadline cannot consume the verification
  reserve; short-to-deep transitions retain that boundary. A clock-controlled
  test crosses coordinator/child serialization and tests drain failure,
  cancellation, insufficient admission budget and verification interruption.
- Preview lifecycle reuse leaves source bytes untouched, does not share an
  interactive generation, and never turns a fail-open preview failure into
  passed acceptance. A failed acceptance preserves existing run statuses and
  publishes only its immutable actual disposition, without a badge.
- The drafting surface displays unsupported requirements, captures edits before
  launch, and makes no paid model call without the disclosed drafting budget.
- Any future persistence scenario fails on a deliberately broken application
  and passes on the corresponding working implementation, through an actual
  reload and the same container/process boundaries used in production.

These are future behavioral checks, not tests claimed to have run for this
document. No new heuristic is designed from a single live incident. Review
the selected vocabulary against the available incident corpus before coding.

## Product promises and dependencies

“Start from run N” would create a new seeded run. Existing publication overlays
additions and updates onto the parent tree; later files absent from N survive.
True restoration requires deletion semantics before it can be promised.
Imported repository runs also require an explicit source/base decision.

**Only one run may execute at a time on the host, across organisations.**
All multi-user descriptions must state this shared-lease limit. Acceptance
verification is part of that run's lifecycle and must not create an unleased
parallel execution path. A published concurrency queue or recovery SLA would
require additional implementation and evidence.
