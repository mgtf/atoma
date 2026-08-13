import { describe, expect, it } from 'vitest';
import {
  ABANDONED_AFTER_MS,
  filterEvents,
  isAbandoned,
  isIndexEntryLive,
  isRunLive,
  mergeRunDelta,
} from '../src/viz/client/run-utils.js';
import type { VizRun } from '../src/viz/client/types.js';

function run(overrides: Partial<VizRun> = {}): VizRun {
  return {
    id: 'run-1',
    label: 'run',
    startedAt: '2026-08-13T10:00:00.000Z',
    events: [],
    ...overrides,
  };
}

describe('React viz live predicates', () => {
  const start = Date.parse('2026-08-13T10:00:00.000Z');

  it('uses the twelve-minute abandonment threshold consistently', () => {
    const active = run({ events: [{ id: 'e1', kind: 'tool', ts: start + 1000 }] });
    expect(isRunLive(active, start + 1000 + ABANDONED_AFTER_MS)).toBe(true);
    expect(isAbandoned(active, start + 1001 + ABANDONED_AFTER_MS)).toBe(true);
    expect(isRunLive(active, start + 1001 + ABANDONED_AFTER_MS)).toBe(false);
  });

  it('does not call an ended run or stale index entry live', () => {
    expect(isRunLive(run({ endedAt: '2026-08-13T10:01:00.000Z' }), start + 2000)).toBe(false);
    expect(isIndexEntryLive({
      id: 'run-1',
      label: 'run',
      startedAt: '2026-08-13T10:00:00.000Z',
      inFlight: true,
      lastEventAt: start,
    }, start + ABANDONED_AFTER_MS + 1)).toBe(false);
  });
});

describe('React viz delta and filters', () => {
  it('appends a delta at eventsFrom and resyncs from zero', () => {
    const current = run({
      events: [
        { id: 'e1', kind: 'llm', ts: 1 },
        { id: 'e2', kind: 'tool', ts: 2 },
      ],
    });
    const delta = run({
      eventsFrom: 2,
      events: [{ id: 'e3', kind: 'trust', ts: 3 }],
      endedAt: '2026-08-13T10:01:00.000Z',
    });
    expect(mergeRunDelta(current, delta).events.map((event) => event.id)).toEqual(['e1', 'e2', 'e3']);
    expect(mergeRunDelta(current, run({
      eventsFrom: 0,
      events: [{ id: 'fresh', kind: 'cache', ts: 4 }],
    })).events.map((event) => event.id)).toEqual(['fresh']);
  });

  it('treats llm-start as llm while preserving role and branch filters', () => {
    const events = [
      { id: 's1', kind: 'llm-start', role: 'execute', branchId: 'a', ts: 1 },
      { id: 'l1', kind: 'llm', role: 'plan', branchId: 'a', ts: 2 },
      { id: 't1', kind: 'tool', branchId: 'b', ts: 3 },
      { id: 'x1', kind: 'trust', branchId: 'a', ts: 4 },
    ];
    expect(filterEvents(events, { kind: 'llm', role: 'all', branchId: 'all' }).map((event) => event.id)).toEqual(['s1', 'l1']);
    expect(filterEvents(events, { kind: 'all', role: 'execute', branchId: 'a' }).map((event) => event.id)).toEqual(['s1', 'x1']);
  });
});
