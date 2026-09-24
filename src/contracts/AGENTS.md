# Contracts — AGENTS.md

`src/contracts/` owns the shared runtime shapes: one schema per shape,
inferred types, and the merge semantics readers and writers agree on.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
Define a schema once and import it everywhere.

Neighbours:

- [`src/tools`](../tools/AGENTS.md) — the writers bound by these merge rules
- [`src/platform`](../platform/AGENTS.md) — the closed event-kind vocabulary
- [`src/atoms`](../atoms/AGENTS.md) — the plan and verdict shapes

## Schemas and examples

- Contract examples are parsed at module load. A schema/example mismatch must
  fail tests immediately.

## Probe manifests

- Probe manifests are structured records. Normalize paths before recognizing
  `.atoma-probes.json`; machine writers merge entries, and model hand-edits are
  refused.
- Manifest MERGE semantics have one definition: `src/contracts/probeManifest.ts`
  owns entry identity per shape (shell by `cmd`, web by `file`+`smoke`, http =
  ordered append) and documents the three writers' corrupt-input policies side
  by side. Never re-implement a merge in a tool.
- A SEEDED workspace inherits the manifest as a replay baseline, filtered by
  `inheritProbeManifest`: an entry `probeEntryProblems` rejects is dropped, one
  by one (HTTP included — a seeded HTTP list is several runs' appends, not one
  sequence), and a clean manifest is copied byte for byte. That per-entry
  function is the one definition of a well-formed entry; `validateProbeManifest`
  is built on it. Do not stamp provenance into entries: web entries and
  compiled verifiers rewrite them whole, so a stamp depends on its writers.
  Attempt-scoped observation is the witness channel
  ([seed inheritance](../../docs/seed-inheritance-2026-09-25.md)).
- The browser-probe discriminant has ONE taught literal
  (`WEB_PROBE_DISCRIMINANT`), and both the manifest writer block and the web
  canonical prompt's `output.probes` example are generated from it. Aliases
  (`REPORTED_WEB_PROBE_ALIASES`) are READER tolerance for recipes distilled
  before a rename; never teach one, and never widen the on-disk checker to
  accept one — a compiled script dispatches on that discriminator.
- `probeManifest.ts` also hosts the taught two-call `validate_html` shape
  (`SMOKE_TWO_CALL_SHAPE`, rendered as `SMOKE_TWO_CALL_LINES`) for the same
  reason it hosts `EXAMPLE_WEB_ENTRY`: one constant, rendered by two layers
  that may not import each other (the tool's refusal and the shared smoke
  guidance). It is the executed-interactions counterpart of
  `establishesDomInteraction`; its second call changes state once before the
  reset because a reset on a fresh page proves nothing. Generic vocabulary
  only — control, milestone, reset — never one widget's names.

## Proof attestation

- `src/contracts/attestation.ts` owns the typed tool observation, the
  attestation record, and the obligation vocabulary. An observation is only
  ever OBSERVED: no model-authored payload may enter that module, and the only
  writer is the runtime seam that saw the raw tool result.
- `requestedInteractions` and `executedInteractions` are SEPARATE fields on
  purpose. Reporting one side is what let `ok: true` with an empty interaction
  log read as proof that clicking worked.
- HTTP, shell, file-read and server-start observations are bounded historical
  evidence in the same attestation log. They do not establish DOM interaction
  or introduce automatic approval, and their scripts/content remain untrusted.
- A `fetch_url` observation carries a structured `http` `{method, path,
  status}` ONLY when the tool reported `servedBy`: the port belongs to a
  server this tool set started and its process holds it, and the response was
  not redirected. That is the only input the acceptance checklist
  (`acceptanceChecklist.ts`) covers from; it is a projection over this log,
  not an obligation.
- The obligation vocabulary is CLOSED and has one member. Adding a second is a
  design review with its own evidence, not a schema edit.
- A `validate_html` PRE-FLIGHT refusal is a statement about the request, not
  an observation of the artefact: no page opened, no document bound. Its
  error strings carry one of TWO prefixes — `SMOKE_PREFLIGHT_REFUSAL_PREFIX`
  for the smoke guards, `PROBE_URL_REFUSAL_PREFIX` for a portless loopback URL
  (2026-09-21: a bound-origin mismatch read as a dead service replayed a run
  into its deadline) — and `isPreflightRefusal` is the one predicate over
  both; the tools write them, the L1 validation ledger reads the predicate.
  Never grep the literals.
- `Witness` declares its OBSERVER. Never relabel a model-declared witness as
  transport-observed, and never fold transport witnesses into the
  recorded-probe rendering — they are references, and they carry no `cmd`.

## Acceptance lists

- `acceptanceChecklist.ts` owns BOTH lists. The drafted parse is lenient (a
  model's bad item is dropped); the user-approved input
  (`approvedChecklistInputSchema`, `acceptanceSpecSchema`) is STRICT, because
  a criterion the user approved and the run lost is the contract's named
  failure. `parseChecklistLines` is the ONE line grammar for console, CLI and
  MCP. The module stays browser-safe: the digest and the env transport live
  in `src/run/acceptanceSpec.ts`, because the client imports this directory.

## Reading a trace without holding it

- `src/contracts/traceFields.ts` owns the ONE projecting reader over a run
  trace: `readTraceTopLevelFields` enumerates the document's DEPTH-1 members in
  bytes and returns only what its caller named — VALUES for members whose
  content is needed, SHAPES for members whose presence and JSON type are. It
  lives here, not in `src/viz`, because `src/viz/server.ts` imports four
  `src/projects` modules and a value edge back would close a subsystem cycle;
  it is allowed here for the same reason `runStats.ts` holds its own parser,
  and because no model-authored payload ever enters it.
- `llmTrace.ts` CITES model-visible context, it does not copy it:
  `citeContext` records a block's source, its true `chars` and a preview
  capped at `CONTEXT_PREVIEW_CHARS`, and the same id is cited on the `llm`
  event. The cap is 2,000 — raised from 160 because the viz `context` step
  exists so a viewer can read what the model was shown, and 160 cut a
  1,167-character recipe mid-sentence (2026-09-21). It stays a CAP: a longer
  block is still truncated with an ellipsis, and one event is recorded per
  distinct block per run, so a trace grows with a run's injects rather than
  with its calls.
- A trace's SIZE is a function of how much work the run did (~19KB per tool
  call, measured). Never bound it with a constant: a 512KB cap recorded
  delivered run `2857a579` as `failed`. Bound the PROJECTION instead — the
  coordinator's spec captures under 400 bytes from a trace of any size.
- `result` and `error` are the members a MODEL wrote, and they are read as
  SHAPES ONLY. `result.output` is typed `unknown` and capped nowhere, so any
  reader that captured it would rebuild the same erasure at a larger threshold.
- The reader is order- and whitespace-agnostic, so archived traces stay
  readable and no caller may depend on member order or indentation. It is
  FAIL-CLOSED: a member is reported absent only after the scan reaches the
  closing brace and then EOF, which is what rules out a head+tail byte window —
  that window cannot tell "the member is not there" from "my window was too
  small", and a missing `error` read as "no error" would publish a failed run.
- Validation is DEPTH-1 ONLY. Inside a skipped container the scan tracks
  strings and nesting but does not check bracket matching or primitive grammar,
  so a document malformed only below depth 1 is accepted where `JSON.parse`
  would refuse. Unreachable from `TraceRecorder`, which emits one
  `JSON.stringify` per persist, and the projected members are still exact.
- ONE ceiling (`MAX_TRACE_BYTES`, 32 MiB), FOUR dispositions above it, stated
  here once: the coordinator fails HARD, because it is deciding whether work
  was delivered; the sentinel fails SOFT (`readBoundedJson` returns null — no
  watch is better than a stall); `summarizeTraceFile` fails soft by skipping the
  row; `/api/runs/:id` REFUSES with a status, because a reader asking for one
  named trace is owed an answer and a skipped row is not one
  ([src/viz](../viz/AGENTS.md)). The ceiling is re-exported by
  `src/sentinel/sources.ts`; it is not redefined there.
- No refusal message carries a filesystem path. `project_runs.error` is served
  to tenants, and the row this reader replaced leaked an absolute host path.

## Model selectors and who paid for a run

- `modelSelector.ts` is the ONE grammar for a model choice, everywhere:
  `<api|sub|own>:<vendor>:<model>`, closed mode and vendor vocabularies, the
  third segment verbatim (Ollama tags keep their colons). `parseModelSelector`
  is the only parser, `transportOf` the only mode+vendor → transport mapping,
  and `readTierSelectors` the only reader of the three REQUIRED
  `ATOMA_MODEL_L*` pins — there is no default, and no other module may
  spell, split or default a selector. Stored pins written before this grammar
  (2026-09-07) are not recognised; the store is reset, not migrated.
- `runPayers.ts` is the ONE answer to who paid, and it is PER TIER: three rows,
  `l1`, `l2`, `l3`, each naming the resolved selector, the transport that
  served it (`transportOf`), the payer kind and the chain level it came from.
  There is no `base` row any more because there is no base transport: every
  call carries its full selector, so nothing is paid by an account the ledger
  does not name.
- THE PAYER IS THE SELECTOR'S FIRST SEGMENT (`payerForSelector`): `sub:` is
  `host-subscription`, `own:` is `principal-subscription`, `api:` is `org-key`
  when the organisation brought the vendor's key, else `host-key`, or
  `host-selfhosted` for Ollama. Nothing infers a payer from a transport name.
- Subscription selectors are ADMISSIBLE BY CHAIN LEVEL, not by spelling: the
  coordinator honours `sub:`/`own:` from an account pin after re-asking the
  authority, and refuses them from the org and host levels; both ChatGPT
  families admit all three tiers through Atoma's host-side tool loop.
- Nothing here carries a secret: a payer names a KIND and a transport. This
  detail is journaled beside `project_runs.error`, which is served to tenants.
- Summary helpers distinguish host and requester subscription spend; both use
  the same structured `runPayerDetail` ledger.

## Publication receipts

- An artifact manifest with `source: workspace` records the complete filtered
  workspace inventory. Absence of this optional field retains the legacy
  explicit-file meaning and its exact hash. Revalidation follows the recorded
  coverage; it never upgrades historical evidence implicitly.

- `baseSha` on a publication is OBSERVED, never a pointer anything decides
  from — the same rule `attestation.ts` states for a tool observation. It
  records the publication parent (the captured run base for imported projects); the
  authority to publish onto an existing branch is read from GitHub at publish
  time. A required KEY with a nullable VALUE on a `.strict()` object, so a
  writer must state what it built on rather than omitting it.
- `commitShaSchema` is the ONE definition of a 40-hex commit sha, imported by
  both the receipt and the row. It was written twice.

## Trajectory signatures

- `src/contracts/trajectory.ts` owns the signature, key and score shapes AND
  the pure derivation over trace events, for the reason `traceFields.ts` lives
  here: two subsystems read it — the sentinel's rule table and the analyst's
  digest — and neither may import the other. It reads runtime-stamped
  identities only (element names, actor names, skill ids, event and branch
  ids) and never `args`, `result` or prose; its event type is structural so
  every `VizEvent` satisfies it without a `src/viz` import.
- ONE EXECUTION IS ONE `llmEventId`. It is CLOSED by the `llm` event carrying
  that id, which `RecordingLlmClient` records only when the call returns, so
  array order is causal and a signature without it is a prefix. It is CREDITED
  by the next `skill.success` (naming its skill, when it had one) or `trust`
  RESULT for its Molecule in an agreeing lane, before that Molecule's next
  execution — so a remediation retry leaves its first attempt uncredited.
  Lanes NEST (measured 2026-09-09 on the real traces): the Cell injects,
  credits and trusts in its OWN lane and the Molecule executes in a child lane
  the Cell opens, so an event agrees with an execution when their lanes are
  equal or one is an ancestor of the other, and a lane-less event agrees with
  any lane. One credit credits the latest attempt in a lane and closes the
  older ones there, so the trust-RESULT-beside-skill-success pair cannot credit
  a retry's failed first attempt; siblings in other lanes keep waiting.
- A reference holds completed AND credited signatures only, newest
  `TRAJECTORY_REFERENCE_MAX_PER_KEY` per key. Assemble it oldest-first.

## Intentional choices and rejected shortcuts

- A second definition of manifest merge semantics, near a writer that needs
  "just one field": refused. `probeManifest.ts` owns entry identity per shape,
  and the three writers' corrupt-input policies sit side by side there so they
  can be compared rather than discovered.
- Teaching a reported web-probe alias, or widening the on-disk checker to
  accept one: refused. `REPORTED_WEB_PROBE_ALIASES` is READER tolerance for
  recipes distilled before a rename, nothing more — a compiled script
  dispatches on that discriminator, so an accepted alias becomes a real code
  path.
- Naming one widget's controls in the taught smoke shape: refused. Generic
  vocabulary only — control, milestone, reset. A shape that names a widget
  teaches the page instead of the method, and is the vocabulary-frozen
  detector class in another costume.
- Relabelling a model-declared `Witness` as transport-observed, or folding
  transport witnesses into the recorded-probe rendering: refused. Who observed
  a fact is part of the fact; transport witnesses are references and carry no
  `cmd`.
- Upgrading historical evidence implicitly when a contract tightens: refused.
  Revalidation follows the RECORDED coverage. A rule that reaches backwards
  turns old traces into claims nobody made.
- Deciding `baseSha` from anything: refused. It is OBSERVED, the same rule
  `attestation.ts` states for a tool observation; the authority to publish
  onto an existing branch is read from GitHub at publish time.
- Letting the trajectory contract carry `args`, `result` or prose: refused.
  Identities only, and a structural event type so every `VizEvent` satisfies
  it without a `src/viz` import — a shared shape that imports a subsystem is a
  dependency edge nobody asked for.
