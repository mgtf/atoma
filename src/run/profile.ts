import type { AtomRegistry, AtomType } from '../registry/atomRegistry.js';
import type { Task, Tool } from '../core/types.js';

/**
 * What a TASK FAMILY contributes to a run.
 *
 * Everything else — provider selection and cross-vendor routing, the
 * sandbox and its builtins, trace recording, the skill-lifecycle flags, the
 * run budget, the abort signal, signal handling and the last-resort
 * watchdog — is family-independent and lives in `runTask`.
 *
 * WHY THIS BOUNDARY AND NOT ANOTHER. It is not a guess: an anatomy pass over
 * the 541 lines of the old `examples/build-app.ts` classified every block as
 * generic, build-specific, or banner. This interface carries EXACTLY the
 * build-specific set and nothing more:
 *   - the workspace preparation step,
 *   - the tier-3 seed (prompt + description),
 *   - the canonical L2/L1 catalog seeding,
 *   - the Task constraints,
 *   - the env-var names and defaults for store, workspace and budget.
 * Resisting the urge to add knobs "while we are here" is the point. There is
 * ONE profile today; an interface designed against a single implementation
 * earns its keep only by being a faithful cut of measured differences, never
 * by anticipating a second one. See CLAUDE.md, "Considered and rejected".
 */
export interface TaskProfile {
  /** Stable id, used in logs and (later) to select a profile. */
  readonly id: string;
  /**
   * Prefix of the viz trace label. Kept per-profile because the label is
   * how a human tells families apart in the run list.
   */
  readonly traceLabelPrefix: string;
  /** Goal used when the caller passes none. */
  readonly defaultGoal: string;
  /** Env var NAMES this family reads (values resolved by the runner). */
  readonly envVars: {
    readonly dbPath: string;
    readonly workspace: string;
    readonly timeoutMs: string;
  };
  /** Fallbacks when the corresponding env var is unset. */
  readonly defaults: {
    readonly dbPath: string;
    readonly workspace: string;
  };
  /**
   * Prepare the workspace directory. Called BEFORE the sandbox is
   * constructed — `ToolSandbox` realpath-resolves its root at construction,
   * so archiving the directory afterwards would leave every tool pointing
   * at the archive. A family with nothing to prepare implements a no-op.
   */
  prepareWorkspace(root: string, clean: boolean): void;
  /** Create or refresh this family's tier-3 cell and return it. */
  seedL3(ctx: ProfileSeedContext): AtomType;
  /** Seed the canonical L2/L1 catalog the prefilter will match against. */
  seedCatalog(ctx: ProfileSeedContext): void;
  /** Wrap the goal in this family's constraints. */
  buildTask(goal: string): Task;
}

/** What the runner hands a profile's seeding hooks. */
export interface ProfileSeedContext {
  readonly registry: AtomRegistry;
  readonly toolDecls: readonly Tool[];
  /**
   * Console sink. Passed in rather than letting profiles call `console.log`
   * directly so the runner owns the output stream — the burn-in harness
   * parses that stream, which makes it an API rather than decoration.
   */
  readonly log: (line: string) => void;
}
