import { afterEach, describe, expect, it } from 'vitest';
import {
  MARK_FIELD_LIGHT_MAX,
  clearMarkFieldLight,
  markColorToRgb,
  readMarkFieldLight,
  writeMarkFieldLight,
} from '../src/viz/client-gl/mark-field-light.js';

afterEach(() => {
  clearMarkFieldLight();
});

describe('mark field light sample', () => {
  it('keeps only the brightest windows, so the far shader has a fixed load', () => {
    writeMarkFieldLight(
      Array.from({ length: MARK_FIELD_LIGHT_MAX + 3 }, (_, index) => ({
        clientX: index * 0.1,
        clientY: 0.5,
        radiusPx: 40,
        r: 1,
        g: 0,
        b: 0,
        intensity: index,
      }))
    );
    const spills = readMarkFieldLight();
    expect(spills).toHaveLength(MARK_FIELD_LIGHT_MAX);
    expect(spills.map((spill) => spill.intensity)).toEqual(
      [MARK_FIELD_LIGHT_MAX + 2, MARK_FIELD_LIGHT_MAX + 1, MARK_FIELD_LIGHT_MAX, MARK_FIELD_LIGHT_MAX - 1]
        .map((value) => value)
    );
  });

  it('clears, so a hidden bead cannot leave a stain on the next view', () => {
    writeMarkFieldLight([{
      clientX: 0.5,
      clientY: 0.5,
      radiusPx: 80,
      r: 0.2,
      g: 0.8,
      b: 0.7,
      intensity: 1,
    }]);
    clearMarkFieldLight();
    expect(readMarkFieldLight()).toEqual([]);
  });

  it('stores the sample on globalThis so lazy chunks cannot hold an empty copy', () => {
    writeMarkFieldLight([{
      clientX: 12,
      clientY: 34,
      radiusPx: 80,
      r: 1,
      g: 0,
      b: 0,
      intensity: 1,
    }]);
    const shared = (globalThis as { __ATOMA_MARK_FIELD_LIGHT__?: { clientX: number }[] })
      .__ATOMA_MARK_FIELD_LIGHT__;
    expect(shared).toHaveLength(1);
    expect(shared?.[0]?.clientX).toBe(12);
    expect(readMarkFieldLight()[0]?.clientX).toBe(12);
  });

  it('splits a rank colour into 0..1 channels the backdrop shader can add', () => {
    expect(markColorToRgb(0xffffff)).toEqual({ r: 1, g: 1, b: 1 });
    expect(markColorToRgb(0x000000)).toEqual({ r: 0, g: 0, b: 0 });
    const teal = markColorToRgb(0x0f9f92);
    expect(teal.g).toBeGreaterThan(teal.r);
    expect(teal.g).toBeGreaterThan(teal.b);
  });
});
