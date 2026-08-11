/**
 * The build-family entrypoint.
 *
 * This file used to be 541 lines and, despite living in `examples/`, was the
 * product: the burn-in harness spawns it once per task, its stdout is the
 * source of `burnin/results.csv`, and AGENTS.md documents it as load-bearing
 * in a dozen places. Everything generic now lives in `src/run/runner.ts` and
 * everything build-specific in `src/run/profiles/build.ts`, so a second task
 * family cannot silently re-diverge the way `research-brief.ts` did.
 *
 * The path stays put on purpose: `src/cli/burnin.ts` spawns it by literal
 * path, and moving it buys nothing measurable while touching the one thing
 * AGENTS.md has caught poisoning a whole batch.
 */
import { runTask } from '../run/runner.js';
import { buildProfile } from '../run/profiles/build.js';

runTask(buildProfile, process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
