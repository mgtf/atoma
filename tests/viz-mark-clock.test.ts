import { afterEach, describe, expect, it } from 'vitest';
import {
  markClockIsPinned,
  markElapsedMs,
  pinMarkElapsedMs,
} from '../src/viz/client-gl/renderer/mark-clock.js';

describe('mark clock', () => {
  afterEach(() => {
    pinMarkElapsedMs(null);
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
});
