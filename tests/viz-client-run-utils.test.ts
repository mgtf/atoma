import { describe, expect, it } from 'vitest';
import {
  ABANDONED_AFTER_MS,
  buildAtomMap,
  coerceEventFilters,
  filterEvents,
  visibleEventKindFilters,
  inFlightLlmEvents,
  isAbandoned,
  isIndexEntryLive,
  isRunLive,
  mergeRunDelta,
  projectRunTaxonomy,
  projectRunUpdate,
  runElapsedMs,
  runHeading,
  tryParseJson,
  usedAtomNames,
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

describe('live run progress', () => {
  const start = Date.parse('2026-08-13T10:00:00.000Z');

  /**
   * The reported shape: one long tool-bearing L1 execute. `llm-start`, then
   * a stream of tool events, and no usage at all until the call returns —
   * the run header must not read as an idle run for those minutes.
   */
  const midToolLoop = run({
    events: [
      { id: 's1', kind: 'llm-start', ts: start + 500, llmEventId: 'c1' },
      { id: 't1', kind: 'tool', ts: start + 900, llmEventId: 'c1' },
    ],
  });

  it('counts a started call that has not returned as in flight', () => {
    expect(inFlightLlmEvents(midToolLoop).map((event) => event.id)).toEqual(['s1']);
  });

  it('stops counting it once the matching llm event lands', () => {
    const done = run({
      events: [
        ...midToolLoop.events,
        { id: 'c1', kind: 'llm', ts: start + 2000 },
      ],
    });
    expect(inFlightLlmEvents(done)).toEqual([]);
  });

  it('ticks the elapsed time while live and freezes it on the recorded duration', () => {
    expect(runElapsedMs(midToolLoop, start + 4000)).toBe(4000);
    expect(runElapsedMs(midToolLoop, start + 9000)).toBe(9000);
    expect(runElapsedMs(run({ durationMs: 1234, endedAt: '2026-08-13T10:00:01.234Z' }), start + 9e6))
      .toBe(1234);
  });

  it('stops the clock rather than counting forever on an abandoned run', () => {
    expect(runElapsedMs(midToolLoop, start + 900 + ABANDONED_AFTER_MS + 1)).toBeUndefined();
  });
});

describe('React viz delta and filters', () => {
  it('parses back-to-back strategy and plan JSON documents for detail rendering', () => {
    expect(tryParseJson(
      'Strategy follows:\n' +
      '{"strategy":"reuse","reasoning":"brace } inside string"}\n' +
      '{"subtasks":[{"description":"Write docs","preferredChild":"Water"}]}'
    )).toEqual([
      { strategy: 'reuse', reasoning: 'brace } inside string' },
      { subtasks: [{ description: 'Write docs', preferredChild: 'Water' }] },
    ]);
  });

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

  it('returns the SAME reference for an empty delta with unchanged metadata', () => {
    // The reference is the contract: under the 1s live poll, every consumer
    // above (React Query structural sharing, the snapshot memo, the GPU
    // render effect) reads a new reference as "something changed" and
    // rebuilds the whole GPU scene. An empty poll must therefore return
    // `current` itself, not an equal copy — this is what stopped the
    // rebuild-per-second frame drops on live runs.
    const current = run({
      events: [
        { id: 'e1', kind: 'llm', ts: 1 },
        { id: 'e2', kind: 'tool', ts: 2 },
      ],
      totals: { calls: 3 },
    });
    const emptyDelta = run({ eventsFrom: 2, events: [], totals: { calls: 3 } });
    expect(mergeRunDelta(current, emptyDelta)).toBe(current);
  });

  it('ignores projection-only rank metadata when comparing a raw empty delta', () => {
    const storedType = {
      tier: 1,
      ordinal: 1,
      name: 'Water',
      description: 'builder',
      systemPrompt: 'prompt',
      tools: [],
      params: {},
      createdBy: 'seed',
      createdAt: '2026-08-14T00:00:00.000Z',
      version: 2,
      successes: 0,
      failures: 0,
    };
    const current = projectRunTaxonomy(run({
      events: [{ id: 'e1', kind: 'llm', ts: 1 }],
      initialTypes: [storedType],
      totals: { calls: 1 },
    }));
    expect(current.initialTypes?.[0]?.rank).toBe('molecule');

    const rawEmptyDelta = run({
      eventsFrom: 1,
      events: [],
      initialTypes: [storedType],
      totals: { calls: 1 },
    });
    expect(mergeRunDelta(current, rawEmptyDelta)).toBe(current);
  });

  it('still merges an empty delta whose metadata moved', () => {
    // The run finishing produces exactly this shape: no new events, but
    // endedAt/error/totals changed. Identity here would freeze the verdict.
    const current = run({
      events: [{ id: 'e1', kind: 'llm', ts: 1 }],
      totals: { calls: 3 },
    });
    const finished = run({
      eventsFrom: 1,
      events: [],
      totals: { calls: 3 },
      endedAt: '2026-08-16T10:00:00.000Z',
    });
    const merged = mergeRunDelta(current, finished);
    expect(merged).not.toBe(current);
    expect(merged.endedAt).toBe('2026-08-16T10:00:00.000Z');
    expect(merged.events.map((event) => event.id)).toEqual(['e1']);
    // Nested metadata participates too: same shape, different leaf.
    const totalsMoved = mergeRunDelta(current, run({
      eventsFrom: 1,
      events: [],
      totals: { calls: 4 },
    }));
    expect(totalsMoved).not.toBe(current);
    expect(totalsMoved.totals).toEqual({ calls: 4 });
  });

  it('never returns identity when the delta carries events or a resync', () => {
    const current = run({ events: [{ id: 'e1', kind: 'llm', ts: 1 }] });
    const withEvents = mergeRunDelta(current, run({
      eventsFrom: 1,
      events: [{ id: 'e2', kind: 'tool', ts: 2 }],
    }));
    expect(withEvents).not.toBe(current);
    // A resync from zero — even to an EMPTY list (the trace was replaced) —
    // must go through the merge: eventsFrom 0 with no events means the server
    // now has none, not that nothing happened.
    const resync = mergeRunDelta(current, run({ eventsFrom: 0, events: [] }));
    expect(resync.events).toEqual([]);
  });

  it('recovers legacy registry counter versions in chronological order', () => {
    const v2 = {
      tier: 1,
      ordinal: 1,
      name: 'Water',
      description: 'builder',
      systemPrompt: 'v2 prompt',
      tools: [],
      params: {},
      createdBy: 'seed',
      createdAt: '2026-08-14T00:00:00.000Z',
      version: 2,
      successes: 0,
      failures: 0,
    };
    const v3 = { ...v2, systemPrompt: 'v3 prompt', version: 3 };
    const legacy = run({
      initialTypes: [v2],
      events: [
        { id: 'before', kind: 'registry', op: 'recordSuccess', name: 'Water', ts: 1 },
        { id: 'patch', kind: 'registry', op: 'patch', name: 'Water', snapshot: v3, ts: 2 },
        { id: 'after', kind: 'registry', op: 'recordSuccess', name: 'Water', ts: 3 },
        { id: 'unknown', kind: 'registry', op: 'recordSuccess', name: 'Methane', ts: 4 },
      ],
    });
    const projected = projectRunTaxonomy(legacy);
    expect(projected.events.map((event) => event.version)).toEqual([2, 3, 3, undefined]);

    // Live polling keeps the delta raw until it rejoins the complete run. If
    // this counter were projected alone, initialTypes would mislabel it v2.
    const current = projectRunTaxonomy(run({
      initialTypes: [v2],
      events: legacy.events.slice(0, 2),
    }));
    const merged = projectRunUpdate(current, run({
      eventsFrom: 2,
      events: [legacy.events[2]!],
    }));
    expect(merged.events[2]?.version).toBe(3);
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

  it('hides the cache kind filter until a run actually records a cache hit', () => {
    const without = [{ id: 'l1', kind: 'llm', ts: 1 }, { id: 't1', kind: 'tool', ts: 2 }];
    expect(visibleEventKindFilters(without)).toEqual([
      'all',
      'llm',
      'tool',
      'trust',
      'skill',
      'registry',
    ]);
    expect(visibleEventKindFilters([...without, { id: 'x1', kind: 'context', ts: 4 }])).toContain(
      'context'
    );
    expect(visibleEventKindFilters([...without, { id: 'c1', kind: 'cache', ts: 3 }])).toContain(
      'cache'
    );
    expect(
      coerceEventFilters(without, { kind: 'cache', role: 'all', branchId: 'all' })
    ).toEqual({ kind: 'all', role: 'all', branchId: 'all' });
  });

  it('keeps run atom lanes to agents that actually participated', () => {
    const snapshot = (name: string, tier: number, ordinal: number) => ({
      tier,
      ordinal,
      name,
      description: `${name} description`,
      systemPrompt: `You are ${name}.`,
      tools: [],
      params: {},
      createdBy: 'seed',
      createdAt: '2026-08-14T00:00:00.000Z',
      version: 1,
      successes: 0,
      failures: 0,
    });
    const fixture = run({
      initialTypes: [
        snapshot('Meristem', 3, 1),
        snapshot('Tracheid', 2, 1),
        snapshot('Sclereid', 2, 2),
        snapshot('Idioblast', 2, 3),
        snapshot('Water', 1, 1),
      ],
      events: [
        { id: 'p1', kind: 'llm', role: 'plan', actor: { name: 'Meristem', tier: 3 }, ts: 1 },
        { id: 'e1', kind: 'llm', role: 'execute', actor: { name: 'Idioblast', tier: 2 }, ts: 2 },
      ],
      result: { producedBy: { name: 'Idioblast', tier: 2 } },
    });
    expect([...usedAtomNames(fixture)].sort()).toEqual(['Idioblast', 'Meristem']);
    expect([...buildAtomMap(fixture).keys()].sort()).toEqual(['Idioblast', 'Meristem']);
    expect(buildAtomMap(fixture).has('Sclereid')).toBe(false);
    const skillOnly = buildAtomMap(run({
      initialTypes: [],
      events: [{ id: 's1', kind: 'skill', l1Name: 'Ammonia', actor: { name: 'Tracheid', tier: 2 }, ts: 1 }],
    }));
    expect(skillOnly.get('Ammonia')?.snapshot.tier).toBe(1);
  });
});

/**
 * A run's stored `label` is `<family>: <goal, cut>` — measured over the 204
 * local traces, 202 are exactly that, so the only thing it holds that the goal
 * does not is the family. Traces written before 2026-08-15 cut it with a bare
 * slice too, ending mid-word ("…tiles that swap colour w"). The heading keeps
 * the two apart and lets the goal speak for itself.
 */
describe('run heading — family apart, goal whole', () => {
  const goal =
    'a single index.html page showing a 3x3 grid of coloured tiles that swap colour when clicked';

  it('splits the family off and titles the run with its whole goal', () => {
    const cut = run({
      label: `build-app: ${goal.slice(0, 80)}`,
      task: { description: goal },
    });
    expect(cut.label.endsWith('colour w')).toBe(true);
    expect(runHeading(cut)).toEqual({ family: 'build-app', title: goal });
    // A label the writer marked as cut reads the same way.
    expect(
      runHeading(run({ label: `build-app: ${goal.slice(0, 80)}…`, task: { description: goal } }))
    ).toEqual({ family: 'build-app', title: goal });
  });

  it('never lets a stale label override the goal it disagrees with', () => {
    // The demo recorder writes its own name; the card still answers "what was
    // this run asked to do".
    expect(
      runHeading(run({
        label: 'demo — research brief (mocked)',
        task: { description: 'Research the state of GPU dashboards' },
      }))
    ).toEqual({ family: null, title: 'Research the state of GPU dashboards' });
  });

  it('falls back to the label, family stripped, when the run carries no goal', () => {
    expect(runHeading(run({ label: 'build-app: something else' }))).toEqual({
      family: 'build-app',
      title: 'something else',
    });
    expect(runHeading(run({ label: 'no family here' }))).toEqual({
      family: null,
      title: 'no family here',
    });
  });

  it('only reads an identifier-shaped prefix as a family', () => {
    // A goal that merely opens on a capitalised word plus a colon is not one.
    const sentence = 'Fix: the lockfile drifts on install';
    expect(runHeading(run({ label: sentence, task: { description: sentence } }))).toEqual({
      family: null,
      title: sentence,
    });
  });
});
