// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewPlane } from '../src/viz/client-gl/PreviewPlane.js';
import { DomBridge } from '../src/viz/client-gl/DomBridge.js';
import { useGpuStore } from '../src/viz/client-gl/store.js';
import { translate } from '../src/viz/client/i18n-catalog.js';
import type { VizPreviewSummary } from '../src/viz/client/types.js';

/**
 * THE PREVIEW SURFACE, from the member's side.
 *
 * Everything asserted here is something a member can see or reach, and every
 * one of them is a boundary rather than a preference:
 *
 * - the iframe exists ONLY in `ready`, so a starting generation cannot render
 *   the gateway's 404 as the first thing a member sees of their own result;
 * - the sandbox and the referrer policy are the parent document's half of the
 *   bound, independent of the headers the gateway sets on the response;
 * - a mid-run snapshot SAYS it is a mid-run snapshot, with its moment;
 * - the host chrome is outside the frame, so generated code cannot cover the
 *   control that leaves it.
 *
 * The keyboard mirror is asserted through the SAME activation ids the canvas
 * dispatches, per the canvas-control rule in src/viz/AGENTS.md: a mirror that
 * called its own callback would pass while the canvas path was broken.
 */

const t = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);

function summary(overrides: Partial<VizPreviewSummary> = {}): VizPreviewSummary {
  return {
    availability: 'available',
    kind: 'node',
    reason: null,
    state: 'ready',
    generation: 3,
    source: 'delivered',
    snapshotAt: null,
    readyAt: '2026-09-02T14:00:00.000Z',
    expiresAt: null,
    errorCode: null,
    requestedHosts: [],
    allowedHosts: [],
    blockedHosts: [],
    ...overrides,
  };
}

function plane(props: Partial<Parameters<typeof PreviewPlane>[0]> = {}) {
  return createElement(PreviewPlane, {
    open: true,
    summary: summary(),
    url: 'https://p1.previews.example.net/#claim-secret',
    reloadNonce: 0,
    projectName: 'Atlas',
    goal: 'build a landing page',
    status: 'idle',
    errorMessage: null,
    t,
    locale: 'en',
    onClose: vi.fn(),
    onReload: vi.fn(),
    onRestart: vi.fn(),
    onStop: vi.fn(),
    ...props,
  });
}

afterEach(() => {
  cleanup();
});

describe('the preview plane', () => {
  it('mounts no iframe until the preview is ready', () => {
    const { container } = render(plane({ summary: summary({ state: 'starting' }) }));

    expect(container.querySelector('iframe')).toBeNull();
    // The member is still told what is happening — an empty stage would read
    // as a preview that opened and showed nothing.
    expect(screen.getAllByText(t('preview.status.starting')).length).toBeGreaterThan(0);
  });

  it('mounts no iframe when the state is ready but no claim is in hand', () => {
    // `ready` with no URL is what a second tab sees while another caller holds
    // the generation. A frame pointed at nothing is worse than a status line.
    const { container } = render(plane({ url: null }));

    expect(container.querySelector('iframe')).toBeNull();
  });

  it('frames the ready preview under the parent document’s own bound', () => {
    const { container } = render(plane());
    const frame = container.querySelector('iframe');

    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('src')).toBe('https://p1.previews.example.net/#claim-secret');
    expect(frame!.getAttribute('referrerpolicy')).toBe('no-referrer');
    const sandbox = frame!.getAttribute('sandbox') ?? '';
    expect(sandbox.split(/\s+/)).toContain('allow-scripts');
    expect(sandbox.split(/\s+/)).toContain('allow-downloads');
    // Granted deliberately: the preview is already isolated by its own
    // registrable domain, and an opaque origin would make the gateway's
    // `default-src 'self'` match nothing.
    expect(sandbox.split(/\s+/)).toContain('allow-same-origin');
    // NEVER: generated code opening windows over the member's browser.
    expect(sandbox).not.toContain('allow-popups');
    expect(sandbox).not.toContain('allow-top-navigation');
  });

  it('reloads to the origin root, because the claim in the URL is spent', () => {
    // Re-navigating to the one-time claim would land on the gateway's "this
    // link has already been used" page — a reload button that breaks the
    // thing it reloads.
    const { container } = render(plane({ reloadNonce: 1 }));

    expect(container.querySelector('iframe')!.getAttribute('src')).toBe(
      'https://p1.previews.example.net/'
    );
  });

  it('gives a restart a new frame rather than navigating the old one', () => {
    const { container, rerender } = render(plane());
    const first = container.querySelector('iframe');

    rerender(plane({ summary: summary({ generation: 4 }) }));

    // A new generation is a new ORIGIN. Reusing the element would carry the
    // previous origin's session history into it.
    expect(container.querySelector('iframe')).not.toBe(first);
  });

  it('says a mid-run snapshot is a mid-run snapshot, with its moment', () => {
    render(
      plane({
        summary: summary({ source: 'in-flight', snapshotAt: '2026-09-02T14:32:00.000Z' }),
      })
    );

    // A surface that cannot say "state at 14:32" lets a member read a
    // half-built app as the finished result.
    const provenance = screen.getByText(/snapshot taken at/i);
    expect(provenance).toBeInTheDocument();
    expect(provenance.textContent).toMatch(/\d/);
  });

  it('keeps every control outside the frame, where generated content cannot reach', () => {
    const { container } = render(plane());
    const frame = container.querySelector('iframe')!;

    for (const label of [t('preview.back'), t('preview.reload'), t('preview.restart'), t('preview.stop')]) {
      const control = screen.getByRole('button', { name: label });
      expect(frame.contains(control)).toBe(false);
    }
    // And the warning is ours too, not something the app can restyle away.
    expect(screen.getByText(t('preview.untrusted'))).toBeInTheDocument();
  });

  it('announces state changes politely instead of moving focus', () => {
    const { container } = render(plane());
    const live = container.querySelector('[aria-live="polite"]');

    expect(live).not.toBeNull();
    expect(live!.textContent).toContain(t('preview.status.ready'));
  });

  it('closes from the backdrop without closing when the modal is clicked', async () => {
    const onClose = vi.fn();
    const { container } = render(plane({ onClose }));
    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(container.querySelector('.gpu-preview-backdrop')!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('takes focus on entry and leaves on Escape', async () => {
    const onClose = vi.fn();
    render(plane({ onClose }));

    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('preview.back') }));

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('says so when the frame has loaded nothing at all', async () => {
    // THE FRAME IS CROSS-ORIGIN: `onError` effectively never fires and
    // `onLoad` fires even for the browser's own error page, so a timer that
    // expires with no load is the only thing this document can observe. Before
    // it, a failed DNS lookup or an untrusted certificate left the chrome
    // cheerfully reporting "ready" over a blank rectangle.
    vi.useFakeTimers();
    try {
      render(plane());
      expect(screen.queryByText(/Nothing has loaded yet/i)).toBeNull();
      act(() => {
        vi.advanceTimersByTime(11_000);
      });
      expect(screen.getByText(/Nothing has loaded yet/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays quiet once the frame reports a load', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(plane());
      act(() => {
        container.querySelector('iframe')!.dispatchEvent(new Event('load'));
      });
      act(() => {
        vi.advanceTimersByTime(11_000);
      });
      expect(screen.queryByText(/Nothing has loaded yet/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders nothing at all when closed', () => {
    const { container } = render(plane({ open: false }));

    expect(container.firstChild).toBeNull();
  });
});

describe('the preview control mirrored for the keyboard', () => {
  function bridge(preview: { state: string; availability: string } | null, onActivate: (id: string) => void) {
    return createElement(DomBridge, {
      runs: [],
      releaseVersion: 'test',
      views: ['runs'],
      t,
      onSelectRun: vi.fn(),
      preview,
      onActivate,
    });
  }

  it('dispatches the SAME activation ids the canvas control does', async () => {
    useGpuStore.setState({ entered: true, view: 'runs' });
    const onActivate = vi.fn();
    render(bridge({ state: 'ready', availability: 'available' }, onActivate));

    await userEvent.click(screen.getByRole('button', { name: t('preview.open') }));
    expect(onActivate).toHaveBeenCalledWith('run.preview.open');

    await userEvent.click(screen.getByRole('button', { name: t('preview.stop') }));
    expect(onActivate).toHaveBeenCalledWith('run.preview.stop');
  });

  it('offers nothing for a run this deployment cannot preview', () => {
    useGpuStore.setState({ entered: true, view: 'runs' });
    render(bridge({ state: 'stopped', availability: 'unavailable' }, vi.fn()));

    // A control that fails after the click is worse than a stated absence.
    expect(screen.queryByRole('button', { name: t('preview.start') })).toBeNull();
  });
});
