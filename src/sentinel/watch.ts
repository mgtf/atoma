import { resolve } from 'node:path';
import type { VizEvent, VizRun } from '../viz/trace.js';
import { peekRunLease } from '../mcp/runLock.js';
import { eventLabel, type PlatformEventInput } from '../contracts/platformEvents.js';
import { runSentinelRules, type SentinelFinding, type SentinelKind } from './rules.js';
import {
  MAX_TRACE_BYTES,
  operatorRunSource,
  readBoundedJson,
  type SentinelLiveRun,
  type SentinelRunSource,
  type SentinelSkip,
} from './sources.js';

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
  list(query: { kind?: string; runId?: string; limit?: number }): {
    events: { detail?: Record<string, unknown> | undefined }[];
  };
}

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
  readonly leasePath?: string;
  readonly logger?: (line: string) => void;
}

export interface SentinelTickReport {
  readonly runs: SentinelLiveRun[];
  readonly emitted: SentinelFinding[];
  /** Candidates seen but skipped, with why — never silently ignored. */
  readonly skipped: SentinelSkip[];
}

export class SentinelWatch {
  private readonly journal: SentinelJournal;
  private readonly sources: readonly SentinelRunSource[];
  private readonly now: () => number;
  private readonly costAlertUsd: number | null;
  private readonly leasePath: string | undefined;
  private readonly logger: (line: string) => void;

  constructor(options: SentinelWatchOptions) {
    this.journal = options.journal;
    this.sources = options.sources ?? [
      operatorRunSource({
        runsDir: resolve(options.runsDir ?? process.env['ATOMA_RUNS_DIR'] ?? './runs'),
      }),
    ];
    this.now = options.now ?? (() => Date.now());
    this.costAlertUsd = options.costAlertUsd ?? null;
    if (options.leasePath !== undefined) this.leasePath = options.leasePath;
    this.logger = options.logger ?? (() => {});
  }

  /** Keys already journaled for this run, so nothing is said twice. */
  private emittedKeys(runId: string): Set<string> {
    const keys = new Set<string>();
    for (const kind of SENTINEL_KINDS) {
      let page: ReturnType<SentinelJournal['list']>;
      try {
        page = this.journal.list({ kind, runId, limit: 200 });
      } catch {
        // A journal read that fails must not turn into a flood: treat it as
        // "everything already said" for this tick and try again next time.
        return new Set(['__journal-unavailable__']);
      }
      for (const event of page.events) {
        const key = event.detail?.['dedupeKey'];
        if (typeof key === 'string') keys.add(key);
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
    const lease = this.leasePath ? peekRunLease(this.leasePath) : null;

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
        this.screen(candidate, lease, emitted, skipped);
      }
    }
    return { runs, emitted, skipped };
  }

  /** One live run: read, apply the table, journal what has not been said. */
  private screen(
    candidate: SentinelLiveRun,
    lease: ReturnType<typeof peekRunLease>,
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
      { runId: candidate.runId, events, costAlertUsd: this.costAlertUsd },
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
    try {
      const report = args.watch.tick();
      args.onTick?.(report);
    } catch (error) {
      log(`tick failed: ${String(error)}`);
    }
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
