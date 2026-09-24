# What a seeded run inherits — design and implementation, 2026-09-25

Status: BUILT, after one adversarial pre-construction review that returned
safe-with-conditions and narrowed the design (see [the review](#the-review-and-what-it-changed)).
Written under the COOLING-OFF contract of the root `AGENTS.md`: the session
that surfaced the incidents designed nothing, this one designs once.

## The incidents

1. **Unreplayable evidence, inherited** — observed, run `d677d824`
   ([run-fix loop](incidents/run-fix-loop-2026-09-24.md#run-4-the-root-refused-once-for-a-reason-the-seed-had-planted)).
   Root acceptance refused once because `.atoma-probes.json` carried six
   prose entries (`"exitCode": null`, `"result": "PASS"`) written by run
   `ef70c2b8` on 2026-08-23, before `write_file` refused manifest edits. The
   seed copy (`cpSync(seedRoot, workspaceRoot, {recursive: true})`) carried
   them through four runs of the project. An HTTP-tooled child always has
   its manifest health-checked (`src/atoms/groundTruth.ts`), so every one of
   those runs reached its validator with `MALFORMED` and a forced review.
2. **A seeded run that deepens loses its seed** — found reading the code,
   reproduced by test. Depth routing's restart archives the workspace and
   builds a new backend over an EMPTY directory. That was decided on
   2026-09-13 for runs that carried no seed ("seeded comparison runs retain
   their existing protocol", [depth experiment](depth-routing-experiment-2026-09-13.md)).
   On 2026-09-23 `2102979` put every project run through depth routing, so
   a project run that deepened rebuilt its corpus from nothing, and the next
   run seeded from that reduced workspace. The decision's rationale — the
   deep attempt must not start over "a half-built workspace" — is about the
   run's STARTING state, which for a seeded run is the seed.

## Why the manifest is not simply excluded from the seed

It is a REPLAY BASELINE. Compiled verification replays every entry
([src/skills](../src/skills/AGENTS.md): "if the manifest exists, it is the
authority over prose") — the measured value of compilation is maintenance
verification — and the maintenance benchmark seeds (`benchmark/seeds/tabstat`,
`benchmark/seeds/wclite`) ship one for exactly that reason. The preview
classifier reads it, including the machine `entry` stamp on HTTP entries, to
learn what the workspace is. Excluding it keeps nothing and costs all of that.

## The contract, as built

- **One seed copy.** `seedWorkspace` in `src/run/workspace.ts`, used at
  launch and again by the deepening restart. The launch log line
  `workspace seeded from … (N entries)` is byte-identical; one more line
  appears only when the manifest changed.
- **One definition of a well-formed entry.** `probeEntryProblems` is the
  per-entry half of `validateProbeManifest`, extracted, not restated. The
  seed transform `inheritProbeManifest` (`src/contracts/probeManifest.ts`)
  keeps every entry it accepts, in order, and drops every entry it rejects —
  one by one, HTTP included, non-objects and unknown shapes included.
- **Bytes untouched when nothing is dropped.** A clean manifest (both
  benchmark seeds) is copied byte for byte, so no benchmark arm sees a
  different file. A manifest that does not parse as version 1, or has
  nothing left, is not written: no manifest is the honest state. A manifest
  that is not a regular file is removed from the copy, never followed.
- **The seed source is never modified.** The run it came from keeps its
  bytes as evidence.
- **Deepening re-seeds.** `restart` drains, archives the first attempt to
  `.prevN`, re-seeds, then builds the new backend. A copy that fails throws,
  and the run fails with the first attempt intact in its archive. Unseeded
  runs keep the empty directory decided on 2026-09-13.

No reader changed. Every reader sees what it saw before, minus entries no
reader could replay.

## The review, and what it changed

The first draft also stamped every inherited entry `"inherited": true` and
gave the attestation readers (health checks, `required-command-manifest`,
`recorded-json-shape`) a view without them. The review refused that half, on
evidence that held when checked:

- **Provenance written into the manifest depends on its writers.** Web
  entries are written by the MODEL through `write_file`, whose merge takes
  the incoming object whole; compiled verifiers merge their observations
  back "preserving each entry's recorded shape". A stamp could be dropped
  (laundering an inherited entry into an observed one) or copied onto fresh
  evidence (hiding it). The claim that the stamp "only removes entries" was
  exactly the false-negative risk.
- **An empty attestation view reads as MALFORMED.** `validateProbeManifest`
  reports an empty entry list as a problem, so a seeded maintenance attempt
  that recorded nothing new would have been told MALFORMED at root
  acceptance — the same refusal class as incident 1.
- **The concept already exists.** Attempt-scoped, host-held observation is
  the witness channel (`recordedProbesFromWitnesses`, already preferred by
  the ground-truth probe) and `attestations.forAttempt`. A stamp that needs
  writers to cooperate would have been a second definition of it.
- **The stale-evidence case was inferred, not observed.** A well-formed
  inherited entry for a required command could satisfy
  `required-command-manifest` on a run that never ran it. No run has shown
  it. Under COOLING-OFF it is recorded, not built. If it is built, the
  direction is to have that gate require a same-attempt recorded-probe
  witness, not to annotate the manifest.

It also corrected two statements of the draft: the validator contract on
"historical observations from the same attempt and branch" governs
runtime-observed witnesses, not the manifest; and a seeded HTTP list is the
concatenation of several runs' appends, not one sequence, so dropping it as
a whole on one bad entry would have wiped an API project's baseline and the
preview's `entry` stamps for nothing a replayer does not already skip.

## Not closed here

- The stale-evidence case above.
- **Inherited fixtures still ship as deliverables** (`wrapper-server.js`,
  `test-setup.js`… on the same project). They are corpus files, not
  evidence; which workspace files a run delivers is a publication question.
- Manifests already in project workspaces are not rewritten. They are
  filtered the next time they are copied as a seed, the only moment they
  mislead anyone.

## Tests

`tests/seed-inheritance.test.ts`: the transform on the `d677d824` shape
(kept in order, dropped one by one, HTTP included, result well-formed),
bytes untouched when clean, idempotence, unreadable and empty inputs, the
source untouched, both benchmark seeds byte-identical, a symlinked manifest
never followed. The production path of incident 1: a trusted molecule's
result validated over the real local tool backend — an unfiltered copy
reaches the validator as MALFORMED with one paid call, the seed copy keeps
the zero-call fast path.

`tests/depth-runner.test.ts`: `startTask --seed` with a first attempt that
deepens. The deep attempt finds the seed's files and filtered manifest and
none of the abandoned attempt's; a seed deleted before the restart fails the
run with `workspace.prev1` intact. Both cases fail on the code before this
change.
