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

describe('React viz taxonomy projection', () => {
  it('shows immutable legacy traces with current structured identities', () => {
    const projected = projectRunTaxonomy(run({
      initialTypes: [
        {
          tier: 1,
          ordinal: 1,
          name: 'Hydrogen',
          description: 'legacy molecule',
          systemPrompt: 'You are Hydrogen, an L1 element.',
          tools: ['read_file'],
          params: {},
          createdBy: 'Methane',
          createdAt: '2026-08-01T00:00:00.000Z',
          version: 1,
          successes: 3,
          failures: 0,
        },
        {
          tier: 2,
          ordinal: 1,
          name: 'Water',
          description: 'legacy cell',
          systemPrompt: 'You are Water, an L2 molecule.',
          tools: [],
          params: {},
          createdBy: 'Neuron',
          createdAt: '2026-08-01T00:00:00.000Z',
          version: 1,
          successes: 2,
          failures: 0,
        },
        {
          tier: 3,
          ordinal: 1,
          name: 'Neuron',
          description: 'legacy tissue',
          systemPrompt: 'You are Neuron, an L3 cell.',
          tools: [],
          params: {},
          createdBy: 'user',
          createdAt: '2026-08-01T00:00:00.000Z',
          version: 1,
          successes: 1,
          failures: 0,
        },
      ],
      events: [
        {
          id: 'llm',
          kind: 'llm',
          ts: 1,
          actor: { tier: 3, name: 'Neuron' },
          child: { tier: 2, name: 'Water' },
          userContent: 'You are atom "Neuron" (tier 3 / cell).',
        },
        {
          id: 'skill',
          kind: 'skill',
          ts: 2,
          l1Name: 'Hydrogen',
        },
        {
          id: 'tool',
          kind: 'tool',
          ts: 3,
          name: 'read_file',
        },
        {
          id: 'registry-patch',
          kind: 'registry',
          op: 'patch',
          ts: 4,
          name: 'Hydrogen',
          by: 'Water',
          snapshot: {
            tier: 1,
            ordinal: 1,
            name: 'Hydrogen',
            description: 'legacy molecule',
            systemPrompt: 'legacy',
            tools: [],
            params: {},
            createdBy: 'Methane',
            createdAt: '2026-08-01T00:00:00.000Z',
            version: 2,
            successes: 0,
            failures: 0,
          },
        },
        {
          id: 'registry-success',
          kind: 'registry',
          op: 'recordSuccess',
          ts: 5,
          name: 'Hydrogen',
        },
      ],
      result: {
        summary: 'Produced by Hydrogen.',
        producedBy: { tier: 1, name: 'Hydrogen', viaFallback: false },
      },
    }));

    expect(projected.initialTypes?.map((type) => type.name)).toEqual([
      'Water',
      'Tracheid',
      'Meristem',
    ]);
    expect(projected.initialTypes?.[0]).toMatchObject({
      rank: 'molecule',
      createdBy: 'Sclereid',
    });
    expect(projected.events[0]).toMatchObject({
      actor: { tier: 3, name: 'Meristem' },
      child: { tier: 2, name: 'Tracheid' },
      // Raw audit text is deliberately not rewritten.
      userContent: 'You are atom "Neuron" (tier 3 / cell).',
    });
    expect(projected.events[1]?.l1Name).toBe('Water');
    expect(projected.events[2]?.name).toBe('read_file');
    expect(projected.events[3]).toMatchObject({
      name: 'Water',
      actor: { tier: 2, name: 'Tracheid' },
      child: { tier: 1, name: 'Water' },
    });
    expect(projected.events[4]?.actor).toBeUndefined();
    expect('actor' in projected.events[4]!).toBe(false);
    expect(projected.events[4]?.child).toEqual({ tier: 1, name: 'Water' });
    expect(projected.result?.producedBy?.name).toBe('Water');
    expect(projected.result?.summary).toBe('Produced by Hydrogen.');
    expect(projectRunTaxonomy(projected)).toEqual(projected);
  });

  it('does not rewrite a custom override whose ordinal proves it is not the legacy name', () => {
    const projected = projectRunTaxonomy(run({
      initialTypes: [{
        tier: 1,
        ordinal: 1,
        name: 'CustomHydrogen',
        description: 'custom',
        systemPrompt: 'custom',
        tools: [],
        params: {},
        createdBy: 'user',
        createdAt: '2026-08-01T00:00:00.000Z',
        version: 1,
        successes: 0,
        failures: 0,
      }],
    }));
    expect(projected.initialTypes?.[0]?.name).toBe('CustomHydrogen');
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
