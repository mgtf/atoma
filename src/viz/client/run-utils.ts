import type { RegistryType, RunIndexEntry, VizEvent, VizRun } from './types.js';

export const ABANDONED_AFTER_MS = 12 * 60 * 1000;

export function isAbandoned(run: VizRun, now = Date.now()): boolean {
  if (run.endedAt) return false;
  const latest = Math.max(
    Date.parse(run.startedAt),
    ...run.events.map((event) => event.ts || 0)
  );
  return now - latest > ABANDONED_AFTER_MS;
}

export function isRunLive(run: VizRun, now = Date.now()): boolean {
  return !run.endedAt && !isAbandoned(run, now);
}

export function isIndexEntryLive(entry: RunIndexEntry, now = Date.now()): boolean {
  if (entry.endedAt || !entry.inFlight) return false;
  const latest = entry.lastEventAt ?? Date.parse(entry.startedAt);
  return now - latest <= ABANDONED_AFTER_MS;
}

export function mergeRunDelta(current: VizRun, incoming: VizRun): VizRun {
  const from = incoming.eventsFrom ?? 0;
  return {
    ...current,
    ...incoming,
    events:
      from === 0
        ? incoming.events
        : current.events.slice(0, from).concat(incoming.events),
  };
}

export function fmtMs(ms?: number): string {
  if (ms == null) return '—';
  return ms > 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

export function fmtCost(cost?: number | null): string {
  return cost == null ? '—' : `$${cost.toFixed(4)}`;
}

export function fmtTime(timestamp?: string | number): string {
  if (timestamp == null) return '—';
  const parsed = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : String(timestamp);
}

export function tryParseJson(text?: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export interface AtomView {
  snapshot: RegistryType;
  origin: 'existing' | 'patched' | 'branched' | 'created';
  events: VizEvent[];
}

export function buildAtomMap(run: VizRun): Map<string, AtomView> {
  const map = new Map<string, AtomView>();
  for (const snapshot of run.initialTypes ?? []) {
    map.set(snapshot.name, { snapshot, origin: 'existing', events: [] });
  }
  const rank = { existing: 0, patched: 1, branched: 2, created: 3 } as const;
  for (const event of run.events) {
    if (event.kind !== 'registry' || !event.snapshot) continue;
    const snapshot = event.snapshot;
    const origin =
      event.op === 'create'
        ? 'created'
        : event.op === 'branch'
          ? 'branched'
          : event.op === 'patch'
            ? 'patched'
            : 'existing';
    const previous = map.get(snapshot.name);
    const bestOrigin =
      previous && rank[previous.origin] > rank[origin] ? previous.origin : origin;
    map.set(snapshot.name, {
      snapshot:
        !previous || snapshot.version >= previous.snapshot.version
          ? snapshot
          : previous.snapshot,
      origin: bestOrigin,
      events: [...(previous?.events ?? []), event],
    });
  }
  return map;
}

export interface EventFilters {
  kind: string;
  role: string;
  branchId: string;
}

export function filterEvents(events: VizEvent[], filters: EventFilters): VizEvent[] {
  return events.filter((event) => {
    const kind = event.kind === 'llm-start' ? 'llm' : event.kind;
    if (filters.kind !== 'all' && kind !== filters.kind) return false;
    if (
      filters.role !== 'all' &&
      (event.kind === 'llm' || event.kind === 'llm-start') &&
      event.role !== filters.role
    ) {
      return false;
    }
    return filters.branchId === 'all' || event.branchId === filters.branchId;
  });
}

export function toolArgSummary(args?: Record<string, unknown>): string {
  if (!args) return '';
  for (const key of ['path', 'url', 'cmd', 'command', 'entry']) {
    if (typeof args[key] === 'string') return String(args[key]).slice(-64);
  }
  return '';
}
