import type { RegistryType, VizEvent, VizRun } from './types.js';
import { taxonomyForTier } from '../../core/taxonomy.js';

/**
 * The live predicates are DEFINED in `../liveness.ts` and re-exported here:
 * server-side readers need them too, and `client/` is emptied by the Vite
 * build. One definition, both import paths.
 */
export {
  ABANDONED_AFTER_MS,
  isAbandoned,
  isIndexEntryLive,
  isRunLive,
} from '../liveness.js';
import { isAbandoned, isRunLive } from '../liveness.js';

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

export function mergeRunDelta(current: VizRun, incoming: VizRun): VizRun {
  const from = incoming.eventsFrom ?? 0;
  // An empty delta with unchanged metadata returns CURRENT — the same
  // reference, not an equal copy. Every consumer above (React Query's
  // structural sharing, the snapshot memo, the GPU render effect) reads a new
  // reference as "something changed" and rebuilds the whole scene; under a 1s
  // live poll that was a rebuild per second for a run that had produced
  // nothing. The reference is the contract that nothing did.
  if (
    incoming.events.length === 0 &&
    from === current.events.length &&
    sameRunMeta(current, incoming)
  ) {
    return current;
  }
  // Re-project the WHOLE merged run. A historical counter event in a live
  // delta may omit its version while the snapshot that establishes it sits in
  // an earlier page; projecting the delta alone cannot recover that context.
  return projectRunTaxonomy({
    ...current,
    ...incoming,
    events:
      from === 0
        ? incoming.events
        : current.events.slice(0, from).concat(incoming.events),
  });
}

/**
 * ONE ingestion boundary for a full trace or a polled delta. The API reader
 * intentionally returns raw trace JSON: projecting a delta before it rejoins
 * the preceding events can assign a counter the initial version even though a
 * patch sits in an earlier page. Merge first, then project the complete run.
 */
export function projectRunUpdate(
  current: VizRun | null | undefined,
  incoming: VizRun
): VizRun {
  return current && incoming.eventsFrom !== undefined
    ? mergeRunDelta(current, incoming)
    : projectRunTaxonomy(incoming);
}

/**
 * Field-by-field over the DELTA's own keys, so a field the server adds later
 * automatically participates instead of silently freezing on screen. JSON
 * compare per field: persisted keys came off the same serializer, so key order
 * is stable, and `totals`/`result` are nested. Projection-only metadata is
 * normalised below. Events are excluded — the caller already knows the delta
 * carries none.
 */
function sameRunMeta(current: VizRun, incoming: VizRun): boolean {
  for (const key of Object.keys(incoming) as (keyof VizRun)[]) {
    if (key === 'events' || key === 'eventsFrom') continue;
    if (
      JSON.stringify(comparableRunMeta(current, key)) !==
      JSON.stringify(comparableRunMeta(incoming, key))
    ) return false;
  }
  return true;
}

function comparableRunMeta(run: VizRun, key: keyof VizRun): unknown {
  if (key !== 'initialTypes') return run[key];
  // `rank` is typed-boundary metadata derived from the persisted numeric tier.
  // CURRENT has already been projected while an API delta is deliberately raw,
  // so comparing the two shapes byte-for-byte would turn every empty poll into
  // a false change and rebuild the GPU scene once per second.
  return run.initialTypes?.map((snapshot) => {
    const storedShape = { ...snapshot };
    delete storedShape.rank;
    return storedShape;
  });
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
  return {
    ...snapshot,
    ...(tier === 1 || tier === 2 || tier === 3
      ? { rank: taxonomyForTier(tier).rank }
      : {}),
  };
}

/**
 * Fill in each event's actor/child from the registry snapshots the run
 * carries.
 *
 * A registry event names its target and its initiator as bare strings; the
 * typed viz boundary resolves them to `{name, tier}` refs so the timeline can
 * colour and group by tier without every renderer re-deriving it. Nothing
 * here rewrites the trace — it is read-only projection.
 */
export function projectRunTaxonomy(run: VizRun): VizRun {
  const refs = new Map<string, { name?: string; tier?: number }>();
  const versions = new Map<string, number>();
  const rememberRef = (snapshot: RegistryType): RegistryType => {
    const projected = projectRegistryType(snapshot);
    refs.set(snapshot.name, { name: projected.name, tier: projected.tier });
    return projected;
  };
  const projectedInitialTypes = run.initialTypes?.map((snapshot) => {
    const projected = rememberRef(snapshot);
    if (Number.isFinite(projected.version)) versions.set(projected.name, projected.version);
    return projected;
  });
  // This pre-pass is ONLY for actor/child taxonomy. Version recovery below is
  // chronological: seeding it from every future snapshot would label a
  // success before a patch with the version created after that success.
  for (const event of run.events) {
    if (event.kind === 'registry' && event.snapshot) rememberRef(event.snapshot);
  }

  return {
    ...run,
    initialTypes: projectedInitialTypes,
    events: run.events.map((event) => {
      const snapshot = event.snapshot ? rememberRef(event.snapshot) : undefined;
      if (snapshot && Number.isFinite(snapshot.version)) {
        versions.set(snapshot.name, snapshot.version);
      }
      const recordedBy = typeof event['by'] === 'string' ? event['by'] : undefined;
      const registryActor =
        event.kind === 'registry' && recordedBy
          ? refs.get(recordedBy) ?? { name: recordedBy }
          : undefined;
      const registryChild =
        event.kind === 'registry'
          ? snapshot
            ? { name: snapshot.name, tier: snapshot.tier }
            : refs.get(event.name ?? '')
          : undefined;
      const actor = event.actor ?? registryActor;
      const child = event.child ?? registryChild;
      const targetName = event.kind === 'registry'
        ? snapshot?.name ?? event.name
        : undefined;
      const recordedVersion = typeof event.version === 'number' && Number.isFinite(event.version)
        ? event.version
        : undefined;
      const registryVersion = event.kind === 'registry'
        ? recordedVersion ?? (targetName ? versions.get(targetName) : undefined)
        : undefined;
      if (targetName && registryVersion !== undefined) {
        versions.set(targetName, registryVersion);
      }
      const baseEvent: VizEvent = { ...event };
      delete baseEvent.actor;
      delete baseEvent.child;
      delete baseEvent.version;
      return {
        ...baseEvent,
        ...(actor ? { actor } : {}),
        ...(child ? { child } : {}),
        ...(snapshot ? { snapshot } : {}),
        ...(registryVersion !== undefined ? { version: registryVersion } : {}),
      };
    }),
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
  'context',
  'registry',
] as const;

export function visibleEventKindFilters(
  events: readonly { kind: string }[]
): string[] {
  const hasCache = events.some((event) => event.kind === 'cache');
  const hasContext = events.some((event) => event.kind === 'context');
  return EVENT_KIND_FILTERS.filter(
    (kind) =>
      (kind !== 'cache' || hasCache) && (kind !== 'context' || hasContext)
  );
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
