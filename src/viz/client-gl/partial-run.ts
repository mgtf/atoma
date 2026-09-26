import { landingReasons, type LandingSignals } from '../../contracts/runLanding.js';
import type { RunIndexEntry, VizProject, VizRun } from '../client/types.js';

/**
 * WHAT A PERSON SHOULD DO ABOUT AN INCOMPLETE RUN.
 *
 * `partial` is precise and says nothing to the person who asked for the work.
 * The typed reasons (`landingReasons`) are the acceptor's own prose, in
 * English, about READMEs and loopback probes — true, and useless to someone
 * who is not a developer. So the guidance is built from two CLOSED facts the
 * trace and the project already carry, and the copy for each is ours:
 *
 *   - WHY it stopped: the budget ran out, the final check refused it, or both
 *     (the two reasons compose — `src/contracts/runLanding.ts`);
 *   - WHETHER THE NEXT RUN CONTINUES IT: a project run's next run starts from
 *     the latest delivered-or-partial workspace and is handed these reasons
 *     (`previousSeedRun`, `PREVIOUS_LANDING_ENV`) — EXCEPT a project imported
 *     from GitHub, whose every run starts from the repository's default branch,
 *     so an unpublished partial change is not carried over, and EXCEPT a
 *     comparison rerun, which sits beside the project and never seeds it
 *     (2026-09-25 review, 2.7), and EXCEPT a partial a later run of the same
 *     line has since superseded: the next run starts from that one. Saying
 *     "it picks up from here" there would be the one sentence on this card
 *     that is false.
 *
 * The model's reasons stay reachable as technical detail, never as the lead.
 */
export type LandingCause = 'budget' | 'refused' | 'both';

export function landingCause(result: LandingSignals | null | undefined): LandingCause | null {
  if (!result) return null;
  const budget = (result.unfinishedPhases?.length ?? 0) > 0;
  const refused = Boolean(result.refusal);
  if (budget && refused) return 'both';
  if (budget) return 'budget';
  return refused ? 'refused' : null;
}

export interface PartialRunGuidance {
  readonly cause: LandingCause;
  /** The project a next run would continue — null for a run outside one. */
  readonly project: VizProject | null;
  /** True when the project's next run starts from this work. */
  readonly carriesOver: boolean;
  /** A comparison rerun: kept beside the project, never continued by it. */
  readonly rerun: boolean;
  /**
   * A later run of the project's own line finished with work to seed (not
   * failed, cancelled, live or a rerun): the next run continues from it. The
   * Projects view shows guidance on its newest row only, for the same reason.
   */
  readonly superseded: boolean;
  /** The goal to offer again, when the run carries one. */
  readonly goal: string | null;
  /** The typed reasons, model-authored: detail, never the headline. */
  readonly details: readonly string[];
}

export function partialRunGuidance(
  run: VizRun,
  index: readonly RunIndexEntry[],
  projects: readonly VizProject[]
): PartialRunGuidance | null {
  const cause = landingCause(run.result);
  if (!cause) return null;
  const entry = index.find((candidate) => candidate.id === run.id);
  const project = entry?.projectId
    ? projects.find((candidate) => candidate.projectId === entry.projectId) ?? null
    : null;
  // The index's goal is the one the person typed, in full; the trace's task
  // description is the fallback for an index that predates that field.
  const goal = entry?.goal?.trim() || run.task?.description?.trim() || null;
  const startedAt = entry ? Date.parse(entry.startedAt) : NaN;
  const superseded = Boolean(entry?.projectId && !entry.rerunOf && Number.isFinite(startedAt) && index.some((other) =>
    other.id !== entry.id && other.projectId === entry.projectId && !other.rerunOf &&
    other.endedAt !== undefined && !other.inFlight && !other.hasError && !other.cancelled &&
    Date.parse(other.startedAt) > startedAt));
  return {
    cause,
    project,
    carriesOver: Boolean(project && !project.repositoryTarget.source && !entry?.rerunOf && !superseded),
    rerun: Boolean(entry?.rerunOf),
    superseded,
    goal,
    details: landingReasons(run.result),
  };
}

/** The activation id of the "continue" control, and its one parser. */
export const PARTIAL_CONTINUE_PREFIX = 'run.partial.continue.';
