import { describe, expect, it } from 'vitest';
import {
  ABANDONED_AFTER_MS,
  buildAtomMap,
  coerceEventFilters,
  filterEvents,
  visibleEventKindFilters,
  isAbandoned,
  isIndexEntryLive,
  isRunLive,
  mergeRunDelta,
  projectRunTaxonomy,
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
