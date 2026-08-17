import { RunnerConfigError } from '../core/errors.js';

export interface ToolBackendMode {
  readonly container: boolean;
  readonly egress: boolean;
}

/**
 * One definition for the run's local/container mode.
 *
 * Doctor must diagnose the mode the runner will actually use. Keeping the
 * env and flag precedence here prevents a preflight from saying "local" while
 * `runTask` starts Docker (or the inverse). Egress always implies a container.
 */
export function resolveToolBackendMode(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): ToolBackendMode {
  let container = env['ATOMA_CONTAINER'] === '1';
  let egress = env['ATOMA_EGRESS'] === '1';
  for (const arg of argv) {
    if (arg === '--container') container = true;
    else if (arg === '--no-container') container = false;
    else if (arg === '--egress') {
      egress = true;
      container = true;
    } else if (arg === '--no-egress') {
      egress = false;
    }
  }
  if (egress) container = true;
  return { container, egress };
}

/**
 * Does this deployment require EVERY run to execute behind an OS boundary?
 *
 * `ATOMA_REQUIRE_ISOLATION=1` is the deployment-wide switch; an embedder can
 * override it per call. Off by default, so a developer running locally is
 * unaffected — the same split that keeps `claude-cli` usable on the operator
 * plane.
 *
 * READ FROM THE HOST ENVIRONMENT, NEVER FROM A RUN'S OWN SNAPSHOT. This is
 * the host's policy about the run, not an input the run gets to choose: a
 * tenant able to set this in the environment it supplies would be a tenant
 * able to unlock its own jail. `startTask` passes `process.env` here even
 * though it passes `providerEnv` everywhere else, and that asymmetry is the
 * point.
 */
export function resolveIsolationRequirement(
  env: NodeJS.ProcessEnv = process.env,
  override?: boolean
): boolean {
  if (override !== undefined) return override;
  return env['ATOMA_REQUIRE_ISOLATION'] === '1';
}

/**
 * Invariant T1 (docs/saas-architecture.md §5): no store is reachable from a
 * run's sandbox.
 *
 * The local backend is NOT a boundary and was never claimed to be. `run_shell`
 * spawns a real child with the workspace as cwd and no jail on the child, so
 * `../..` reaches the atom store, the skills root and other runs' workspaces —
 * reproduced in §3, and the reason the document says tenant isolation "is not
 * implementable in-process". No column and no `WHERE org_id = ?` survives a
 * child that can `cat` the database file.
 *
 * Only `container` is asserted, not `egress`. Both containerised modes are
 * already default-deny at the OS layer: without `--egress` the container runs
 * `--network none` and reaches nothing, and with it every request goes through
 * a per-run proxy with an anchored host allowlist. Destination policy is
 * therefore enforced by the boundary rather than re-implemented per tool —
 * adding a `fetch_url` allowlist on top would be a second copy of one rule.
 */
export function assertIsolationBoundary(mode: ToolBackendMode, required: boolean): void {
  if (!required || mode.container) return;
  throw new RunnerConfigError(
    'isolation is required (ATOMA_REQUIRE_ISOLATION=1 or requireIsolation) but this run would ' +
      'use the local tool backend, which is not a boundary: run_shell spawns an unjailed child ' +
      "with the workspace as cwd, so the atom store, the skills root and other runs' workspaces " +
      'are reachable with `..`. Launch with --container (or --egress for allowlisted network ' +
      'access), or set ATOMA_CONTAINER=1.'
  );
}
