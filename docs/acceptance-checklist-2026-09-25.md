# The acceptance checklist — a run says what it will prove, 2026-09-25

Status: BUILT the same day at the owner's request ("on essaye d'avancer"),
after one adversarial pre-construction review (safe-with-conditions; its
conditions are folded into the text below). A narrowed, first executable
slice of the [acceptance contract](acceptance-contract-2026-09-14.md), not its
implementation — and a PROJECTION over the existing attestation log, not a
second proof-obligation vocabulary (`PROOF_OBLIGATIONS` is unchanged).

## The problem, measured

- Every root acceptance of the 2026-09-24 session carried `floorCoverage: []`
  and `obligations: []` ([run-fix loop](incidents/run-fix-loop-2026-09-24.md)):
  the build profile has no universal floor and no run declares what it must
  prove, so "nothing declares one, so nothing can be uncovered".
- The continuation measurements ([run continuation](run-continuation-design-2026-09-24.md))
  show the cost: a goal naming nine verifiable behaviours was refused twice,
  and each refusal named exactly the behaviours that had never been probed.
  The acceptor knew at the END what the planner was never told at the START.

## The mechanism

1. **Draft, once per run, before the attempt loop.** The runner's depth
   handle calls `draftAcceptanceChecklist` (`src/atoms/acceptanceChecklist.ts`)
   before `runDepthTask`, so a deepening keeps the list. ONE call on
   `modelForTier(1)`, role `draft-checklist` (a member of the closed
   `LLM_CALL_ROLES`, so the viz does not file it as planning), actor
   `run-checklist` at tier 1. At most 12 items `{id, behaviour, check}`,
   where `check` is `{kind: 'http', method, path, status?}` ONLY when the goal
   names the method and path, else `{kind: 'review'}`. One schema,
   `src/contracts/acceptanceChecklist.ts`; a malformed item is dropped, and
   any failure yields an empty list and a warning — it never stops a run.
2. **Tell the planner.** The items ride in the root task's `inputs` as
   `acceptanceChecklist`, with a one-line note on what they are for —
   the channel `rootAcceptanceRefusal` uses, never the description. Inputs
   change no prefilter cache key, skill match or trajectory key.
3. **Attribute, host-side.** `fetch_url` reports `servedBy` only when the
   answering port belongs to a server THIS tool set started AND the kernel
   confirms that process holds it (`servedOriginHoldsPort`), and never for a
   redirected response. `parseExecutionObservation` adds a structured `http`
   `{method, path, status}` — the manifest HTTP entry's three fields — only
   from that. An explicit unregistered port stays probeable and is nobody's
   evidence; so is anything the control plane answers.
4. **Cover, from observations taken BEFORE the root's own probe.** The root
   acceptor's ground-truth probe fetches through the same attesting executor,
   so coverage is computed first: the root never covers a behaviour by
   looking. An `http` item is OBSERVED when this attempt holds a matching
   observation: same method; path segments decoded one by one and compared
   case-insensitively, `:name` matching any one segment, trailing slash
   ignored; the query compared only when the item names one, parameter by
   parameter; the named status, or any 2xx.
5. **Inform, never decide.** The block is rendered into the verdict's proof
   block ONLY when the list holds an http item (a list of review items adds
   no observation). It says OBSERVED is status only and not bound to the
   current bytes, and that a `run_shell` request is invisible to it. On a
   LANDED result it says NOT OBSERVED items from unfinished phases are
   expected, in line with the landing guidance. The coverage is recorded on
   the acceptance event (`checklist`). No outcome approves or refuses.

## Why a model-drafted list is allowed here

The acceptance-contract design forbids a model from activating "its own
draft as independent acceptance authority". This checklist has no authority
to accept: it can only ADD things the acceptor looks for. The worst a bad
draft can do is ask for a behaviour the goal did not want, which the acceptor
reads beside the goal; it can never make a run pass. The user-reviewed,
immutable criterion set of that design remains future work.

## Cost, and where this departs from the acceptance contract

One cheapest-tier call per depth-routed run, bounded output, no retries,
counted in `llmCalls` like any other call. Its fixed system prompt is far
below the cacheable minimum, so it does not cache. On the subscription
transport it is one more subprocess before planning (a few seconds).
Comparison arms do not use depth routing and are untouched.

The acceptance contract asks for user-reviewed criteria and "no extra LLM
call" for the initial vocabulary. This slice departs from both, on purpose
and for a POC: the list is model-drafted, unreviewed, and costs one call. It
is safe to depart there because the list holds no authority to accept.

## Not in this slice

- Propagation to the molecule that makes the requests: subtasks carry only
  their own inputs, so the list reaches the root planner, and the molecule
  only through the L2 high-confidence reuse shortcut. Inheritance like
  `effectiveObligations` is the next step if runs show the planner does not
  pass it down.
- Binding an observation to the served entry's digest, so a later rewrite
  of the server retires it.
- User editing or approval; persistence outside the trace; browser, file or
  persistence checks; a verification reserve; publication binding — all
  remain as the acceptance contract states them.
