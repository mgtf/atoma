import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerdictRunStatus } from '../contracts/supervisorVerdict.js';
import type { VizEvent, VizRun } from '../viz/trace.js';

/**
 * THE MECHANICAL PRE-DIGEST the analyst reads before the trace.
 *
 * A trace grows with the work a run did (~19KB per tool call, measured), and
 * a model reading it linearly spends more than the run did. So the harness
 * writes two bounded views first: a small digest — metadata, totals, computed
 * status, per-kind counts, every error event, the most expensive calls, the
 * final result — and one digested event per line, in causal order, so line N
 * is event index N and `Grep`/`Read` on a range are surgical. Long fields are
 * truncated with an EXPLICIT marker, so the analyst never mistakes a cut for
 * the whole.
 *
 * Nothing here interprets. Every string is carried as model or tool output
 * and the analyst prompt says so.
 */

/** A model- or tool-authored value as text, whatever its shape. */
export function stringifyLoose(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserialisable]';
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.75);
  const tail = Math.floor(max * 0.25);
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)} …[truncated ${dropped} chars]… ${text.slice(text.length - tail)}`;
}

function pruneDeep(value: unknown, depth: number, stringMax: number): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return truncate(value, stringMax);
  if (typeof value !== 'object') return value;
  if (depth <= 0) return Array.isArray(value) ? `[array ${value.length}]` : '[object]';
  if (Array.isArray(value)) {
    const capped: unknown[] = value.slice(0, 20).map((item) => pruneDeep(item, depth - 1, stringMax));
    if (value.length > 20) capped.push(`…[${value.length - 20} more items]`);
    return capped;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = pruneDeep(entry, depth - 1, stringMax);
  }
  return out;
}

const EVENT_STRING_LIMITS: Record<string, number> = {
  error: 4000,
  response: 1200,
  userContent: 1200,
  reasoning: 800,
  systemPrompt: 300,
  subject: 300,
  preview: 200,
};

function digestEvent(event: VizEvent, index: number): Record<string, unknown> {
  const out: Record<string, unknown> = { i: index };
  for (const [key, value] of Object.entries(event as unknown as Record<string, unknown>)) {
    if (value == null) continue;
    if (key === 'snapshot') {
      out[key] = '[registry type snapshot omitted]';
    } else if (typeof value === 'string') {
      out[key] = truncate(value, EVENT_STRING_LIMITS[key] ?? 400);
    } else if (typeof value === 'object') {
      out[key] = pruneDeep(value, 3, 400);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Cancelled beats error: a cancelled run records an error message by design. */
export function runStatusOf(run: Pick<VizRun, 'cancelled' | 'endedAt' | 'error'>): VerdictRunStatus {
  if (run.cancelled) return 'cancelled';
  if (run.endedAt) return run.error ? 'failed' : 'delivered';
  return 'unknown';
}

export interface RunDigest {
  readonly id: string;
  readonly label: string;
  readonly status: VerdictRunStatus;
  readonly cancelled: boolean;
  readonly error: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly task: unknown;
  readonly initialTypes: unknown;
  readonly totals: VizRun['totals'] | null;
  readonly result: unknown;
  readonly eventCount: number;
  readonly kindCounts: Record<string, number>;
  readonly errorEvents: { i: number; kind: string; error: string }[];
  readonly expensiveCalls: Record<string, unknown>[];
}

export function digestRun(run: VizRun): { digest: RunDigest; lines: string[] } {
  const events = Array.isArray(run.events) ? run.events : [];
  const kindCounts: Record<string, number> = {};
  const errorEvents: RunDigest['errorEvents'] = [];
  const costed: (Record<string, unknown> & { costUsd: number })[] = [];
  const lines: string[] = [];
  events.forEach((event, index) => {
    const row = event as unknown as Record<string, unknown>;
    const kind = typeof row['kind'] === 'string' ? (row['kind']) : 'unknown';
    kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    if (row['error'] != null) {
      errorEvents.push({ i: index, kind, error: truncate(stringifyLoose(row['error']), 600) });
    }
    if (typeof row['costUsd'] === 'number' && row['costUsd'] > 0) {
      const actor = row['actor'] as { name?: string } | undefined;
      costed.push({
        i: index,
        kind,
        model: row['servedModel'] ?? row['model'],
        actor: actor?.name,
        costUsd: row['costUsd'],
        durationMs: row['durationMs'],
        stopReason: row['stopReason'],
      });
    }
    lines.push(JSON.stringify(digestEvent(event, index)));
  });
  costed.sort((a, b) => b.costUsd - a.costUsd);
  const digest: RunDigest = {
    id: run.id,
    label: run.label,
    status: runStatusOf(run),
    cancelled: run.cancelled ?? false,
    error: run.error != null ? truncate(stringifyLoose(run.error), 2000) : null,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    durationMs: run.durationMs ?? null,
    task: pruneDeep(run.task, 3, 2000),
    initialTypes: pruneDeep(run.initialTypes, 2, 200),
    totals: run.totals ?? null,
    result: pruneDeep(run.result, 4, 2000),
    eventCount: events.length,
    kindCounts,
    errorEvents,
    expensiveCalls: costed.slice(0, 8),
  };
  return { digest, lines };
}

export interface DigestPaths {
  readonly dir: string;
  readonly digestPath: string;
  readonly eventsPath: string;
}

/** `supervisor/work/<runId>/{digest.json,events.ndjson}`. */
export function writeDigest(workDir: string, run: VizRun): { digest: RunDigest; paths: DigestPaths } {
  const { digest, lines } = digestRun(run);
  const dir = join(workDir, run.id);
  mkdirSync(dir, { recursive: true });
  const digestPath = join(dir, 'digest.json');
  const eventsPath = join(dir, 'events.ndjson');
  writeFileSync(digestPath, JSON.stringify(digest, null, 2));
  writeFileSync(eventsPath, lines.join('\n') + (lines.length ? '\n' : ''));
  return { digest, paths: { dir, digestPath, eventsPath } };
}
