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
    // 30px probes sit below the ramp, where the clamp never engages; the
    // 100px probes force a raw offset of ~29px against a reach of 13, so this
    // test pins the clamp itself, not just distances that never needed it.
    for (const distance of [30, 100]) {
      for (const angle of [0, 0.7, 1.6, 2.4, 3.9, 5.2]) {
        const offset = cast({
          lightX: SURFACE.left + SURFACE.width / 2 + Math.cos(angle) * distance,
          lightY: SURFACE.top + SURFACE.height / 2 + Math.sin(angle) * distance,
        });
        const rest = ambientShadowOffset();
        const bound = CAST_SHADOW_REACH_PX + Math.hypot(rest.x, rest.y);
        expect(Math.hypot(offset.x, offset.y)).toBeLessThanOrEqual(bound);
      }
    }
  });

  it('lands directly underneath when the light is at the centre', () => {
    // This test used to assert the AMBIENT offset here, which is what the
    // divide-by-zero guard returned. That made a shadow JUMP sideways to its
    // resting position for the one pixel the pointer crossed the middle, and
    // it is not what a lamp held overhead does: it casts underneath itself.
    // The direction is undefined at the centre; the length is not, it is zero.
    const offset = cast({
      lightX: SURFACE.left + SURFACE.width / 2,
      lightY: SURFACE.top + SURFACE.height / 2,
    });
    expect(Number.isFinite(offset.x)).toBe(true);
    expect(Number.isFinite(offset.y)).toBe(true);
    expect(Math.hypot(offset.x, offset.y)).toBeLessThan(0.5);
  });

  it('slides the shadow out gradually as the light moves off centre', () => {
    // The reported defect: with the pointer parked mid-button the shadow was
    // already at full length on one side. Reach depended only on the DIRECTION
    // to the centre, so half a pixel off centre bought the whole offset.
    const cx = SURFACE.left + SURFACE.width / 2;
    const cy = SURFACE.top + SURFACE.height / 2;
    const lengths = [2, 8, 20, 40].map((d) => {
      const offset = cast({ lightX: cx - d, lightY: cy });
      return Math.hypot(offset.x, offset.y);
    });
    for (let i = 1; i < lengths.length; i += 1) {
      expect(lengths[i]!).toBeGreaterThan(lengths[i - 1]!);
    }
    // Near the centre it is a small fraction of full reach, not most of it.
    expect(lengths[0]!).toBeLessThan(CAST_SHADOW_REACH_PX * 0.25);
  });

  it('ramps on an absolute distance, not on how broad the surface is', () => {
    // This test used to assert the OPPOSITE — that a wide surface ramps more
    // slowly because the ramp was its own half-diagonal. That made the ramp
    // ~450px long for a control frame, so a pointer just below one had barely
    // started it and the downward ambient offset still won: the shadow fell
    // toward the light. A lit plate's shadow shifts with the light's lateral
    // distance and its own thickness; the plate's breadth does not enter into
    // it.
    const narrow = castShadowOffset({
      left: 0, top: 0, width: 80, height: 30,
      lightX: 40, lightY: 15 + 60, strength: 1,
    });
    const wide = castShadowOffset({
      left: 0, top: 0, width: 900, height: 30,
      lightX: 450, lightY: 15 + 60, strength: 1,
    });
    expect(Math.hypot(wide.x, wide.y)).toBeCloseTo(Math.hypot(narrow.x, narrow.y), 6);
  });

  it('throws a wide control frame UPWARD when the pointer sits below it', () => {
    // The reported defect, at the geometry that produced it: a 900px group
    // frame with the pointer just under its lower edge. The shadow must run
    // away from the light — up — and must not be dragged back down by the
    // ambient offset it is supposed to be overriding.
    const frame = { left: 0, top: 200, width: 900, height: 44 };
    for (const below of [10, 30, 60, 80]) {
      const offset = castShadowOffset({
        ...frame,
        lightX: frame.left + frame.width / 2,
        lightY: frame.top + frame.height + below,
        strength: 1,
        depth: 0.8,
      });
      // Substantially up, not merely non-positive: the broken model still
      // produced -0.6px at the near distances — technically away from the
      // light, visually nothing — before flipping downward past 60px. A test
      // for the sign alone passes on the defect.
      expect(offset.y).toBeLessThan(-2);
    }
  });

  it('throws UP wherever along a wide frame the pointer sits below, not sideways', () => {
    // The second half of the same defect, reported after the first fix: aiming
    // at the surface's geometric CENTRE meant a pointer below a 900px frame at
    // x=200 aimed at a centre 250px to the right, so the shadow ran sideways
    // with almost no lift. The light is local — it lights a patch, and that
    // patch's shadow must go up wherever the patch is.
    const frame = { left: 0, top: 200, width: 900, height: 44 };
    for (const x of [200, 450, 700]) {
      const offset = castShadowOffset({
        ...frame,
        lightX: x,
        lightY: frame.top + frame.height + 30,
        strength: 1,
        depth: 0.8,
      });
      expect(offset.y).toBeLessThan(-2);
      // Up must dominate: the lit patch sits symmetrically around the pointer
      // here, so any sideways component is residual, not the direction.
      expect(Math.abs(offset.x)).toBeLessThan(Math.abs(offset.y));
    }
  });

  it('aims away from the lit patch near a frame end, never at the light', () => {
    // Below the frame near its LEFT end: the lit patch is clipped on the left,
    // so its centroid sits up and slightly right — the shadow may tilt right,
    // but it must still rise, and it must never point back down at the light.
    const frame = { left: 0, top: 200, width: 900, height: 44 };
    const offset = castShadowOffset({
      ...frame,
      lightX: 40,
      lightY: frame.top + frame.height + 30,
      strength: 1,
      depth: 0.8,
    });
    expect(offset.y).toBeLessThan(-2);
  });

  it('stays continuous across the empty-overlap boundary at a shrunken radius', () => {
    // At lightHeight 0.3 the lit square is only 45px wide, so the overlap can
    // empty out while the falloff is still ~0.29 — the one regime where the
    // empty-overlap fallback in litSpanCentre is visible. Collapsing to the
    // FAR end instead of the near one jumps 2.2px across this boundary; the
    // wide sweep below never reaches it (its boundaries sit at ±150px), which
    // is how that mutation survived the whole suite.
    const frame = { left: 0, top: 200, width: 900, height: 44 };
    const boundary = frame.left - POINTER_LIGHT_RADIUS_PX * 0.3;
    const at = (lightX: number) =>
      castShadowOffset({
        ...frame,
        lightX,
        lightY: frame.top + frame.height + 10,
        strength: 1,
        lightHeight: 0.3,
      });
    const inside = at(boundary + 0.1);
    const outside = at(boundary - 0.1);
    expect(Math.hypot(inside.x - outside.x, inside.y - outside.y)).toBeLessThan(0.5);
  });

  it('answers ambient, not NaN, when an input is unplaceable', () => {
    // A damped strength that ever went NaN would STAY NaN through exponential
    // damping, so one poisoned frame would break the shadow forever.
    const rest = ambientShadowOffset();
    expect(cast({ lightX: 450, lightY: 430, strength: Number.NaN })).toEqual(rest);
    expect(cast({ lightX: Number.NaN, lightY: 430 })).toEqual(rest);
    expect(cast({ lightX: 450, lightY: Number.POSITIVE_INFINITY })).toEqual(rest);
    const deep = castShadowOffset({
      ...SURFACE, lightX: 450, lightY: 430, strength: 1, depth: Number.NaN,
    });
    expect(Number.isFinite(deep.x)).toBe(true);
    expect(Number.isFinite(deep.y)).toBe(true);
  });

  it('moves continuously as the pointer sweeps under and past a wide frame', () => {
    // The lit-span midpoint is what keeps direction from snapping at edge
    // crossings; a jump here reads as the shadow twitching under the pointer.
    const frame = { left: 0, top: 200, width: 900, height: 44 };
    let previous: { x: number; y: number } | null = null;
    for (let x = -120; x <= 1020; x += 4) {
      const offset = castShadowOffset({
        ...frame,
        lightX: x,
        lightY: frame.top + frame.height + 24,
        strength: 1,
        depth: 0.8,
      });
      if (previous) {
        expect(Math.hypot(offset.x - previous.x, offset.y - previous.y)).toBeLessThan(2);
      }
      previous = offset;
    }
  });

  it('still reaches most of its length once the light is clear of the surface', () => {
    // Not exactly full: just outside the footprint the light's own falloff has
    // begun, so the ramp being complete does not mean the blend is.
    const offset = cast({ lightX: SURFACE.left - 20, lightY: SURFACE.top + SURFACE.height / 2 });
    expect(Math.hypot(offset.x, offset.y)).toBeGreaterThan(CAST_SHADOW_REACH_PX * 0.9);
  });
});
