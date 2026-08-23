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
