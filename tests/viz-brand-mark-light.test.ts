import { describe, expect, it } from 'vitest';
import {
  ATOMA_MARK_CORE_LIGHT_RADIUS,
  ATOMA_MARK_CORE_SPEED_U,
  ATOMA_MARK_CORE_SPEED_V,
  buildAtomaMarkFrame,
  coreLightFalloff,
} from '../src/viz/client-gl/brand-mark.js';

describe('coreLightFalloff', () => {
  it('is full at the source and nothing past its reach', () => {
    expect(coreLightFalloff(0)).toBe(1);
    expect(coreLightFalloff(ATOMA_MARK_CORE_LIGHT_RADIUS)).toBe(0);
    expect(coreLightFalloff(ATOMA_MARK_CORE_LIGHT_RADIUS + 5)).toBe(0);
  });

  it('decreases monotonically, so the light has no bright ring', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let d = 0; d <= ATOMA_MARK_CORE_LIGHT_RADIUS; d += 0.25) {
      const value = coreLightFalloff(d);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it('eases at both ends rather than falling off linearly', () => {
    // Smoothstep: the midpoint is 0.5, but the quarter points are pulled in.
    expect(coreLightFalloff(ATOMA_MARK_CORE_LIGHT_RADIUS / 2)).toBeCloseTo(0.5, 5);
    expect(coreLightFalloff(ATOMA_MARK_CORE_LIGHT_RADIUS * 0.25)).toBeGreaterThan(0.75);
    expect(coreLightFalloff(ATOMA_MARK_CORE_LIGHT_RADIUS * 0.75)).toBeLessThan(0.25);
  });

  it('never returns a value a fill alpha could not use', () => {
    for (const d of [-1, 0, 1, 4, 9.4, 100, Number.NaN]) {
      const value = coreLightFalloff(d);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('core bead motion', () => {
  it('runs on incommensurate frequencies, so the path does not loop quickly', () => {
    const ratio = ATOMA_MARK_CORE_SPEED_U / ATOMA_MARK_CORE_SPEED_V;
    expect(Number.isInteger(ratio)).toBe(false);
    expect(Number.isInteger(1 / ratio)).toBe(false);
  });

  it('moves further per second than the previous rate', () => {
    // The ask was "faster"; this pins it against a silent revert to 0.52/0.37.
    expect(ATOMA_MARK_CORE_SPEED_U).toBeGreaterThan(0.52);
    expect(ATOMA_MARK_CORE_SPEED_V).toBeGreaterThan(0.37);
  });

  it('keeps the bead inside the crystal at every sampled moment', () => {
    // Faster motion must not let the bead escape the hull it reflects off.
    for (let ms = 0; ms < 20_000; ms += 97) {
      const frame = buildAtomaMarkFrame(ms);
      const dx = frame.corePosition.x - 14;
      const dy = frame.corePosition.y - 14;
      expect(Math.hypot(dx, dy), `at ${ms}ms`).toBeLessThan(12);
    }
  });
});
