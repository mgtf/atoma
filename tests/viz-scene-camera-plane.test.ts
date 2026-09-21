// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneCameraPlane } from '../src/viz/client-gl/SceneCameraPlane.js';
import { setReducedMotionOverrideForTests } from '../src/viz/client-gl/renderer/motion.js';
import {
  sceneCameraForMode,
  sceneCameraNavigationShot,
} from '../src/viz/client-gl/scene-camera.js';

/**
 * THE CAMERA DRIVER, from the click that moves it.
 *
 * Reaching another section from the rail while the camera is already focused
 * moved nothing: the content swapped under a static lens. What is asserted
 * here is the production path for that click — the same prop the app publishes
 * when `activateView` routes — and it is asserted on the PAINTED matrix, since
 * that one matrix is what the DOM overlays, the Pixi render transform and the
 * inverse hit tests all read. A test that only asked the pure pose functions
 * would have passed while the driver never scheduled a frame.
 */

const WIDTH = 1_440;
const HEIGHT = 900;

let clock = 0;
let nextFrame = 1;
const frames = new Map<number, FrameRequestCallback>();

/** The painted scene scale: `forward[0]` of a face-on pose is its scale. */
function paintedScale(plane: HTMLElement): number {
  const match = /^matrix3d\((.*)\)$/.exec(plane.style.transform);
  if (!match) throw new Error(`not a matrix3d: ${plane.style.transform}`);
  return Number(match[1]!.split(',')[0]);
}

function plane(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-scene-camera="perspective"]');
  if (!element) throw new Error('no camera plane');
  return element;
}

/** Runs the driver's own rAF chain forward, one 16ms frame at a time. */
function runFrames(count: number): void {
  for (let index = 0; index < count && frames.size > 0; index += 1) {
    clock += 16;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(clock);
  }
}

function settle(): void {
  runFrames(200);
}

beforeEach(() => {
  clock = 0;
  nextFrame = 1;
  frames.clear();
  setReducedMotionOverrideForTests(false);
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(WIDTH);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(HEIGHT);
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrame;
    nextFrame += 1;
    frames.set(id, callback);
    return id;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => {
    frames.delete(id);
  }));
  vi.stubGlobal('ResizeObserver', class {
    observe() { /* layout never changes in these cases */ }
    disconnect() { /* nothing observed */ }
  });
});

afterEach(() => {
  cleanup();
  setReducedMotionOverrideForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the scene camera plane', () => {
  const focused = (key: string, rank: number, onSettled?: () => void) => ({
    mode: 'focus' as const,
    navigation: { key, rank },
    onSettled,
    children: null,
  });

  it('plays a travelling shot when the rail routes to another section', () => {
    const settled = vi.fn();
    const view = render(createElement(
      SceneCameraPlane,
      focused('runs', 1, settled),
    ));
    const element = plane(view.container);
    settle();
    const focus = sceneCameraForMode('focus', WIDTH, HEIGHT).sceneScale;
    expect(paintedScale(element)).toBeCloseTo(focus, 9);
    const arrivals = settled.mock.calls.length;

    view.rerender(createElement(SceneCameraPlane, focused('skills', 3, settled)));
    expect(element.dataset['sceneCameraMotion']).toBe('moving');
    const startedAt = clock;

    // Departure: the camera eases back along its own axis, so more of the
    // scene is on screen than the focused crop shows.
    runFrames(8);
    const departure = paintedScale(element);
    expect(departure).toBeLessThan(focus);
    expect(element.dataset['sceneCameraMotion']).toBe('moving');

    // Landing: the approach carries a little past the pose it settles on.
    const shot = sceneCameraNavigationShot(2);
    let punch = departure;
    while (frames.size > 0 && clock - startedAt < shot.durationMs * 0.92) {
      runFrames(1);
      punch = Math.max(punch, paintedScale(element));
    }
    expect(punch).toBeGreaterThan(focus);

    settle();
    expect(element.dataset['sceneCameraMotion']).toBe('settled');
    expect(element.dataset['sceneCameraProgress']).toBe('1');
    expect(paintedScale(element)).toBeCloseTo(focus, 9);
    expect(settled.mock.calls.length).toBeGreaterThan(arrivals);
  });

  it('travels further for a longer jump down the rail', () => {
    const reveal = (fromRank: number, toRank: number) => {
      const view = render(createElement(
        SceneCameraPlane,
        focused('runs', fromRank)
      ));
      const element = plane(view.container);
      settle();
      view.rerender(createElement(SceneCameraPlane, focused('other', toRank)));
      let widest = Number.POSITIVE_INFINITY;
      while (frames.size > 0) {
        runFrames(1);
        widest = Math.min(widest, paintedScale(element));
      }
      cleanup();
      clock = 0;
      return widest;
    };
    // Neighbours get a beat; crossing the rail gets the whole move.
    expect(reveal(0, 5)).toBeLessThan(reveal(0, 1));
  });

  it('does not move for anything but a change of destination', () => {
    const settled = vi.fn();
    const view = render(createElement(
      SceneCameraPlane,
      focused('runs', 1, settled),
    ));
    const element = plane(view.container);
    settle();
    const painted = paintedScale(element);

    // A new object for the SAME destination is a re-render, not a route.
    view.rerender(createElement(SceneCameraPlane, focused('runs', 1, settled)));
    expect(frames.size).toBe(0);
    expect(element.dataset['sceneCameraMotion']).toBe('settled');
    expect(paintedScale(element)).toBeCloseTo(painted, 12);
  });

  it('honours reduced motion by landing on the pose with no shot at all', () => {
    setReducedMotionOverrideForTests(true);
    const view = render(createElement(SceneCameraPlane, focused('runs', 1)));
    const element = plane(view.container);
    const focus = sceneCameraForMode('focus', WIDTH, HEIGHT).sceneScale;
    expect(frames.size).toBe(0);
    expect(paintedScale(element)).toBeCloseTo(focus, 9);

    view.rerender(createElement(SceneCameraPlane, focused('skills', 4)));
    expect(frames.size).toBe(0);
    expect(element.dataset['sceneCameraMotion']).toBe('settled');
    expect(paintedScale(element)).toBeCloseTo(focus, 9);
  });

  it('keeps the long mode move for arrival and departure', () => {
    const view = render(createElement(
      SceneCameraPlane,
      { mode: 'overview' as const, navigation: { key: 'runs', rank: 1 }, children: null },
    ));
    const element = plane(view.container);
    settle();
    expect(paintedScale(element)).toBeCloseTo(1, 9);

    // Clicking a rail row from the overview changes BOTH the mode and the
    // destination; that click is the long approach, never a shot on top of it.
    view.rerender(createElement(
      SceneCameraPlane,
      { mode: 'focus' as const, navigation: { key: 'skills', rank: 3 }, children: null },
    ));
    let widest = Number.POSITIVE_INFINITY;
    while (frames.size > 0) {
      runFrames(1);
      widest = Math.min(widest, paintedScale(element));
    }
    expect(widest).toBeGreaterThanOrEqual(1);
    expect(paintedScale(element)).toBeCloseTo(
      sceneCameraForMode('focus', WIDTH, HEIGHT).sceneScale,
      9
    );
  });
});
