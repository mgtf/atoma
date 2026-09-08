// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasEditableWork, pageBuild, restoreUpdateNavigation, saveUpdateNavigation, startAutoUpdate } from '../src/viz/client-gl/auto-update.js';
import { useGpuStore } from '../src/viz/client-gl/store.js';
import { api, pendingApiMutations } from '../src/viz/client/data-api.js';

const shell = (hash: string) => `<html><head><script type="module" src="/assets/index-${hash}.js"></script><link rel="stylesheet" href="/assets/index-${hash}.css"></head><body></body></html>`;
const stops: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  document.head.innerHTML = new DOMParser().parseFromString(shell('old'), 'text/html').head.innerHTML;
  document.body.innerHTML = '';
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function watcher(canReload = () => true) {
  const reload = vi.fn();
  const beforeReload = vi.fn();
  const updater = startAutoUpdate({ reload, beforeReload, canReload });
  stops.push(updater.stop);
  vi.advanceTimersByTime(6000);
  return { ...updater, reload, beforeReload };
}
function serve(html = shell('new'), status = 200) {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(html, { status, headers: { 'content-type': 'text/html' } })));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('automatic frontend updates', () => {
  it('uses hashed assets even when the package version is unchanged and reloads once', async () => {
    const fetcher = serve();
    const w = watcher();
    await w.check();
    await w.check();
    expect(fetcher).toHaveBeenCalledWith('/', expect.objectContaining({ cache: 'no-store', redirect: 'error' }));
    expect(w.beforeReload).toHaveBeenCalledOnce();
    expect(w.reload).toHaveBeenCalledOnce();
  });
  it.each([shell('old'), '<html>Sign in</html>'])('ignores unchanged builds and non-app responses', async (html) => {
    serve(html);
    const w = watcher();
    await w.check();
    expect(w.reload).not.toHaveBeenCalled();
  });
  it('defers dirty or focused fields and pending actions, then checks fresh evidence again', async () => {
    const fetcher = serve();
    let busy = true;
    const w = watcher(() => !busy);
    await w.check();
    busy = false;
    document.body.innerHTML = '<textarea>Unsaved goal</textarea>';
    await w.check();
    const input = document.querySelector('textarea')!;
    input.value = '';
    input.focus();
    await w.check();
    expect(w.reload).not.toHaveBeenCalled();
    input.blur();
    await w.check();
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(w.reload).toHaveBeenCalledOnce();
  });
  it('never reloads after network failure, failed deployment, or a deployment that rolled back', async () => {
    const fetcher = serve(shell('new'), 503);
    const w = watcher();
    await w.check();
    fetcher.mockRejectedValueOnce(new Error('offline'));
    await w.check();
    fetcher.mockResolvedValueOnce(new Response(shell('old'), { headers: { 'content-type': 'text/html' } }));
    await w.check();
    expect(w.reload).not.toHaveBeenCalled();
  });
  it('polls and checks on focus, skips hidden pages, and cleans up', async () => {
    const fetcher = serve(shell('old'));
    const w = watcher();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await w.check();
    expect(fetcher).toHaveBeenCalledTimes(2);
    w.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rechecks safety after a slow response and avoids repeated reloads of a stale shell', async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const w = watcher();
    const checking = w.check();
    document.dispatchEvent(new Event('input'));
    resolve(new Response(shell('new'), { headers: { 'content-type': 'text/html' } }));
    await checking;
    expect(w.reload).not.toHaveBeenCalled();
    serve();
    vi.advanceTimersByTime(6000);
    await w.check();
    expect(w.reload).toHaveBeenCalledOnce();
    w.stop();
    const nextPage = watcher();
    await nextPage.check();
    expect(nextPage.reload).not.toHaveBeenCalled();
  });
  it('preserves navigation once, only for the same account and organisation', () => {
    useGpuStore.setState({ view: 'runs', selectedProjectId: 'project', selectedRunId: 'run', sceneCameraMode: 'focus' });
    saveUpdateNavigation('principal:org');
    useGpuStore.setState({ view: 'projects', selectedProjectId: null, selectedRunId: null });
    restoreUpdateNavigation('other:org', ['runs', 'projects']);
    expect(useGpuStore.getState().selectedRunId).toBeNull();
    useGpuStore.setState({ view: 'runs', selectedProjectId: 'project', selectedRunId: 'run' });
    saveUpdateNavigation('principal:org');
    useGpuStore.setState({ view: 'projects', selectedProjectId: null, selectedRunId: null });
    restoreUpdateNavigation('principal:org', ['runs', 'projects']);
    expect(useGpuStore.getState()).toMatchObject({ view: 'runs', selectedProjectId: 'project', selectedRunId: 'run' });
    useGpuStore.setState({ view: 'projects' });
    restoreUpdateNavigation('principal:org', ['runs', 'projects']);
    expect(useGpuStore.getState().view).toBe('projects');
  });
  it('recognises CSS-only changes and protects autofilled fields', () => {
    const old = new DOMParser().parseFromString(shell('old'), 'text/html');
    const next = new DOMParser().parseFromString(shell('old').replace('index-old.css', 'index-new.css'), 'text/html');
    expect(pageBuild(old)).not.toBe(pageBuild(next));
    document.body.innerHTML = '<input value="autofilled">';
    expect(hasEditableWork(document)).toBe(true);
    document.body.innerHTML = '<section role="dialog" aria-modal="true"><iframe></iframe></section>';
    expect(hasEditableWork(document)).toBe(true);
  });
});

it('holds mutation protection until the response body is consumed, including errors', async () => {
  let finish!: (value: unknown) => void;
  const response = new Response('{}');
  vi.spyOn(response, 'json').mockImplementation(() => new Promise((done) => { finish = done; }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const operation = api.createApiToken('test');
  await vi.advanceTimersByTimeAsync(0);
  expect(pendingApiMutations()).toBe(1);
  finish({ token: 'once' });
  await operation;
  expect(pendingApiMutations()).toBe(0);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('failed')));
  await expect(api.revokeApiToken('test')).rejects.toThrow('failed');
  expect(pendingApiMutations()).toBe(0);
});
