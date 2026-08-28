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
 * The outcome of a bounded read. TWO refusals, because callers answer them
 * differently: a list SKIPS a row, while `/api/runs/:id` must say something,
 * and "past the ceiling" is not "no such run".
 */
export type BoundedRunFileRead =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: 'unreadable' | 'overCeiling' };

/**
 * The one place viz reads a whole file out of the run corpus — a trace, or the
 * operator `index.json` that points at them. Reviewed 2026-08-27 (2.4, 3.9):
 * `summarizeTraceFile` was bounded while `/api/runs/:id` and
 * `listOperatorRunIndex` still read whole documents. Nothing caps these files
 * in the pipeline: `TraceRecorder.persist()` rewrites the full trace after
 * every flush, measured at 1.48 MB and growing ~19KB per tool call.
 *
 * It hands back BYTES, not a parsed document, because the detail route serves
 * the trace byte-for-byte and a delta rejoins the complete run BEFORE
 * projection: re-serialising here would put this reader inside a wire contract
 * it does not own. That is also why it is not the sentinel's `readBoundedJson`
 * (`src/sentinel/sources.ts`), which owns the same NUMBER for a watch that only
 * ever wants the parsed value. One ceiling, two jobs, neither drifting into the
 * other.
 *
 * `lstatSync`, not `statSync`: a symlink is refused rather than followed out of
 * the corpus. The stat is a moment older than the read it guards, accepted
 * deliberately — at 32 MiB against ~19KB per persist the race overshoots by a
 * flush, never by an order of magnitude, and the streaming alternative
 * (`src/contracts/traceFields.ts`) cannot return a document by construction.
 */
export function readBoundedRunFile(file: string): BoundedRunFileRead {
  let size: number;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) return { ok: false, reason: 'unreadable' };
    size = stat.size;
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (size > MAX_TRACE_BYTES) return { ok: false, reason: 'overCeiling' };
  try {
    return { ok: true, bytes: readFileSync(file) };
  } catch {
    // Unlinked or replaced between the stat and the read: absent by the time
    // it mattered, and the caller's disposition for absent is the right one.
    return { ok: false, reason: 'unreadable' };
  }
}

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
    // The ceiling and the symlink refusal live in the shared reader; the
    // fail-SOFT disposition over them stays HERE, where a skipped row is not a
    // wrong answer about whether work was delivered.
    const read = readBoundedRunFile(file);
    if (!read.ok) return null;
    const run = JSON.parse(read.bytes.toString('utf8')) as TraceFileHeader;
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
