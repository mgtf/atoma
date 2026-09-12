// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/viz/client/data-api.js';
import type { VizPreviewOpen, VizPreviewSummary } from '../src/viz/client/types.js';
import { usePreviewStatus } from '../src/viz/client-gl/queries.js';
import { usePreviewSession } from '../src/viz/client-gl/usePreviewSession.js';

const target = { projectId: 'project', projectRunId: 'run' };
const key = ['viz', 'preview', target.projectId, target.projectRunId];
const t = (key: string) => key;
const clients: QueryClient[] = [];
function summary(generation: number, state: VizPreviewSummary['state'] = 'ready'): VizPreviewSummary {
  return { availability: 'available', kind: 'static', reason: null, state, generation,
    source: 'in-flight', snapshotAt: '2026-09-09T12:00:00.000Z', readyAt: null,
    expiresAt: null, errorCode: null, requestedHosts: [], allowedHosts: [], blockedHosts: [] };
}
function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  let current = summary(0, 'stopped');
  client.setQueryData(key, current);
  vi.spyOn(api, 'previewStatus').mockImplementation(async () => current);
  const hook = renderHook(({ selected = target }) => {
    const status = usePreviewStatus(selected.projectId, selected.projectRunId, true);
    return usePreviewSession({ previewTarget: selected, previewSummary: status.data ?? null, t });
  }, { initialProps: { selected: target }, wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children) });
  function publish(value: VizPreviewSummary) { current = value; client.setQueryData(key, value); }
  function answer(generation: number): VizPreviewOpen {
    current = summary(generation);
    return { summary: current, url: `https://g${generation}.previews.example.net/#claim-${generation}` };
  }
  return { hook, publish, answer, client };
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); });

describe('the production preview session', () => {
  it('replaces an obsolete URL when polling skips straight to another ready generation', async () => {
    const { hook, publish, answer } = fixture();
    const open = vi.spyOn(api, 'openPreview').mockImplementation(async (_p, _r, body) => answer(body?.generation ?? 1));
    await act(async () => hook.result.current.requestPreview('open'));
    await waitFor(() => expect(hook.result.current.previewUrl).toContain('g1.'));
    act(() => publish(summary(2)));
    await waitFor(() => expect(hook.result.current.previewUrl).toContain('g2.'));
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith('project', 'run', { generation: 2 });
  });

  it('joins the generation from a 202 instead of restarting an in-flight snapshot', async () => {
    const { hook, publish, answer } = fixture();
    const open = vi.spyOn(api, 'openPreview').mockImplementationOnce(async () => {
      const pending = summary(1, 'starting'); publish(pending);
      return { summary: pending, retryAfterSeconds: 2 };
    }).mockImplementation(async () => answer(1));
    await act(async () => hook.result.current.requestPreview('open'));
    expect(hook.result.current.previewUrl).toBeNull();
    act(() => publish(summary(1)));
    await waitFor(() => expect(hook.result.current.previewUrl).toContain('g1.'));
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith('project', 'run', { generation: 1 });
  });

  it('discards a response arriving after Back closes the plane', async () => {
    const { hook, answer } = fixture();
    let finish!: (value: VizPreviewOpen) => void;
    vi.spyOn(api, 'openPreview').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let opening!: Promise<void>;
    act(() => { opening = hook.result.current.requestPreview('open'); });
    act(() => hook.result.current.closePreview());
    await act(async () => { finish(answer(1)); await opening; });
    expect(hook.result.current.previewOpen).toBe(false);
    expect(hook.result.current.previewUrl).toBeNull();
  });

  it('drops the spent claim before a restart resets the reload nonce', async () => {
    const { hook, answer } = fixture();
    vi.spyOn(api, 'openPreview').mockImplementation(async () => answer(1));
    let finish!: (value: VizPreviewOpen) => void;
    vi.spyOn(api, 'restartPreview').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => hook.result.current.requestPreview('open'));
    act(() => hook.result.current.reloadPreview());
    expect(hook.result.current.previewReloadNonce).toBe(1);
    let restarting!: Promise<void>;
    act(() => { restarting = hook.result.current.requestPreview('restart'); });
    expect(hook.result.current.previewUrl).toBeNull();
    await act(async () => { finish(answer(2)); await restarting; });
    await waitFor(() => expect(hook.result.current.previewUrl).toContain('g2.'));
    expect(hook.result.current.previewReloadNonce).toBe(0);
  });

  it('reports an expired generation without retrying in a loop', async () => {
    const { hook, publish, answer } = fixture();
    const open = vi.spyOn(api, 'openPreview').mockImplementationOnce(async () => answer(1))
      .mockRejectedValue(new Error('preview is not ready'));
    await act(async () => hook.result.current.requestPreview('open'));
    act(() => publish(summary(2)));
    await waitFor(() => expect(hook.result.current.previewStatus).toBe('error'));
    expect(hook.result.current.previewUrl).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
  });
});


describe('preview session identity changes', () => {
  it.each([false, true])('closes the old preview when selecting another run (cached=%s)', async (cached) => {
    const { hook, answer, client } = fixture();
    const open = vi.spyOn(api, 'openPreview').mockImplementation(async () => answer(1));
    await act(async () => hook.result.current.requestPreview('open'));
    await waitFor(() => expect(hook.result.current.previewUrl).toContain('g1.'));
    if (cached) act(() => { client.setQueryData(['viz', 'preview', 'other-project', 'other-run'], summary(1)); });
    hook.rerender({ selected: { projectId: 'other-project', projectRunId: 'other-run' } });
    await waitFor(() => expect(hook.result.current.previewOpen).toBe(false));
    expect(hook.result.current.previewUrl).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('ignores an old stop failure after opening a new preview session', async () => {
    const { hook, answer } = fixture();
    vi.spyOn(api, 'openPreview').mockImplementation(async () => answer(1));
    let rejectStop!: (error: Error) => void;
    vi.spyOn(api, 'stopPreview').mockImplementation(() => new Promise((_resolve, reject) => { rejectStop = reject; }));
    await act(async () => hook.result.current.requestPreview('open'));
    let stopping!: Promise<void>;
    act(() => { stopping = hook.result.current.stopPreview(); });
    await act(async () => hook.result.current.requestPreview('open'));
    await act(async () => { rejectStop(new Error('old stop failed')); await stopping; });
    expect(hook.result.current.previewStatus).toBe('idle');
    expect(hook.result.current.previewError).toBeNull();
    expect(hook.result.current.previewUrl).toContain('g1.');
  });
});


it('discards an opening response after the selected run changes', async () => {
  const { hook, answer } = fixture();
  let finish!: (value: VizPreviewOpen) => void;
  vi.spyOn(api, 'openPreview').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  let opening!: Promise<void>;
  act(() => { opening = hook.result.current.requestPreview('open'); });
  hook.rerender({ selected: { projectId: 'project', projectRunId: 'another-run' } });
  await act(async () => { finish(answer(1)); await opening; });
  expect(hook.result.current.previewOpen).toBe(false);
  expect(hook.result.current.previewUrl).toBeNull();
  expect(hook.result.current.previewError).toBeNull();
});
