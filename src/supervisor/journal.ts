import type { PlatformEventInput, PlatformEventSink } from '../contracts/platformEvents.js';
import type { MendRecordOutcome } from '../contracts/supervisorMend.js';
import type { FindingKind, VerdictGrade, VerdictRunStatus } from '../contracts/supervisorVerdict.js';

/**
 * WHAT THE SUPERVISOR WRITES INTO THE JOURNAL, worded once.
 *
 * Every stage action is an attributable act on the deployment — a verdict
 * recorded, a mend started, a pull request opened — and the journal is where
 * such acts live (`src/platform/AGENTS.md`). The rows are `system`: a resident
 * or cron process, not a signed-in principal, like the sentinel's.
 *
 * NOTHING MODEL-AUTHORED ENTERS A ROW. A finding's title, a verdict's summary
 * and a mend report's text are model prose over untrusted trace material; they
 * stay in the git-ignored `supervisor/` records. A row carries counts, kinds,
 * grades, a defect key, a branch name, a PR URL, a cost and a model id — what
 * an operator filters by and what a push body may safely render.
 */

export interface VerdictJournalFacts {
  readonly runId: string;
  readonly runStatus: VerdictRunStatus;
  readonly grade: VerdictGrade;
  readonly worstFindingKind: FindingKind | null;
  readonly findingKinds: Readonly<Record<FindingKind, number>>;
  readonly modelRequested: string;
  readonly modelsServed: readonly string[];
  readonly analysisCostUsd: number | null;
  readonly verdictPath: string;
}

export function verdictEvent(facts: VerdictJournalFacts): PlatformEventInput {
  const worst = facts.worstFindingKind ? `, worst finding ${facts.worstFindingKind}` : ', no actionable finding';
  return {
    kind: 'supervisor.verdict',
    actorType: 'system',
    runId: facts.runId,
    summary: `Analyst graded a ${facts.runStatus} run ${facts.grade}${worst}`,
    detail: {
      stage: 'analyst',
      runStatus: facts.runStatus,
      grade: facts.grade,
      worstFindingKind: facts.worstFindingKind,
      findingKinds: facts.findingKinds,
      modelRequested: facts.modelRequested,
      modelsServed: facts.modelsServed,
      analysisCostUsd: facts.analysisCostUsd,
      verdictPath: facts.verdictPath,
    },
  };
}

export interface MendJournalFacts {
  readonly runId: string;
  readonly findingIndex: number;
  readonly key: string;
  readonly branch: string;
  readonly outcome: MendRecordOutcome | 'started';
  readonly prUrl?: string | null;
  readonly sha?: string | null;
  readonly modelRequested?: string;
  readonly modelsServed?: readonly string[];
  readonly mendCostUsd?: number | null;
  readonly changedFiles?: number;
  readonly changedLines?: number;
  /** Stable harness reasons (policy problems), never model text. */
  readonly problems?: readonly string[];
  readonly worktreeKept?: boolean;
}

const MEND_KIND_BY_OUTCOME: Record<
  MendJournalFacts['outcome'],
  'mender.started' | 'mender.declined' | 'mender.refused' | 'mender.pr_opened' | 'mender.failed' | null
> = {
  started: 'mender.started',
  declined: 'mender.declined',
  refused: 'mender.refused',
  'pr-opened': 'mender.pr_opened',
  'pushed-no-pr': 'mender.failed',
  'model-failed': 'mender.failed',
  'invalid-report': 'mender.failed',
  'harness-failed': 'mender.failed',
  // Nothing happened to the deployment: no row.
  'skipped-duplicate': null,
  'dry-run': null,
};

const MEND_SUMMARY: Record<MendJournalFacts['outcome'], string> = {
  started: 'Mender started on a cited defect',
  declined: 'Mender declined to fix a defect',
  refused: 'Mender harness refused the model’s fix',
  'pr-opened': 'Mender opened a pull request',
  'pushed-no-pr': 'Mender pushed a branch but could not open the pull request',
  'model-failed': 'Mender session failed',
  'invalid-report': 'Mender session ended without a valid report',
  'harness-failed': 'Mender harness failed',
  'skipped-duplicate': '',
  'dry-run': '',
};

/** Null when the outcome is bookkeeping only and no row is owed. */
export function mendEvent(facts: MendJournalFacts): PlatformEventInput | null {
  const kind = MEND_KIND_BY_OUTCOME[facts.outcome];
  if (!kind) return null;
  return {
    kind,
    actorType: 'system',
    runId: facts.runId,
    summary: MEND_SUMMARY[facts.outcome],
    detail: {
      stage: 'mender',
      outcome: facts.outcome,
      findingIndex: facts.findingIndex,
      key: facts.key,
      branch: facts.branch,
      ...(facts.prUrl !== undefined ? { prUrl: facts.prUrl } : {}),
      ...(facts.sha !== undefined ? { sha: facts.sha } : {}),
      ...(facts.modelRequested !== undefined ? { modelRequested: facts.modelRequested } : {}),
      ...(facts.modelsServed !== undefined ? { modelsServed: facts.modelsServed } : {}),
      ...(facts.mendCostUsd !== undefined ? { mendCostUsd: facts.mendCostUsd } : {}),
      ...(facts.changedFiles !== undefined ? { changedFiles: facts.changedFiles } : {}),
      ...(facts.changedLines !== undefined ? { changedLines: facts.changedLines } : {}),
      ...(facts.problems !== undefined ? { problems: facts.problems.map((p) => p.slice(0, 160)).slice(0, 5) } : {}),
      ...(facts.worktreeKept !== undefined ? { worktreeKept: facts.worktreeKept } : {}),
    },
  };
}

/** A sink that never throws into the stage, whatever the journal does. */
export function safeSink(sink: PlatformEventSink | null | undefined, warn: (line: string) => void): PlatformEventSink {
  return (input) => {
    if (!sink) return;
    try {
      sink(input);
    } catch (error) {
      warn(`journal append failed for ${input.kind}: ${String(error)}`);
    }
  };
}
