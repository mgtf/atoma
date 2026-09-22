// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CubeTurnPlane } from '../src/viz/client-gl/CubeTurnPlane.js';
import { publishSceneCapture } from '../src/viz/client-gl/scene-capture.js';
import { setReducedMotionOverrideForTests } from '../src/viz/client-gl/renderer/motion.js';

/**
 * THE TURN, from the click that asks for it.
 *
 * Asserted on the DOM the browser actually composites, because that is the
 * whole mechanism: there is no Pixi geometry to inspect and no pose to read
 * back. The still is the one thing the driver cannot produce by itself, so the
 * cases that matter are the ones where it is absent — no renderer, a readback
 * the browser refused — and the turn must then decline rather than swing an
 * empty face across the screen.
 */

let clock = 0;
let nextFrame = 1;
const frames = new Map<number, FrameRequestCallback>();
let captures = 0;

function cube(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('.gpu-cube');
  if (!element) throw new Error('no cube');
  return element;
}

function face(container: HTMLElement, which: 'leaving' | 'arriving'): HTMLElement {
  const element = container.querySelector<HTMLElement>(`.gpu-cube__face--${which}`);
  if (!element) throw new Error(`no ${which} face`);
  return element;
}

function runFrames(count: number): void {
  for (let index = 0; index < count && frames.size > 0; index += 1) {
    clock += 16;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(clock);
  }
}

beforeEach(() => {
  clock = 0;
  nextFrame = 1;
  captures = 0;
  frames.clear();
  setReducedMotionOverrideForTests(false);
  publishSceneCapture(() => {
    captures += 1;
    return document.createElement('canvas');
  });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_440);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900);
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
  publishSceneCapture(null);
  setReducedMotionOverrideForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the cube turn plane', () => {
  const at = (key: string, rank: number, group = 'workspace') => ({
    mode: 'focus' as const,
    navigation: { key, rank, group },
    children: null,
  });

  it('turns the box when the rail routes somewhere else', () => {
    const view = render(createElement(CubeTurnPlane, at('runs', 1)));
    const box = cube(view.container);
    expect(box.dataset['cubeTurn']).toBe('idle');
    expect(frames.size).toBe(0);

    view.rerender(createElement(CubeTurnPlane, at('skills', 3)));
    expect(box.dataset['cubeTurn']).toBe('turning');
    expect(box.dataset['cubeTurnAxis']).toBe('y');
    // The face being left carries a still of the screen being left, and it is
    // taken ONCE — a second capture would be of the view already swapped in.
    expect(captures).toBe(1);
    expect(face(view.container, 'leaving').childElementCount).toBe(1);

    runFrames(6);
    const leaving = face(view.container, 'leaving');
    const arriving = face(view.container, 'arriving');
    expect(leaving.style.transform).toMatch(/rotateY\(-\d/);
    expect(arriving.style.transform).toMatch(/rotateY\(\d/);
    expect(box.dataset['cubeTurn']).toBe('turning');

    runFrames(200);
    expect(box.dataset['cubeTurn']).toBe('idle');
    expect(box.dataset['cubeTurnProgress']).toBe('1');
    // Settled means settled: no transform left on either face, and the still
    // released rather than held as a screen of pixels between routes.
    expect(leaving.style.transform).toBe('none');
    expect(arriving.style.transform).toBe('none');
    expect(leaving.childElementCount).toBe(0);
  });

  it('tips the box when the route leaves the rail group', () => {
    const view = render(createElement(CubeTurnPlane, at('runs', 1, 'workspace')));
    view.rerender(createElement(CubeTurnPlane, at('journal', 7, 'admin')));
    const box = cube(view.container);
    expect(box.dataset['cubeTurnAxis']).toBe('x');
    expect(face(view.container, 'leaving').style.transform).toMatch(/rotateX\(/);
  });

  it('turns the other way when the route climbs the rail', () => {
    const view = render(createElement(CubeTurnPlane, at('docs', 5)));
    view.rerender(createElement(CubeTurnPlane, at('runs', 1)));
    runFrames(4);
    expect(face(view.container, 'leaving').style.transform).toMatch(/rotateY\(\d/);
  });

  it('declines the turn when there is no still to put on the face', () => {
    publishSceneCapture(null);
    const view = render(createElement(CubeTurnPlane, at('runs', 1)));
    view.rerender(createElement(CubeTurnPlane, at('skills', 3)));
    expect(cube(view.container).dataset['cubeTurn']).toBe('idle');
    expect(frames.size).toBe(0);
    expect(face(view.container, 'leaving').childElementCount).toBe(0);
  });

  it('declines the turn for reduced motion, for a re-render, and from overview', () => {
    setReducedMotionOverrideForTests(true);
    const view = render(createElement(CubeTurnPlane, at('runs', 1)));
    view.rerender(createElement(CubeTurnPlane, at('skills', 3)));
    expect(cube(view.container).dataset['cubeTurn']).toBe('idle');
    expect(captures).toBe(0);

    setReducedMotionOverrideForTests(false);
    // A new object for the same destination is a re-render, never a route.
    view.rerender(createElement(CubeTurnPlane, at('skills', 3)));
    expect(cube(view.container).dataset['cubeTurn']).toBe('idle');
    expect(frames.size).toBe(0);

    // And arriving from the whole-scene overview is the camera's long move;
    // the box must not turn on top of it.
    view.rerender(createElement(CubeTurnPlane, {
      ...at('runs', 1),
      mode: 'overview' as const,
    }));
    view.rerender(createElement(CubeTurnPlane, at('registry', 2)));
    expect(cube(view.container).dataset['cubeTurn']).toBe('idle');
    expect(frames.size).toBe(0);
  });
});
