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

**NOT built, because each is a new mechanism and this is the session that
surfaced the incident:**

- **Interaction checkpoints.** Today the only way to prove an intermediate
  state is to abandon `interactions` entirely and drive the app's own API —
  which presumes the app exposes one. A `checkpoints` argument (snapshot an
  expression after interaction *k*) would make the ordinary path provable.
  This is the one candidate that is a real capability gap rather than a
  teaching failure, and it is the one that needs a reviewed design: it adds a
  second evaluation channel to a tool whose attestation fields currently
  assume exactly one.
- **A repeat-failure gate across a phase.** `makeSmokeStuckTracker` catches the
  IDENTICAL smoke retried; it does not catch fourteen DIFFERENT smokes failing
  the same way. Whatever would catch that is a new heuristic with a threshold,
  and thresholds designed against one trace are how one concept acquires two
  definitions.
- **The vocabulary-frozen detector.** `smokeDrivesIntermediateState` keys on a
  regex word list (`milestone|beforeReset|preReset|...`). A correct smoke that
  names its snapshot something else is invisible to it and gets refused for a
  problem it does not have. Widening the list reproduces the failure mode one
  word further out; the fix is structural and is not a same-day edit. This is
  the 2026-08-14 review's measured pattern, in our own code.

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
