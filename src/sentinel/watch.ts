import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { VizEvent, VizRun, VizRunIndexEntry } from '../viz/trace.js';
import { isIndexEntryLive } from '../viz/client/run-utils.js';
import { peekRunLease } from '../mcp/runLock.js';
import { eventLabel, type PlatformEventInput } from '../contracts/platformEvents.js';
import { runSentinelRules, type SentinelFinding, type SentinelKind } from './rules.js';

/**
 * THE SENTINEL WATCH — one tick, and the loop around it.
 *
 * Reads, never writes anything but journal rows. It holds no LLM and spends
 * no tokens, which is what lets it run continuously beside the viz server and
 * the MCP host while runs execute (`docs/supervisor-design.md`: "The sentinel
 * costs zero tokens forever").
 *
 * WHAT IT READS, and what it deliberately does not:
 *   - `runs/index.json` plus each live run's trace file. The index is the
 *     detection surface because `isIndexEntryLive` is the repo's ONE live
 *     predicate and because every run writes a trace — a lease-only watch
 *     would miss the CLI runs (burn-in, benchmark) that most need watching.
 *   - the MCP run lease, for context only: which pid holds it, if any. The
 *     lease is not the detector.
 *   - NEVER the runner's stdout. That stream is the burn-in harness's parsed
 *     API and a second parser on it would couple the sentinel to a format it
 *     does not own.
 *
 * DE-DUPLICATION IS AGAINST THE JOURNAL, not against process memory. The
 * journal is the record of what has already been said, so a restarted watcher
 * repeats nothing and two watchers cannot double-report. Each finding's
 * `dedupeKey` is stored in `detail` for exactly this read-back.
 */

/** A trace larger than this is not read: no watch is better than a stall. */
export const MAX_TRACE_BYTES = 32 * 1024 * 1024;

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
  readonly runsDir?: string;
  readonly now?: () => number;
  /** USD alert threshold, or null to disable that rule. Not a budget. */
  readonly costAlertUsd?: number | null;
  readonly leasePath?: string;
  readonly logger?: (line: string) => void;
}

export interface SentinelTickReport {
  readonly liveRuns: string[];
  readonly emitted: SentinelFinding[];
  /** Runs seen but skipped, with why — never silently ignored. */
  readonly skipped: { runId: string; reason: string }[];
}

function readJsonFile<T>(path: string, maxBytes: number): T | null {
  if (!existsSync(path)) return null;
  if (statSync(path).size > maxBytes) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export class SentinelWatch {
  private readonly journal: SentinelJournal;
  private readonly runsDir: string;
  private readonly now: () => number;
  private readonly costAlertUsd: number | null;
  private readonly leasePath: string | undefined;
  private readonly logger: (line: string) => void;

  constructor(options: SentinelWatchOptions) {
    this.journal = options.journal;
    this.runsDir = resolve(options.runsDir ?? process.env['ATOMA_RUNS_DIR'] ?? './runs');
    this.now = options.now ?? (() => Date.now());
    this.costAlertUsd = options.costAlertUsd ?? null;
    if (options.leasePath !== undefined) this.leasePath = options.leasePath;
    this.logger = options.logger ?? (() => {});
  }

  /** Runs the index says are executing right now. */
  private liveEntries(): VizRunIndexEntry[] {
    const index = readJsonFile<VizRunIndexEntry[]>(
      resolve(this.runsDir, 'index.json'),
      MAX_TRACE_BYTES
    );
    if (!Array.isArray(index)) return [];
    const now = this.now();
    return index.filter((entry) => isIndexEntryLive(entry, now));
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
    const skipped: { runId: string; reason: string }[] = [];
    const liveRuns: string[] = [];
    const lease = this.leasePath ? peekRunLease(this.leasePath) : null;

    for (const entry of this.liveEntries()) {
      liveRuns.push(entry.id);
      const tracePath = resolve(this.runsDir, `${entry.id}.json`);
      const run = readJsonFile<VizRun>(tracePath, MAX_TRACE_BYTES);
      if (!run) {
        skipped.push({ runId: entry.id, reason: 'trace unreadable or over the size cap' });
        continue;
      }
      const events: VizEvent[] = run.events ?? [];
      const already = this.emittedKeys(entry.id);
      if (already.has('__journal-unavailable__')) {
        skipped.push({ runId: entry.id, reason: 'journal unavailable for read-back' });
        continue;
      }
      const findings = runSentinelRules(
        { runId: entry.id, events, costAlertUsd: this.costAlertUsd },
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
          orgId: null,
          projectId: null,
          runId: entry.id,
          summary: eventLabel(finding.summary, 200),
          detail: {
            ...finding.detail,
            dedupeKey: finding.dedupeKey,
            ...(lease ? { leaseOwnerPid: lease.ownerPid, leaseRunId: lease.runId } : {}),
          },
        });
        emitted.push(finding);
        this.logger(`${finding.kind} ${finding.ruleId} on ${entry.id}: ${finding.summary}`);
      }
    }
    return { liveRuns, emitted, skipped };
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
