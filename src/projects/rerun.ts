import { lstatSync, readFileSync } from 'node:fs';
import { extractJson } from '../atoms/json.js';
import { parseAcceptanceChecklist } from '../contracts/acceptanceChecklist.js';
import type { Project, ProjectRun } from '../contracts/projects.js';
import { MAX_TRACE_BYTES } from '../contracts/traceFields.js';
import { captureAcceptanceSpec } from '../run/acceptanceSpec.js';
import type { VizRun } from '../viz/trace.js';
import { ProjectStateConflict, resolveProjectRunTraceFile, type ProjectStore, type RunAcceptance } from './store.js';

/**
 * COMPARISON RERUNS — what a rerun copies from the run it re-runs.
 * src/projects/AGENTS.md, "Comparison reruns".
 *
 * A rerun B of an origin A answers one question: what would A have cost and
 * produced on other models? So B starts from the state A STARTED from (its
 * seed run R0, never A's own output and never the project's latest run), is
 * asked A's goal, and is judged against the list A was judged against. Every
 * refusal below is a refusal to compare two different things under one name.
 */

export interface RerunOrigin {
  readonly origin: ProjectRun;
  /** The run whose workspace A was seeded from; null when A started empty. */
  readonly seedRun: ProjectRun | null;
  /** The list A ran against, and who wrote it; null when A had none. */
  readonly acceptance: RunAcceptance | null;
}

export function resolveRerunOrigin(input: {
  readonly store: ProjectStore;
  readonly project: Project;
  readonly orgId: string;
  readonly rerunOf: string;
  /** A legacy origin's seed, from its retrieval receipt: `undefined` when there is none. */
  readonly recordedSourceRunId: (runId: string) => string | null | undefined;
}): RerunOrigin {
  const origin = input.store.getProjectRun(input.orgId, input.rerunOf);
  if (!origin || origin.projectId !== input.project.projectId) throw new Error('project run not found');
  if (input.project.repositoryTarget.source) {
    // An imported project's seed is a snapshot of its default branch taken at
    // launch; re-taking it would compare against a different repository head.
    throw new ProjectStateConflict('comparison reruns are not available yet for projects imported from GitHub');
  }
  if (origin.status !== 'delivered' && origin.status !== 'partial') {
    throw new ProjectStateConflict('only a delivered or partial run can be rerun for comparison');
  }
  return {
    origin,
    seedRun: seedRunOf(input, origin),
    acceptance: input.store.getRunAcceptance(origin.orgId, origin.projectRunId) ?? draftedAcceptance(origin),
  };
}

function seedRunOf(
  input: Parameters<typeof resolveRerunOrigin>[0],
  origin: ProjectRun
): ProjectRun | null {
  let seedRunId: string | null;
  if (origin.seed) {
    if (origin.seed.kind === 'repository') {
      throw new ProjectStateConflict('comparison reruns are not available yet for projects imported from GitHub');
    }
    seedRunId = origin.seed.kind === 'run' ? origin.seed.runId : null;
  } else {
    // Rows started before `seed_json` existed: the retrieval receipt names
    // the same `previousSeedRun` the launch copied from, for a project that
    // is not imported (refused above).
    const recorded = input.recordedSourceRunId(origin.projectRunId);
    if (recorded === undefined) {
      throw new ProjectStateConflict('the state this run started from was not recorded, so it cannot be rerun from it');
    }
    seedRunId = recorded;
  }
  if (seedRunId === null) return null;
  const seedRun = input.store.getProjectRun(origin.orgId, seedRunId);
  if (!seedRun || seedRun.projectId !== origin.projectId) {
    throw new ProjectStateConflict('the run this run started from no longer exists');
  }
  if (seedRun.bytesExpiredAt) {
    throw new ProjectStateConflict('the workspace this run started from has expired; restore it before rerunning');
  }
  let present = false;
  try {
    present = lstatSync(seedRun.hostPaths.workspacePath).isDirectory();
  } catch {
    present = false;
  }
  if (!present) throw new ProjectStateConflict('the workspace this run started from is no longer on disk');
  return seedRun;
}

/**
 * The list an origin DRAFTED for itself, recovered from its trace: the
 * response of its one `draft-checklist` call, parsed by the same functions
 * the run used (`draftAcceptanceChecklist`). The acceptance event keeps only
 * coverage, not the HTTP checks, so the response is the one complete record.
 *
 * The fifth disposition over `MAX_TRACE_BYTES` (src/contracts/AGENTS.md): a
 * rerun REFUSES, because a list it could not read would silently be replaced
 * by a new draft from other models — two yardsticks under one comparison.
 * `null` when the origin drafted nothing, which leaves the rerun to draft.
 */
function draftedAcceptance(origin: ProjectRun): RunAcceptance | null {
  const tracePath = resolveProjectRunTraceFile({
    projectRunId: origin.projectRunId,
    runsPath: origin.hostPaths.runsPath,
    traceId: origin.traceId,
  });
  if (!tracePath) return null;
  const stat = lstatSync(tracePath);
  if (!stat.isFile() || stat.size > MAX_TRACE_BYTES) {
    throw new ProjectStateConflict("this run's trace cannot be read to recover its acceptance checklist");
  }
  let trace: Partial<VizRun>;
  try {
    trace = JSON.parse(readFileSync(tracePath, 'utf8')) as Partial<VizRun>;
  } catch {
    throw new ProjectStateConflict("this run's trace cannot be read to recover its acceptance checklist");
  }
  const draft = (Array.isArray(trace.events) ? trace.events : []).find(
    (event) => event.kind === 'llm' && event.role === 'draft-checklist'
  );
  if (!draft || draft.kind !== 'llm' || typeof draft.response !== 'string') return null;
  let items;
  try {
    items = parseAcceptanceChecklist(extractJson(draft.response));
  } catch {
    return null;
  }
  if (items.length === 0) return null;
  return {
    spec: captureAcceptanceSpec(items.map(({ behaviour, check }) => ({ behaviour, check }))),
    source: 'drafted',
  };
}
