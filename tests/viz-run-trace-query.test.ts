// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/viz/client/data-api.js';
import type { RunIndexEntry, VizRun } from '../src/viz/client/types.js';
import { useRunTrace } from '../src/viz/client-gl/queries.js';

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); });
const entry: RunIndexEntry = { id: 'new-run', label: 'new run', startedAt: new Date().toISOString(), inFlight: true };
const trace: VizRun = { ...entry, endedAt: new Date().toISOString(), events: [] };
function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return renderHook(({ active, indexEntry }: { active: boolean; indexEntry?: RunIndexEntry }) => useRunTrace(entry.id, active, indexEntry), {
    initialProps: { active: true, indexEntry: entry },
    wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children),
  });
}
it('retries a missing initial trace while the index says the run is live', async () => {
  const read = vi.spyOn(api, 'run').mockRejectedValueOnce(new Error('HTTP 404')).mockResolvedValue(trace);
  const hook = fixture();
  await waitFor(() => expect(hook.result.current.error).toBeTruthy());
  await waitFor(() => expect(hook.result.current.data?.id).toBe(entry.id), { timeout: 2500 });
  expect(read).toHaveBeenCalledTimes(2);
  expect(hook.result.current.error).toBeNull();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  expect(read).toHaveBeenCalledTimes(2);
});
it('does not expose an inactive trace error or keep polling it', async () => {
  const read = vi.spyOn(api, 'run').mockRejectedValue(new Error('HTTP 404'));
  const hook = fixture();
  await waitFor(() => expect(hook.result.current.error).toBeTruthy());
  hook.rerender({ active: false, indexEntry: entry });
  expect(hook.result.current.error).toBeNull();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  expect(read).toHaveBeenCalledTimes(1);
});
it('stops retrying a missing trace when the index no longer says live', async () => {
  const read = vi.spyOn(api, 'run').mockRejectedValue(new Error('HTTP 404'));
  const hook = fixture();
  await waitFor(() => expect(hook.result.current.error).toBeTruthy());
  hook.rerender({ active: true, indexEntry: { ...entry, inFlight: false, endedAt: trace.endedAt } });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  expect(read).toHaveBeenCalledTimes(1);
});
