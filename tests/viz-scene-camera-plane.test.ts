// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneCameraPlane } from '../src/viz/client-gl/SceneCameraPlane.js';
import { setReducedMotionOverrideForTests } from '../src/viz/client-gl/renderer/motion.js';
import { sceneCameraForMode } from '../src/viz/client-gl/scene-camera.js';

/**
 * THE CAMERA DRIVER.
 *
 * The camera moves for a MODE change and for nothing else: routing between two
 * sections is the cube's move, and the camera holds still through it so the
 * rail stays where the reader left it. Asserted on the PAINTED matrix, since
 * that one matrix is what the DOM overlays, the Pixi render transform and the
 * inverse hit tests all read — a test that only asked the pure pose functions
 * would pass while the driver never scheduled a frame.
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

function pane(container: HTMLElement): HTMLElement {
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
  const plane = (mode: 'overview' | 'focus') => ({ mode, children: null });

  it('travels the long approach when the mode changes, and lands exactly', () => {
    const settled = vi.fn();
    const view = render(createElement(SceneCameraPlane, { ...plane('overview'), onSettled: settled }));
    const element = pane(view.container);
    settle();
    expect(paintedScale(element)).toBeCloseTo(1, 9);
    const arrivals = settled.mock.calls.length;

    view.rerender(createElement(SceneCameraPlane, { ...plane('focus'), onSettled: settled }));
    expect(element.dataset['sceneCameraMotion']).toBe('moving');
    runFrames(6);
    const focus = sceneCameraForMode('focus', WIDTH, HEIGHT).sceneScale;
    const midway = paintedScale(element);
    expect(midway).toBeGreaterThan(1);
    expect(midway).toBeLessThan(focus);

    settle();
    expect(element.dataset['sceneCameraMotion']).toBe('settled');
    expect(element.dataset['sceneCameraProgress']).toBe('1');
    expect(paintedScale(element)).toBeCloseTo(focus, 9);
    expect(settled.mock.calls.length).toBeGreaterThan(arrivals);
  });

  it('holds still for anything that is not a mode change', () => {
    const view = render(createElement(SceneCameraPlane, plane('focus')));
    const element = pane(view.container);
    settle();
    const painted = paintedScale(element);
    // A re-render at the same mode schedules nothing: a route belongs to the
    // box, and a camera that moved for it would take the rail along.
    view.rerender(createElement(SceneCameraPlane, plane('focus')));
    expect(frames.size).toBe(0);
    expect(element.dataset['sceneCameraMotion']).toBe('settled');
    expect(paintedScale(element)).toBeCloseTo(painted, 12);
  });

  it('honours reduced motion by landing on the pose with no travel at all', () => {
    setReducedMotionOverrideForTests(true);
    const view = render(createElement(SceneCameraPlane, plane('overview')));
    const element = pane(view.container);
    view.rerender(createElement(SceneCameraPlane, plane('focus')));
    expect(frames.size).toBe(0);
    expect(element.dataset['sceneCameraMotion']).toBe('settled');
    expect(paintedScale(element)).toBeCloseTo(
      sceneCameraForMode('focus', WIDTH, HEIGHT).sceneScale,
      9
    );
  });
});
