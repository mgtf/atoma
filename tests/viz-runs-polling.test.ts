// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRunsIndex } from '../src/viz/client/use-runs.js';
import { api } from '../src/viz/client/data-api.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('accepts the last live run closing even when its id and list length do not change', async () => {
  const live = { id: 'benchmark', label: 'Benchmark', startedAt: new Date().toISOString(), hasError: false, inFlight: true };
  const done = { ...live, inFlight: false, endedAt: new Date().toISOString() };
  vi.spyOn(api, 'runs').mockResolvedValueOnce([live]).mockResolvedValue([done]);
  const hook = renderHook(() => useRunsIndex(true));
  await waitFor(() => expect(hook.result.current.runs).toEqual([live]));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)); });
  expect(hook.result.current.runs).toEqual([done]);
});
