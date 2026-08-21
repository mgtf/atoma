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
