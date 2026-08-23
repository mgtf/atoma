import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { VizRunIndexEntry } from '../viz/trace.js';
import { ABANDONED_AFTER_MS, isIndexEntryLive } from '../viz/liveness.js';

/**
 * WHO IS RUNNING RIGHT NOW — the sentinel's discovery sources, and the
 * bounded read they share.
 *
 * There are TWO run corpora and they never mix (`src/projects/AGENTS.md`).
 * Operator runs — CLI, MCP, burn-in, benchmark — land in one shared `runs/`
 * directory. A project run gets `ATOMA_RUNS_DIR` pointed at its OWN
 * `…/runs/<runId>/traces` precisely so its trace never joins the instance
 * corpus. So a watch on `runs/index.json` alone sees every operator run and
 * NOT ONE customer run: the corpus the platform exists to serve.
 *
 * Hence two sources behind one interface, with ONE tick, ONE rule table and
 * ONE de-duplication path above them. What differs between the corpora is
 * only how a live run is FOUND:
 *   - operator: `index.json` + `isIndexEntryLive`, an INFERENCE from event
 *     timestamps, because nothing records the fact;
 *   - project: `project_runs.status = 'running'`, a transactional fact, plus
 *     a staleness bound for the window where a row outlives its process.
 * A project finding also carries the org and project it belongs to, which the
 * operator corpus does not have.
 */

/** A trace larger than this is not read: no watch is better than a stall. */
export const MAX_TRACE_BYTES = 32 * 1024 * 1024;

/** Bounded, total: absent, oversized and torn all read as null. */
export function readBoundedJson<T>(path: string, maxBytes = MAX_TRACE_BYTES): T | null {
  if (!existsSync(path)) return null;
  if (statSync(path).size > maxBytes) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export type SentinelRunCorpus = 'operator' | 'project';

export interface SentinelLiveRun {
  readonly runId: string;
  readonly tracePath: string;
  readonly corpus: SentinelRunCorpus;
  /** Set for a project run, null for an operator run. Attribution only. */
  readonly orgId: string | null;
  readonly projectId: string | null;
  /** For the operator's console line. Never journaled as authority. */
  readonly label: string | null;
}

export interface SentinelSkip {
  /** Null when the whole source, not one run, could not be read. */
  readonly runId: string | null;
  readonly reason: string;
}

export interface SentinelDiscovery {
  readonly runs: readonly SentinelLiveRun[];
  /** Candidates seen and NOT screened, with why. Never a silent drop. */
  readonly skipped: readonly SentinelSkip[];
}

export interface SentinelRunSource {
  readonly corpus: SentinelRunCorpus;
  discover(now: number): SentinelDiscovery;
}

function isIndexShaped(entry: unknown): entry is VizRunIndexEntry {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    typeof (entry as { id?: unknown }).id === 'string'
  );
}

/** The instance corpus: one directory, one index, inferred liveness. */
export function operatorRunSource(options: { readonly runsDir: string }): SentinelRunSource {
  const runsDir = resolve(options.runsDir);
  return {
    corpus: 'operator',
    discover(now: number): SentinelDiscovery {
      const indexPath = resolve(runsDir, 'index.json');
      // ABSENT is silence: a checkout that has never run anything is not a
      // fault. PRESENT-AND-UNREADABLE is reported — a torn index would
      // otherwise make the watch observe nothing at all, quietly, which is
      // the exact failure this stage exists to remove.
      if (!existsSync(indexPath)) return { runs: [], skipped: [] };
      const index = readBoundedJson<unknown[]>(indexPath);
      if (!Array.isArray(index)) {
        return {
          runs: [],
          skipped: [{ runId: null, reason: 'runs index unreadable or over the size cap' }],
        };
      }
      const runs: SentinelLiveRun[] = [];
      for (const entry of index) {
        if (!isIndexShaped(entry)) continue;
        if (!isIndexEntryLive(entry, now)) continue;
        runs.push({
          runId: entry.id,
          tracePath: resolve(runsDir, `${entry.id}.json`),
          corpus: 'operator',
          orgId: null,
          projectId: null,
          label: entry.label ?? null,
        });
      }
      return { runs, skipped: [] };
    },
  };
}

/** What the source needs of `ProjectStore`, and nothing more. */
export interface ProjectRunTraceReader {
  listLiveRunTraces(): readonly {
    readonly projectRunId: string;
    readonly orgId: string;
    readonly projectId: string;
    readonly projectSlug: string;
    readonly file: string | null;
  }[];
}

/**
 * The tenant corpus: one directory per run, liveness from the control plane.
 *
 * Read-only on purpose. A `running` row whose process was killed is fixed by
 * `reconcileInterrupted` at the next boot; the sentinel bounds its own
 * exposure with `staleAfterMs` and does NOT repair the row. An observer that
 * writes the control plane is no longer an observer.
 */
export function projectRunSource(options: {
  readonly reader: ProjectRunTraceReader;
  readonly staleAfterMs?: number;
}): SentinelRunSource {
  const staleAfterMs = options.staleAfterMs ?? ABANDONED_AFTER_MS;
  return {
    corpus: 'project',
    discover(now: number): SentinelDiscovery {
      const runs: SentinelLiveRun[] = [];
      const skipped: SentinelSkip[] = [];
      for (const row of options.reader.listLiveRunTraces()) {
        if (!row.file) {
          // Normal for the first seconds: the run is `running` before the
          // recorder's first persist. The next tick sees it.
          skipped.push({ runId: row.projectRunId, reason: 'trace not persisted yet' });
          continue;
        }
        let silentForMs: number;
        try {
          silentForMs = now - statSync(row.file).mtimeMs;
        } catch {
          skipped.push({
            runId: row.projectRunId,
            reason: 'trace vanished between listing and read',
          });
          continue;
        }
        if (silentForMs > staleAfterMs) {
          skipped.push({
            runId: row.projectRunId,
            reason: `control plane says running, trace silent for ${Math.round(silentForMs / 1000)}s`,
          });
          continue;
        }
        runs.push({
          runId: row.projectRunId,
          tracePath: row.file,
          corpus: 'project',
          orgId: row.orgId,
          projectId: row.projectId,
          label: row.projectSlug,
        });
      }
      return { runs, skipped };
    },
  };
}
