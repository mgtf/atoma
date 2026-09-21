# Delegating the host subscription — decision and contract, 2026-09-22

Owner decision, implemented the same day. It extends the per-tier
subscription design of
[2026-08-28](subscription-per-tier-design-2026-08-28.md), whose vocabulary
(`host-subscription:`) predates the selector grammar of 2026-09-07; read that
record first for why the door exists at all.

## The problem

Since 2026-08-28 exactly one kind of account could name a `sub:` selector on a
tier: a **platform admin**, on the deployment that declares an organisation
for its own login session. Three facts were re-asked per run, fail-closed, in
`assertSubscriptionPinIsHonourable`:

1. the pin sits at the **account** level (never an org default, never the host
   environment);
2. the requester holds the **platform-admin flag**;
3. the run belongs to the organisation named by `ATOMA_HOST_SUBSCRIPTION_ORG`.

The second fact conflated two different powers. "May spend the operator's
Claude and ChatGPT subscription" and "holds every operator power on this
instance" were the same flag, so letting a colleague in the operator's own
organisation use the subscription also handed them burn-in, the operator run
corpus, cross-organisation reads, the four skill/registry writes, the ledger
and the journal. The operator wanted the first without the second.

## The decision

Add a second authority for the SAME door, and change nothing else.

A **host-subscription delegation** is one row scoped to a membership
(`auth_subscription_delegates(org_id, principal_id, granted_at, granted_by)`).
It answers fact 2 for one member of the declared organisation. Facts 1 and 3
are untouched: the delegate still chooses the subscription **per tier in their
own Settings**, and the run still has to belong to the declared organisation.

What the delegate does NOT get: the platform-admin flag, any operator surface,
and any ability to delegate further. The authority to hand out operator spend
is not itself delegated.

### Who may mint one

Three doors, one body (`src/auth/subscriptionDelegates.ts`):

| Door | Authority | Entry point |
|---|---|---|
| CLI | possession of the machine, as `grant-admin` | `npm run auth -- grant-subscription --principal <id-or-email> [--org <org-id>]` |
| HTTP | a platform admin's own session, same-origin | `PUT`/`DELETE /api/org/subscription-delegates/:principalId` |
| MCP | a platform-tier caller | `atoma_subscription_delegates` |

The rule was NOT restated per door — that is how one rule becomes three
spellings, and this one decides who spends money. Each door resolves its actor
and calls the shared body; the body owns the authority check, the declared
organisation, the membership precondition and the journal row.

### Bounds: none, deliberately

Considered and not built, on the owner's call: a TTL, a per-tier subset
(`l1,l2` but not `l3`), and a spend ceiling. A delegation is a live row or it
is absent, and withdrawal is one command. The reasons: a TTL that expires
mid-week produces a run failure whose cause is invisible to the delegate; a
tier subset duplicates a choice the delegate already makes pin by pin; and a
spend ceiling is a real mechanism — it needs the cost ledger read at launch
and a refusal path of its own — which belongs to its own commit, not to this
one. If spend becomes the problem, the ceiling is the answer, not a shorter
lease.

### Scope: both host logins

One delegation covers both machine-bound families, Claude (`sub:anthropic`)
and ChatGPT (`sub:openai`), because `hostSubscriptionOffers()` offers them
together and both spend the same machine. A per-vendor delegation would be a
second dimension in the table and a second rule in the picker, for a
distinction nobody asked for.

### What a delegate is shown

A platform admin sees an unusable offer with a REASON (`undeclared`,
`other-organisation`) because the flag is instance-wide and the greyed row
explains itself. A delegate sees the family only where it is usable: a
delegation exists only inside the declared organisation, so an
offered-but-unusable row would name a payer that is none of their business.

## Terms

The refusal this replaces was not only about the flag. Driving a machine-local
`claude /login` for a TENANT's work is what Anthropic's terms prohibit, and
that refusal stands — see the
[SaaS architecture evidence](incidents/saas-architecture-evidence-through-2026-08-28.md#L136-L151).
A delegation is narrower by construction: one member of the ONE organisation
the operator declares for their own login, on a deployment the operator runs.
It is the operator's judgement that this is their own work, and the journal
row (`admin.subscription_delegated`, severity `security`, actor named) is what
makes that judgement answerable afterwards. `own:anthropic` — a member's OWN
claude.ai login — remains refused by name until Anthropic grants the
third-party approval its SDK terms require.

## Contract, once

The normative rules live beside the code: [src/auth](../src/auth/AGENTS.md)
for the row and its lifecycle, [src/projects](../src/projects/AGENTS.md) for
the per-run authority, [src/mcp](../src/mcp/AGENTS.md) for the catalogue row.
This document is the reasoning, not a second contract.

## Evidence

- `tests/subscription-delegation.test.ts` — the shared body's rules (authority,
  declaration, membership, idempotence, journal, pre-migration stores) and the
  CLI door through `runAuthCli`.
- `tests/project-coordinator.test.ts` — a delegate with no flag starts a run on
  `sub:` account pins; a delegation lookup that throws refuses the run.
- `tests/viz-auth-gate.test.ts` — the HTTP door end to end, including the point
  of the feature: the member's `sub:anthropic:sonnet` pin is refused 403,
  accepted after the delegation, and refused again after withdrawal, while
  `/api/burnin` keeps refusing them throughout.
- `tests/mcp-http.test.ts` — the tool sits at the platform tier and is invisible
  to an organisation admin.
