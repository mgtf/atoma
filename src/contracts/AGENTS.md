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
- The browser-probe discriminant has ONE taught literal
  (`WEB_PROBE_DISCRIMINANT`), and both the manifest writer block and the web
  canonical prompt's `output.probes` example are generated from it. Aliases
  (`REPORTED_WEB_PROBE_ALIASES`) are READER tolerance for recipes distilled
  before a rename; never teach one, and never widen the on-disk checker to
  accept one — a compiled script dispatches on that discriminator.

## Proof attestation

- `src/contracts/attestation.ts` owns the typed tool observation, the
  attestation record, and the obligation vocabulary. An observation is only
  ever OBSERVED: no model-authored payload may enter that module, and the only
  writer is the runtime seam that saw the raw tool result.
- `requestedInteractions` and `executedInteractions` are SEPARATE fields on
  purpose. Reporting one side is what let `ok: true` with an empty interaction
  log read as proof that clicking worked.
- The obligation vocabulary is CLOSED and has one member. Adding a second is a
  design review with its own evidence, not a schema edit.
- `Witness` declares its OBSERVER. Never relabel a model-declared witness as
  transport-observed, and never fold transport witnesses into the
  recorded-probe rendering — they are references, and they carry no `cmd`.

## Reading a trace without holding it

- `src/contracts/traceFields.ts` owns the ONE projecting reader over a run
  trace: `readTraceTopLevelFields` enumerates the document's DEPTH-1 members in
  bytes and returns only what its caller named — VALUES for members whose
  content is needed, SHAPES for members whose presence and JSON type are. It
  lives here, not in `src/viz`, because `src/viz/server.ts` imports four
  `src/projects` modules and a value edge back would close a subsystem cycle;
  it is allowed here for the same reason `runStats.ts` holds its own parser,
  and because no model-authored payload ever enters it.
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

- `baseSha` on a publication is OBSERVED, never a pointer anything decides
  from — the same rule `attestation.ts` states for a tool observation. It
  records the branch head found immediately before that publication; the
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
