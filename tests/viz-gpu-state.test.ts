import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { invalidateActiveView } from '../src/viz/client-gl/queries.js';
import { useGpuStore } from '../src/viz/client-gl/store.js';

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
    store.selectAtom('Hydrogen');
    expect(useGpuStore.getState()).toMatchObject({
      selectedEventId: null,
      selectedAtomName: 'Hydrogen',
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
