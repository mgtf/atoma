import { resolve } from 'node:path';
import type { VizEvent, VizRun } from '../viz/trace.js';
import { peekRunLease } from '../mcp/runLock.js';
import { eventLabel, type PlatformEventInput } from '../contracts/platformEvents.js';
import { runSentinelRules, type SentinelFinding, type SentinelKind } from './rules.js';
import type { TrajectoryReference } from '../contracts/trajectory.js';
import { operatorTrajectoryReferenceSource, type TrajectoryReferenceSource } from './reference.js';
import {
  MAX_TRACE_BYTES,
  operatorRunSource,
  readBoundedJson,
  type SentinelLiveRun,
  type SentinelRunCorpus,
  type SentinelRunSource,
  type SentinelSkip,
} from './sources.js';
import type { SentinelWatchSource } from './lease.js';

/**
 * THE SENTINEL WATCH — one tick, and the loop around it.
 *
 * Reads, never writes anything but journal rows. It holds no LLM and spends
 * no tokens, which is what lets it run continuously beside the viz server and
 * the MCP host while runs execute (`docs/supervisor-design.md`: "The sentinel
 * costs zero tokens forever").
 *
 * WHAT IT READS, and what it deliberately does not:
 *   - every live run its SOURCES report, and that run's trace file. There are
 *     two corpora and a watch on either alone is half blind: `./runs` holds
 *     the operator runs (CLI, burn-in, benchmark), while each project run
 *     writes into its own directory. `sources.ts` owns that split; this file
 *     owns what happens to a run once found.
 *   - the MCP run lease, for context only: which pid holds it, if any. The
 *     lease is not the detector — a lease-only watch would miss the CLI runs
 *     that most need watching.
 *   - NEVER the runner's stdout. That stream is the burn-in harness's parsed
 *     API and a second parser on it would couple the sentinel to a format it
 *     does not own.
 *
 * DE-DUPLICATION IS AGAINST THE JOURNAL, not against process memory. The
 * journal is the record of what has already been said, so a restarted watcher
 * repeats nothing and two watchers cannot double-report. Each finding's
 * `dedupeKey` is stored in `detail` for exactly this read-back.
 */

/** The kinds this watcher writes, and the only kinds it reads back. */
const SENTINEL_KINDS: readonly SentinelKind[] = ['run.anomaly', 'security.flagged'];

export interface SentinelJournal {
  append(input: PlatformEventInput): unknown;
  list(query: { kind?: string; runId?: string; limit?: number; before?: number }): {
    events: { seq?: number; detail?: Record<string, unknown> | undefined }[];
    /** Cursor for the next (older) page, or null at the end. */
    nextBefore?: number | null;
  };
}

/**
 * How many pages of read-back one run may cost per kind.
 *
 * The read-back USED to be one page of 200, which quietly turned the
 * cross-tick guarantee into a cross-tick-under-200-findings guarantee: past
 * that, the oldest keys fell off the page, the rules re-emitted them, and each
 * tick added more rows for the next tick to miss. Paging fixes it; the cap
 * bounds it. Hitting the cap is treated exactly like a journal that cannot be
 * read — "everything already said" — because a run with 2000 findings needs an
 * operator, not more rows.
 */
export const MAX_DEDUPE_PAGES = 10;
const DEDUPE_PAGE_SIZE = 200;

export interface SentinelWatchOptions {
  readonly journal: SentinelJournal;
  /**
   * Where live runs come from. Omitted, it is the operator corpus alone —
   * which is what a bare `npm run sentinel` on a checkout with no tenants
   * should watch, and nothing more.
   */
  readonly sources?: readonly SentinelRunSource[];
  /** Operator corpus directory, used only to build the default source. */
  readonly runsDir?: string;
  readonly now?: () => number;
  /** USD alert threshold, or null to disable that rule. Not a budget. */
  readonly costAlertUsd?: number | null;
  /**
   * Similarity floor for `trajectory-drift`, or null to disarm it. Defaults to
   * DISARMED here, so a bare watch in a test screens the window-only rules;
   * both hosts pass the environment's value through one helper
   * (`sentinelTrajectoryMinScoreFromEnv`), which arms it by default.
   */
  readonly trajectoryMinScore?: number | null;
  /**
   * Where the credited trajectories of finished runs come from, one per
   * corpus. Omitted with the default operator source, it is that corpus's own
   * `runs/`; omitted beside explicit `sources`, it is nothing, because this
   * class cannot know which directories or stores those sources read.
   */
  readonly trajectoryReferences?: readonly TrajectoryReferenceSource[];
  readonly leasePath?: string;
  /**
   * Which host is watching. It rides every row as `detail.watch` so a finding
   * can be traced to the process that wrote it — there are two hosts now, and
   * `actorType` stays `system` for both because watcher identity is a sentinel
   * fact, not an actor. Defaults to the CLI, the historical host; the viz
   * server passes its own.
   */
  readonly source?: SentinelWatchSource;
  readonly logger?: (line: string) => void;
}

export interface SentinelReferenceReport {
  readonly corpus: SentinelRunCorpus;
  readonly runs: number;
  readonly signatures: number;
  readonly unreadable: number;
  /** The source threw; the rule was silent for this corpus this tick. */
  readonly failed: string | null;
}

export interface SentinelTickReport {
  readonly runs: SentinelLiveRun[];
  readonly emitted: SentinelFinding[];
  /** Candidates seen but skipped, with why — never silently ignored. */
  readonly skipped: SentinelSkip[];
  /** Present when the trajectory rule is armed: what each corpus was scored against. */
  readonly references?: SentinelReferenceReport[];
}

export class SentinelWatch {
  private readonly journal: SentinelJournal;
  private readonly sources: readonly SentinelRunSource[];
  private readonly now: () => number;
  private readonly costAlertUsd: number | null;
  private readonly trajectoryMinScore: number | null;
  private readonly trajectoryReferences: readonly TrajectoryReferenceSource[];
  private readonly leasePath: string | undefined;
  private readonly source: SentinelWatchSource;
  private readonly logger: (line: string) => void;

  constructor(options: SentinelWatchOptions) {
    this.journal = options.journal;
    const runsDir = resolve(options.runsDir ?? process.env['ATOMA_RUNS_DIR'] ?? './runs');
    this.sources = options.sources ?? [operatorRunSource({ runsDir })];
    this.trajectoryMinScore = options.trajectoryMinScore ?? null;
    this.trajectoryReferences =
      options.trajectoryReferences ??
      (options.sources ? [] : [operatorTrajectoryReferenceSource({ runsDir })]);
    this.now = options.now ?? (() => Date.now());
    this.costAlertUsd = options.costAlertUsd ?? null;
    if (options.leasePath !== undefined) this.leasePath = options.leasePath;
    this.source = options.source ?? 'cli';
    this.logger = options.logger ?? (() => {});
  }

  /** Keys already journaled for this run, so nothing is said twice. */
  private emittedKeys(runId: string): Set<string> {
    const keys = new Set<string>();
    for (const kind of SENTINEL_KINDS) {
      let before: number | undefined;
      for (let page = 0; page < MAX_DEDUPE_PAGES; page++) {
        let read: ReturnType<SentinelJournal['list']>;
        try {
          read = this.journal.list({
            kind,
            runId,
            limit: DEDUPE_PAGE_SIZE,
            ...(before !== undefined ? { before } : {}),
          });
        } catch {
          // A journal read that fails must not turn into a flood: treat it as
          // "everything already said" for this tick and try again next time.
          return new Set(['__journal-unavailable__']);
        }
        for (const event of read.events) {
          const key = event.detail?.['dedupeKey'];
          if (typeof key === 'string') keys.add(key);
        }
        const next = read.nextBefore;
        if (typeof next !== 'number') break;
        before = next;
        // The cap is reached WITH a page still outstanding: the run has more
        // history than this watch will read, so say nothing rather than
        // re-say what is beyond the cap.
        if (page === MAX_DEDUPE_PAGES - 1) return new Set(['__journal-unavailable__']);
      }
    }
    return keys;
  }

  /** One pass. Pure with respect to everything except journal rows. */
  tick(): SentinelTickReport {
    const emitted: SentinelFinding[] = [];
    const skipped: SentinelSkip[] = [];
    const runs: SentinelLiveRun[] = [];
    const now = this.now();
    // Contained, like every other read in this pass: `peekRunLease` opens a
    // SQLite file this module does not own, and it was the one call in `tick`
    // that could throw past every guard. Context is worth having and never
    // worth a failed pass.
    let lease: ReturnType<typeof peekRunLease> = null;
    try {
      if (this.leasePath) lease = peekRunLease(this.leasePath);
    } catch {
      lease = null;
    }

    // The trajectory reference, once per tick and per corpus, before any run
    // is screened. Contained like every other read in this pass: a source that
    // throws leaves its corpus unscored this tick and says so in the report.
    let references: Map<SentinelRunCorpus, TrajectoryReference> | null = null;
    const referenceReports: SentinelReferenceReport[] = [];
    if (this.trajectoryMinScore !== null) {
      references = new Map();
      for (const source of this.trajectoryReferences) {
        try {
          const load = source.load();
          references.set(source.corpus, load.reference);
          referenceReports.push({
            corpus: source.corpus,
            runs: load.reference.runs,
            signatures: load.reference.signatures,
            unreadable: load.unreadable,
            failed: null,
          });
        } catch (error) {
          referenceReports.push({
            corpus: source.corpus,
            runs: 0,
            signatures: 0,
            unreadable: 0,
            failed: String(error),
          });
          this.logger(`trajectory reference for ${source.corpus} runs failed: ${String(error)}`);
        }
      }
    }

    for (const source of this.sources) {
      let discovered;
      try {
        discovered = source.discover(now);
      } catch (error) {
        // One unreachable corpus must not blind the watch to the other. A
        // tenant store that is locked, absent or mid-migration is exactly the
        // moment operator runs still need watching.
        skipped.push({ runId: null, reason: `${source.corpus} source failed: ${String(error)}` });
        continue;
      }
      skipped.push(...discovered.skipped);
      for (const candidate of discovered.runs) {
        runs.push(candidate);
        this.screen(candidate, lease, references?.get(candidate.corpus) ?? null, emitted, skipped);
      }
    }
    return { runs, emitted, skipped, ...(references ? { references: referenceReports } : {}) };
  }

  /** One live run: read, apply the table, journal what has not been said. */
  private screen(
    candidate: SentinelLiveRun,
    lease: ReturnType<typeof peekRunLease>,
    reference: TrajectoryReference | null,
    emitted: SentinelFinding[],
    skipped: SentinelSkip[]
  ): void {
    const run = readBoundedJson<VizRun>(candidate.tracePath, MAX_TRACE_BYTES);
    if (!run) {
      skipped.push({ runId: candidate.runId, reason: 'trace unreadable or over the size cap' });
      return;
    }
    const events: VizEvent[] = run.events ?? [];
    const already = this.emittedKeys(candidate.runId);
    if (already.has('__journal-unavailable__')) {
      skipped.push({ runId: candidate.runId, reason: 'journal unavailable for read-back' });
      return;
    }
    const findings = runSentinelRules(
      {
        runId: candidate.runId,
        events,
        costAlertUsd: this.costAlertUsd,
        trajectoryReference: reference,
        trajectoryMinScore: this.trajectoryMinScore,
      },
      (ruleId, error) => this.logger(`rule ${ruleId} threw: ${String(error)}`)
    );
    for (const finding of findings) {
      if (already.has(finding.dedupeKey)) continue;
      already.add(finding.dedupeKey);
      this.journal.append({
        kind: finding.kind,
        // `system`: a resident process, not the operator CLI and not a
        // signed-in principal. The row is attributable to the machine.
        actorType: 'system',
        actorId: null,
        // ATTRIBUTION, not audience. A tenant run's finding names its org and
        // project so an admin can filter and so a future org-scoped read has
        // something to scope by. The push audience is unchanged and stays in
        // `viz/push/routes.ts`: these rules are not calibrated yet, and the
        // first thing a customer should learn from atoma is not an
        // uncalibrated heuristic about their own run.
        orgId: candidate.orgId,
        projectId: candidate.projectId,
        runId: candidate.runId,
        summary: eventLabel(finding.summary, 200),
        detail: {
          ...finding.detail,
          dedupeKey: finding.dedupeKey,
          corpus: candidate.corpus,
          // WHICH HOST wrote this row. The pid and start time deliberately do
          // NOT ride along: they are fresh in the health payload and in the
          // watch lease, and a stale pid on an immutable row is a fact that
          // rots.
          watch: this.source,
          ...(lease ? { leaseOwnerPid: lease.ownerPid, leaseRunId: lease.runId } : {}),
        },
      });
      emitted.push(finding);
      this.logger(
        `${finding.kind} ${finding.ruleId} on ${candidate.corpus} run ${candidate.runId}: ${finding.summary}`
      );
    }
  }
}

export const SENTINEL_DEFAULT_INTERVAL_MS = 20_000;

/**
 * THE ONLY WAY EITHER SHELL REACHES A TICK.
 *
 * Containment used to live inside `runSentinelLoop`, which was fine while the
 * CLI was the only host: a throwing tick cost one pass. In a server process an
 * exception escaping an interval callback is an UNCAUGHT exception — the viz
 * server registers no `uncaughtException` handler, so the process exits, and
 * `scripts/viz-dev.mjs` then takes Vite down with it. One bad `statSync` would
 * end the operator's session. So containment is a function both shells call,
 * not a property of one of them.
 */
export function safeTick(
  watch: Pick<SentinelWatch, 'tick'>,
  log: (line: string) => void
): SentinelTickReport | null {
  try {
    return watch.tick();
  } catch (error) {
    log(`tick failed: ${String(error)}`);
    return null;
  }
}

/**
 * The resident loop. Ticks, sleeps, repeats until the signal aborts.
 *
 * A tick that throws is logged and the loop continues: an observer that dies
 * on one bad trace stops observing everything after it, which is the failure
 * mode this whole stage exists to remove.
 */
export async function runSentinelLoop(args: {
  readonly watch: SentinelWatch;
  readonly signal: AbortSignal;
  readonly intervalMs?: number;
  readonly logger?: (line: string) => void;
  readonly onTick?: (report: SentinelTickReport) => void;
}): Promise<void> {
  const interval = args.intervalMs ?? SENTINEL_DEFAULT_INTERVAL_MS;
  const log = args.logger ?? (() => {});
  while (!args.signal.aborted) {
    const report = safeTick(args.watch, log);
    if (report) args.onTick?.(report);
    if (args.signal.aborted) break;
    await new Promise<void>((resolveSleep) => {
      const timer = setTimeout(resolveSleep, interval);
      args.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolveSleep();
      }, { once: true });
    });
  }
}
