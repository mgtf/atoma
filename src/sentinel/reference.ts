import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assembleTrajectoryReference,
  deriveTrajectorySignatures,
  TRAJECTORY_REFERENCE_MAX_RUNS,
  type TrajectoryReference,
  type TrajectorySignature,
} from '../contracts/trajectory.js';
import type { VizRun } from '../viz/trace.js';
import { readBoundedJson, type SentinelRunCorpus } from './sources.js';

/**
 * WHAT A LIVE EXECUTION IS SCORED AGAINST — the trajectory reference, built
 * from FINISHED traces and handed to the rule table through `SentinelEnv`.
 *
 * The rules stay pure: no rule reads a file. This module is the one impure
 * step, and it obeys the same discipline as `sources.ts`: bounded reads
 * (`readBoundedJson` under `MAX_TRACE_BYTES`), fail-soft on a trace it cannot
 * read (counted, never thrown), and TWO CORPORA THAT NEVER MIX — an operator
 * run is scored against operator runs, a project run against project runs.
 * Across organisations, on purpose: what one organisation's runs teach about
 * how a skill executes is knowledge, and knowledge is the platform commons;
 * the finding itself still carries its org as attribution and no more power
 * than any other sentinel row.
 *
 * The reference is loaded once per tick. A trace whose size and mtime have not
 * changed is not parsed again — finished traces do not change, so in the
 * steady state a tick costs one `stat` per reference run and no parsing.
 */

export interface TrajectoryReferenceLoad {
  readonly corpus: SentinelRunCorpus;
  readonly reference: TrajectoryReference;
  /** Finished runs whose trace could not be read or was over the cap. Counted, never dropped silently. */
  readonly unreadable: number;
}

export interface TrajectoryReferenceSource {
  readonly corpus: SentinelRunCorpus;
  load(): TrajectoryReferenceLoad;
}

class TraceSignatureCache {
  private readonly entries = new Map<
    string,
    { size: number; mtimeMs: number; signatures: readonly TrajectorySignature[] }
  >();

  /** Signatures of one finished trace, from the cache when the file is unchanged; null when unreadable. */
  read(path: string): readonly TrajectorySignature[] | null {
    let size: number;
    let mtimeMs: number;
    try {
      const stat = statSync(path);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      return null;
    }
    const hit = this.entries.get(path);
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.signatures;
    const run = readBoundedJson<VizRun>(path);
    if (!run || !Array.isArray(run.events)) return null;
    const signatures = deriveTrajectorySignatures(typeof run.id === 'string' ? run.id : path, run.events);
    this.entries.set(path, { size, mtimeMs, signatures });
    return signatures;
  }

  /** Forget traces that left the window, so the cache is bounded by the run cap. */
  keepOnly(paths: ReadonlySet<string>): void {
    for (const path of [...this.entries.keys()]) {
      if (!paths.has(path)) this.entries.delete(path);
    }
  }
}

function collect(
  corpus: SentinelRunCorpus,
  paths: readonly (string | null)[],
  cache: TraceSignatureCache
): TrajectoryReferenceLoad {
  const sets: (readonly TrajectorySignature[])[] = [];
  const keep = new Set<string>();
  let unreadable = 0;
  for (const path of paths) {
    if (path === null) {
      unreadable += 1;
      continue;
    }
    keep.add(path);
    const signatures = cache.read(path);
    if (signatures === null) {
      unreadable += 1;
      continue;
    }
    sets.push(signatures);
  }
  cache.keepOnly(keep);
  return { corpus, reference: assembleTrajectoryReference(sets), unreadable };
}

interface FinishedIndexEntry {
  readonly id: string;
  readonly endedAt: string;
}

function isFinishedIndexEntry(entry: unknown): entry is FinishedIndexEntry {
  if (entry === null || typeof entry !== 'object') return false;
  const row = entry as { id?: unknown; endedAt?: unknown };
  return typeof row.id === 'string' && typeof row.endedAt === 'string' && row.endedAt.length > 0;
}

/**
 * The instance corpus: `runs/index.json` entries with an `endedAt`, most recent
 * `maxRuns` of them, oldest first so the per-key cap keeps the newest paths.
 * A run without `endedAt` is live or died without its closing stamp; neither
 * is a finished path and neither enters the reference.
 */
export function operatorTrajectoryReferenceSource(options: {
  readonly runsDir: string;
  readonly maxRuns?: number;
}): TrajectoryReferenceSource {
  const runsDir = resolve(options.runsDir);
  const maxRuns = options.maxRuns ?? TRAJECTORY_REFERENCE_MAX_RUNS;
  const cache = new TraceSignatureCache();
  return {
    corpus: 'operator',
    load(): TrajectoryReferenceLoad {
      const index = readBoundedJson<unknown[]>(resolve(runsDir, 'index.json'));
      const finished = (Array.isArray(index) ? index : [])
        .filter(isFinishedIndexEntry)
        .sort((left, right) => left.endedAt.localeCompare(right.endedAt))
        .slice(-maxRuns);
      return collect(
        'operator',
        finished.map((entry) => resolve(runsDir, `${entry.id}.json`)),
        cache
      );
    },
  };
}

/** What the source needs of `ProjectStore`, and nothing more. */
export interface ProjectFinishedTraceReader {
  listFinishedRunTraces(): readonly {
    readonly projectRunId: string;
    readonly endedAt: string;
    readonly file: string | null;
  }[];
}

/**
 * The tenant corpus: runs the control plane says have ENDED (`ended_at` is the
 * transactional fact), each trace in its own directory. Read-only, like every
 * sentinel read of the control plane.
 */
export function projectTrajectoryReferenceSource(options: {
  readonly reader: ProjectFinishedTraceReader;
  readonly maxRuns?: number;
}): TrajectoryReferenceSource {
  const maxRuns = options.maxRuns ?? TRAJECTORY_REFERENCE_MAX_RUNS;
  const cache = new TraceSignatureCache();
  return {
    corpus: 'project',
    load(): TrajectoryReferenceLoad {
      const finished = [...options.reader.listFinishedRunTraces()]
        .sort((left, right) => left.endedAt.localeCompare(right.endedAt))
        .slice(-maxRuns);
      return collect(
        'project',
        finished.map((row) => row.file),
        cache
      );
    },
  };
}
