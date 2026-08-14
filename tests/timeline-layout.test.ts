import { describe, expect, it } from 'vitest';
import {
  buildTimelineLayout,
  timelineBranchHeading,
  timelineBranchTitle,
} from '../src/viz/client/timeline-layout.js';
import type { VizEvent } from '../src/viz/client/types.js';

function event(
  id: string,
  ts: number,
  overrides: Partial<VizEvent> = {}
): VizEvent {
  return { id, ts, kind: 'llm', role: 'plan', ...overrides };
}

const all = { kind: 'all', role: 'all', branchId: 'all' };

describe('Runs timeline layout', () => {
  it('places trunk-only events oldest-to-newest in one lane', () => {
    const layout = buildTimelineLayout([
      event('new', 30),
      event('old', 10),
      event('middle', 20),
    ], all);

    expect(layout.items.map((item) => item.event.id)).toEqual(['old', 'middle', 'new']);
    expect(layout.items.every((item) => item.lane === 0)).toBe(true);
    expect(layout.branches).toEqual([]);
    expect(layout.totalHeight).toBe(layout.items.length * layout.rowHeight);
  });

  it('reuses a lane for sequential phases and labels them non-parallel', () => {
    const layout = buildTimelineLayout([
      event('phase-a-1', 10, { branchId: 'a', actor: { tier: 2, name: 'Tracheid' } }),
      event('phase-a-2', 20, { branchId: 'a', child: { tier: 1, name: 'Water' } }),
      event('phase-b-1', 30, { branchId: 'b', actor: { tier: 2, name: 'Sclereid' } }),
      event('phase-b-2', 40, { branchId: 'b', child: { tier: 1, name: 'Methane' } }),
    ], all);

    expect(layout.branches.map((branch) => ({
      id: branch.id,
      lane: branch.lane,
      parallel: branch.parallel,
      ordinal: branch.ordinal,
    }))).toEqual([
      { id: 'a', lane: 1, parallel: false, ordinal: 1 },
      { id: 'b', lane: 1, parallel: false, ordinal: 2 },
    ]);
  });

  it('gives overlapping sibling branches separate lanes with fork/join edges', () => {
    const layout = buildTimelineLayout([
      event('trunk-plan', 5),
      event('a-1', 10, { branchId: 'a', actor: { tier: 2, name: 'Tracheid' } }),
      event('b-1', 12, { branchId: 'b', actor: { tier: 2, name: 'Sclereid' } }),
      event('a-2', 30, { branchId: 'a' }),
      event('b-2', 35, { branchId: 'b' }),
      event('trunk-join', 40),
    ], all);

    expect(layout.branches.map((branch) => branch.lane)).toEqual([1, 2]);
    expect(layout.branches.every((branch) => branch.parallel)).toBe(true);
    expect(layout.maxLane).toBe(2);
    expect(layout.connectors).toHaveLength(4);
    expect(layout.connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'fork', fromLane: 0, toLane: 1 }),
        expect.objectContaining({ kind: 'fork', fromLane: 0, toLane: 2 }),
        expect.objectContaining({ kind: 'join', fromLane: 1, toLane: 0 }),
        expect.objectContaining({ kind: 'join', fromLane: 2, toLane: 0 }),
      ])
    );
  });

  it('infers a nested supervision branch from interval containment and tier depth', () => {
    const layout = buildTimelineLayout([
      event('outer-start', 10, { branchId: 'outer', actor: { tier: 3, name: 'Meristem' } }),
      event('inner-start', 30, { branchId: 'inner', actor: { tier: 2, name: 'Tracheid' } }),
      event('inner-end', 60, { branchId: 'inner', child: { tier: 1, name: 'Water' } }),
      event('outer-end', 90, { branchId: 'outer', child: { tier: 2, name: 'Tracheid' } }),
    ], all);

    const outer = layout.branches.find((branch) => branch.id === 'outer')!;
    const inner = layout.branches.find((branch) => branch.id === 'inner')!;
    expect(inner.parentId).toBe(outer.id);
    expect(outer.path).toEqual([1]);
    expect(inner.path).toEqual([1, 1]);
    expect(inner.lane).toBeGreaterThan(outer.lane);
    expect(layout.connectors).toContainEqual(
      expect.objectContaining({
        kind: 'fork',
        branchId: 'inner',
        fromLane: outer.lane,
        toLane: inner.lane,
      })
    );
  });

  it('prefers exact branch lifecycle metadata over overlap heuristics', () => {
    const layout = buildTimelineLayout([
      event('outer-start-meta', 5, {
        kind: 'branch',
        op: 'start',
        branchId: 'outer',
        index: 0,
        total: 1,
        aggregationMode: 'sequential',
        label: 'Build the files',
        actor: { tier: 3, name: 'Meristem' },
      }),
      event('outer-work', 10, { branchId: 'outer', actor: { tier: 2, name: 'Tracheid' } }),
      event('inner-start-meta', 12, {
        kind: 'branch',
        op: 'start',
        branchId: 'inner',
        parentBranchId: 'outer',
        index: 1,
        total: 2,
        aggregationMode: 'concat',
        label: 'Verify the files',
        actor: { tier: 2, name: 'Tracheid' },
      }),
      event('inner-work', 15, { branchId: 'inner', actor: { tier: 1, name: 'Water' } }),
      event('inner-end-meta', 20, {
        kind: 'branch',
        op: 'end',
        branchId: 'inner',
      }),
      event('outer-end-meta', 25, {
        kind: 'branch',
        op: 'end',
        branchId: 'outer',
      }),
    ], all);

    expect(layout.items.map((item) => item.event.id)).toEqual([
      'outer-work',
      'inner-work',
    ]);
    const outer = layout.branches.find((branch) => branch.id === 'outer')!;
    const inner = layout.branches.find((branch) => branch.id === 'inner')!;
    expect(outer).toMatchObject({
      label: 'Build the files',
      aggregationMode: 'sequential',
      parallel: false,
      path: [1],
    });
    expect(inner).toMatchObject({
      parentId: 'outer',
      label: 'Verify the files',
      aggregationMode: 'concat',
      parallel: true,
      path: [1, 2],
    });
  });

  it('honours kind and branch filters and hides completed llm-start pairs', () => {
    const events = [
      event('start', 1, { kind: 'llm-start', llmEventId: 'done', branchId: 'a' }),
      event('done', 2, { branchId: 'a' }),
      event('tool-a', 3, { kind: 'tool', branchId: 'a', name: 'read_file' }),
      event('tool-b', 4, { kind: 'tool', branchId: 'b', name: 'write_file' }),
    ];
    const layout = buildTimelineLayout(events, {
      kind: 'tool',
      role: 'all',
      branchId: 'a',
    });
    expect(layout.items.map((item) => item.event.id)).toEqual(['tool-a']);
    expect(layout.items[0]?.lane).toBe(0);
    expect(layout.connectors).toEqual([]);
  });

  it('formats a selected-branch heading for humans, not the raw planner dump', () => {
    const label = [
      'FINAL SEPARATE PHASE: verify server.js as an HTTP API by booting it on an OS-assigned port',
      'and probing the exact documented contract: POST /items with {"label":"Blue umbrella","location":"Lobby"};',
      'GET /items; GET /items/:id using the created ID; POST /items with a blank label;',
      'and POST /items with a missing location. Confirm success responses have the documented status codes.',
      '',
      '== LITERAL CONTRACTS FROM TOP-LEVEL GOAL ==',
      'POST /items {label, location}',
    ].join(' ');
    const layout = buildTimelineLayout([
      event('start', 5, {
        kind: 'branch',
        op: 'start',
        branchId: 'verify',
        index: 1,
        total: 2,
        aggregationMode: 'sequential',
        label,
        actor: { tier: 2, name: 'Tracheid' },
      }),
      event('work', 10, { branchId: 'verify', actor: { tier: 1, name: 'Ammonia' } }),
      event('end', 20, { kind: 'branch', op: 'end', branchId: 'verify' }),
    ], all);
    const branch = layout.branches.find((item) => item.id === 'verify')!;
    const translate = (key: string, vars?: Record<string, unknown>) => {
      const phase = vars?.n;
      return key === 'timeline.phase' && (typeof phase === 'string' || typeof phase === 'number')
        ? `Phase ${phase}`
        : key;
    };
    const heading = timelineBranchHeading(branch, translate);
    expect(heading.eyebrow).toBe('Phase 2');
    expect(heading.title).toBe('Verify server.js as an HTTP API');
    expect(heading.lines.some((line) => /POST \/items with \{"label":"Blue umbrella"/.test(line))).toBe(true);
    expect(heading.lines.some((line) => line.startsWith('GET /items'))).toBe(true);
    expect(heading.title).not.toMatch(/LITERAL CONTRACTS/);
    expect(heading.lines.join(' ')).not.toMatch(/LITERAL CONTRACTS/);
    expect(timelineBranchTitle(branch, translate)).toBe('Phase 2 · Verify server.js as an HTTP API');
  });
});
