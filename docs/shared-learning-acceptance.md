# Shared-learning acceptance — W14

Status on 2026-09-20: shared-learning test passed in [CI at `4788dfd`](https://github.com/mgtf/atoma/actions/runs/35478666242).
W13 subsequently proved the assembled stack and workspace separation. W14's
remaining corpus and HTTP trace checks passed on the isolated stack later that
day; see the [machine-readable receipt](saas-w14-report-2026-09-20.json).

## Executed scenario

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

## Reproducing the check

On Linux with the pinned Node version and installed dependencies:

```sh
npx vitest run tests/shared-learning-acceptance.test.ts
```

No paid model calls, Docker engine or real account credentials are used. The
local tool backend executes a Node child inside disposable test workspaces.
Windows skips this execution scenario; typechecking it is not acceptance.

## Assembled isolation acceptance

The extended [stack driver](../scripts/packaged-stack-smoke.mjs) executes
[corpus acceptance](../scripts/packaged-stack-privacy.mjs) inside the real web
image, using its installed Python BM25 engine and production receipt, authority
and search implementations. No ranking mock or model call is used.

Each organisation's real worker writes a distinct private document. A subsequent
synthetic run can search its own delivered artifact through an immutable receipt.
Both directions reject the other organisation's source run, expose no foreign
marker in search results, reject a forged scope and model-supplied organisation
selector, and deny search immediately after receipt revocation. Positive controls
require a nonempty own result containing the expected private marker.

Over verified HTTPS, ordinary member/viewer sessions in A and an ordinary owner
in B read their own raw traces with HTTP 200. Foreign traces return 404 without
the private marker, for both full and incremental (`?after=0`) readers. The
founder's platform-admin session is deliberately excluded from these refusal
assertions: cross-organisation administrative reads are an intentional contract.

The same execution passes real worker filesystem/egress checks, gVisor preview,
backup/restore and graceful restart. Image digests are retained in the receipt;
the web, launcher and worker images are those validated for W13, while the
preview image was rebuilt from the same Dockerfile. Two fixture-only setup
defects were corrected before the passing run: synthetic completion now uses
`cancelled`, and each synthetic run has the log required by restore verification.
No product implementation or acceptance threshold changed for W14.

Reproduce with the W13 [isolated stack procedure](saas-stack-acceptance-2026-09-20.md#reproduction),
including all three `packaged-stack-*.mjs` scripts. The private registry is
disposable; its digests are evidence identifiers, not public download links.

## Scope limits

This checks the shared-learning arm at the store/lifecycle/tool boundary, not
full project admission or end-to-end delivery. It does not prove isolation
against hostile code: the local backend is not an OS boundary. The
[W13 stack scenario](saas-stack-acceptance-2026-09-20.md) subsequently proved
two real worker workspaces, denied foreign filesystem access, worker egress
policy, gVisor previews and scoped HTTP run/preview reads. The extension above
closes W14's corpus-search and HTTP trace-reader acceptance on that stack.
Shared learning remains the earlier deterministic CI proof, not a paid learning
quality measurement. No production migration, hostile-code security audit or
hosted-backup recovery result is claimed.
