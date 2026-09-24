# Run — AGENTS.md

`src/run/` owns the single runner: task profiles, provider construction,
workspaces and tool backends.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/core`](../core/AGENTS.md) — transports and model resolution
- [`src/cli`](../cli/AGENTS.md) — the shells and the burn-in harness
- [`src/tools`](../tools/AGENTS.md) — the backends it selects

## Entry points

- `startTask(profile, argv)` is the library entry: it owns provider, sandbox,
  traces, skills, budgets, the watchdog and post-mortems, throws
  `RunnerConfigError` on bad input, resolves lifecycle env against the HOST
  snapshot (a run's own writes never become the next run's "operator intent"),
  applies the same snapshot to `ATOMA_MODEL_L*` via `applyTierPins` so atom
  `modelForTier()` calls agree with the router (a missing pin is deleted, not
  left as leftover ambient state), and returns a `RunHandle {settled, shutdown}`
  that never parks and never exits. `runTask(profile, argv)` is the CLI shell
  that owns process death: exit 2 on config errors, exit 1 on failure,
  park-forever on delivery, SIGINT/SIGTERM → shutdown. Its stdout is an API
  (burn-in parses it) — the handle refactor kept it byte-identical. A
  `TaskProfile` contributes only family-specific workspace, seed, canonical
  catalog, constraints, and env names.
- The three `ATOMA_MODEL_L*` selectors are REQUIRED and parsed at LAUNCH
  (`tierSelectors`, a `RunnerConfigError` on a missing or malformed pin), AFTER
  `applyTierPins` so a snapshot-only pin is what the run sees and an ambient
  pin omitted from the snapshot is not. Codex selectors (`sub:openai`,
  `own:openai`) support all tiers through the host-side action loop.
  `assertTransportHonoursCredentials` refuses every `sub:`/`own:`
  tier the parent did not authorise whenever a snapshot is supplied.
- IT NOW FIRES ON PROJECT RUNS TOO, and that is the point. It never had:
  `runTask` passes no snapshot and `spawnRun` replaces the child env wholesale,
  so on the ONE path where a payer decision crosses a process boundary the
  coordinator was the sole gate. A tenant run is marked `ATOMA_TENANT_RUN=1` by
  the coordinator, and its own `process.env` IS the supplied snapshot; the
  developer path, which sets no such marker, is untouched.
- The refusal reads `ATOMA_SUBSCRIPTION_TIERS`, the list of tiers the PARENT
  authorised for either the host or requesting principal's subscription
  (`l1`, `l2`, `l3`). A `sub:`/`own:` selector on a tier that list does not
  name reached the child another way and throws at launch, before spend. The list only ever NARROWS what is
  permitted: a forged one grants no credential, because the profile path is
  injected only by the coordinator after its host-authority or exact-principal
  check. The same authority applies to Codex L1. See
  [src/projects](../projects/AGENTS.md) for who may arm a tier, and
  `docs/subscription-per-tier-design-2026-08-28.md` for why.

## Run host

- `src/run/platform.ts` is the ONE definition of where a run may execute:
  `darwin` and `linux`. It is not a preference — the run is a detached process
  GROUP reaped through SIGTERM → grace → SIGKILL, and `npm` must be an
  executable. Windows stays a DEVELOPMENT host — typecheck, lint, docs:check,
  build and the compiled MCP smoke pass there; parts of the TEST SUITE are
  POSIX-shaped on purpose (they drive shells, `chmod`, `tar` and process
  groups, which is what makes them proof). WSL2 with the checkout on ext4 is
  the named way to run, and to run the full suite; the per-platform procedure
  is [`docs/development-setup.md`](../../docs/development-setup.md).
- The refusal is enforced at the LAUNCHER (`spawnRun`), before the spawn, and
  reuses the `--- spawn failed ---` log shape so every caller keeps reading
  outcome `error` with the reason in the log. Doctor reports the same fact as
  a hard failure. Both quote `platform.ts`; neither restates the list.
- Do NOT add an override switch. The defect this contract replaces was not the
  platform's limits but SILENCE — a run that died as a bare `spawn npm ENOENT`
  several processes deep, and a cancellation that reported success over
  orphans still running. A flag that starts a run where the kill sequence
  cannot work restores exactly that.

## Provider construction

- Provider construction has one switch per TRANSPORT: `makeTransportClient`
  in `src/run/providers.ts`, reached through `buildTierClients`, which builds
  only the transports the three selectors name (`transportOf`) — consumed by
  runner, curriculum and the viz announcement translator. There is no base
  client and no `ATOMA_LLM`. A `providerEnv` snapshot must also drive the
  three `ATOMA_MODEL_L*` pins (`applyTierPins`); do not re-read `process.env`
  for pins the router already resolved from the snapshot.

## Run accounting

- New ordinary build runs default to short-first supervision. `--depth deep`
  explicitly enters through L3; `--depth short` selects the default. Baseline
  and REGISTERED COMPARISON ARMS (`--comparison`) retain their existing
  protocol — and that flag exists because the rule read `--seed` until
  2026-09-23. Two unrelated populations pass `--seed`: a campaign arm seeds to
  hold its protocol fixed, a PROJECT run seeds to continue its own corpus. So
  every project run after a project's first silently lost `runDepthTask`, and
  with it root delivery acceptance, the ground-truth probe, the delivery proof
  floor and the attestation log. `resolveSupervisionDepth` is the one decision,
  exported and tested like `resolveSkillPromotion` beside it; the depth design
  had already settled the intent ("CLI, MCP and project launches all inherit
  it"). Depth routing keeps model pins and
  one run deadline, cost ledger and trace. Its profile freezes the delivery
  `proofFloor` before routing, without adding it to phase `proofObligations`.
  Deep enters through L3; short plans and executes
  through the canonical L2, including its peers. Every result goes through
  the same root acceptance; a refusal is handed BACK ONCE
  (`MAX_ROOT_REMEDIATIONS`) and LANDS on the second — it does not fail. The run
  keeps its workspace, records `partial`, seeds the next run, and never
  publishes; measured on production run `6ab0ae3b`, which spent thirty minutes
  and 0.42 USD writing real files and recorded `failed`, so `previousSeedRun`
  skipped it on its status filter and every byte was lost. The refusal
  rides in the task's `inputs` as `rootAcceptanceRefusal` — never appended to
  the description, which planning and skill matching key on — and the pass
  runs in the SAME attempt and workspace, so the attestations already earned
  still cover their deliverables (`rootProofCoverage` re-reads each file and
  compares its digest, so a proof lives exactly as long as the bytes it was
  made against). The budget is one extra pass per RUN, not per attempt: a
  deepening is already this run's second chance at a structural failure.
  A pass the wall clock cannot pay for (`outOfPhaseBudget`) is not opened.
  Measured 2026-09-23: with one pass only, a goal naming nine verifiable
  behaviours was refused twice while a goal naming six was delivered, and the
  refusals named exactly which behaviours had never been probed.
- Only the first short attempt may deepen, at the existing supervision
  fallback moment after its branch retry. Cancel and drain all branches,
  confirm tool processes have exited, archive the workspace, then construct
  a new backend and run the original task through L3. Deep fallbacks remain
  allowed. Gains already earned stay in this run; old attestations cannot
  cover the new attempt. Mechanical plan/result one-shot memos reset per
  attempt and stay fork-shared within it. Lifecycle settings are resolved
  once at launch and stay identical in both attempts; `--depth` does not
  override them. Both local and container backends confirm teardown before
  replacement; container removal is confirmed by the engine before egress
  teardown. An unavailable engine or remaining worker prevents replacement.
- Design and remaining measurement protocol:
  [depth experiment](../../docs/depth-routing-experiment-2026-09-13.md).

- A run has THREE success-side outcomes, not two. `partial` is a run that ended
  with real work and did NOT deliver, for either of TWO typed reasons, and they
  COMPOSE: `Result.unfinishedPhases` (the deadline landed the dispatch before
  some phases ran) and `Result.refusal` (root delivery acceptance did not
  accept the result). `isLanded` in
  [src/contracts/runLanding.ts](../contracts/runLanding.ts) is the ONE
  derivation — the runner, the viz client and the supervisor digest each read a
  different type carrying the same two fields, and were three unlinked copies
  of one expression until 2026-09-24. Typed fields, never the summary text,
  which continues into model-authored prose. Every reader that explains a run
  to a person reports BOTH reasons (`landingReasons`): a run cut short and then
  refused would otherwise show only its phases, dropping the half that says the
  work was judged. The
  trace records it, `machineRunStats` reports it, and `runTask` treats it like a
  delivery for process purposes: exit 0 and park, because there IS something to
  look at. A landed run is not a failure and must not be scripted as one.
- The runner's `ATOMA_RUN_STATS` JSON epilogue is the burn-in accounting
  contract. `parseRunLog` keeps text parsing only for interrupted legacy runs;
  never add global regexes over model-authored prose.

## Intentional choices and rejected shortcuts

- An override switch for the run host: refused, and stated above at length.
  The defect this contract replaces was SILENCE, not the platform's limits.
- A base client, or one `ATOMA_LLM` selector: gone. Provider construction has
  one switch per TRANSPORT (`makeTransportClient`), and the three
  `ATOMA_MODEL_L*` pins are REQUIRED and parsed at launch. A missing pin is a
  `RunnerConfigError`, never a silent default — a run that quietly picks a
  model spends the operator's quota on a decision nobody made.
- Re-reading `process.env` for pins the router already resolved from the
  snapshot: refused. A run's own writes must never become the next run's
  "operator intent".
- Treating a landed run as a failure: refused. `partial` is a THIRD
  success-side outcome, and `runTask` exits 0 and parks on it exactly as on a
  delivery, because there IS something to look at. Scripts that branch on
  "not delivered" are reading the wrong field; the typed
  `Result.unfinishedPhases` is what separates the two.
- Raising the run budget as the answer to a truncated run: refused as the
  MAIN answer. A bigger budget only moves the cliff; landing is what recovers
  the spend. The 30 → 60 minute raise of 2026-09-22 shipped as the smaller
  half of that change, beside moving preparation off the tenant's clock.
- Reading `--seed` as "this run is a measurement arm": refused since
  2026-09-23, and it is the reason `--comparison` exists. A seed says where
  the workspace came from, never why. Measured on run `e743b47d`, delivered
  and published to a tenant repository with `probes: []`.
- Global regexes over the runner's stdout: refused. `ATOMA_RUN_STATS` is the
  accounting contract and `parseRunLog` keeps text parsing only for
  interrupted legacy runs. A regex over model-authored prose is a parser whose
  input nobody controls.
