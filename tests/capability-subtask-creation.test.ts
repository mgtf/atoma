import { describe, expect, it } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import type { Tool } from '../src/core/types.js';
import { capabilityDescription } from '../src/atoms/capability.js';

function makeTools(names: readonly string[]): Tool[] {
  return names.map((name) => ({
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => ({ ok: true as const, output: 'noop' as unknown }),
  }));
}

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
