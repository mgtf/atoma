// @vitest-environment jsdom

/**
 * The handheld gate (2026-09-18): a phone or tablet meets the hero crystal
 * and ONE Continue, never the product. Pressed, the control re-labels and
 * disables, the bead surges and a white flood closes the whole interface.
 * These tests drive the predicate, the store, the white-out hook with its
 * DOM veil, the DOM mirror of the gate, and the surge sample the mark reads.
 */

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '../src/viz/client/i18n-catalog.js';
import { DomBridge } from '../src/viz/client-gl/DomBridge.js';
import {
  handheldMediaQuery,
  handheldQueryOverride,
  isHandheldDevice,
  setHandheldOverrideForTests,
} from '../src/viz/client-gl/handheld.js';
import {
  HANDHELD_FLOOD_DIAGONALS,
  HANDHELD_FLOOD_SOLID,
  HANDHELD_WHITEOUT_MS,
  handheldFloodCentre,
  handheldWhiteoutSample,
  useHandheldWhiteout,
} from '../src/viz/client-gl/handheld-whiteout.js';
import { HandheldVeilLayer } from '../src/viz/client-gl/HandheldVeilLayer.js';
import {
  MARK_SURGE,
  markCoreSurge,
  markSurgeGain,
  readMarkCoreScreen,
  setMarkCoreSurge,
  writeMarkCoreScreen,
} from '../src/viz/client-gl/renderer/mark-surge.js';
import { setReducedMotionOverrideForTests } from '../src/viz/client-gl/renderer/motion.js';
import { useGpuStore } from '../src/viz/client-gl/store.js';

const t = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);
const HANDHELD_QUERY = '(any-pointer: coarse) and (any-hover: none)';

function fakeMediaQuery(matches: boolean) {
  return {
    matches,
    media: HANDHELD_QUERY,
    addEventListener() {},
    removeEventListener() {},
  };
}

describe('isHandheldDevice', () => {
  afterEach(() => {
    setHandheldOverrideForTests(null);
    vi.unstubAllGlobals();
  });

  it('asks ONE pointer-capability media query, never a viewport width', () => {
    const asked: string[] = [];
    vi.stubGlobal('matchMedia', (query: string) => {
      asked.push(query);
      return fakeMediaQuery(true);
    });
    setHandheldOverrideForTests(null);
    expect(isHandheldDevice()).toBe(true);
    expect(isHandheldDevice()).toBe(true);
    // Cached after the first read: repeated calls are cheap.
    expect(asked).toEqual([HANDHELD_QUERY]);
    expect(handheldMediaQuery()?.matches).toBe(true);
  });

  it('is false where the query does not match, and where matchMedia is absent', () => {
    vi.stubGlobal('matchMedia', () => fakeMediaQuery(false));
    setHandheldOverrideForTests(null);
    expect(isHandheldDevice()).toBe(false);
    setHandheldOverrideForTests(null);
    vi.stubGlobal('matchMedia', undefined);
    expect(isHandheldDevice()).toBe(false);
    expect(handheldMediaQuery()).toBeNull();
  });

  it('lets ?atomaHandheld=1 rehearse the gate on a desktop', () => {
    expect(handheldQueryOverride('?atomaHandheld=1')).toBe(true);
    expect(handheldQueryOverride('?lang=fr&atomaHandheld=true')).toBe(true);
    expect(handheldQueryOverride('?atomaHandheld=0')).toBe(false);
    expect(handheldQueryOverride('?atomaHandheld=')).toBe(false);
    expect(handheldQueryOverride('')).toBe(false);
  });

  it('honours the test override in both directions', () => {
    vi.stubGlobal('matchMedia', () => fakeMediaQuery(true));
    setHandheldOverrideForTests(false);
    expect(isHandheldDevice()).toBe(false);
    setHandheldOverrideForTests(true);
    expect(isHandheldDevice()).toBe(true);
  });
});

describe('the store on a handheld device', () => {
  beforeEach(() => {
    useGpuStore.setState({ entered: false, handheld: true, handheldBlocked: false });
  });

  afterEach(() => {
    useGpuStore.setState({ handheld: false, handheldBlocked: false, entered: false });
    vi.unstubAllGlobals();
  });

  it('enter() refuses, flips the blocked flag and persists nothing', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    useGpuStore.getState().enter();
    expect(useGpuStore.getState()).toMatchObject({ entered: false, handheldBlocked: true });
    expect(values.has('atoma.viz.entered')).toBe(false);
    // Pressing again is idempotent: still blocked, still outside.
    useGpuStore.getState().enter();
    expect(useGpuStore.getState()).toMatchObject({ entered: false, handheldBlocked: true });
  });

  it('blockHandheld() is the same transition without the admission attempt', () => {
    useGpuStore.getState().blockHandheld();
    expect(useGpuStore.getState()).toMatchObject({ entered: false, handheldBlocked: true });
  });

  it('a media-query flip to handheld throws the visitor back behind the gate', () => {
    useGpuStore.setState({ entered: true, handheld: false });
    useGpuStore.getState().setHandheld(true);
    expect(useGpuStore.getState()).toMatchObject({ entered: false, handheld: true });
    useGpuStore.getState().setHandheld(false);
    expect(useGpuStore.getState().handheld).toBe(false);
    // Leaving the handheld class does not admit anyone by itself.
    expect(useGpuStore.getState().entered).toBe(false);
  });

  it('starts behind the gate on a handheld device even when the arrival bit is persisted', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'atoma.viz.entered' ? '1' : null),
      setItem() {},
    });
    vi.resetModules();
    const handheld = await import('../src/viz/client-gl/handheld.js');
    handheld.setHandheldOverrideForTests(true);
    try {
      const fresh = await import('../src/viz/client-gl/store.js');
      expect(fresh.useGpuStore.getState()).toMatchObject({
        handheld: true,
        entered: false,
        handheldBlocked: false,
      });
    } finally {
      handheld.setHandheldOverrideForTests(null);
      vi.resetModules();
    }
  });

  it('still honours the persisted arrival bit on a desktop', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'atoma.viz.entered' ? '1' : null),
      setItem() {},
    });
    vi.resetModules();
    const handheld = await import('../src/viz/client-gl/handheld.js');
    handheld.setHandheldOverrideForTests(false);
    try {
      const fresh = await import('../src/viz/client-gl/store.js');
      expect(fresh.useGpuStore.getState()).toMatchObject({ handheld: false, entered: true });
    } finally {
      handheld.setHandheldOverrideForTests(null);
      vi.resetModules();
    }
  });
});

describe('the handheld white-out', () => {
  let frames: Array<(now: number) => void>;
  const pump = (now: number) => {
    const pending = frames.splice(0);
    for (const callback of pending) callback(now);
  };

  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    useGpuStore.setState({ entered: false, handheld: true, handheldBlocked: false });
    setReducedMotionOverrideForTests(false);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setReducedMotionOverrideForTests(null);
    setMarkCoreSurge(0);
    writeMarkCoreScreen(null);
    useGpuStore.setState({ handheld: false, handheldBlocked: false, entered: false });
  });

  function Probe() {
    const { phase, begin, floodRef } = useHandheldWhiteout();
    return createElement(
      'div',
      null,
      createElement('button', { onClick: () => { begin(); } }, 'go'),
      createElement(HandheldVeilLayer, { phase, floodRef, notice: t('welcome.handheld.hint') }),
      createElement('span', { 'data-testid': 'phase' }, phase)
    );
  }

  it('leads with the bead, trails with the flood, and ends uniformly white', () => {
    expect(handheldWhiteoutSample(0)).toEqual({ surge: 0, flood: 0, alpha: 0 });
    const early = handheldWhiteoutSample(0.3);
    expect(early.surge).toBeGreaterThan(early.flood);
    expect(early.alpha).toBeGreaterThan(early.flood);
    const late = handheldWhiteoutSample(0.8);
    expect(late.alpha).toBe(1);
    expect(late.flood).toBeLessThan(1);
    expect(handheldWhiteoutSample(1)).toEqual({ surge: 1, flood: 1, alpha: 1 });
    expect(handheldWhiteoutSample(2)).toEqual({ surge: 1, flood: 1, alpha: 1 });
    expect(handheldWhiteoutSample(-1)).toEqual({ surge: 0, flood: 0, alpha: 0 });
    // The solid white stop, at full scale, reaches the farthest viewport corner
    // (at most one diagonal from any bead position) with margin.
    expect(HANDHELD_FLOOD_DIAGONALS * HANDHELD_FLOOD_SOLID).toBeGreaterThan(1.2);
    expect(HANDHELD_WHITEOUT_MS).toBeGreaterThanOrEqual(2_000);
    expect(HANDHELD_WHITEOUT_MS).toBeLessThanOrEqual(4_000);
  });

  it('blocks the gate at once, drives the surge and the flood, then goes white', () => {
    render(createElement(Probe));
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.querySelector('.gpu-handheld-veil')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(useGpuStore.getState()).toMatchObject({ handheldBlocked: true, entered: false });
    expect(screen.getByTestId('phase')).toHaveTextContent('flare');
    expect(document.querySelector('.gpu-handheld-veil')?.getAttribute('data-phase')).toBe('flare');
    expect(frames).toHaveLength(1);

    act(() => pump(1_000));
    expect(markCoreSurge()).toBe(0);
    act(() => pump(1_000 + HANDHELD_WHITEOUT_MS / 2));
    const half = markCoreSurge();
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
    const flood = document.querySelector<HTMLElement>('.gpu-handheld-veil__flood');
    expect(flood).not.toBeNull();
    expect(flood!.style.transform).toMatch(/translate3d\(.+\) scale\(0\.\d+\)/);
    expect(Number(flood!.style.opacity)).toBeGreaterThan(0);
    const side = Math.hypot(window.innerWidth, window.innerHeight) * HANDHELD_FLOOD_DIAGONALS;
    expect(flood!.style.width).toBe(`${side}px`);
    expect(screen.getByTestId('phase')).toHaveTextContent('flare');

    act(() => pump(1_000 + HANDHELD_WHITEOUT_MS + 1));
    expect(markCoreSurge()).toBe(1);
    expect(screen.getByTestId('phase')).toHaveTextContent('white');
    expect(document.querySelector('.gpu-handheld-veil')?.getAttribute('data-phase')).toBe('white');
    expect(screen.getByRole('status')).toHaveTextContent(t('welcome.handheld.hint'));
    // The loop ended with the flare: nothing is left scheduled.
    expect(frames).toHaveLength(0);
  });

  it('centres the flood on the bead the mark published, else on the viewport', () => {
    writeMarkCoreScreen(null);
    expect(handheldFloodCentre(390, 844)).toEqual({ x: 195, y: 422 });
    writeMarkCoreScreen({ clientX: 180, clientY: 400, radiusPx: 12 });
    expect(handheldFloodCentre(390, 844)).toEqual({ x: 180, y: 400 });
    writeMarkCoreScreen({ clientX: Number.NaN, clientY: 400, radiusPx: 12 });
    expect(handheldFloodCentre(390, 844)).toEqual({ x: 195, y: 422 });
  });

  it('jumps straight to white under reduced motion', () => {
    setReducedMotionOverrideForTests(true);
    render(createElement(Probe));
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(useGpuStore.getState().handheldBlocked).toBe(true);
    expect(screen.getByTestId('phase')).toHaveTextContent('white');
    expect(markCoreSurge()).toBe(1);
    expect(frames).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent(t('welcome.handheld.hint'));
  });

  it('takes a second press without restarting the flare', () => {
    render(createElement(Probe));
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    act(() => pump(1_000));
    act(() => pump(1_000 + HANDHELD_WHITEOUT_MS / 2));
    const before = markCoreSurge();
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(markCoreSurge()).toBe(before);
    expect(frames).toHaveLength(1);
  });

  it('declines on a desktop so the ordinary arrival runs', () => {
    useGpuStore.setState({ handheld: false });
    let took: boolean | null = null;
    function Desktop() {
      const { begin } = useHandheldWhiteout();
      return createElement('button', { onClick: () => { took = begin(); } }, 'go');
    }
    render(createElement(Desktop));
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(took).toBe(false);
    expect(useGpuStore.getState().handheldBlocked).toBe(false);
    expect(markCoreSurge()).toBe(0);
    expect(frames).toHaveLength(0);
  });

  it('resets the surge when the surface unmounts mid-flare', () => {
    const view = render(createElement(Probe));
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    act(() => pump(10));
    act(() => pump(10 + HANDHELD_WHITEOUT_MS / 2));
    expect(markCoreSurge()).toBeGreaterThan(0);
    view.unmount();
    expect(markCoreSurge()).toBe(0);
  });
});

describe('the DOM mirror of the handheld gate', () => {
  beforeEach(() => {
    useGpuStore.setState({ entered: false, handheld: true, handheldBlocked: false, locale: 'en' });
  });

  afterEach(() => {
    cleanup();
    useGpuStore.setState({ handheld: false, handheldBlocked: false, entered: false });
  });

  function renderGate(onEnter = vi.fn()) {
    render(
      createElement(DomBridge, {
        runs: [],
        releaseVersion: '9.8.7',
        t,
        onSelectRun: vi.fn(),
        onEnter,
        // The auth gate is ON: a desktop would see this provider anchor.
        loginLinks: [{ id: 'github', label: 'GitHub', href: '/auth/login?provider=github' }],
      })
    );
    return onEnter;
  }

  it('offers one Continue button and no provider anchor, even when the gate is a login', () => {
    const onEnter = renderGate();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button).toBeEnabled();
    expect(screen.getByText('v9.8.7')).toBeInTheDocument();
    fireEvent.click(button);
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('re-labels and disables once blocked, with the reason as plain copy', () => {
    useGpuStore.setState({ handheldBlocked: true });
    const onEnter = renderGate();
    const button = screen.getByRole('button', { name: t('welcome.handheld.blocked') });
    expect(button).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.getByText(t('welcome.handheld.hint'))).toBeInTheDocument();
    fireEvent.click(button);
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('falls back to the store when no arrival callback is wired, which blocks rather than enters', () => {
    render(
      createElement(DomBridge, {
        runs: [],
        releaseVersion: '9.8.7',
        t,
        onSelectRun: vi.fn(),
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(useGpuStore.getState()).toMatchObject({ entered: false, handheldBlocked: true });
    expect(screen.getByRole('button', { name: t('welcome.handheld.blocked') })).toBeDisabled();
  });
});

describe('the mark surge sample', () => {
  afterEach(() => {
    setMarkCoreSurge(0);
    writeMarkCoreScreen(null);
  });

  it('clamps to 0..1 and ignores a broken clock', () => {
    setMarkCoreSurge(0.4);
    expect(markCoreSurge()).toBe(0.4);
    setMarkCoreSurge(7);
    expect(markCoreSurge()).toBe(1);
    setMarkCoreSurge(-1);
    expect(markCoreSurge()).toBe(0);
    setMarkCoreSurge(0.5);
    setMarkCoreSurge(Number.NaN);
    expect(markCoreSurge()).toBe(0.5);
    setMarkCoreSurge(Number.POSITIVE_INFINITY);
    expect(markCoreSurge()).toBe(0.5);
  });

  it('is exactly 1 at rest for every lit part, so the resting mark is untouched', () => {
    for (const factor of Object.values(MARK_SURGE)) {
      expect(factor).toBeGreaterThan(0);
      expect(markSurgeGain(0, factor)).toBe(1);
      expect(markSurgeGain(1, factor)).toBe(1 + factor);
      expect(markSurgeGain(0.5, factor)).toBeCloseTo(1 + factor / 2, 10);
    }
    // Out-of-range surges are clamped, never amplified.
    expect(markSurgeGain(3, 2)).toBe(3);
    expect(markSurgeGain(-3, 2)).toBe(1);
  });

  it("publishes and clears the bead's screen position", () => {
    expect(readMarkCoreScreen()).toBeNull();
    writeMarkCoreScreen({ clientX: 1, clientY: 2, radiusPx: 3 });
    expect(readMarkCoreScreen()).toEqual({ clientX: 1, clientY: 2, radiusPx: 3 });
    writeMarkCoreScreen(null);
    expect(readMarkCoreScreen()).toBeNull();
  });
});
