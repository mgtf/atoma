# Decided, not built — session snapshot, 2026-08-23

Status: **snapshot, not a contract.** Every normative rule lives in the
document or `AGENTS.md` it belongs to; this file only points at them, so
nothing here may be cited as a decision. It exists because three consecutive
chantiers ended in "accepted, implement later", and a later session that
cannot see which of them were already reasoned through will re-design them.

## Landed this session

| what | where | state |
|---|---|---|
| browser-probe discriminant, one taught literal | `3ee624d` | done, regression-tested |
| supervisor-held proof attestation (A1), steps 1-6 | [review](supervisor-attestation-a1-review-2026-08-22.md), `ea9e2ec` | done and MEASURED |
| L3 → L2 obligation threading | `33ad67d` | done; found by the armed control, not by tests |
| platform-admin door for the subscription transport | [src/projects](../src/projects/AGENTS.md), `a6ff7e1` | done |
| `npm run projects` (org-scoped runs from a terminal) | [src/cli](../src/cli/AGENTS.md), `a6ff7e1` | done |
| depth-1 trace reader: a large trace stops erasing a delivery | [src/contracts](../src/contracts/AGENTS.md) | done; 11 new tests fail on the old reader |
| incremental publication: every delivered run reaches the repository | [src/github](../src/github/AGENTS.md) | done and VERIFIED against real GitHub — commit `c28afe4f`, `parents 1`, `baseSha f66b0fff` |

## Reasoned through, deliberately not built

Ordered as agreed. Each item's reasoning is in its own document; the entry
here is a pointer and a one-line status, never a restatement.

1. **Turn skill learning back on for project runs, per organisation.**
   `ATOMA_SKILL_LEARN` and `ATOMA_EVENT_SKILLS` to `1` in
   `projectRunEnvironment`, while `ATOMA_SKILL_PROMOTE` and
   `ATOMA_SKILL_DIRECT` stay `0`. Rationale and the boundary it respects:
   [platform-skill-offer-review §8 step 1](platform-skill-offer-review-2026-08-23.md).
   Needs none of the new machinery, and it is the whole product benefit minus
   the cross-tenant part. CORRECTION to how this entry first read: it is NOT
   only a variable change. The coordinator also passes `--no-learn-skills
   --no-promote-skills --no-direct-skills` as CLI flags, and
   `src/skills/AGENTS.md` records `--no-promote-skills` as the final veto over
   both env and seed — so the flags must move too, or the env change is inert.
   A project run is also structurally in maintenance mode: it is `--seed`ed
   from the previous delivered workspace, itself a promotion-enabling signal,
   which is why that veto is there.
2. **Behavioural attestation for `kind: script` candidates.**
   [§3.2 and §8 step 2](platform-skill-offer-review-2026-08-23.md). To be
   measured against §4.1(e)'s nine obfuscated payloads BEFORE it is wired to
   any decision.
3. **The offer dossier and the journaled operator approval.**
   [§3.3, §3.4, §8 step 3](platform-skill-offer-review-2026-08-23.md). Blocked
   on one operator choice, not on code: which reviewer-fatigue
   counter-measure from §6, stated in the contract rather than discovered
   later.
4. **The A1 design limit: a PHASED plan distils outside the gate.** Measured,
   recorded, and left unfixed under the cooling-off rule. Three candidate
   directions, none accepted:
   [armed controls record](incidents/a1-armed-controls-2026-08-22.md#the-design-limit-this-measured).
   Whoever picks this up designs it against all of the session's incidents at
   once, not this one alone.

Item 1 is independent of 2-4. Items 2 and 3 are each their own review, and
neither should be designed in the session that lands the one before it.

## Asked for, and what the code says about it

**Route `benchmark` and `burn-in` through admin (project) runs** — asked
2026-08-23. Recorded rather than built, because the two harnesses answer
differently and one answers no for a reason of MEASUREMENT, not configuration.

The coordinator drives a project run with `--container --no-learn-skills
--no-promote-skills --no-direct-skills` plus, when an earlier run delivered,
`--seed <that run's workspace>`.

- **`benchmark`: no.** Its own header fixes the invariant this would break —
  *"Every run of either arm gets a freshly archived workspace, so no run
  inherits its predecessor's deliverable; without that the second atoma run
  would find the artefact already on disk and 'solve' the task for free,
  which would be a measurement of the harness rather than the system."* A
  project run inherits that workspace by design. Two further blocks: the
  benchmark's central invariant is *"two arms, one code path"* (`--baseline`
  swaps one line of `runTask`), so routing one arm through the product
  launcher and not the other destroys the comparison, while routing both puts
  an experimental flag inside the production launcher; and frozen skills
  remove half of the amortisation mechanism the benchmark exists to measure.
- **`burn-in`: yes, but only after step 1 above.** Its header states its
  purpose — *"Each run also matures the skill/trust counters as a side effect
  — the harness IS usage."* Under today's project-run settings it would
  mature atom trust only, with skill counters pinned at zero: a cost-decay
  curve with its engine disconnected. Once step 1 lands, the shape that fits
  is **one project per burn-in task**, which makes the seeding coherent —
  each task evolves in its own project — instead of mixing unrelated tasks
  into one workspace.
- **What the ask probably wants, at no cost to any invariant.** Both
  harnesses are wanted VISIBLE, which is a reading problem, not a launching
  one. The gated viz refuses the operator corpus by contract, but nothing
  stops exposing that corpus TO A PLATFORM ADMIN in its own
  clearly-labelled view — operator, not org. A bounded viz change, no runner
  touched, no measurement invalidated. Proposed as the first thing to build
  here.

## Left open by the watch-placement commit (2026-08-23)

The mechanical watch now lives inside the gated viz server
([src/viz](../src/viz/AGENTS.md), [src/sentinel](../src/sentinel/AGENTS.md)).
Five questions were reasoned through during that review and deliberately not
answered in it, each because answering it is its own change:

1. **A uniqueness index on `platform_events` over (kind, run_id, dedupeKey).**
   The lease makes the double-append unreachable through supported paths; the
   constraint would make it unreachable at all, and would let `--once` run
   beside a resident watch with no possible duplicate. It is not cheap:
   `dedupeKey` lives inside the `detail` JSON, so it needs a generated column
   or a new one — a migration on a live table.
2. **Re-arming `security.flagged` for platform-admin push.** Disarmed on
   purpose: the route had never fired, and `injection-signature` is a lexical
   screen whose FALSE-POSITIVE rate nobody has measured (an element result is
   also where the system's own output comes back — a molecule that writes an
   install script and reads it back matches). It needs a noise floor from a
   burn-in batch, then one line.
3. **Deleting `viz:dev`.** It is byte-identical to `viz`, and its existence is
   most of why a third launcher name looked attractive. Removing it moves two
   pinned test strings and one line each in three docs — small, but naming
   surgery, not a placement change.
4. **What a release note says about a resident journal writer inside
   `viz:serve`.** `release:check` exercises the sentinel not at all, and
   `dist/cli/sentinel.js` appears in neither archive list in `README.md`. The
   first honest CHANGELOG entry has to name which process now watches.
5. **Whether two watchers over DISJOINT corpora should be allowed.** The lease
   is per store, not per corpus, so a server watching projects and a CLI
   watching an operator directory contend even though their dedupe keys never
   meet. Recording coverage in the lease row would allow both; it also adds a
   second thing the lease has to be right about.

## Left open by the repository-visibility commit (2026-08-23)

The public/private choice landed ([src/projects](../src/projects/AGENTS.md)).
Three adjacent gaps were verified during its review and deliberately not built,
because each is its own change and none is on the path the choice opens:

1. **The publication retry has no caller.** `POST
   /api/projects/:id/runs/:runId/publish` → `ProjectService.retryPublication`
   exists, works, is role-checked and same-origin guarded, and is pinned by
   `tests/project-publisher.test.ts` — and nothing in the client, the CLI or
   MCP ever calls it. A tenant whose publication failed has no button, while
   the push notification tells them a retry is possible. Minimum viable: one
   `retryPublication` in `data-api.ts` and one action on a run row whose
   publication is `failed`; the 502 already carries a bounded reason.
2. **A successful publication is the quietest event in the product.**
   `publication.published` pushes to the requester only, while every FAILURE
   reaches the org owners. On a User-target installation a member can therefore
   publish under the organisation's installation with no owner ever told. One
   line in `viz/push/routes.ts` (`orgOwners: true`) plus `visibility` in the
   event detail would fix both halves — but who gets paged is a policy
   decision, not a wiring one.
3. **Nobody can review what a run will publish.** The manifest never crosses
   the API in either direction, so a tenant cannot see the file set before or
   after. That is the fact that decided the default; making it reviewable is a
   product feature (an approval step before the first commit), not a default.

## Left open by the first real publication (2026-08-23)

The first end-to-end project run delivered and could not publish: `POST
/git/blobs` answers `409 "Git Repository is empty."` in a fresh repository, so
the publisher's whole flow was unreachable against real GitHub while every
test mocked the client. Fixed ([src/github](../src/github/AGENTS.md)) and
verified against a throwaway repository. Three things that run stopped at:

1. **The CLI cannot CREATE a project.** It can list, run and publish, so an
   operator can drive everything except the one step that needs a repository
   target and an installation choice — which is a product surface (name, slug,
   repository name, visibility) and not obviously a terminal's business. Worth
   deciding rather than drifting into.
2. **A repository that exists out-of-band bricks its project.**
   `REPOSITORY_TRANSITIONS.ready = []` is deliberate, and a `main` ref that
   appeared by any means other than a publication makes every future publish a
   divergence refusal with no way back. That is the correct refusal and the
   wrong dead end; the missing piece is a supported way to point a project at a
   different repository name, or to retire it.
3. **`publication.published` still pushes to the requester alone** while every
   failure reaches the org owners — see the visibility entry above. Unchanged,
   because who gets paged is a policy decision.

## The one product gap the third run exposed (2026-08-23)

**Only the FIRST delivered run of a project can publish.** Measured: run 2 of
`stopwatch-e2e-two` was refused with `GitHub repository branch already exists;
initial publish refused` — correctly, because `publishInitialCommit` is exactly
that, an INITIAL commit, and its divergence guard cannot tell our own previous
publication from somebody else's branch.

The copy has been corrected so nothing lies (`projects.actionsHint.ready` used
to promise that later runs add features, which they do — locally, unpublished).
The feature itself is a fork worth stating before anyone builds it, because it
decides what a project's repository IS:

- **A snapshot per run.** Every publication force-moves the branch to the run's
  manifest. Simple, and it throws away history nobody agreed to lose.
- **A history.** Each publication commits on top of the current head, with the
  head sha as an optimistic-concurrency check — the divergence guard becomes
  "the branch moved under us" instead of "the branch exists". This is the
  normal git shape and what a customer expects from "later runs".
- **A branch or a pull request per run.** Nothing is ever overwritten and a
  human merges. The most honest for unreviewed model output, and the most
  machinery.

The second is probably right, and it needs `parents: [head]` plus a ref update
the client already has (`updateReference`, added for the multi-file seed). None
of it should be decided by whoever happens to be in the file.

## What the fourth run's browser probes exposed (2026-08-23)

Measured on project run `a786358a`: **25 `validate_html` calls, 14 failures**.
Two were pre-flight refusals (a `getComputedStyle` compared to a literal
`rgb()`, and interactions that repeated a control then reset before the smoke
ran); twelve were smokes that ran and whose own assertions came back false —
`themeToggledToDark: false`, `beforeResetElapsedGreaterThanZero: false`, all of
them about an intermediate state the probe had already erased.

**The contract already had the answer.** `smokeDrivesOwnState` empties the
interaction list when the smoke drives the app itself, and the `smoke`
description says it: *drive/snapshot the milestone INSIDE the IIFE before
reset; the final DOM cannot prove an erased intermediate state.* So this was
not a missing capability. It was fourteen round trips spent rediscovering a
capability we own, one diagnostic at a time.

**Landed** (legibility over evidence already in hand, which the cooling-off
rule permits — no smoke is refused that was not refused before):

- `preflightSmokeRefusals` consults all three detectors and returns every
  refusal that applies. Two problems used to cost two refusals.
- `renderSmokeFailure` NAMES the false boolean fields instead of pasting the
  result object and leaving the caller to diagnose its own output — including
  when the 500-char truncation would have cut the failing field off.
- The erased-state refusal quotes one accepted smoke verbatim
  (`SMOKE_SELF_DRIVEN_EXAMPLE`), and a test asserts the pre-flight accepts it:
  advice we hand out must never be advice we refuse. It lives on the error
  path deliberately — prompt text is paid on every call, an error message only
  by the caller who already got it wrong.

**NOT built.** A six-agent review of the trace (25 calls read one by one, every
detector executed against the real payloads) produced the list below. Each
entry changes a DISPOSITION — what a detector accepts — which the cooling-off
rule forbids today. Two of them are landed drift, VERIFIED BY EXECUTION, not
hypotheses:

1. **`smokeOkIncludesStyling`'s frozen literal.** It matches
   `/Object\.values\(checks\)\.every\(Boolean\)/` — the identifier from the
   canonical prompt shape. Call #2's smoke asserted the colour change inside
   its aggregate and was overridden anyway, because the object was spelled
   `allChecks`. A pure rename flips the predicate with zero change to what is
   asserted. The model responded to the message by strengthening the assertion
   it was already making — which cannot move a name-based detector — and never
   escaped the gate in 25 calls. Today's commit makes the finding legible and
   names the two accepted spellings; it does not widen the predicate. The sharp
   objection to that is accepted: naming the accepted spellings invites the
   cheapest compliance, a rename, which is the cargo-cult the frozen literal
   already rewards.
2. **`webStylingEvidenceMissing` (src/atoms/resultGates.ts) — THE STRUCTURAL
   CAUSE OF THE WHOLE RUN, and nothing in today's commit touches it.** It
   requires `/(?:milestone|afterIncrement|afterClick|streak.?3)/i` AND
   `/(?:reset|final)/i`. Exactly 1 of 25 smokes satisfied it, by accident, on a
   FAILING call, because it happened to contain a check named
   `stopwatchStartedAfterClick`. A theme-toggle smoke naturally writes
   `afterToggle`, `bgAfter`, `colorAfter` — none match. Call #1, the FIRST call
   of the run, used the canonical idiom correctly with `ok:true` and 11/11
   checks, and was rejected by it; three consecutive L2 verdicts then rejected
   PASSING calls and coached the model toward more `getComputedStyle` reads,
   into the transition race the tool's own guidance warns about. No amount of
   legibility reaches an unsatisfiable gate.
3. **Making the erased-state refusal reachable for a self-driving smoke.** It
   is DOUBLY unreachable: `interactions` is emptied before the detector is
   consulted, AND the detector has its own `smokeDrivesIntermediateState`
   escape. Passing the pre-filter list would refuse payloads currently
   accepted.
4. **Promoting `ignoredInteractions > 0` to an error when the smoke also
   failed.** Today it stays a warning that now states its consequence.
5. **A detector for the interleaving misconception** (5 calls, the most
   expensive mode: the caller believed the smoke observed the page BETWEEN
   interactions) **or for a settle shorter than the source's own declared
   transition duration** (2 calls plus one FALSE PASS at #16, which observed
   transition progress and proved nothing — no gate in the product can catch
   that).
6. **Interaction checkpoints** (`{type:'snapshot', name, expr}` evaluated
   in-page during the loop). The review argued for this and then withdrew it:
   call #23 proves the existing surface could express the proof. It forces four
   contract changes and it RETRACTS the mutual-exclusivity sentence three of
   today's edits rest on. Before designing it, measure over archived web
   traces: how many `validate_html` calls re-drive state solely to obtain a
   before/after, split by whether the artefact exposed a hook. Below ~25% of
   web smoke failures it is not worth the four contract changes.

**Two closing observations that no edit addresses.** First, a hole survives
today's commit: `bodyBg.includes('25') || bodyBg.includes('26')` still passes
pre-flight, because `detectBrittleComputedStyleLiteral` only matches
`=== 'rgb(`. That substring hack is strictly more brittle than what the guard
refused, and it PASSED. Second, and larger: **every recovery in the trace is a
DELETION, and the deleted thing is always the requirement under test.** Colour
assertions deleted after the transition race; `getComputedStyle` deleted after
the rgb refusal and replaced with the tautology
`finalTheme === 'dark' || finalTheme === 'light'`; the theme claim deleted after
the discard trap and restored as a substring hack. Nine of the eleven PASSES
advanced the page by nothing. Nothing in this commit makes deletion more
expensive than correctness, and a clearer message plausibly produces a
better-targeted deletion rather than a better probe. The pre-registered check
for the next web run is therefore NOT "did the messages improve" but the same
ratio measured the same way: the contract-versus-artefact split of
`validate_html` calls (22 versus 3 here), plus a zero-count assertion that no
error string contains `smoke check failed` above an object whose `ok` is true.

## The envelope, measured one notch up (2026-08-23, expenses-node-api)

One goal, deliberately one size above the stopwatch lineage: a Node HTTP
server plus a JSON API plus a front-end, no external dependencies. Two runs,
both failed, both worth more than a delivery.

**Run `d771d166`** died at 6.5 min on `"preferredChild": null` in the L3's
second-phase plan — fixed same day (`afa6d09`) by extending the schema's own
documented null-tolerance pattern to the two fields it missed. Only
multi-phase goals reach a second L3 plan, which is why three days of
single-page runs never saw it.

**Run `949ecd5d`** hit the real walls:

- **The 900s budget, at 68 tool calls / 34 LLM calls / $0.96.** The
  post-mortem's own advice is `ATOMA_BUILD_TIMEOUT_MS`; whether project runs
  should carry a higher default than operator runs is a product choice, not a
  session edit.
- **The trace: 1.17 MB, ~17 KB per tool call.** Had the run delivered, the
  512 KB control-plane cap (`MAX_CONTROL_JSON_BYTES`) would have refused it —
  the same defect that erased run `2857a579`'s delivery. The cap binds at
  roughly 30-60 tool calls, i.e. INSIDE the working range of any multi-file
  goal. Fix direction still undecided (bound-per-field read vs. verification
  as a publication precondition, not a delivery condition).
- **The structural wall: a live process does not cross phases.** The back-end
  molecule booted its server (`start_node_server :38197`), proved the API with
  fetch_url probes, and its sandbox cleanup — mandatory, a contract — killed
  the server with the phase. The front-end molecule then had no live API, was
  not tooled with `start_node_server` or `fetch_url` at all (its declared
  tools were the static six), and did the only things its toolset allowed:
  static server → eight /api 404s, then five guessed ports. Thirteen of its
  sixteen validate_html calls were structurally unable to succeed. Message
  fixes landed (`fbe9306`); the real design question — how a phase whose
  artefacts are coupled through a live process hands that process (or the
  responsibility to restart it) to the next phase, and how the L2 tools the
  receiving molecule — is an atoms/registry design, not a tools edit, and is
  NOT designed here.
- **Chords:** `Unknown key: "Control+A"` ×3 — remedy now on the error path
  (`fbe9306`). Translating chords into modifier sequences would be a
  capability change; recorded, not built.

**What the same run proved in the right direction:** the false-field naming
from `bc518ba` fired live — eight of nine smoke failures named their failing
checks, and the sequence narrowed (`labelAppearsInList, totalUpdated` →
`totalUpdated` → `totalShows550`) across consecutive calls, which is the
learning curve the naming was built to produce. And the failed row kept its
cost (`stats_json` populated on `failed`), which run `a786358a` had lost.

## What the trace-cap design panel settled, and the ten it recorded (2026-08-23)

Fifteen agents: two grounding, four independent designs, eight adversarial
reviewers (a security lens and a contract lens per design), one synthesis.
What shipped is the depth-1 projecting reader
([`src/contracts/traceFields.ts`](../src/contracts/traceFields.ts)). Three
receipt-based designs were rejected, and the reason is item 1.

1. **THE RECEIPT CHANNEL IS FORGEABLE FROM THE TENANT'S GOAL.** The most
   valuable finding of the round, reproduced end-to-end by one reviewer against
   the compiled parsers, and verified again by hand before this was written.
   The chain: `projectGoalSchema` is `z.string().trim().min(1).max(4_000)` and
   permits newlines (`src/contracts/projects.ts:58`); `buildTask` sets
   `description: goal` verbatim and `runner.ts:720` prints it at second zero;
   `builtin.ts` echoes the model's own argv; `containerExecutor.ts` forwards
   worker stderr from a handler that outlives the terminal epilogue;
   `spawnRun` merges stdout and stderr into one string; and
   `parseRunStatsEpilogue` is a last-valid-wins LINE SCAN after `.trim()`, with
   NO binding to a run id. On a normal run the runner's real epilogue wins by
   position — but `burnin.ts`'s hard-reap path prints prose only, so a forged
   line can be the ONLY receipt. What stands between that and a forged
   `delivered` today is `verifiedTrace`, i.e. the trace itself; the three
   rejected designs each deleted it. Two candidate closures, neither built: a
   runner-written receipt FILE via a path env var (tmp+rename, read under the
   surviving bound — the `ARTIFACT_MANIFEST_PATH_ENV` precedent), and/or a
   coordinator-minted nonce echoed in the epilogue. Record alongside it that
   `projectRunId`'s present unforgeability is an ACCIDENTAL secret nobody
   designed, protected or tested, and it breaks the moment anyone forwards
   `ATOMA_RUN_ID` into the container, mounts the run root, or runs project work
   on the host backend.
2. **"No `ATOMA_RUN_STATS` epilogue means not delivered."** `parseRunLog` falls
   back to a prose vote on `/✓ build finished/` over a log that contains
   model output. A real hole, a new mechanical gate, and not safe on its own
   while item 1 stands. Decide it WITH item 1, not before.
3. **`degraded` on `runStatsSchema` — decided against, not merely deferred.** It
   would be a second carrier of one fact, defaulted fail-open across a
   `dist/`-versus-source build boundary, whose only consumer is a decision the
   trace already answers unforgeably.
4. **Whether degraded work is deliverable, publishable and SEEDABLE.** Two of
   the rejected designs would have made a fallback-produced workspace the seed
   for run N+1 through `previousDeliveredWorkspace`. `src/viz/friction.ts`
   already refuses to LEARN from such a run. This is a judgement about model
   output — exactly what the cooling-off rule targets.
5. **Post-delivery refusals as non-destructive, and where a withheld reason is
   stored.** The store forbids `error` on a delivered row, `reservePublication`
   requires a manifest hash, and the platform event vocabulary is a closed
   enum — so "delivered but withheld" is a state the schema cannot currently
   express. Three options to cost out: a nullable typed withholding field with
   the CHECK relaxed; a manifest-hash-free publication row; a new closed event
   kind with its severity mapping.
6. **Incremental publication, and a per-project staleness surface.** Now
   MEASURED, not theoretical: `project_publications` holds three rows —
   `8597ec79` published to `mgtf/atoma-e2e-stopwatch-2`, and `a06b09ff` (the lap
   button, trace 360_820 bytes, UNDER the old cap) refused with *"GitHub
   repository branch already exists; initial publish refused"*. So the real
   repository still shows a stopwatch with no laps. The trace-cap fix makes this
   MORE FREQUENT, not newly possible, which is why holding the erasure fix
   hostage to a GitHub-flow design was rejected. Includes: may
   `repository_status = 'ready'` keep claiming currency while the repository is
   N runs behind?
7. **`MAX_CONTROL_JSON_BYTES` versus its own schema's bounds.**
   `declaredArtifactManifestSchema` permits roughly 1.05 MB of schema-legal
   declarations while 512 KB is enforced — the same defect class through a
   different door, reachable with no large trace at all.
8. **The cost drop on a trace-refused delivery.** `finish()` keys its stats
   exclusion on the PARSED outcome, so a run the runner called delivered and the
   trace refused persists `stats_json = NULL`; `2857a579` lost $0.8421 and one
   learned skill. Pinned by a test that asserts the CURRENT behaviour on
   purpose. The repair is a store-contract decision (a `failed` row may not
   carry `delivered` stats), not a one-line change.
9. **PARTLY CLOSED, and the rest deliberately left.** `summarizeTraceFile` no
   longer whole-parses with NO bound on the gated `/api/runs` path: it is now
   held to the shared 32 MiB ceiling and fails SOFT, skipping the row, which is
   this subsystem's disposition rather than the coordinator's. Its header key
   names are pinned against `VizRun` with `satisfies`, which closes the "do not
   duplicate interfaces" violation without claiming types a file may not hold.
   NOT done: actually PROJECTING it. The row needs `totals.calls` and
   `totals.costUsd`, which live BELOW depth 1, where the reader gives shapes
   rather than nested values on purpose. Extending it to capture a bounded
   container would work, and is not built in the session that shipped the
   reader. The sentinel's `readBoundedJson` was already bounded; what remains
   there is that it materialises up to the ceiling per synchronous tick. The
   accurate claim stays narrow: the COORDINATOR'S delivery decision
   materialises under 400 bytes.
10. **A writer-side cap on `result.summary` and `result.output`.** `output` is
    typed `unknown` and passed through uncapped; 11 KB is the largest observed,
    with nothing in code preventing more.

Two honest limits of what shipped:

- **The in-scan byte counter is not covered behaviourally.** Both stat checks
  shadow it for a regular file, so triggering it needs a concurrent writer
  appending between the stat and the read — a race the suite cannot make
  deterministic. It is kept because a stat is stale the moment it returns and
  the child owns that directory. Stated in the test file too.
- **No real-child DELIVERED run is tested.** The FIFO case crosses a process
  boundary and `runner-cancel-epilogue` crosses one for a cancelled run, but a
  delivered real child needs a stubbed L3-L2-L1 chain the suite does not have.
  The bug's boundary was reader-versus-file, so this is acceptable; closing it
  means extending the ollama stub to complete a full protocol, which is worth
  doing for other reasons.

And one finding from the same session that is a decision, not a defect:

- **A project run has no timeout lever.** `coordinator.ts` hard-codes
  `15 * 60 * 1_000`, neither construction site passes `timeoutMs`,
  `projects run` has no `--timeout`, and `spawnRun` writes
  `ATOMA_BUILD_TIMEOUT_MS` AFTER spreading the caller's env — so an operator's
  exported value is silently overwritten. "Raise the timeout", which run
  `949ecd5d`'s own post-mortem suggested, is therefore unreachable advice. The
  fix is small (an option, a flag, and `extraEnv` instead of `env`); the DEFAULT
  is the operator's call.

## What incremental publication settled, and what it left (2026-08-23)

Ten agents: three designs, six adversarial reviewers, one synthesis. What
shipped is `publishManifestCommit` — the head read decides, `expectedHead`
authorises, `base_tree` merges, `force: false` untouched. Two of the safety
reviewer's three fatal findings against the first design were verified by hand
before anything was written, and they changed the design:

- **The empty-branch precondition was the only guard against writing into a
  repository atoma never created.** `ensureRepository` ADOPTS a pre-existing
  repository on a 422 name collision, checking only its visibility. Deleting
  the precondition without replacing it would have let atoma commit into a
  stranger's repository. `expectedHead` is the replacement, and it is now stated
  rather than being a side effect.
- **Two projects of one organisation can name the same repository.** The
  projects DDL carries only `UNIQUE (project_id, org_id)` and
  `UNIQUE (org_id, slug)` — nothing on the repository owner/name. The second
  project now gets a permanent, honest divergence refusal instead of a silent
  overwrite.

Not built, deliberately:

1. **MANIFEST-DECLARED DELETION.** A path published once cannot be removed by
   publication, and a rename leaves the old path with stale content. Any signal
   that expresses deletion — a completeness assertion, an explicit deletions
   list — redefines what a declared output set MEANS, which is squarely inside
   COOLING-OFF. The rejected design's `--allow-removals` flag is not the answer
   either: it authorises an unbounded set.
2. **A supported way to re-point or retire a project**, now with two symptoms:
   a renamed default branch and a deleted branch both end at
   `GitHubBranchGoneError` with no in-product repair.
3. **The create-path partial seed still bricks a project.** The contents seed
   lands a real commit before anything else, so a crash there leaves a branch
   with one file of N and no published row; the next attempt sees
   `expectedHead === null` against a populated branch and refuses, permanently.
   This is exactly the old behaviour, not a regression, and the refusal now
   names the head so an operator can recognise their own half-seeded publish.
   Two candidate repairs: record the attempted commit sha, or adopt the tip by
   observation.
4. **CLOSED.** `projects_org_repository_target_idx` is a unique INDEX, created
   in the guarded migration rather than in the table DDL: SQLite cannot add a
   UNIQUE by `ALTER TABLE`, and a rebuild would leave fresh and migrated stores
   with different schemas. It is wrapped, because a store that already holds a
   duplicate pair cannot create the index and failing to OPEN would be far worse
   than failing to enforce — the operator is told loudly which pair to resolve,
   and the duplicate is never touched. `createProject` also refuses early and by
   name, slug first, because the slug is the project's own identity and a caller
   who reused it wants to hear that. Both conflicts are now HTTP 409 from a
   typed error, replacing a regex over one driver's prose that said "slug" for
   every collision.

   The reason this was worth closing now: since publication became incremental,
   the second project only learned of the collision AFTER running and spending —
   its first publish read a branch it does not own and was refused permanently.
5. **CLOSED.** The publish bound was one number doing two unrelated jobs. It is
   now two: `MAX_GITHUB_PUBLISH_FILE_BYTES` (20 MiB) is DERIVED — every file
   travels as its own base64 request body and base64 inflates by 4/3, so the
   30 MiB body cap allows 22.5 MiB of content — and
   `MAX_GITHUB_PUBLISH_TOTAL_BYTES` now MATCHES
   `DEFAULT_ARTIFACT_LIMITS.maxTotalBytes` at 50 MiB, so a manifest the artifact
   policy accepted at delivery can no longer be one publication refuses for
   ever. `src/github` may not import `src/projects`, so nothing in the type
   system holds the two together: a test asserts all three ceilings dominate
   their artifact-policy counterparts, and that the per-file bound survives
   base64 inflation.
6. **Blob diffing**, so unchanged paths are not re-uploaded on every attempt
   including a no-op; and the orphan git objects a refused attempt leaves.
7. **A no-op publication still pushes "Published to <repo>"** at the transport
   level, because the push routes key on event kind alone. The event SUMMARY now
   says "No change to publish", which is the honest half that was cheap.
8. **A `publication.diverged` audience decision** for `baseSha` differing from
   the previous publication's commit — the store-only, network-free record that
   something outside atoma moved the branch. Nothing reads it yet.
9. **The commit message body carrying the run goal.** Two reviewers
   independently flagged what lands in a tenant's repository as its own
   disposition. The message stays byte-identical.
10. **The path-versus-directory collision under `base_tree`** (a manifest blob
    at `docs` where the base tree holds `docs/`). GitHub's exact behaviour is
    unmeasured; the guarantee is therefore stated narrowly — no path ABSENT
    from the manifest is removed, except where the run itself changed the type
    at that path.
11. **`force: false` is a fast-forward test, not a compare-and-swap.** A human
    who resets the branch to an ancestor inside the window gets rolled forward.
    GitHub's ref API has no expected-old-sha, so there is no cheap close; the
    next publication observes it through `baseSha`.
12. **`POST /git/trees` against the 1 MiB response cap** as a merged tree grows.

Two deviations from the synthesis, both mine and both stated:

- **The stateless `mockClient` in `tests/project-publisher.test.ts` was NOT
  deleted.** The synthesis wanted it gone and retyped so a stale commit
  override became a type error. It survives, renamed, with a comment saying it
  is a CALL-SHAPE stub on which no behavioural claim may rest — because the
  tests that use it are about the repository lifecycle and the token split, not
  about what reaches a branch. Every behavioural claim moved to
  `tests/github-incremental-publish.test.ts` and to the two-run cases, which
  drive the REAL client over a stateful fake GitHub.
- **`projects show` does not exist**, so the staleness line went on
  `projects list`.

## The chained two-run build, measured (2026-08-23, expenses-node-api)

The thesis test: build the expense tracker as TWO runs of one project instead of
one, each seeded from the last. Both delivered.

| run | what | outcome | cost | llm | tools | trace | wall |
|---|---|---|---|---|---|---|---|
| `c1f30d1f` | API only, no front-end | delivered | $0.2968 | 10 | 21 | 274 KB | ~240s |
| `ef70c2b8` | front-end, seeded | delivered | $1.69 | 26 | 122 | **1.19 MB** | **1294s** |

**BOTH OF TODAY'S FIXES WERE INDIVIDUALLY NECESSARY FOR THE SECOND DELIVERY TO
EXIST.** 1294s is past the old 900s budget, so the run would have been killed
at roughly two thirds of the way; 1,190,050 bytes is 2.27x the old 512 KB
control-plane cap, so had it survived the clock it would then have been recorded
`failed` and erased. Neither fix was sufficient alone. The seed also worked: run
2's workspace held `server.js` and `expenses.json` before it started, and the
delivered manifest is `app.js`, `index.html`, `server.js`.

**And the front-end was never validated in a browser against its own API.** All
38 `validate_html` calls ran against a STATIC server, which structurally cannot
serve `/api/expenses`, so every one of them carried an unavoidable
`404 (File not found) [source: .../api/expenses]`. The run's last four browser
probes — run by the L2 itself — are all `ok: false` for exactly that reason, and
the final smoke checks only DOM presence (`hasExpenseList`, `hasTotal`,
`hasForm`, …): the page's SHAPE, never its behaviour against the API. The run
was still recorded `delivered`, `degraded: false`.

The integration WAS proven, separately and at the HTTP level: a later molecule
(`Methane/L1`) started the real server and fetched `/`, `/app.js` and
`/api/expenses` three times, all ok. So the deliverable is plausible; what is
missing is the one thing only a browser can show, which is that `app.js`
actually renders the list and posts a new expense against the live API.

**This CORRECTS the earlier diagnosis.** The 2026-08-23 envelope note said the
wall was that a live process does not cross phases. True, but not the binding
constraint here: the binding constraint is a TOOLSET PARTITION. `Ethanol`,
`Methanol` and `Tracheid` held `start_static_server` + `validate_html`;
`Methane` held `start_node_server` + `fetch_url`. No molecule in this run ever
held both a real server and a browser at the same time — which is why 38 browser
probes could only ever look at a page whose API was absent, and why the API's
proof came from a tool that cannot see a rendered DOM.

Not built, and deliberately not designed tonight (COOLING-OFF — these are
judgements about model output and about planning):

1. **Giving one molecule both a real server and a browser**, or teaching the
   planner that a front-end phase validating against an API needs the
   node-server tool. Precise evidence now exists; the fix is a
   registry/planning design with its own review.
2. **Whether a run whose final browser probes all failed may be `delivered`.**
   Four consecutive `ok: false` results, each naming the same 404, did not stop
   this run. Whether that should gate — and how, without making an unavoidable
   static-server 404 fatal — is exactly the disposition the cooling-off rule
   exists for.
3. **Suppressing the unavoidable 404.** A static server serving a page whose
   script calls an API will always produce it, and the noise cost is real: a
   share of 26 LLM calls went into chasing a symptom that no edit to the page
   could remove. Any suppression is a new detector, so it is recorded.

## The forgeable receipt: reproduced, designed, and not built (2026-08-24)

Eleven agents reviewed it. What SHIPPED is only the cheap half — the prose
fallback now fails closed (`adae87e`). The durable fix is designed and its two
load-bearing facts are MEASURED on this machine, and it is deliberately not
built in the session that found the hole.

**Reproduced first**, driving the real parsers with a goal that carries a forged
line:

    A: the runner also prints its honest epilogue  -> failed | cost 0.02   safe
    B: HARD REAP, no honest epilogue               -> delivered | cost 0
    C: no epilogue at all, prose vote only         -> delivered
    D: the goal forges the PROSE MARKER            -> delivered

Case D was not in the earlier record and is the simplest: one string, no JSON,
and it beat the log's own `✖ build failed`. That is what `adae87e` closes. Cases
B and C need the same precondition — no valid epilogue — and remain open.

**TWO MEASURED FACTS, and neither is what a reasonable person would assume.**

1. **The environment cannot hold a secret.** `ps eww -p <pid>` on a `node`
   process of the same user PRINTS its environment, even when the child was
   launched with `env -i`. So `run_shell` — `bash` is allowlisted — can read
   anything passed to the runner in its environment, which kills every
   nonce-in-the-environment design. Verify with a `node` target, NOT `/bin/sleep`:
   platform binaries have restricted introspection and testing one nearly made
   this session reject the finding as false.
2. **stdin is the channel that survives; fd 3 is not.** Through the real `npm`
   layer, a child writing to fd 3 gets **ENXIO** — npm forwards only 0, 1, 2 —
   while a key written to stdin arrives intact, and a `run_shell`-shaped
   grandchild inheriting stdin reads EMPTY, because the parent wrote once and
   ended and the pipe is at EOF. Note `sh -c` alone DOES forward fd 3; the hop
   that matters is npm's, so any test of this must go through it.

**The design, ready to implement.** A new `src/contracts/runReceipt.ts`: the
parent mints a 32-byte key and writes it to the child's stdin as one line; the
environment carries only the receipt PATH, which is not a secret; the runner
writes a receipt file (tmp+rename, mode 0600) whose body is the existing
`runStatsSchema` plus an HMAC over `version | runId | emittedAt | the canonical
epilogue`, so the on-disk receipt is useless to a reader and a future stats field
enters the MAC automatically. `runStatsSchema` is imported, never extended. The
reader is TOTAL and returns a discriminated union — `verified`, `absent`,
`unreadable`, `forged` — where `forged` is a security event and not a data point.
The receipt is written BEFORE the epilogue line, because the line is the losable
channel: the watchdog's default is `process.exit(1)` on the next statement, and
`writeFileSync`+`renameSync` complete across it. The decision function takes a
facts object with NO `log` field, so it structurally cannot read prose.

**Why it is not built tonight**, stated plainly: it changes the runner's four
epilogue sites, `spawnRun`'s stdio, and what a burn-in and a benchmark row MEAN.
The measurement harnesses' comparability is load-bearing here, and one of the
review's two central claims was half-wrong when checked (fd 3 survives `sh -c`
and dies at npm), which is the sort of detail that decides whether this works.
Building it at the end of the session that found the hole is exactly what the
cooling-off rule exists to prevent, even though a trust boundary is not a
disposition about model output.

**Still open, and now narrower.** With `adae87e` the prose vote can no longer be
used to claim delivery. What remains is cases B and C: a hard-reaped or
crashed-before-teardown run, where a forged `ATOMA_RUN_STATS` line from the goal
is the only receipt. For project runs `verifiedTrace` refuses it — accidentally,
not by design. For a burn-in or benchmark CSV nothing refuses it.

## Incremental publication, verified against real GitHub (2026-08-24)

The commit shipped tested only against a stateful fake. This is the part no fake
could establish, run against `mgtf/atoma-e2e-stopwatch-2` — and it also FIXED the
live defect rather than merely demonstrating it.

**Read first, zero writes.** The induction base held exactly: `readBranchHead`
returned `{state:'head', sha:'f66b0fff…'}`, the recorded publication and nobody
had moved the branch since; `getCommit` returned its tree and **0 parents**, a
root commit, consistent with the one-file contents seed; the tree had **exactly
one entry**, `index.html`, mode `100644`, 6 614 bytes, whose sha256 is
byte-identical to what run `8597ec79` declared in its manifest.

**Then the write.** Publishing `7baaa773` produced commit `c28afe4f`:
`baseSha = f66b0fff` (the observed head), **`parents 1`** where the previous head
had 0 — so the incremental path ran — and a tree of one entry at **11 981 bytes**
holding both the lap button and dark mode. The repository now shows what the
tenant watched being built, instead of the bare stopwatch it had shown since
09:13. So `readBranchHead` → `getCommit` → `createBlob` → `createTree(base_tree)`
→ `createCommit(parents:[head])` → `PATCH force:false` is verified end to end.

**The order gate too.** Publishing `a06b09ff` afterwards is refused with its own
sentence, exit 1, and the branch unmoved.

**A CORRECTION TO THIS FILE, and a live example of item 3.** The register said
`bbc7dd85` / `mgtf/atoma-first-e2e-test` was `ready` over an EMPTY repository
whose only publication died at `POST /git/blobs` 409. It is not empty. Its `main`
sits at `bbc125b5` with **1 parent and git's canonical empty tree**
(`4b825dc642cb6eb9a060e54bf8d69288fbee4904`) — at least two commits and zero
files at the tip. `createRepository` sends `auto_init: false`, so atoma never
asked for that state. Whatever produced it, the consequence is exactly the brick
recorded as item 3: that project has **zero** published publications, so
`expectedHead` is NULL, so the next attempt reads a populated branch and is
refused permanently by `GitHubDivergenceError`. Recorded, not repaired — the two
candidate repairs are unchanged.

**STILL UNVERIFIED, and it is the one assumption a read cannot reach:** whether a
reference read on a genuinely EMPTY repository answers 409, which is what
`state: 'empty'` is built on. Neither existing repository is empty and
`mgtf/expenses-node-api` does not exist yet. Note the exposure is narrow: on a
FIRST publication both 409 and 404 take the same seed path, because the branch is
not a head either way. The discrimination only decides behaviour for a project
that HAS published — 404 then means the branch was deleted, 409 that the
repository was emptied — and that is the case a throwaway repository, or simply
publishing the expenses project, would settle.

Also unverified, as before: `PUT /contents/{path}` naming an absent branch of a
NON-empty repository. `tests/github-api-fake.ts` answers 404 there and says in a
comment that it is unmeasured.

## Publication by local clone, and the pull that would sync client edits (2026-08-24)

Asked: instead of composing commits through the REST API, `git clone` the
project's repository, push after each run, and `git pull` so a client editing
the repository directly stays in sync. Recorded as TWO questions, because they
have different answers — a transport choice and a product-semantics choice —
and the second is the one that matters.

**The fact that frames both, verified in `publishManifestCommit` before this
was written: a moved branch does NOT brick a project that has published.** The
incremental path deliberately does not require `head === expectedHead` — it
merges onto the OBSERVED head's tree, parents the commit on the observed head,
and records that head as `baseSha`. So a client's direct commits stay in
history, and their edits to paths the manifest does not name survive on the
branch. What does NOT exist is the reverse direction: the workspace seeds from
`previousDeliveredWorkspace`, never from the repository, so the runs never see
a client edit — and every publication OVERWRITES the client's version of any
path the manifest names, silently, with a file generated by a run that never
saw their change. `baseSha` records that somebody moved the branch; item 8
above stands — nothing reads it. That one-directional steamroll is the real
gap the ask points at.

**The transport half, on its own: not worth it now.** What the git protocol
would genuinely buy over the REST client:

- `push --force-with-lease=<ref>:<sha>` is a true compare-and-swap; the ref
  API has no expected-old-sha, which is item 11 of the incremental-publication
  section — the one window that has no cheap close today.
- No empty-repository seed dance: `git push` to a repository with no commits
  just works, deleting the whole contents-API-first mechanism.
- Idempotence for free: `git commit` refuses an empty commit, which is
  `T1 === T0` without building it.
- Ruleset refusals arrive in stderr WITH their message, where `GitHubApiError`
  carries no body — the `moved`/`blocked`/`unknown` re-read would be legible
  directly.
- Copying manifest files over a checkout and committing gives the
  merge-never-delete semantics for free.

What it costs: it rewrites a subsystem verified end-to-end against real GitHub
yesterday, with every edge (409-vs-404, parent count, adoption on 422, the
order gate) already encoded in tests; it puts a `git` binary and subprocesses
inside a control plane that today publishes with in-process HTTP and zero disk
state (a `doctor` rule, version drift, hung children); it creates per-project
clone state that grows with history — or a shallow clone's network cost per
publication — plus a locking story for the clone directory; and the one-hour
installation token must never reach `.git/config`, a remote URL, or argv, and
the forgeable-receipt session measured that `ps eww` prints a node process's
ENVIRONMENT — so the only safe shape is per-invocation `http.extraheader` /
`GIT_ASKPASS`, a new secret-handling surface. Marginal gain over a transport
that just started working; not now.

**The sync half is a fork about what a project's repository IS — the same
fork as "The one product gap the third run exposed", extended to the read
direction.** Two coherent policies, neither designed here:

1. **The repository becomes the source of truth.** Run N+1 seeds from a clone
   of the repository instead of from the previous delivered workspace. Client
   edits integrate at seed time with no merge machinery (the repo IS the
   base); the first-publish divergence family shrinks; and deletion becomes
   expressible — the thing publication deliberately cannot say today. The
   measured cost: anything a run kept in its workspace WITHOUT declaring it is
   lost between runs. Concretely, run `ef70c2b8` seeded `server.js` AND
   `expenses.json` while the delivered manifest was `app.js`/`index.html`/
   `server.js` — repo-as-source would have dropped the data file the API
   depends on. A client push landing DURING a run still collides at push
   time; `--force-with-lease` detects exactly that, and "refuse, the next run
   pulls" is a coherent disposition. And it admits a new input class that must
   be stated, not slipped: tenant-authored file content entering what the next
   run reads and executes in the container (egress-off bounds it; nothing has
   accepted it).
2. **Workspace lineage stays; the overwrite becomes legible.** Keep the repo a
   write-only projection, but stop being silent about the steamroll: decide
   the `publication.diverged` audience (item 8), surface "this publication
   replaced content somebody pushed" from the `baseSha` the store already
   holds, and/or mark the project dirty from the push webhook — the signal
   already arrives at `/webhooks/github` without polling.

**The coupling is the actual decision.** Choosing (1) is when the local-clone
transport justifies itself in one move — pull/merge is what git does natively
and what the REST API does worst, so the two changes are one review. Choosing
(2) keeps the current transport exactly right. Deciding the transport first,
alone, forecloses nothing and gains almost nothing; decide the semantics
first.

## Waiting on the operator

Not code — these cannot be done from an agent session.

- **Identity and organisation.** The 2026-08-22 "fresh clone" reset deleted
  `~/.atoma` and the product store, so the principal, the organisation and
  both projects are gone. The supported restore is a login, not a SQL edit:
  `npm run viz:dev` → GitHub login (recreates principal + org) →
  `npm run auth:dev -- grant-admin --principal <id-or-email>` → create a
  project in the Projects tab. Until then `npm run projects -- list` is empty
  and has nothing to target. The pre-reset rows and both old projects are in
  `~/atoma-archives-preserved/pre-fresh-clone-reset-2026-08-22T18-52-20Z/`.
- **The worker image.** `atoma-worker:latest` is listed by `docker images`
  but `docker image inspect` reports `No such image`, while `:f9test`
  inspects fine — a broken tag in the local image store. `atoma doctor` is
  RIGHT to call it not installed. Project runs force `ATOMA_CONTAINER=1`, so
  they need `npm run build:worker` first.
- **The reviewer-fatigue choice** for item 3 above.

## Facts a later session should not have to re-derive

- Project runs and operator runs are two corpora that never mix, so a
  measurement that depends on skill learning cannot be run as a project run
  while item 1 is unbuilt — and after item 1, still not one that depends on
  promotion or deterministic dispatch. See
  [src/projects](../src/projects/AGENTS.md).
- The armed-control method earned its keep: the L3 threading defect was
  invisible to 2419 green unit tests because every one of them declared the
  obligation at the tier that consumes it. A gate that crosses tiers needs a
  test that crosses them too.
