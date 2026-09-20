# Shared-learning acceptance — W14

Status on 2026-09-20: test authored and statically checked; execution deferred
at the owner's request. W14 is not closed by this document.

## Prepared scenario

[shared-learning-acceptance.test.ts](../tests/shared-learning-acceptance.test.ts)
uses two authenticated organisations, their registered project runs, one product
store and one explicitly recorded platform skill root. It exercises:

1. Organisation A reads its workspace through the real tool backend. The
   accepted result is a fixture; the production distillation path saves an LLM
   recipe from a mocked model reply.
2. The production promotion path compiles that recipe using a mocked compiler
   reply, preserves the fallback and resets trust. Eligibility history and
   subsequent script successes are seeded through registry methods; this is
   not a measurement of learning quality or real-world earned trust.
3. Organisation B reloads the same catalog and registry with its own run
   authority, workspace and lifecycle scope. The normal L2 prefilters select
   the shared molecule and recipe, and deterministic dispatch executes the
   real Node script against B's input. Only the two mocked prefilter replies
   are available; entering the L1 model loop fails the test.
4. A's reader observes B's increment on the same skill row. The corresponding
   lifecycle event must name B's organisation, project, run and principal.
   Both input files remain unchanged and the scratch script is removed.
5. B cannot retrieve A's run through the organisation-scoped store reader,
   and substituting A's workspace into B's registered run authority is denied.

The older retrieval privacy fixtures intentionally create separate skill
roots. They characterise those fixture paths; their empty-catalog assertions
are not proof of the production commons. This scenario explicitly supplies
the common skill path in both run records, as the coordinator does today.

## Running later

On Linux with the pinned Node version and installed dependencies:

```sh
npx vitest run tests/shared-learning-acceptance.test.ts
```

No paid model calls, Docker engine or real account credentials are used. The
local tool backend executes a Node child inside disposable test workspaces.
Windows skips this execution scenario; typechecking it is not acceptance.

## Remaining acceptance

This checks the shared-learning arm at the store/lifecycle/tool boundary, not
full project admission or end-to-end delivery. It does not prove isolation
against hostile code: the local backend is not an OS boundary. W13 and W14's
packaged-stack arm still need two organisations on the real launcher stack,
with denied foreign trace/workspace/corpus reads and denied control-plane
reachability from the workload network. Existing retrieval tests remain
separate evidence for corpus scoping. No hosted acceptance result is claimed.
