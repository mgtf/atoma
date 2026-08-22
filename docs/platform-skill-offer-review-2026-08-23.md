# Offering a skill to the platform catalog — design review, 2026-08-23

Status: **design review. One contract proposed, no code written, nothing
accepted.** It answers the operator's ask of 2026-08-23: have the supervisor
do the platform-level review that
[`saas-architecture.md`](saas-architecture.md) §4.2(2) requires.

The short answer is that the supervisor can do most of it and must not do the
last part, and the reason is already written in
[`supervisor-design.md`](supervisor-design.md). What follows is the contract
that splits those, examined against §4.1's chain point by point.

## 0. A word, first, because this repo has been bitten by one

`promote` is TAKEN: it means llm → script inside one namespace
(`promoteToScript`, `ATOMA_SKILL_PROMOTE`), and `publish` is TAKEN too — it
means pushing a project's artefact to GitHub (`src/projects/publisher.ts`).
Neither is what this document is about.

This document uses the vocabulary the code already chose for this exact
question: `src/skills/shareability.ts` asks "would this body be safe to
**OFFER** to a DIFFERENT organisation?" and answers with a `ShareVerdict`. So
the operation here is **offering a skill to the platform catalog**, and a
body that has been offered is **catalog-offered**. One concept, one word —
the discriminant defect closed in `3ee624d` is the cautionary tale.

## 1. What is actually blocked today

The product intent is not in dispute and the SaaS document states it in the
operator's own terms: *"one user's learning makes every other user's runs
cheaper"*. §4.2 says which half survives — the two expensive LLM calls
(distillation, compilation) paid once platform-wide, and llm-recipe injection
after review — and which half cannot: the zero-token dispatch arriving free
in the next tenant, because that transfer is the transfer of arbitrary code
execution rights into another tenant's sandbox.

So the blocker is not the principle. It is that §4.2(2)'s defence —
*"Promotion to the platform catalog requires human review of the Node
source"* — has no practical form. Nobody reads Node source all day, so in
practice nothing is ever offered, and the platform does not improve across
tenants at all. A gate that is never exercised is not a safe gate; it is an
absent feature with a safety story attached.

The mechanical half already exists and is honest about what it is not.
`assessShareability` returns `blocked` / `review-required` / `not-shareable`,
and its own docstring says: *"It is not the gate, and it must never be cited
as one … A clean verdict here means 'a reviewer's time will not be wasted',
never 'approved'."* The MCP tool repeats it. What is missing is everything
after that verdict.

## 2. The one thing the supervisor must not be

[`supervisor-design.md`](supervisor-design.md) settles this before we get to
it:

> **The watcher is the top injection surface.** Run output, trace text and
> skill bodies are model-authored … An LLM that reads them live *and* holds
> power is the most attractive target in the system. Stage 1 therefore holds
> (almost) no power and no LLM; stage 2 holds an LLM and no power beyond a
> verdict file; stage 3 holds write power and never reads raw trace prose.

Offering a skill needs both halves at once: **judging a body** (adversarial,
model-authored prose) and **authorising its distribution** to other tenants.
That is precisely the union the three-stage split exists to prevent.

Two further reasons, specific to this operation:

- **The body is the reviewer's prompt.** A reviewing LLM ingests the payload
  it is meant to judge. Every other component in this system that reads
  model-authored text is explicitly denied power for that reason; a reviewer
  that reads and decides inverts the rule at the one place where the decision
  hands out code execution in someone else's sandbox.
- **"Better than the deny-list" is not authorisation.** §4.1(e) measured 8 of
  9 concat-obfuscated payloads passing the static scan, and the scan's own
  docstring calls itself an honest hygiene filter that must never be promoted
  to an authorization boundary. An LLM reviewer would score better on that
  corpus. It would still be a detector, and the repo's R5 rule is about the
  category, not the accuracy.

## 3. The contract

Four posts. Exactly one of them can say yes, and it is not a model.

### 3.1 Post 1 — the mechanical pre-screen (exists)

`assessShareability`, unchanged, run at the moment a body is distilled rather
than at offer time. Its purpose is stated in its own comment and is worth
keeping: applying the criterion the week a recipe is learned is far cheaper
than rejecting one that has been trusted for months.

`blocked` ends the process. `not-shareable` ends it too — offering a
structurally local recipe elsewhere is meaningless, not merely unsafe.
`review-required` is an entry ticket, never an approval.

### 3.2 Post 2 — behavioural attestation, for `kind: script` only (new)

Instead of asking a model whether code is malicious — the question §4.1(e)
shows we cannot answer by reading — require the candidate to **demonstrate
what it does**.

The candidate script runs in a deliberately hostile sandbox: egress
deny-all, a synthetic workspace, no store, no secrets, no credentials of any
kind. The runtime observes, at the transport, what it actually did: files
touched, processes launched, network attempts. That observation is an
attestation in the sense the A1 contract just landed
([review](supervisor-attestation-a1-review-2026-08-22.md)) — machine-written
at the tool seam, never a claim the script makes about itself.

Mechanical dispositions, no judgment:

- a network attempt of any kind → refused;
- a read or write outside the synthetic workspace → refused;
- a process launch outside the declared probe contract → refused;
- nothing observed at all → refused as unproven, not accepted as clean.

This is the part that makes the human's job small. It converts "audit for
intent" into "read a body whose observable behaviour is already bounded".

### 3.3 Post 3 — the offer dossier, by the analyst (new)

Stage 2 of the supervisor design, in its existing shape: a headless
read-only session, structured output, spend ceiling, no writes beyond its
verdict file. It produces an **offer dossier** — not a decision:

- the body, verbatim and complete;
- the pre-screen findings and the attestation record;
- what the recipe claims to do, and which parts of the body the analyst could
  not account for;
- the leakage question answered explicitly: which literals in the body trace
  back to the originating run;
- a recommendation, labelled as a recommendation, with confidence.

The verdict schema v1 has no `kind` for this — its four are `defect`,
`mechanism_candidate`, `security_incident`, `observation`. An offer dossier is
a fifth output with its own schema, not a finding squeezed into that one.

And the discipline the analyst already carries applies with full force here:
an instruction-shaped payload inside a body is itself a `security_incident`,
never something to act on.

### 3.4 Post 4 — the operator approves (new, and the only yes)

An offer becomes catalog-offered when a human says so, in a journaled action,
on a dossier. This mirrors the mender's proposed default in the supervisor
design's open decisions — *proposal-only with operator approval*.

## 4. What never globalises

§4.2(1) stands untouched: **bodies may globalise, trust never does.**
Counters live per `(org, entity)`. A catalog-offered body reaching a new
organisation arrives with zero successes, and that organisation earns its own
three clean validated runs before any zero-LLM deterministic path opens
against its workspaces. The two expensive LLM calls are what the platform
saves; the dispatch right is not transferable.

Consequently the catalog is a store of **bodies and provenance**, never of
counters — and the existing per-project skills directory
(`orgs/<org>/projects/<project>/skills`) remains where a tenant's own
counters live.

## 5. Adversarial review against §4.1

1. **(a) Bodies are authored from tenant-controlled content.** Unchanged and
   unchangeable — it is the premise. The contract's answer is that
   tenant-authored content is never distributed on a model's say-so.
2. **(b) A distilled body lands in every other tenant's HOME namespace.**
   This is the vector the contract removes, and it removes it by
   construction rather than by review: nothing globalises implicitly at all.
   A body reaches another tenant only by having been offered, which requires
   post 4. *Residual:* the canonical-atom naming that made namespaces
   collide is untouched; B1's surrogate id is still the real fix.
3. **(c) Injection is execution for a script skill.** Untouched, and it is
   why post 2 exists at all. The contract does not make script injection
   safe; it makes the set of scripts that can arrive from outside a reviewed,
   behaviourally bounded set. *Residual:* once offered, injection is still
   execution on first match inside the receiving org.
4. **(d) The trust threshold is reachable from inside one's own org.** Also
   untouched — and it does not need touching, because §4.2(1) means an
   offered body arrives at 0/0. Reaching the deterministic path in your own
   org with your own recipe was never the cross-tenant problem.
5. **(e) The static scan is not a gate.** Honoured: post 1 keeps its status
   as a pre-screen, and post 2 is not a better scan — it is an observation
   with mechanical dispositions, which is a different kind of thing.
6. **(f) Downstream gates check what the script says, not what it did.** This
   is the one place the contract genuinely improves an existing weakness: the
   attestation is exactly "what it did", and it is machine-written.
7. **(g) `kind: llm` bodies receive no content scan.** Partly answered, and
   this is the contract's weakest point. There is no behavioural attestation
   for prose — a recipe cannot be executed in a sandbox to see what it does.
   So for `kind: llm` the dossier is the whole defence, and the dossier is
   produced by a model reading adversarial text. The mitigation is that the
   body is presented verbatim and complete to the human, and that llm bodies
   remain validated on every injection in the receiving org. It is thinner
   than the script path, which is the opposite of the intuitive ordering.
8. **(h) The cheapest attack needs no payload.** Answered by §4.2(1), not by
   anything here: pooled counters are what made a single induced failure
   permanent, and per-`(org, entity)` counters remove the pooling. If
   counters ever globalise, this document's contract is void.

## 6. What survives

- **Dormant payloads.** A condition on a date, a hostname, or a workspace
  file does not fire in an observed sandbox run. Post 2 bounds observable
  behaviour; it does not prove innocuousness, and no amount of observation
  will. This is why post 4 is a human and not a threshold.
- **Injection on the analyst.** Mitigated structurally — the analyst holds no
  power, its dossier is itself read by the human, and a payload shaped like
  an instruction is a reportable finding — but not eliminated. A dossier
  whose recommendation was written by the payload is a real outcome; what the
  contract guarantees is that acting on it still requires a human who was
  shown the body.
- **Reviewer fatigue, and this one is caused BY the contract.** Making the
  dossier good makes approval easy, and easy approval becomes automatic. We
  would have replaced "nothing is reviewed because it is too expensive" with
  "everything is approved because the dossier looked clean" — a worse failure,
  because it carries a safety story. Candidate counter-measures, none chosen:
  put the verbatim body FIRST and the recommendation LAST; require the
  approver to quote a line of the body; make offers expire unapproved rather
  than queue; sample-audit approved offers against their dossiers.
- **Leakage remains a confidentiality question, not a safety one.** The
  literal scan is a filter over a known list. A body that paraphrases a
  tenant's private domain logic leaks it without containing one flagged
  literal.

## 7. Rejected here

- **A model as the gate.** §2. Not a question of accuracy.
- **Cross-org corroboration.** §4.2(5) already deletes it: orgs are
  self-serve, so N orgs is a linear Sybil cost, and the scheme launders
  multi-org provenance as stronger evidence. Do not tune N.
- **Promoting the static scan to an authorisation boundary.** Its own
  docstring forbids it; R5 forbids the category.
- **Offering `kind: script` bodies before default-deny egress ships.**
  §4.2(4) makes container-with-egress-allowlist a precondition, and post 2's
  sandbox is not a substitute for it — post 2 observes one execution, F1
  bounds every later one.
- **Globalising counters "just for reads".** A counter is a trigger in this
  system, not a statistic. There is no read-only use of one.

## 8. If accepted, the order

Least dangerous first, and each step useful alone:

1. **`kind: llm` bodies, offered per organisation, no catalog yet.** Turn
   learning back on for project runs (`ATOMA_SKILL_LEARN`,
   `ATOMA_EVENT_SKILLS`) while `ATOMA_SKILL_PROMOTE` and
   `ATOMA_SKILL_DIRECT` stay off. A tenant accumulates its own validated
   recipes; nothing crosses a tenant boundary; the zero-token path stays
   shut. This is the whole product benefit of §1 minus the cross-tenant part,
   and it needs none of posts 2-4.
2. **Post 2, the behavioural attestation**, as a reader over candidates —
   measured against a corpus that includes §4.1(e)'s nine obfuscated
   payloads, before it is wired to any decision.
3. **Posts 3 and 4**, the dossier and the journaled approval, with a
   fatigue counter-measure chosen from §6 and stated in the contract rather
   than discovered later.

Step 1 is a variable change with a documented rationale. Steps 2 and 3 are
each their own review, and neither should be designed in the session that
lands the one before it.
