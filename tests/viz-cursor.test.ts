// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtomaCursor } from '../src/viz/client-gl/AtomaCursor.js';
// FROM THE MODULE THAT OWNS THEM. `AtomaCursor.tsx` used to re-export these
// beside the component, which is the fast-refresh boundary 0d268a7 / aee4790 /
// 5e1b0ec establish for this subtree — a component file exports the component
// and nothing else. This test was the re-export's only consumer
// (2026-08-27, 3.15).
import {
  ATOMA_CURSOR_HOTSPOT,
  ATOMA_CURSOR_PATH,
  atomaCursorPoints,
} from '../src/viz/client-gl/pointer-cursor.js';
import {
  hidePointerLight,
  hideTrackedPointer,
  POINTER_LIGHT_RADIUS_PX,
  pointerClientToRenderer,
  pointerClientToUv,
  pointerLightFalloff,
  readPointerLight,
} from '../src/viz/client-gl/pointer-light.js';

class ControlledMediaQuery extends EventTarget {
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null = null;

  constructor(
    readonly media: string,
    public matches: boolean
  ) {
    super();
  }

  addListener(listener: (event: MediaQueryListEvent) => void) {
    this.addEventListener('change', listener as EventListener);
  }

  removeListener(listener: (event: MediaQueryListEvent) => void) {
    this.removeEventListener('change', listener as EventListener);
  }

  setMatches(matches: boolean) {
    this.matches = matches;
    this.dispatchEvent(new Event('change'));
  }
}

const media = new Map<string, ControlledMediaQuery>();
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

function query(name: string) {
  const found = media.get(name);
  if (!found) throw new Error(`missing media query ${name}`);
  return found;
}

function pointerMove(x: number, y: number, pointerType = 'mouse') {
  const event = new MouseEvent('pointermove', { clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  window.dispatchEvent(event);
}

function flushFrame() {
  const pending = [...frames.entries()];
  frames.clear();
  for (const [, callback] of pending) callback(performance.now());
}

beforeEach(() => {
  media.clear();
  media.set(
    '(any-hover: hover) and (any-pointer: fine)',
    new ControlledMediaQuery('(any-hover: hover) and (any-pointer: fine)', true)
  );
  media.set(
    '(prefers-reduced-motion: reduce)',
    new ControlledMediaQuery('(prefers-reduced-motion: reduce)', false)
  );
  media.set(
    '(forced-colors: active)',
    new ControlledMediaQuery('(forced-colors: active)', false)
  );
  frames.clear();
  nextFrame = 1;
  vi.stubGlobal('matchMedia', vi.fn((name: string) => query(name) as MediaQueryList));
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrame;
    nextFrame += 1;
    frames.set(id, callback);
    return id;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => {
    frames.delete(id);
  }));
});

afterEach(() => {
  cleanup();
  hidePointerLight();
  hideTrackedPointer();
  document.documentElement.classList.remove('atoma-cursor-active');
  vi.unstubAllGlobals();
});

describe('Atoma pointer light geometry', () => {
  it('maps one CSS pointer position into both GPU coordinate systems without DPR drift', () => {
    expect(pointerClientToUv(320, 180, 1_280, 720)).toEqual({ x: 0.25, y: 0.75 });
    expect(pointerClientToRenderer(
      260,
      170,
      { left: 100, top: 50, width: 640, height: 360 },
      1_280,
      720
    )).toEqual({ x: 320, y: 240 });
    // Anchored to the shared radius, not to a copy of it: the shaders now
    // interpolate the same constant, so retuning the light must not need a
    // number changed in two places to stay honest.
    expect(pointerLightFalloff(0)).toBe(1);
    expect(pointerLightFalloff(POINTER_LIGHT_RADIUS_PX)).toBeCloseTo(Math.exp(-2.2));
    expect(pointerLightFalloff(POINTER_LIGHT_RADIUS_PX * 2)).toBeLessThan(0.001);
  });
});

describe('Atoma 3D cursor', () => {
  it('coalesces pointer movement while keeping the light hotspot exact', () => {
    const { container } = render(createElement(AtomaCursor));
    const cursor = container.querySelector('.atoma-pointer-cursor');
    expect(cursor).toHaveAttribute('aria-hidden', 'true');
    expect(cursor).toHaveAttribute('data-enabled', 'true');
    expect(ATOMA_CURSOR_HOTSPOT).toEqual({ x: 12, y: 12 });
    expect(ATOMA_CURSOR_PATH).toMatch(/^M12 12/);

    pointerMove(120, 80);
    pointerMove(164, 96);
    expect(frames.size).toBe(1);
    expect(readPointerLight()).toMatchObject({ clientX: 164, clientY: 96, active: true });

    flushFrame();
    expect(cursor).toHaveAttribute('data-x', '164');
    expect(cursor).toHaveAttribute('data-y', '96');
    expect(cursor).toHaveAttribute('data-visible', 'true');
    expect(cursor).toHaveStyle({
      transform: 'translate3d(152px, 84px, 0) rotate(0deg)',
    });
    expect(document.documentElement).toHaveClass('atoma-cursor-active');
  });

  it('hides on blur and disables both cursor and light when preferences change', () => {
    const { container } = render(createElement(AtomaCursor));
    const cursor = container.querySelector('.atoma-pointer-cursor');
    pointerMove(90, 70);
    flushFrame();
    expect(readPointerLight().active).toBe(true);

    window.dispatchEvent(new Event('blur'));
    expect(cursor).toHaveAttribute('data-visible', 'false');
    expect(readPointerLight().active).toBe(false);
    expect(document.documentElement).not.toHaveClass('atoma-cursor-active');

    pointerMove(110, 75);
    flushFrame();
    query('(prefers-reduced-motion: reduce)').setMatches(true);
    expect(cursor).toHaveAttribute('data-enabled', 'false');
    expect(cursor).toHaveAttribute('data-visible', 'false');
    expect(readPointerLight().active).toBe(false);
  });

  it('keeps native pointer behavior for touch and coarse-only devices', () => {
    query('(any-hover: hover) and (any-pointer: fine)').matches = false;
    const { container } = render(createElement(AtomaCursor));
    const cursor = container.querySelector('.atoma-pointer-cursor');
    expect(cursor).toHaveAttribute('data-enabled', 'false');

    pointerMove(50, 40, 'touch');
    flushFrame();
    expect(cursor).toHaveAttribute('data-visible', 'false');
    expect(readPointerLight().active).toBe(false);
    expect(document.documentElement).not.toHaveClass('atoma-cursor-active');

    pointerMove(72, 56, 'mouse');
    expect(readPointerLight()).toMatchObject({
      clientX: 72,
      clientY: 56,
      trackingActive: true,
      active: false,
    });
  });

  it('parses the shared silhouette into the Pixi echo polygon', () => {
    const points = atomaCursorPoints();
    expect(points[0]).toEqual(ATOMA_CURSOR_HOTSPOT);
    expect(points).toHaveLength(7);
  });
});
