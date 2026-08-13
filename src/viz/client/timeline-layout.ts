import type { EventFilters } from './run-utils.js';
import { filterEvents } from './run-utils.js';
import type { VizEvent } from './types.js';

export const TIMELINE_ROW_HEIGHT = 92;

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
  readonly chronological: true;
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

function overlaps(a: MutableBranch, b: MutableBranch): boolean {
  return a.firstTs <= b.lastTs && b.firstTs <= a.lastTs;
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

export function buildTimelineLayout(
  events: readonly VizEvent[],
  filters: EventFilters,
  options: { rowHeight?: number } = {}
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
  const items = visible.map((event, row): TimelineItem => {
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
  }));
  const connectors: TimelineConnector[] = singleBranch
    ? []
    : publicBranches.flatMap((branch) => {
        const parentLane = branch.parentId
          ? branchById.get(branch.parentId)?.lane ?? 0
          : 0;
        return [
          {
            kind: 'fork' as const,
            row: branch.firstRow,
            fromLane: parentLane,
            toLane: branch.lane,
            branchId: branch.id,
          },
          {
            kind: 'join' as const,
            row: branch.lastRow,
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
    chronological: true,
  };
}
