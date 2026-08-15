import type { EventFilters } from './run-utils.js';
import { filterEvents } from './run-utils.js';
import type { VizEvent } from './types.js';

export const TIMELINE_ROW_HEIGHT = 64;

export interface TimelineBranch {
  readonly id: string;
  readonly lane: number;
  readonly parentId?: string;
  readonly firstRow: number;
  readonly lastRow: number;
  readonly firstTs: number;
  readonly lastTs: number;
  readonly eventCount: number;
  readonly tier?: number;
  readonly agentName?: string;
  readonly label?: string;
  readonly aggregationMode?: 'concat' | 'llm-synthesize' | 'sequential';
  readonly ordinal: number;
  readonly path: readonly number[];
  readonly parallel: boolean;
  readonly colorIndex: number;
  /**
   * Display row range of this branch INCLUDING its descendants.
   *
   * A parent phase is still alive while its children run, so its rail has to
   * reach them: drawing it over `firstRow..lastRow` alone left a child rail
   * visually detached whenever the parent's own events stopped before the
   * fork (observed on a real run, 2026-08-15). Forks and joins always land
   * on a live rail when the parent is drawn over its subtree span.
   */
  readonly subtreeFirstRow: number;
  readonly subtreeLastRow: number;
}

export interface TimelineItem {
  readonly event: VizEvent;
  readonly row: number;
  readonly lane: number;
  readonly branchId?: string;
  readonly branchStart: boolean;
  readonly branchEnd: boolean;
  readonly tier?: number;
}

export interface TimelineConnector {
  readonly kind: 'fork' | 'join';
  readonly row: number;
  readonly fromLane: number;
  readonly toLane: number;
  readonly branchId: string;
}

export interface TimelineLayout {
  readonly items: readonly TimelineItem[];
  readonly branches: readonly TimelineBranch[];
  readonly connectors: readonly TimelineConnector[];
  readonly maxLane: number;
  readonly rowHeight: number;
  readonly totalHeight: number;
  /**
   * True when row 0 is the OLDEST event. The GPU client asks for
   * `newestFirst` (what happened last is what you came to read); the layout
   * itself stays order-agnostic so rails, cards and connectors all derive
   * from one row space whichever way it runs.
   */
  readonly chronological: boolean;
}

interface MutableBranch {
  id: string;
  events: VizEvent[];
  firstTs: number;
  lastTs: number;
  tier?: number;
  agentName?: string;
  label?: string;
  aggregationMode?: 'concat' | 'llm-synthesize' | 'sequential';
  exactMetadata: boolean;
  parentId?: string;
  lane: number;
  ordinal: number;
  parallel: boolean;
}

/**
 * Concurrency between two branches, as HALF-OPEN intervals.
 *
 * Sequential phases are back-to-back to the millisecond: the runner closes one
 * branch and opens the next on the same event, so `phase 1.lastTs` and
 * `phase 2.firstTs` are byte-identical (measured at exactly 0 ms apart on run
 * 68cdf607, 2026-08-15). Comparing them as CLOSED intervals made that shared
 * instant count as an overlap, which pushed phase 2 past both phase 1's lane
 * and its child's — a branch indented two lanes deep with nothing running
 * beside it — and would label two strictly sequential inferred phases as
 * parallel siblings. Touching at one instant is succession, not concurrency.
 */
function overlaps(a: MutableBranch, b: MutableBranch): boolean {
  return a.firstTs < b.lastTs && b.firstTs < a.lastTs;
}

function branchColorIndex(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 8;
}

function eventTier(event: VizEvent): number | undefined {
  const tiers = [event.actor?.tier, event.child?.tier].filter(
    (tier): tier is number => typeof tier === 'number'
  );
  return tiers.length ? Math.max(...tiers) : undefined;
}

function branchAgent(events: readonly VizEvent[]): string | undefined {
  for (const event of events) {
    if (event.child?.name) return event.child.name;
    if (event.actor?.name) return event.actor.name;
    if (event.l1Name) return event.l1Name;
  }
  return undefined;
}

function inferParents(branches: MutableBranch[]): void {
  for (const branch of branches) {
    if (branch.exactMetadata) continue;
    const candidates = branches.filter((candidate) => {
      if (candidate.id === branch.id) return false;
      if (candidate.firstTs > branch.firstTs || candidate.lastTs < branch.lastTs) return false;
      if (candidate.firstTs === branch.firstTs && candidate.lastTs === branch.lastTs) return false;
      if (
        candidate.tier !== undefined &&
        branch.tier !== undefined &&
        candidate.tier <= branch.tier
      ) {
        return false;
      }
      return true;
    });
    candidates.sort(
      (a, b) =>
        (a.lastTs - a.firstTs) - (b.lastTs - b.firstTs) ||
        (b.tier ?? 0) - (a.tier ?? 0)
    );
    branch.parentId = candidates[0]?.id;
  }
}

function assignLanes(branches: MutableBranch[]): void {
  const byId = new Map(branches.map((branch) => [branch.id, branch]));
  const assigned: MutableBranch[] = [];
  for (const branch of branches) {
    const parentLane = branch.parentId ? byId.get(branch.parentId)?.lane ?? 0 : 0;
    let lane = parentLane + 1;
    while (assigned.some((other) => other.lane === lane && overlaps(other, branch))) lane++;
    branch.lane = lane;
    assigned.push(branch);
  }
}

function markParallelSiblings(branches: MutableBranch[]): void {
  for (const branch of branches) {
    if (branch.exactMetadata) {
      branch.parallel = branch.aggregationMode !== 'sequential';
      continue;
    }
    branch.parallel = branches.some(
      (other) =>
        other.id !== branch.id &&
        other.parentId === branch.parentId &&
        overlaps(other, branch)
    );
  }
}

const LITERAL_CONTRACT_MARKER = '== LITERAL CONTRACTS FROM TOP-LEVEL GOAL ==';
const PLANNER_PHASE_PREFIX = /^(?:(?:final|last)\s+)?(?:separate\s+)?phase\s*:\s*/i;

export interface TimelineBranchHeading {
  readonly eyebrow: string;
  readonly title: string;
  readonly lines: readonly string[];
}

function collapseWs(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sentenceCaseFirst(value: string): string {
  const trimmed = collapseWs(value);
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function splitReadableLines(value: string): string[] {
  const text = collapseWs(value);
  const lead = text.match(
    /^(.+?[:.])\s+((?:and\s+)?(?:GET|POST|PUT|PATCH|DELETE)\b.+)$/i
  );
  const parts = lead?.[1] && lead[2] ? [lead[1], lead[2]] : [text];
  return parts.flatMap((part) =>
    collapseWs(part)
      .split(
        /(?<=[.!?])\s+|(?<=;)\s+(?=(?:and\s+)?(?:GET|POST|PUT|PATCH|DELETE)\b)/i
      )
      .map((item) => collapseWs(item.replace(/[;]+$/, '')))
      .filter(Boolean)
  );
}

function splitHeading(text: string): { title: string; rest: string } {
  const byMatch = text.match(/^(.{12,90}?)(?:\s+by\s+)(.+)$/i);
  if (byMatch?.[1] && byMatch[2]) {
    return { title: sentenceCaseFirst(byMatch[1]), rest: sentenceCaseFirst(byMatch[2]) };
  }
  const colon = text.indexOf(': ');
  if (colon >= 18 && colon <= 120) {
    return {
      title: sentenceCaseFirst(text.slice(0, colon)),
      rest: sentenceCaseFirst(text.slice(colon + 2)),
    };
  }
  const sentence = text.match(/^(.+?[.!?])\s+(.+)$/);
  if (sentence?.[1] && sentence[2] && sentence[1].length <= 140) {
    return { title: sentenceCaseFirst(sentence[1]), rest: sentenceCaseFirst(sentence[2]) };
  }
  return { title: sentenceCaseFirst(text), rest: '' };
}

export function timelineBranchHeading(
  branch: TimelineBranch,
  t: (key: string, vars?: Record<string, unknown>) => string
): TimelineBranchHeading {
  const eyebrow = t(
    branch.parallel ? 'timeline.parallelBranch' : 'timeline.phase',
    { n: branch.path.join('.') }
  );
  const raw = collapseWs(branch.label ?? branch.agentName ?? '');
  if (!raw) return { eyebrow, title: eyebrow, lines: [] };
  const withoutContracts = collapseWs(raw.split(LITERAL_CONTRACT_MARKER)[0] ?? raw);
  const withoutPrefix =
    collapseWs(withoutContracts.replace(PLANNER_PHASE_PREFIX, '')) || withoutContracts;
  const { title, rest } = splitHeading(withoutPrefix);
  return {
    eyebrow,
    title: title || eyebrow,
    lines: rest ? splitReadableLines(rest) : [],
  };
}

export function timelineBranchTitle(
  branch: TimelineBranch,
  t: (key: string, vars?: Record<string, unknown>) => string
): string {
  const heading = timelineBranchHeading(branch, t);
  return heading.title === heading.eyebrow
    ? heading.eyebrow
    : `${heading.eyebrow} · ${heading.title}`;
}

export function buildTimelineLayout(
  events: readonly VizEvent[],
  filters: EventFilters,
  options: { rowHeight?: number; newestFirst?: boolean } = {}
): TimelineLayout {
  const lifecycle = new Map<
    string,
    {
      startTs?: number;
      endTs?: number;
      parentId?: string;
      index?: number;
      total?: number;
      aggregationMode?: 'concat' | 'llm-synthesize' | 'sequential';
      label?: string;
      actorName?: string;
      actorTier?: number;
    }
  >();
  for (const event of events) {
    if (event.kind !== 'branch' || !event.branchId) continue;
    const current = lifecycle.get(event.branchId) ?? {};
    const aggregationMode = event['aggregationMode'];
    const index = event['index'];
    const total = event['total'];
    const label = event['label'];
    const parentId = event['parentBranchId'];
    lifecycle.set(event.branchId, {
      ...current,
      ...(event.op === 'start' ? { startTs: event.ts } : { endTs: event.ts }),
      ...(typeof parentId === 'string' ? { parentId } : {}),
      ...(typeof index === 'number' ? { index } : {}),
      ...(typeof total === 'number' ? { total } : {}),
      ...(aggregationMode === 'concat' ||
      aggregationMode === 'llm-synthesize' ||
      aggregationMode === 'sequential'
        ? { aggregationMode }
        : {}),
      ...(typeof label === 'string' ? { label } : {}),
      ...(event.actor?.name ? { actorName: event.actor.name } : {}),
      ...(typeof event.actor?.tier === 'number'
        ? { actorTier: event.actor.tier }
        : {}),
    });
  }
  const completed = new Set(
    events
      .filter((event) => event.kind === 'llm')
      .map((event) => String(event.id))
  );
  const originalIndex = new Map(events.map((event, index) => [event.id, index]));
  const visible = filterEvents([...events], filters)
    .filter((event) => event.kind !== 'branch')
    .filter(
      (event) =>
        event.kind !== 'llm-start' ||
        !completed.has(String(event.llmEventId))
    )
    .sort(
      (a, b) =>
        a.ts - b.ts ||
        (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0)
    );

  const grouped = new Map<string, VizEvent[]>();
  for (const event of visible) {
    if (!event.branchId) continue;
    const group = grouped.get(event.branchId) ?? [];
    group.push(event);
    grouped.set(event.branchId, group);
  }

  const branches: MutableBranch[] = [...grouped.entries()]
    .map(([id, branchEvents]) => {
      const metadata = lifecycle.get(id);
      const tiers = branchEvents
        .map(eventTier)
        .filter((tier): tier is number => tier !== undefined);
      const agentName = branchAgent(branchEvents);
      return {
        id,
        events: branchEvents,
        firstTs: metadata?.startTs ?? branchEvents[0]!.ts,
        lastTs: metadata?.endTs ?? branchEvents.at(-1)!.ts,
        ...(metadata?.actorTier !== undefined
          ? { tier: metadata.actorTier }
          : tiers.length
            ? { tier: Math.max(...tiers) }
            : {}),
        ...(agentName
          ? { agentName }
          : metadata?.actorName
            ? { agentName: metadata.actorName }
            : {}),
        ...(metadata?.label ? { label: metadata.label } : {}),
        ...(metadata?.aggregationMode
          ? { aggregationMode: metadata.aggregationMode }
          : {}),
        ...(metadata?.parentId ? { parentId: metadata.parentId } : {}),
        lane: 1,
        ordinal:
          metadata?.index !== undefined
            ? metadata.index + 1
            : 0,
        parallel: false,
        exactMetadata: metadata?.startTs !== undefined,
      };
    })
    .sort((a, b) => a.firstTs - b.firstTs || a.id.localeCompare(b.id));

  inferParents(branches);
  const siblingCounters = new Map<string, number>();
  for (const branch of branches) {
    const key = branch.parentId ?? 'trunk';
    if (branch.ordinal === 0) {
      const ordinal = (siblingCounters.get(key) ?? 0) + 1;
      siblingCounters.set(key, ordinal);
      branch.ordinal = ordinal;
    } else {
      siblingCounters.set(
        key,
        Math.max(siblingCounters.get(key) ?? 0, branch.ordinal)
      );
    }
  }
  markParallelSiblings(branches);
  assignLanes(branches);

  const singleBranch = filters.branchId !== 'all';
  if (singleBranch) {
    for (const branch of branches) branch.lane = 0;
  }

  const branchById = new Map(branches.map((branch) => [branch.id, branch]));
  const firstRows = new Map<string, number>();
  const lastRows = new Map<string, number>();
  // Row assignment is the ONLY place order enters. `ordered` is what the
  // screen reads top-down; `firstRows`/`lastRows` therefore mean top and
  // bottom of a branch's rail segment, not earliest/latest in time — the
  // causal ends are recovered below for the fork/join connectors.
  const newestFirst = options.newestFirst === true;
  const ordered = newestFirst ? [...visible].reverse() : visible;
  const items = ordered.map((event, row): TimelineItem => {
    const branch = event.branchId ? branchById.get(event.branchId) : undefined;
    if (branch) {
      if (!firstRows.has(branch.id)) firstRows.set(branch.id, row);
      lastRows.set(branch.id, row);
    }
    return {
      event,
      row,
      lane: branch?.lane ?? 0,
      ...(branch ? { branchId: branch.id } : {}),
      branchStart: false,
      branchEnd: false,
      ...(eventTier(event) !== undefined ? { tier: eventTier(event) } : {}),
    };
  });

  const finalizedItems = items.map((item): TimelineItem => ({
    ...item,
    branchStart:
      item.branchId !== undefined && firstRows.get(item.branchId) === item.row,
    branchEnd:
      item.branchId !== undefined && lastRows.get(item.branchId) === item.row,
  }));
  // Subtree extents: a branch's rail must reach every descendant so forks
  // and joins land on a live rail (see TimelineBranch.subtreeFirstRow).
  const childrenOf = new Map<string, string[]>();
  for (const branch of branches) {
    if (!branch.parentId) continue;
    const siblings = childrenOf.get(branch.parentId) ?? [];
    siblings.push(branch.id);
    childrenOf.set(branch.parentId, siblings);
  }
  const subtreeExtent = (id: string, seen = new Set<string>()): { first: number; last: number } => {
    let first = firstRows.get(id) ?? 0;
    let last = lastRows.get(id) ?? 0;
    if (seen.has(id)) return { first, last };
    seen.add(id);
    for (const childId of childrenOf.get(id) ?? []) {
      const child = subtreeExtent(childId, seen);
      first = Math.min(first, child.first);
      last = Math.max(last, child.last);
    }
    return { first, last };
  };

  const publicBranches: TimelineBranch[] = branches.map((branch) => ({
    id: branch.id,
    lane: branch.lane,
    ...(branch.parentId ? { parentId: branch.parentId } : {}),
    firstRow: firstRows.get(branch.id) ?? 0,
    lastRow: lastRows.get(branch.id) ?? 0,
    firstTs: branch.firstTs,
    lastTs: branch.lastTs,
    eventCount: branch.events.length,
    ...(branch.tier !== undefined ? { tier: branch.tier } : {}),
    ...(branch.agentName ? { agentName: branch.agentName } : {}),
    ...(branch.label ? { label: branch.label } : {}),
    ...(branch.aggregationMode
      ? { aggregationMode: branch.aggregationMode }
      : {}),
    ordinal: branch.ordinal,
    path: (() => {
      const path = [branch.ordinal];
      let parentId = branch.parentId;
      while (parentId) {
        const parent = branchById.get(parentId);
        if (!parent) break;
        path.unshift(parent.ordinal);
        parentId = parent.parentId;
      }
      return path;
    })(),
    parallel: branch.parallel,
    colorIndex: branchColorIndex(branch.id),
    ...(() => {
      const extent = subtreeExtent(branch.id);
      return { subtreeFirstRow: extent.first, subtreeLastRow: extent.last };
    })(),
  }));
  const connectors: TimelineConnector[] = singleBranch
    ? []
    : publicBranches.flatMap((branch) => {
        const parentLane = branch.parentId
          ? branchById.get(branch.parentId)?.lane ?? 0
          : 0;
        // Causal ends, not display ends: reversed order puts a branch's
        // first event at its BOTTOM row, and a fork drawn at the top row
        // would point at the wrong moment.
        const forkRow = newestFirst ? branch.lastRow : branch.firstRow;
        const joinRow = newestFirst ? branch.firstRow : branch.lastRow;
        return [
          {
            kind: 'fork' as const,
            row: forkRow,
            fromLane: parentLane,
            toLane: branch.lane,
            branchId: branch.id,
          },
          {
            kind: 'join' as const,
            row: joinRow,
            fromLane: branch.lane,
            toLane: parentLane,
            branchId: branch.id,
          },
        ];
      });
  const rowHeight = options.rowHeight ?? TIMELINE_ROW_HEIGHT;

  return {
    items: finalizedItems,
    branches: publicBranches,
    connectors,
    maxLane: publicBranches.reduce((max, branch) => Math.max(max, branch.lane), 0),
    rowHeight,
    totalHeight: finalizedItems.length * rowHeight,
    chronological: !newestFirst,
  };
}
