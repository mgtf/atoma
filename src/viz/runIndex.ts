import { lstatSync, readFileSync } from 'node:fs';
import { MAX_TRACE_BYTES } from '../contracts/traceFields.js';
import type { VizRun, VizRunIndexEntry } from './trace.js';

/**
 * The members this row is built from, PINNED AGAINST `VizRun` so renaming one
 * there fails to compile here instead of silently reading `undefined`. The
 * values stay `unknown` on purpose — this parses a file, and a file may hold
 * anything — but the NAMES are not a second copy of the shape.
 */
export const TRACE_HEADER_KEYS = [
  'id',
  'label',
  'startedAt',
  'endedAt',
  'durationMs',
  'error',
  'degraded',
  'cancelled',
  'totals',
] as const satisfies readonly (keyof VizRun)[];

type TraceFileHeader = {
  readonly [K in (typeof TRACE_HEADER_KEYS)[number]]?: K extends 'totals'
    ? { calls?: unknown; costUsd?: unknown }
    : unknown;
};

/**
 * Lightweight Runs-tab row from a persisted trace JSON.
 *
 * BOUNDED, and fail-SOFT: a trace over the shared ceiling yields null and the
 * row is skipped. It used to parse the whole document with no bound at all, on
 * a GATED HTTP path — the same files the coordinator refused to read whole,
 * measured at 1.48 MB and growing ~19KB per tool call. The ceiling is the one
 * in `src/contracts/traceFields.ts`; the disposition over it is this
 * subsystem's, and it differs from the coordinator's on purpose: a missing row
 * in a list is not a wrong answer about whether work was delivered.
 *
 * This still materialises the document it accepts, because the row needs
 * `totals.calls` and `totals.costUsd` — values BELOW depth 1, which the
 * projecting reader deliberately does not give. Projecting them is registered,
 * not built.
 */
export function summarizeTraceFile(file: string): VizRunIndexEntry | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_TRACE_BYTES) return null;
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
