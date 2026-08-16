import type { RegistryType, RunIndexEntry, VizEvent, VizRun } from './types.js';
import { taxonomyForTier } from '../../core/taxonomy.js';
import { currentDisplayName } from '../../registry/taxonomyNames.js';

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

/**
 * LLM calls that have STARTED and not yet returned.
 *
 * A tool-bearing L1 execute is ONE provider call that can run for minutes:
 * `llm-start` is recorded when it is issued, dozens of `tool` events stream
 * out during the loop, and the single `llm` event carrying usage/cost only
 * lands when the call returns. `computeTotals` counts usage, so for the whole
 * duration of that loop a live run legitimately reports 0 calls / 0 tokens /
 * $0 — which reads as "nothing is happening" on the run header (2026-08-16
 * report against a 3-minute build-app run). The started-but-unfinished set is
 * the missing half of that picture.
 */
export function inFlightLlmEvents(run: VizRun): VizEvent[] {
  const completed = new Set(
    run.events.filter((event) => event.kind === 'llm').map((event) => event.id)
  );
  return run.events.filter(
    (event) =>
      event.kind === 'llm-start' &&
      typeof event.llmEventId === 'string' &&
      !completed.has(event.llmEventId)
  );
}

/**
 * How long the run has been going: the recorded duration once it ended, and
 * the elapsed wall clock while it is still live. An abandoned run keeps the
 * dash — we do not know when it stopped, so we do not keep counting.
 */
export function runElapsedMs(run: VizRun, now = Date.now()): number | undefined {
  if (run.durationMs != null) return run.durationMs;
  if (!isRunLive(run, now)) return undefined;
  const started = Date.parse(run.startedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : undefined;
}

export type RunStatus = 'live' | 'abandoned' | 'cancelled' | 'failed' | 'delivered';

/**
 * ONE definition of "what happened to this run", for every surface that
 * labels one (timeline bookends, run header, pickers).
 *
 * Cancellation takes precedence over the error flag on purpose: a
 * signal-cancelled run records an error message BY DESIGN ("run cancelled by
 * user (signal received)"), and reporting that as a failure is the same lie
 * the burn-in CSV told until 2026-08-15 — a deliberate kill is not a fault.
 */
export function runStatus(run: VizRun, now = Date.now()): RunStatus {
  if (run.cancelled) return 'cancelled';
  if (!run.endedAt) return isAbandoned(run, now) ? 'abandoned' : 'live';
  return run.error ? 'failed' : 'delivered';
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

export interface RunHeading {
  /** Which profile ran it — the `build-app` half of the stored label. */
  readonly family: string | null;
  /** What the run was asked to do, whole. */
  readonly title: string;
}

/**
 * The two things a run's stored `label` actually carries, separated.
 *
 * `label` is a display name shaped `<family>: <goal, cut>`. Measured over the
 * 204 local traces: 202 are exactly that, so the ONLY information it holds
 * that the goal does not is the family. Everything else is a cut copy — and
 * traces written before 2026-08-15 cut it with a bare slice, ending mid-word
 * ("…tiles that swap colour w") with nothing saying so.
 *
 * So the goal IS the title whenever the run carries one, and the label is
 * consulted only for the family and as the fallback title of a run without a
 * goal. Those stored bytes stay on disk untouched; this is a projection.
 *
 * The family is recognised as an identifier-shaped prefix rather than a fixed
 * list, so a new profile needs no change here.
 */
export function runHeading(run: VizRun): RunHeading {
  const label = (run.label ?? '').trim();
  const prefixed = /^([a-z][a-z0-9._-]{1,23}):\s+(.*)$/s.exec(label);
  const goal = run.task?.description?.trim() ?? '';
  return {
    family: prefixed?.[1] ?? null,
    title: goal || prefixed?.[2] || label,
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
        // Fall through to the balanced-document scan below. Plan responses
        // can contain two back-to-back JSON objects rather than one array.
      }
    }
  }

  const values: unknown[] = [];
  let quote = false;
  let escaped = false;
  let start = -1;
  const stack: string[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (stack.length === 0) {
      if (char === '{' || char === '[') {
        start = index;
        stack.push(char);
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') {
      quote = true;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }
    if (char !== '}' && char !== ']') continue;
    const open = stack.at(-1);
    if ((open === '{' && char !== '}') || (open === '[' && char !== ']')) {
      stack.length = 0;
      start = -1;
      continue;
    }
    stack.pop();
    if (stack.length !== 0 || start < 0) continue;
    try {
      values.push(JSON.parse(text.slice(start, index + 1)));
    } catch {
      // Not a JSON document (often prose punctuation around braces).
    }
    start = -1;
  }
  if (values.length === 1) return values[0];
  if (values.length > 1) return values;
  return undefined;
}

function projectRegistryType(snapshot: RegistryType): RegistryType {
  const tier = snapshot.tier;
  const name = currentDisplayName(tier, snapshot.name, snapshot.ordinal) ?? snapshot.name;
  const createdBy =
    currentDisplayName(tier < 3 ? tier + 1 : undefined, snapshot.createdBy) ??
    snapshot.createdBy;
  return {
    ...snapshot,
    name,
    createdBy,
    ...(tier === 1 || tier === 2 || tier === 3
      ? { rank: taxonomyForTier(tier).rank }
      : {}),
  };
}

function projectActor(
  ref: { name?: string; tier?: number } | undefined
): { name?: string; tier?: number } | undefined {
  if (!ref) return undefined;
  return {
    ...ref,
    name: currentDisplayName(ref.tier, ref.name),
  };
}

/**
 * Present immutable pre-v2 traces through the current taxonomy.
 *
 * Raw prompt/response/result text remains untouched for auditability; only
 * structured identity fields are projected. The persisted trace on disk is
 * never rewritten.
 */
export function projectRunTaxonomy(run: VizRun): VizRun {
  const rawRefs = new Map<string, { name?: string; tier?: number }>();
  const projectedRefs = new Map<string, { name?: string; tier?: number }>();
  let legacyRun = false;
  const remember = (snapshot: RegistryType): RegistryType => {
    const projected = projectRegistryType(snapshot);
    if (projected.name !== snapshot.name) legacyRun = true;
    const ref = { name: projected.name, tier: projected.tier };
    rawRefs.set(snapshot.name, ref);
    projectedRefs.set(projected.name, ref);
    return projected;
  };
  const projectedInitialTypes = run.initialTypes?.map(remember);
  for (const event of run.events) {
    if (event.kind === 'registry' && event.snapshot) remember(event.snapshot);
  }

  return {
    ...run,
    initialTypes: projectedInitialTypes,
    events: run.events.map((event) => {
      const snapshot = event.snapshot ? remember(event.snapshot) : undefined;
      const recordedBy = typeof event['by'] === 'string' ? event['by'] : undefined;
      const registryActor =
        event.kind === 'registry' && recordedBy
          ? (legacyRun ? rawRefs.get(recordedBy) : projectedRefs.get(recordedBy)) ??
            rawRefs.get(recordedBy) ??
            projectedRefs.get(recordedBy) ??
            { name: recordedBy }
          : undefined;
      const registryChild =
        event.kind === 'registry'
          ? snapshot
            ? { name: snapshot.name, tier: snapshot.tier }
            : (legacyRun ? rawRefs.get(event.name ?? '') : projectedRefs.get(event.name ?? '')) ??
              rawRefs.get(event.name ?? '') ??
              projectedRefs.get(event.name ?? '')
          : undefined;
      const actor = projectActor(event.actor) ?? registryActor;
      const child = projectActor(event.child) ?? registryChild;
      const baseEvent: VizEvent = { ...event };
      delete baseEvent.actor;
      delete baseEvent.child;
      return {
        ...baseEvent,
        ...(actor ? { actor } : {}),
        ...(child ? { child } : {}),
        ...(event.l1Name
          ? { l1Name: currentDisplayName(1, event.l1Name) ?? event.l1Name }
          : {}),
        ...(snapshot ? { snapshot } : {}),
        ...(event.kind === 'registry' && event.name
          ? {
              name:
                currentDisplayName(
                  snapshot?.tier ?? event.actor?.tier,
                  event.name,
                  snapshot?.ordinal
                ) ?? event.name,
            }
          : {}),
      };
    }),
    result: run.result
      ? {
          ...run.result,
          producedBy: run.result.producedBy
            ? {
                ...run.result.producedBy,
                name: currentDisplayName(
                  run.result.producedBy.tier,
                  run.result.producedBy.name
                ),
              }
            : undefined,
        }
      : undefined,
  };
}

export interface AtomView {
  snapshot: RegistryType;
  origin: 'existing' | 'patched' | 'branched' | 'created';
  events: VizEvent[];
}

function rememberAtomName(names: Set<string>, name?: string) {
  if (name) names.add(name);
}

/** Agents that actually appear in this run — never the idle rest of the store. */
export function usedAtomNames(run: VizRun): Set<string> {
  const names = new Set<string>();
  rememberAtomName(names, run.result?.producedBy?.name);
  for (const event of run.events) {
    rememberAtomName(names, event.actor?.name);
    rememberAtomName(names, event.child?.name);
    rememberAtomName(names, event.l1Name);
    if (event.kind === 'registry') rememberAtomName(names, event.snapshot?.name);
  }
  return names;
}

function atomRefTier(run: VizRun, name: string): number {
  if (run.result?.producedBy?.name === name && run.result.producedBy.tier) {
    return run.result.producedBy.tier;
  }
  for (const event of run.events) {
    if (event.actor?.name === name && event.actor.tier) return event.actor.tier;
    if (event.child?.name === name && event.child.tier) return event.child.tier;
    if (event.kind === 'registry' && event.snapshot?.name === name && event.snapshot.tier) {
      return event.snapshot.tier;
    }
    if (event.l1Name === name) return 1;
  }
  return 0;
}

function stubAtomView(name: string, tier: number): AtomView {
  return {
    snapshot: {
      tier,
      ordinal: 0,
      name,
      description: '',
      systemPrompt: '',
      tools: [],
      params: {},
      createdBy: '',
      createdAt: '',
      version: 0,
      successes: 0,
      failures: 0,
    },
    origin: 'existing',
    events: [],
  };
}

export function buildAtomMap(run: VizRun): Map<string, AtomView> {
  const used = usedAtomNames(run);
  const map = new Map<string, AtomView>();
  for (const snapshot of run.initialTypes ?? []) {
    if (!used.has(snapshot.name)) continue;
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
  for (const name of used) {
    if (!map.has(name)) map.set(name, stubAtomView(name, atomRefTier(run, name)));
  }
  return map;
}

export interface EventFilters {
  kind: string;
  role: string;
  branchId: string;
}

export const EVENT_KIND_FILTERS = [
  'all',
  'llm',
  'tool',
  'trust',
  'skill',
  'cache',
  'registry',
] as const;

export function visibleEventKindFilters(
  events: readonly { kind: string }[]
): string[] {
  const hasCache = events.some((event) => event.kind === 'cache');
  return EVENT_KIND_FILTERS.filter((kind) => kind !== 'cache' || hasCache);
}

export function coerceEventFilters(
  events: readonly { kind: string }[],
  filters: EventFilters
): EventFilters {
  if (visibleEventKindFilters(events).includes(filters.kind)) return filters;
  return { ...filters, kind: 'all', role: 'all' };
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
