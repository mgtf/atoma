import { describe, expect, it } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { capabilityDescription } from '../src/atoms/capability.js';
import { makeTools } from './helpers/factories.js';

describe('L2Atom.createSubtaskL1 — capability-first description', () => {
  it('drops a task-themed seed.description in favour of the canonical capability label', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const webTools = makeTools([
      'write_file',
      'read_file',
      'list_files',
      'start_static_server',
      'validate_html',
    ]);
    const l2Type = reg.create(2, {
      description: 'l2',
      systemPrompt: 'l2',
      tools: webTools,
      params: {},
      createdBy: 'test',
    });
    const l2 = L2Atom.fromType(l2Type, reg);
    // Simulate the LLM emitting a task-baked seed — historically this
    // would pollute the registry with a per-theme singleton.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = (l2 as any).createSubtaskL1(
      { description: 'build a chess puzzle with 8x8 grid and drag-and-drop', preferredChild: undefined },
      {
        action: 'create',
        seed: {
          description: 'Mate-in-1 chess builder: 8x8 board, drag-and-drop, checkmate detection',
          tools: [],
          params: {},
        },
      },
      { description: 'parent task' }
    );
    // Registry description is capability-derived, not task-themed.
    expect(created.description).toBe(capabilityDescription(webTools, 1));
    expect(created.description).toMatch(/builder/);
    expect(created.description).not.toMatch(/chess|mate|8x8|drag-and-drop/i);
    // The subtask description still reaches the prompt (via the fresh-L1 template).
    expect(created.systemPrompt).toContain('Subtask you were handed: build a chess puzzle');
  });

  it('falls back to the capability label when no seed.description is provided', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const webTools = makeTools(['write_file', 'start_static_server', 'validate_html']);
    const l2Type = reg.create(2, {
      description: 'l2',
      systemPrompt: 'l2',
      tools: webTools,
      params: {},
      createdBy: 'test',
    });
    const l2 = L2Atom.fromType(l2Type, reg);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = (l2 as any).createSubtaskL1(
      { description: 'any task', preferredChild: undefined },
      { action: 'create', seed: undefined },
      { description: 'parent' }
    );
    expect(created.description).toBe(capabilityDescription(webTools, 1));
  });

  it('honours a clean, generic seed.description when the LLM got it right', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const webTools = makeTools(['write_file', 'start_static_server', 'validate_html']);
    const l2Type = reg.create(2, {
      description: 'l2',
      systemPrompt: 'l2',
      tools: webTools,
      params: {},
      createdBy: 'test',
    });
    const l2 = L2Atom.fromType(l2Type, reg);
    const goodSeed = 'focused HTML writer for single-file deliverables';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = (l2 as any).createSubtaskL1(
      { description: 'any task', preferredChild: undefined },
      {
        action: 'create',
        seed: { description: goodSeed, tools: [], params: {} },
      },
      { description: 'parent' }
    );
    expect(created.description).toBe(goodSeed);
  });
});

describe('L3Atom.createSubtaskL2 — capability-first description', () => {
  it('drops a task-themed seed.description in favour of the canonical capability label', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const webTools = makeTools(['write_file', 'start_static_server', 'validate_html']);
    const l3Type = reg.create(3, {
      description: 'l3',
      systemPrompt: 'l3',
      tools: webTools,
      params: {},
      createdBy: 'test',
    });
    const l3 = await L3Atom.fromType(l3Type, reg, undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = (l3 as any).createSubtaskL2(
      { description: 'minesweeper 10x10 with flag icons', preferredChild: undefined },
      {
        action: 'create',
        seed: {
          description: 'Minesweeper 10x10 orchestrator with flag icons and mine counts',
          tools: [],
          params: {},
        },
      },
      { description: 'parent task' }
    );
    expect(created.description).toBe(capabilityDescription(webTools, 2));
    expect(created.description).toMatch(/orchestrator/);
    expect(created.description).not.toMatch(/builder:/);
    expect(created.description).not.toMatch(/minesweeper|10x10|flag/i);
  });

  it('a plan naming the SAME invented preferredChild on two subtasks creates ONE L2, not clones', async () => {
    // Cold-start regression: the Opus plan asked for "Ethane" on both
    // phases; each lookup missed independently and the registry gained
    // Ammonia AND CarbonDioxide — identical capability labels, one plan.
    const reg = new AtomRegistry(openDb(':memory:'));
    const tools = makeTools(['write_file', 'read_file', 'run_shell']);
    const l3Type = reg.create(3, {
      description: 'l3',
      systemPrompt: 'l3',
      tools,
      params: {},
      createdBy: 'test',
    });
    const l3 = await L3Atom.fromType(l3Type, reg, undefined);
    const ctx = { logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } };
    const strategy = {
      action: 'create',
      seed: { description: 'CLI project orchestrator', tools: [], params: {} },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const any3 = l3 as any;
    any3.planChildAliases.clear();
    const first = any3.resolveL2ForSubtask(
      { description: 'phase 1: build the CLI', preferredChild: 'Ethane' },
      strategy,
      { description: 'parent' },
      0,
      ctx
    );
    const second = any3.resolveL2ForSubtask(
      { description: 'phase 2: document the CLI', preferredChild: 'Ethane' },
      strategy,
      { description: 'parent' },
      1,
      ctx
    );
    expect(second.name).toBe(first.name);
    expect(reg.listByTier(2)).toHaveLength(1);
    // A DIFFERENT invented name still gets its own L2 — the alias is
    // per-name, not a blanket "reuse whatever was created last".
    const third = any3.resolveL2ForSubtask(
      { description: 'phase 3: something else', preferredChild: 'Benzene' },
      strategy,
      { description: 'parent' },
      2,
      ctx
    );
    expect(third.name).not.toBe(first.name);
    expect(reg.listByTier(2)).toHaveLength(2);
  });

  it('tier-2 description stays distinct from tier-1 for the same toolset (L2 ≠ L1)', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const webTools = makeTools(['write_file', 'start_static_server', 'validate_html']);
    const l3Type = reg.create(3, {
      description: 'l3',
      systemPrompt: 'l3',
      tools: webTools,
      params: {},
      createdBy: 'test',
    });
    const l3 = await L3Atom.fromType(l3Type, reg, undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createdL2 = (l3 as any).createSubtaskL2(
      { description: 'anything', preferredChild: undefined },
      { action: 'create', seed: undefined },
      { description: 'parent' }
    );
    expect(createdL2.description).toBe(capabilityDescription(webTools, 2));
    expect(createdL2.description).not.toBe(capabilityDescription(webTools, 1));
  });
});

  it('L2 mirror: the SAME invented preferredChild on two subtasks creates ONE L1, not clones (audit rank-5)', () => {
    // L3 got this dedup first; L2 had the identical failure mode
    // (L3Atom's own comment says "same failure mode as in
    // L2.resolveL1ForSubtask") but no map — a Sonnet plan naming ONE
    // invented L1 on N subtasks minted N same-labelled clones in a single
    // dispatch, splitting trust counters and fragmenting skill namespaces.
    const reg = new AtomRegistry(openDb(':memory:'));
    const tools = makeTools(['write_file', 'read_file', 'run_shell']);
    const l2Type = reg.create(2, {
      description: 'l2', systemPrompt: 'l2', tools, params: {}, createdBy: 'test',
    });
    // NOTE: the atom's toolset comes from `l2Type.tools`; `fromType`'s third
    // parameter is the L2 PEER list, which this test does not exercise.
    const l2 = L2Atom.fromType(l2Type, reg);
    const ctx = { logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } };
    const strategy = {
      strategy: 'create',
      seed: { description: 'file writer', tools: [], params: {} },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const any2 = l2 as any;
    any2.planChildAliases.clear();
    const first = any2.resolveL1ForSubtask(
      { description: 'write module A', preferredChild: 'Carbon' },
      strategy, { description: 'parent' }, 0, ctx
    );
    const second = any2.resolveL1ForSubtask(
      { description: 'write module B', preferredChild: 'Carbon' },
      strategy, { description: 'parent' }, 1, ctx
    );
    expect(second.name).toBe(first.name);
    expect(reg.listByTier(1)).toHaveLength(1);
    // A different invented name still gets its own L1.
    const third = any2.resolveL1ForSubtask(
      { description: 'write module C', preferredChild: 'Krypton' },
      strategy, { description: 'parent' }, 2, ctx
    );
    expect(third.name).not.toBe(first.name);
    expect(reg.listByTier(1)).toHaveLength(2);
  });
