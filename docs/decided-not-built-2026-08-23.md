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
   Needs none of the new machinery — it is a variable change with a written
   rationale, and it is the whole product benefit minus the cross-tenant part.
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
