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
- Codex tier pins are refused for L1 at LAUNCH (`RunnerConfigError`), not only
  in doctor, and the check reads the pin AFTER `applyTierPins` so a
  snapshot-only `codex:` L1 is caught and an ambient pin omitted from the
  snapshot is not. A codex L1 would serve every text-only prefilter/validator
  and detonate at the first tool-bearing execute, mid-run and mid-spend.
  `assertTransportHonoursCredentials` refuses `claude-cli` / `codex` as the
  base transport AND as a tier pin whenever a snapshot is supplied.
- IT NOW FIRES ON PROJECT RUNS TOO, and that is the point. It never had:
  `runTask` passes no snapshot and `spawnRun` replaces the child env wholesale,
  so on the ONE path where a payer decision crosses a process boundary the
  coordinator was the sole gate. A tenant run is marked `ATOMA_TENANT_RUN=1` by
  the coordinator, and its own `process.env` IS the supplied snapshot; the
  developer path, which sets no such marker, is untouched.
- The refusal reads `ATOMA_SUBSCRIPTION_TIERS`, the list of tiers the PARENT
  authorised for the host subscription (`base`, `l1`, `l2`, `l3`). A
  `claude-cli:` pin on a tier that list does not name reached the child another
  way and throws at launch, before spend. The list only ever NARROWS what is
  permitted: a forged one grants no credential, because that transport
  authenticates from the host's own login session, which a tenant run has no
  way to obtain. `codex:` is never authorisable. See
  [src/projects](../projects/AGENTS.md) for who may arm a tier, and
  `docs/subscription-per-tier-design-2026-08-28.md` for why.

## Run host

- `src/run/platform.ts` is the ONE definition of where a run may execute:
  `darwin` and `linux`. It is not a preference — the run is a detached process
  GROUP reaped through SIGTERM → grace → SIGKILL, and `npm` must be an
  executable. Windows stays a DEVELOPMENT host — typecheck, lint, docs:check,
  build and the compiled MCP smoke pass there; parts of the TEST SUITE are
  POSIX-shaped on purpose (they drive shells, `chmod`, `tar` and process
  groups, which is what makes them proof). WSL2 and `.devcontainer/` are the
  named ways to run, and to run the full suite.
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

- Provider construction has one switch: `makeBaseClient` in
  `src/run/providers.ts`, consumed by runner and curriculum. Never hand-roll
  the ollama/claude-cli/anthropic ternary again. A `providerEnv` snapshot
  must also drive the three `ATOMA_MODEL_L*` pins (`applyTierPins`); do not
  re-read `process.env` for pins the router already resolved from the snapshot.

## Run accounting

- The runner's `ATOMA_RUN_STATS` JSON epilogue is the burn-in accounting
  contract. `parseRunLog` keeps text parsing only for interrupted legacy runs;
  never add global regexes over model-authored prose.
