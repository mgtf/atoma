# Project retrieval: downstream privacy audit

Date: 2026-09-09. Source reviewed: `3b0f4e5`, with the executable audit fixture
introduced alongside this record. Status: **audit complete; confidentiality
condition NOT satisfied. Real tenant-document rollout is blocked by the
common registry channel below.** This is an offline adversarial characterization,
not a live customer incident, an independent security review or a measurement
of how often a provider copies private information.

This closes the investigation promised by
[Step 8](project-retrieval-action-plan-2026-09-08.md#step-8--wire-the-element-through-the-real-atoma-execution-path),
not its confidentiality exit condition. It qualifies the earlier
[activation record](project-retrieval-activation-2026-09-09.md): query isolation
and passing release/container checks do not establish downstream data isolation.

## Reproducible finding: private facts cross through registry metadata

**Priority: P1.** A model-authored validator modification can move a private
source fact into `atom_types`, which is common to project runs. Another
organisation can receive that fact in a subsequent model request without
passing the first project's retrieval authorization boundary.

The audit fixture follows these production paths:

1. Create a private project and a delivered manifest containing one synthetic
   Markdown pricing document. Admit its snapshot through
   `ProjectRetrievalLaunchStore.prepare` and resolve the current run's receipt.
2. Drive `L2Atom.handleDirect`, the shared supervision loop, `L1Atom.execute`
   and the real `AnthropicLlmClient` tool dispatcher with mocked decisions.
   `search_project_docs` returns an exact passage from the real FTS index.
3. Make the mocked result validator copy the observed fact into a persistent
   modification. The model has no direct database tool: the supervision hook
   is the writer.
4. Register another organisation's run in the same product database, with its
   own paths and an explicitly admitted empty corpus.
5. Start a fresh Node process. It resolves the second run's receipt, successfully
   searches its empty corpus, loads the common registry and invokes the real
   L1 planner and L2 routing prefilter with mocked completions.
6. Observe the first project's fact in the second process's model request,
   although its search returned no passages. No skill file crosses projects.

Four metadata carriers are reproduced, under one missing ownership boundary:

- `systemPromptAppend` with scope `patch`: the next project's L1 planner
  receives the private sentence in its system prompt.
- `systemPromptAppend` with scope `branch`: a new persistent type carries the
  sentence and can be hydrated by the next project.
- `descriptionReplace`: the short synthetic private sentence passes
  `resolveCreationDescription` and enters another project's routing catalogue.
  Task-theme hygiene is not a confidentiality policy.
- `branchName`: a syntactically valid label containing synthetic tenant facts
  enters the common catalogue. Filename-safe characters do not make a label
  public information.

The corresponding ephemeral modification stays on the current instance and
does not appear after reload. `additionalContext` is also correctly separated
from persistent modifications in both supervisor hook implementations. These
are useful positive controls, but they cannot stop a model placing the same
fact into one of the persistent fields.

The relevant writers/readers are
[`L2Atom.makeL1Hooks`](../src/atoms/L2Atom.ts),
[`L3Atom.makeL2Hooks`](../src/atoms/L3Atom.ts),
[`AtomRegistry.patch/branch`](../src/registry/atomRegistry.ts) and
[`resolveCreationDescription`](../src/atoms/capability.ts).
The fixture reproduces L2 → L1 writes and subsequent L1/L2 reads. L3 → L2
writes share the inspected pattern; they are not independently exercised by
this new fixture. Planner-authored descriptions and tool metadata also need
coverage in the correction, rather than assuming these four examples exhaust
the writable surface.

This channel predates retrieval: a private fact obtained from workspace tools
can take the same route. The new source element provides another input to it.
The existing warning that local runtime trust is not a complete multi-tenant
architecture remains material.

## Skills: containment works; generalization is not enforced

The successful-run fixture deliberately makes the distiller return a recipe
containing the private fact. The real lifecycle passes the L1 summary to the
distillation call, includes its existing generalization instruction, then saves
the copied fact. A fresh `SkillRegistry` reads it back from the project's
skills directory with `distilled` provenance.

That body is visible to compatible donor/reader namespaces **inside the same
project root**. It is absent from another project in the same organisation,
another organisation and the operator skills root. The test first proves that
namespace sharing actually admits the donor in the owning root, so an empty
foreign result cannot be explained by disabling sharing or using incompatible
tools. Recovery-skill generation likewise preserves a deliberately copied
private fact inside the project root; its assessment is `not-shareable`.

`assessShareability` returns `review-required` with no mechanical blockers for
the ordinary recipe containing the private sentence. This is correct under
its existing contract: it is a hygiene assessment, not a redactor or an
authorization decision. Raising its regex sensitivity cannot establish that
private facts have been removed, especially when paraphrased.

`exportSkillToSpec` faithfully retains that sentence. It is an operator-invoked
format conversion, not a platform catalogue admission path; the fixture does
not send an export to another tenant. The
[catalogue-offer review](platform-skill-offer-review-2026-08-23.md) remains a
design, not an implemented automatic distribution gate. The current MCP and
HTTP catalogues reserve operator skill/registry APIs to the platform tier.
Their API authorization does not protect the internal registry reuse channel
described above.

Source withdrawal is not automatic forgetting: removing a source or revoking
search cannot erase facts already delivered to a run or learned in its private
recipes. Coordinated retention/provenance remains an operational design item.

## Cache and execution controls

The fixture derives lifecycle settings from `projectRunEnvironment`, including
`ATOMA_PREFILTER_CACHE=0`. An existing common cache row is not read or credited
with a hit, and a new private decision is not written. This checks both sides
of the existing cache policy, rather than merely inspecting the environment.
Retrieval does not introduce a query/result cache.

Project-local skill paths, current receipt resolution, pre/post search
authorization, disabled promotion/direct dispatch and worker isolation retain
their earlier tests. This audit changes none of those policies, adds no LLM
call site, and does not disable learning. None of them partitions atom-type
metadata; a correct retrieval check cannot repair a separate store reader.

## Required corrective increment before real-document activation

Treat tenant-authored registry content as project data. Preserve reusable
platform knowledge through an explicit shared-body boundary; do not infer
public status from a prompt instruction, a keyword detector or a successful run.
Implement the correction as one coherent registry ownership change:

1. Define the trusted project ownership context at run construction, using the
   existing current run/project/principal resolver. It must reach every registry
   creation, patch, branch, reload and catalogue reader, including escalation.
2. Keep project-owned definitions and their history in the existing product
   SQLite store. Distinguish them from explicitly admitted shared definitions.
   Another project must not load a private prompt, name, description or tool
   definition merely because both runs use the same database file.
3. Preserve stable atom IDs, lineage, project skill namespaces, trace identity
   and per-owner trust. Follow the repository's complete identity/migration
   contract, including backups and rollback. Existing unscoped model-authored
   rows cannot silently be declared public; retain their evidence and define
   their admission policy explicitly.
4. Keep the shared supervision loop and project learning intact. Private
   coaching remains usable in its owning run/project. A model-generated
   sanitizer or disabling distillation would not close the reproduced registry
   channel and must not substitute for ownership.
5. Cover L1 and L2 creation, both supervisor mutation hooks, alternate metadata
   fields, forks, subsequent same-project reuse and foreign-project reload in
   a real child process. Convert the exposure characterizations below into
   absence assertions with that implementation; test useful same-project reuse
   as well as rejection.
6. Keep review/admission separate from export formatting and skill trust.
   Evaluate copied and paraphrased facts before any future shared-body offer.
   Define provenance/retention for derived content before promising deletion.
7. Re-run source, release and container checks, then register the fresh BM25
   A/B treatment and control on the corrected revision. Keep experiments on
   synthetic data and independently initialized state while this boundary is
   unresolved.

The current activation switch is unchanged and still defaults to off. This
audit does not enable a deployment, remove stored evidence or introduce a new
runtime gate. Until the correction lands, do not treat opt-in availability as
approval to use real private documents on a shared tenant host.

## Verification

Run with the pinned Node version:

```bash
npx vitest run tests/project-retrieval-privacy.test.ts
```

The eight tests include **exposure characterizations**, explicitly labelled
in the source. Their passing result means the audit is reproducible, not that
the confidentiality condition passes. All documents and provider decisions
are synthetic; real retrieval, supervision, persistence and process boundaries
execute, with no paid provider call. Existing `mcp-http`, `viz-auth-gate`,
skill lifecycle/shareability and retrieval tests cover the surrounding paths.

`npm run check` passed on Node 24.20.0: both TypeScript configurations,
documentation checks, lint and 3,745 tests passed; 13 conditional worker,
preview and mender tests were skipped. The eight new audit cases all executed,
including the real child-process reloads. This test/documentation increment
does not claim a new container-isolation certification.
