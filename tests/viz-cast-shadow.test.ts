import { describe, expect, it } from 'vitest';
import {
  ambientShadowOffset,
  CAST_SHADOW_REACH_PX,
  castShadowOffset,
} from '../src/viz/client-gl/renderer/cast-shadow.js';
import { POINTER_LIGHT_RADIUS_PX } from '../src/viz/client-gl/pointer-light.js';

const SURFACE = { left: 400, top: 400, width: 100, height: 60 };

function cast(overrides: Partial<Parameters<typeof castShadowOffset>[0]>) {
  return castShadowOffset({
    ...SURFACE,
    lightX: 0,
    lightY: 0,
    strength: 1,
    ...overrides,
  });
}

describe('pointer-cast shadows', () => {
  it('rests on the ambient offset when the pointer light is absent', () => {
    const rest = ambientShadowOffset();
    expect(cast({ strength: 0, lightX: 450, lightY: 430 })).toEqual(rest);
    // A negative or overshooting strength is clamped, never inverted.
    expect(cast({ strength: -3, lightX: 450, lightY: 430 })).toEqual(rest);
  });

  it('scales the ambient offset with depth so stacked layers separate', () => {
    const near = ambientShadowOffset(0.5);
    const deep = ambientShadowOffset(1.5);
    expect(deep.x).toBeGreaterThan(near.x);
    expect(deep.y).toBeGreaterThan(near.y);
    expect(deep.y / deep.x).toBeCloseTo(near.y / near.x);
  });

  it('throws away from the light when the light sits on the surface', () => {
    // Light on the surface's left edge: the shadow must run right.
    const right = cast({ lightX: 400, lightY: 430 });
    expect(right.x).toBeGreaterThan(0);
    // Light on the right edge: it must run left, i.e. flip sign.
    const left = cast({ lightX: 500, lightY: 430 });
    expect(left.x).toBeLessThan(0);
  });

  it('measures reach to the nearest edge, not to the centre', () => {
    // A wide surface with the light resting ON it. Measured from the centre,
    // the light would read as 600px away — far outside its radius — and the
    // shadow would never move. This is the bug the edge measure fixes.
    const wide = {
      left: 0,
      top: 400,
      width: 1200,
      height: 60,
      lightX: 20,
      lightY: 430,
      strength: 1,
    };
    const offset = castShadowOffset(wide);
    const rest = ambientShadowOffset();
    expect(Math.abs(offset.x - rest.x)).toBeGreaterThan(5);
    expect(offset.x).toBeGreaterThan(0);
  });

  it('falls back to ambient once the surface is out of the light', () => {
    const far = cast({
      lightX: SURFACE.left - POINTER_LIGHT_RADIUS_PX * 4,
      lightY: SURFACE.top,
    });
    const rest = ambientShadowOffset();
    expect(far.x).toBeCloseTo(rest.x, 1);
    expect(far.y).toBeCloseTo(rest.y, 1);
  });

  it('never throws further than its reach', () => {
    for (const angle of [0, 0.7, 1.6, 2.4, 3.9, 5.2]) {
      const offset = cast({
        lightX: SURFACE.left + SURFACE.width / 2 + Math.cos(angle) * 30,
        lightY: SURFACE.top + SURFACE.height / 2 + Math.sin(angle) * 30,
      });
      const rest = ambientShadowOffset();
      const bound = CAST_SHADOW_REACH_PX + Math.hypot(rest.x, rest.y);
      expect(Math.hypot(offset.x, offset.y)).toBeLessThanOrEqual(bound);
    }
  });

  it('rests rather than dividing by zero when the light is at the centre', () => {
    const offset = cast({
      lightX: SURFACE.left + SURFACE.width / 2,
      lightY: SURFACE.top + SURFACE.height / 2,
    });
    expect(Number.isFinite(offset.x)).toBe(true);
    expect(Number.isFinite(offset.y)).toBe(true);
    expect(offset).toEqual(ambientShadowOffset());
  });
});
