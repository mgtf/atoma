import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  gpuCardShaderMode,
  gpuEventCardCopy,
  gpuFilterButtonWidth,
} from '../src/viz/client-gl/gpu-renderer.js';
import { invalidateActiveView } from '../src/viz/client-gl/queries.js';
import {
  nextRunFilters,
  useGpuStore,
} from '../src/viz/client-gl/store.js';

beforeEach(() => {
  useGpuStore.setState({
    view: 'runs',
    selectedRunId: null,
    selectedEventId: null,
    selectedAtomName: null,
    runFilters: { kind: 'all', role: 'all', branchId: 'all' },
    burninFamily: 'all',
    burninOutcome: 'all',
    burninPreset: 'all',
    burninPage: 1,
    scrollY: { runs: 0, registry: 0, skills: 0, burnin: 0, launch: 0 },
  });
});

describe('full-GL Zustand scene state', () => {
  it('keeps event and atom selections mutually exclusive', () => {
    const store = useGpuStore.getState();
    store.selectEvent('event-1');
    expect(useGpuStore.getState()).toMatchObject({
      selectedEventId: 'event-1',
      selectedAtomName: null,
    });
    store.selectAtom('Water');
    expect(useGpuStore.getState()).toMatchObject({
      selectedEventId: null,
      selectedAtomName: 'Water',
    });
  });

  it('resets dependent UI state and clamps GPU scrolling', () => {
    const store = useGpuStore.getState();
    store.setBurninPage(4);
    store.setBurninFilter('family', 'http');
    store.setScrollY('runs', -200);
    expect(useGpuStore.getState()).toMatchObject({
      burninFamily: 'http',
      burninPage: 1,
      scrollY: { runs: 0 },
    });
  });
});

describe('TanStack Query remains server-state authority', () => {
  it('invalidates only the active view query roots', async () => {
    const client = new QueryClient();
    client.setQueryData(['viz', 'runs'], []);
    client.setQueryData(['viz', 'run', 'r1'], { id: 'r1' });
    client.setQueryData(['viz', 'burnin'], { rows: [] });
    await invalidateActiveView(client, 'runs');
    expect(client.getQueryState(['viz', 'runs'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['viz', 'run', 'r1'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['viz', 'burnin'])?.isInvalidated).toBe(false);
  });
});

describe('full-GL event cards preserve trace metadata', () => {
  it('selects a distinct shader mode for every functional event family', () => {
    const base = { id: 'e', ts: 1 };
    const modes = [
      gpuCardShaderMode({ ...base, kind: 'llm' }),
      gpuCardShaderMode({ ...base, kind: 'tool' }),
      gpuCardShaderMode({ ...base, kind: 'trust' }),
      gpuCardShaderMode({ ...base, kind: 'skill' }),
      gpuCardShaderMode({ ...base, kind: 'cache' }),
      gpuCardShaderMode({ ...base, kind: 'registry' }),
    ];
    expect(new Set(modes).size).toBe(6);
  });

  it('renders tool arguments, result facts, branch, duration and timestamp', () => {
    const copy = gpuEventCardCopy({
      id: 'tool-1',
      ts: Date.parse('2026-08-13T10:20:30.000Z'),
      kind: 'tool',
      name: 'read_file',
      actor: { tier: 1, name: 'Ammonia' },
      branchId: 'abcdef12-3456',
      args: { path: 'src/index.ts' },
      result: { ok: true },
      durationMs: 12,
    });
    expect(copy).toMatchObject({
      title: 'Li · read_file',
      meta: expect.stringContaining('L1 Ammonia'),
      body: expect.stringContaining('src/index.ts'),
    });
    expect(copy.meta).toContain('⑂ abcdef');
    expect(copy.body).toContain('ok=true');
    expect(copy.footer).toContain('12ms');
    expect(copy.footer).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('renders LLM routing, model, cost, child and verdict decision', () => {
    const copy = gpuEventCardCopy({
      id: 'llm-1',
      ts: Date.parse('2026-08-13T10:20:30.000Z'),
      kind: 'llm',
      role: 'validate-result',
      actor: { tier: 3, name: 'Meristem' },
      child: { tier: 2, name: 'Erythrocyte' },
      model: 'zai:glm-4.5-air',
      response: JSON.stringify({ approved: true, reasoning: 'clean' }),
      durationMs: 1500,
      costUsd: 0.0123,
    });
    expect(copy.title).toBe('validate-result');
    expect(copy.meta).toContain('L3 Meristem');
    expect(copy.meta).toContain('→ Erythrocyte');
    expect(copy.footer).toContain('zai:glm-4.5-air');
    expect(copy.footer).toContain('$0.0123');
    expect(copy.decision).toBe('✓ approved');
  });

  it('projects a legacy atom-prefilter target without rewriting skill ids', () => {
    const base = {
      id: 'prefilter',
      ts: 1,
      kind: 'llm',
      role: 'prefilter',
      actor: { tier: 2, name: 'Tracheid' },
      response: JSON.stringify({ outcome: 'reuse', target: 'Hydrogen' }),
    };
    expect(gpuEventCardCopy(base).decision).toBe('→ Water');
    expect(gpuEventCardCopy({
      ...base,
      systemPrompt: 'You match a subtask against a catalog of learned skills',
    }).decision).toBe('→ Hydrogen');
  });
});

describe('full-GL filter controls preserve semantic labels', () => {
  it('allocates enough width for every current kind, role and branch label', () => {
    for (const label of [
      'REGISTRY',
      'ALL ROLES',
      'PREFILTER',
      'VALIDATE-RESULT',
      'ALL BRANCHES',
      '⑂ c545fb',
    ]) {
      const availableCharacters = Math.floor((gpuFilterButtonWidth(label) - 16) / 6.2);
      expect(availableCharacters, label).toBeGreaterThanOrEqual(label.length);
    }
  });

  it('makes role filters LLM-exclusive and resets stale roles on kind changes', () => {
    const current = { kind: 'all', role: 'all', branchId: 'all' };
    expect(nextRunFilters(current, 'role', 'prefilter')).toEqual({
      kind: 'llm',
      role: 'prefilter',
      branchId: 'all',
    });
    expect(
      nextRunFilters(
        { kind: 'llm', role: 'prefilter', branchId: 'all' },
        'kind',
        'tool'
      )
    ).toEqual({ kind: 'tool', role: 'all', branchId: 'all' });
  });
});
