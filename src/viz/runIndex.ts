import { readFileSync } from 'node:fs';
import type { VizRunIndexEntry } from './trace.js';

interface TraceFileHeader {
  id?: unknown;
  label?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  durationMs?: unknown;
  error?: unknown;
  degraded?: unknown;
  cancelled?: unknown;
  totals?: { calls?: unknown; costUsd?: unknown };
}

/**
 * Lightweight Runs-tab row from a persisted trace JSON.
 */
export function summarizeTraceFile(file: string): VizRunIndexEntry | null {
  try {
    const run = JSON.parse(readFileSync(file, 'utf8')) as TraceFileHeader;
    if (typeof run.id !== 'string' || typeof run.label !== 'string' || typeof run.startedAt !== 'string') {
      return null;
    }
    const entry: VizRunIndexEntry = {
      id: run.id,
      label: run.label,
      startedAt: run.startedAt,
      hasError: Boolean(run.error),
    };
    if (typeof run.endedAt === 'string') entry.endedAt = run.endedAt;
    if (typeof run.durationMs === 'number') entry.durationMs = run.durationMs;
    if (run.degraded === true) entry.degraded = true;
    if (run.cancelled === true) entry.cancelled = true;
    if (typeof run.totals?.calls === 'number') entry.calls = run.totals.calls;
    if (typeof run.totals?.costUsd === 'number') entry.costUsd = run.totals.costUsd;
    return entry;
  } catch {
    return null;
  }
}

/** Newest `startedAt` first. */
export function sortRunIndex(entries: readonly VizRunIndexEntry[]): VizRunIndexEntry[] {
  return [...entries].sort((a, b) => {
    const tb = Date.parse(b.startedAt);
    const ta = Date.parse(a.startedAt);
    if (Number.isFinite(tb) && Number.isFinite(ta) && tb !== ta) return tb - ta;
    return b.id.localeCompare(a.id);
  });
}
