import { describe, expect, it } from 'vitest';
import {
  ATOMA_MARK_CORE_LIGHT_RADIUS,
  ATOMA_MARK_CORE_SPEED_U,
  ATOMA_MARK_CORE_SPEED_V,
  ATOMA_MARK_CORE_SPEED_W,
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
  it('runs its three axes on incommensurate frequencies, so the path does not loop quickly', () => {
    const speeds = [
      ATOMA_MARK_CORE_SPEED_U,
      ATOMA_MARK_CORE_SPEED_V,
      ATOMA_MARK_CORE_SPEED_W,
    ];
    for (const [index, speed] of speeds.entries()) {
      expect(speed).toBeGreaterThan(0);
      for (const other of speeds.slice(index + 1)) {
        const ratio = speed / other;
        expect(Number.isInteger(ratio)).toBe(false);
        expect(Number.isInteger(1 / ratio)).toBe(false);
      }
    }
  });

  it('moves continuously and only deforms while contacting a wall', () => {
    const frames = Array.from(
      { length: 3_001 },
      (_value, index) => buildAtomaMarkFrame(index * 10)
    );
    const steps = frames.slice(1).map((frame, index) => Math.hypot(
      frame.core3[0] - frames[index]!.core3[0],
      frame.core3[1] - frames[index]!.core3[1],
      frame.core3[2] - frames[index]!.core3[2]
    ));
    const impactSteps = frames.slice(1).map((frame, index) =>
      Math.abs(frame.coreImpact - frames[index]!.coreImpact));
    expect(Math.max(...steps)).toBeLessThan(0.015);
    expect(Math.max(...impactSteps)).toBeLessThan(0.08);
    expect(frames.some((frame) => frame.coreImpact > 0.35)).toBe(true);
    for (const frame of frames) {
      expect(frame.coreImpact).toBeGreaterThanOrEqual(0);
      expect(frame.coreImpact).toBeLessThanOrEqual(1);
      expect(frame.coreDeformation[0]).toBeCloseTo(1 - frame.coreImpact * 0.18, 12);
      expect(frame.coreDeformation[1]).toBeCloseTo(1 + frame.coreImpact * 0.11, 12);
    }
  });

  it('keeps the bead inside the crystal at every sampled moment', () => {
    // The bipyramid is THIN: its nearest wall sits about 4 projected units from
    // the centre, so a bead confined to the volume can never reach out to the
    // 12-unit hull the way one confined to the projected outline could.
    for (let ms = 0; ms < 20_000; ms += 97) {
      const frame = buildAtomaMarkFrame(ms);
      const dx = frame.corePosition.x - 14;
      const dy = frame.corePosition.y - 14;
      expect(Math.hypot(dx, dy), `at ${ms}ms`).toBeLessThan(8);
    }
  });

  it('lets gravity bias the long-term path toward the lower half', () => {
    const meanViewY = Array.from(
      { length: 6_001 },
      (_value, index) => buildAtomaMarkFrame(index * 10).core3[1]
    ).reduce((sum, y) => sum + y, 0) / 6_001;
    expect(meanViewY).toBeLessThan(-0.03);
  });
});
