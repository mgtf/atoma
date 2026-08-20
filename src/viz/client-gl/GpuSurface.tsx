import { useEffect, useRef, useState } from 'react';
import type {
  GpuRenderer,
  GpuDataSnapshot,
} from './gpu-renderer.js';
import type { GpuRenderMetrics } from './renderer/metrics.js';
import { useGpuStore } from './store.js';

export function GpuSurface({
  data,
  releaseVersion,
  t,
  onActivate,
  onMetrics,
}: {
  data: GpuDataSnapshot;
  releaseVersion: string;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onActivate: (id: string) => void;
  onMetrics: (metrics: GpuRenderMetrics) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<GpuRenderer | null>(null);
  const [ready, setReady] = useState(false);
  const [resizeVersion, setResizeVersion] = useState(0);
  const renderCount = useRef(0);
  const state = useGpuStore();

  useEffect(() => {
    if (!host.current) return;
    const currentHost = host.current;
    let next: GpuRenderer | null = null;
    let cancelled = false;
    void import('./gpu-renderer.js')
      .then(async ({ GpuRenderer: Renderer }) => {
        if (cancelled) return;
        const created = new Renderer();
        next = created;
        renderer.current = created;
        await created.init(currentHost);
        if (cancelled) created.destroy();
        else setReady(true);
      })
      .catch((error: unknown) => {
        console.error('[viz:gpu] renderer initialization failed', error);
      });
    const observer = new ResizeObserver(() => setResizeVersion((value) => value + 1));
    observer.observe(currentHost);
    return () => {
      cancelled = true;
      observer.disconnect();
      renderer.current = null;
      next?.destroy();
    };
  }, []);

  useEffect(() => {
    const current = renderer.current;
    if (!current || !ready) return;
    current.render({
      state,
      data,
      releaseVersion,
      t,
      onActivate,
      onScroll: (view, delta) => {
        const currentY = useGpuStore.getState().scrollY[view];
        useGpuStore.getState().setScrollY(view, currentY + delta);
      },
      onRunPickerScroll: (delta) => {
        const store = useGpuStore.getState();
        store.setRunPickerScrollY(store.runPickerScrollY + delta);
      },
    });
    const metrics = current.getMetrics();
    if (host.current) {
      host.current.dataset['gpuBackend'] = metrics.backend;
      host.current.dataset['gpuObjects'] = String(metrics.objectCount);
      // Rebuild cost and label retention, published for the smoke. Written on
      // every render rather than sampled, because the interesting renders are
      // the ones a wheel tick provokes — there is nothing to poll between them.
      host.current.dataset['gpuRenderMs'] = metrics.renderMs.toFixed(3);
      host.current.dataset['gpuLabelsCreated'] = String(metrics.labelsCreated);
      host.current.dataset['gpuLabelsReused'] = String(metrics.labelsReused);
      // A monotonic rebuild count. The tuning smoke needs to prove a rebuild
      // actually happened MID-DRAG — without it, "the value still changed"
      // would pass on a page that never re-rendered at all.
      renderCount.current += 1;
      host.current.dataset['gpuRenderCount'] = String(renderCount.current);
    }
    onMetrics(metrics);
  }, [data, onActivate, onMetrics, ready, releaseVersion, resizeVersion, state, t]);

  return <div ref={host} className="gpu-ui-host" />;
}
