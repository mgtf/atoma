import { afterEach, describe, expect, it } from 'vitest';
import {
  markBeadVisible,
  markClockIsPinned,
  markElapsedMs,
  markTurnDegrees,
  pinMarkElapsedMs,
  pinMarkTurnDegrees,
  setMarkBeadVisible,
} from '../src/viz/client-gl/renderer/mark-clock.js';
import { ATOMA_MARK_TURN_MS } from '../src/viz/client-gl/brand-mark.js';

describe('mark clock', () => {
  afterEach(() => {
    pinMarkElapsedMs(null);
    setMarkBeadVisible(true);
  });

  it('follows the wall until pinned, then holds the pin', () => {
    expect(markClockIsPinned()).toBe(false);
    const live = markElapsedMs();
    expect(live).toBeGreaterThanOrEqual(0);

    pinMarkElapsedMs(1_250);
    expect(markClockIsPinned()).toBe(true);
    expect(markElapsedMs()).toBe(1_250);
    expect(markElapsedMs()).toBe(1_250);

    pinMarkElapsedMs(null);
    expect(markClockIsPinned()).toBe(false);
    expect(markElapsedMs()).toBeGreaterThanOrEqual(live);
  });

  it('rejects non-finite pins rather than freezing the crystal at NaN', () => {
    pinMarkElapsedMs(500);
    pinMarkElapsedMs(Number.NaN);
    expect(markClockIsPinned()).toBe(false);
    pinMarkElapsedMs(Number.POSITIVE_INFINITY);
    expect(markClockIsPinned()).toBe(false);
  });

  it('clamps a negative pin to the start of the turn', () => {
    pinMarkElapsedMs(-40);
    expect(markElapsedMs()).toBe(0);
  });

  it('pins by turn degrees and unwraps 360 to the rest pose', () => {
    pinMarkTurnDegrees(90);
    expect(markClockIsPinned()).toBe(true);
    expect(markElapsedMs()).toBeCloseTo(ATOMA_MARK_TURN_MS / 4, 5);
    expect(markTurnDegrees()).toBe(90);

    pinMarkTurnDegrees(360);
    expect(markElapsedMs()).toBeCloseTo(0, 5);
    expect(markTurnDegrees()).toBe(0);

    pinMarkTurnDegrees(null);
    expect(markClockIsPinned()).toBe(false);
    pinMarkTurnDegrees(Number.NaN);
    expect(markClockIsPinned()).toBe(false);
  });

  it('hides the bead only while the inspect flag is off', () => {
    expect(markBeadVisible()).toBe(true);
    setMarkBeadVisible(false);
    expect(markBeadVisible()).toBe(false);
    setMarkBeadVisible(true);
    expect(markBeadVisible()).toBe(true);
  });
});
