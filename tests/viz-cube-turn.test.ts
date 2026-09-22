import { describe, expect, it } from 'vitest';
import {
  cubeTurnFrame,
  cubeTurnPlan,
  type CubeTurnPlan,
} from '../src/viz/client-gl/cube-turn.js';

/**
 * THE GEOMETRY OF THE TURN.
 *
 * What is asserted here is what makes two rectangles read as one solid: the
 * same lens, the same recoil, the same hinge, and rotations exactly a quarter
 * turn apart. Those four together are the box — get any one of them wrong on
 * one face and the pair becomes two cards flapping past each other, which is
 * not something a screenshot review reliably catches mid-motion.
 */

interface ParsedFace {
  readonly scale: number;
  readonly perspective: number;
  readonly hingeBack: number;
  readonly rotation: number;
  readonly axis: 'x' | 'y';
  readonly hingeForward: number;
}

function parseFace(transform: string): ParsedFace {
  const match = /^scale\((-?[\d.]+)\) perspective\(([\d.]+)px\) translateZ\((-?[\d.]+)px\) rotate([XY])\((-?[\d.]+)deg\) translateZ\((-?[\d.]+)px\)$/
    .exec(transform);
  if (!match) throw new Error(`unreadable face transform: ${transform}`);
  return {
    scale: Number(match[1]),
    perspective: Number(match[2]),
    hingeBack: Number(match[3]),
    axis: match[4] === 'X' ? 'x' : 'y',
    rotation: Number(match[5]),
    hingeForward: Number(match[6]),
  };
}

const SAMPLES = Array.from({ length: 81 }, (_, index) => index / 80);
/** The focused rail leaves roughly this much of itself on screen. */
const COLUMN_LEFT = 57;

describe('the cube turn', () => {
  it('reports the route through the axis and the direction', () => {
    expect(cubeTurnPlan(2, true, true)).toMatchObject({ axis: 'y', direction: 1 });
    expect(cubeTurnPlan(2, true, false)).toMatchObject({ axis: 'y', direction: -1 });
    // Leaving the rail group tips the box instead of swinging it, so the one
    // boundary in the rail that means something is the one the motion shows.
    expect(cubeTurnPlan(2, false, true)).toMatchObject({ axis: 'x', direction: 1 });
    // Rail rows set the clock: a neighbour is a beat, a jump is the move.
    const durations = [1, 2, 3, 4, 5, 9].map((rows) => cubeTurnPlan(rows, true, true).durationMs);
    for (let index = 1; index < 5; index += 1) {
      expect(durations[index]).toBeGreaterThan(durations[index - 1]!);
    }
    expect(durations.at(-1)).toBe(durations[4]);
  });

  it('hinges both faces on the same edge, a quarter turn apart', () => {
    for (const [width, height] of [[1_440, 900], [432, 720], [2_560, 1_440]] as const) {
      for (const plan of [
        { axis: 'y', direction: 1, durationMs: 520 },
        { axis: 'y', direction: -1, durationMs: 520 },
        { axis: 'x', direction: 1, durationMs: 520 },
      ] as CubeTurnPlan[]) {
        for (const progress of SAMPLES) {
          const frame = cubeTurnFrame(progress, plan, width, height, COLUMN_LEFT);
          const leaving = parseFace(frame.outgoingTransform);
          const arriving = parseFace(frame.incomingTransform);
          const where = `${width}x${height} ${plan.axis}${plan.direction} at ${progress}`;
          // One solid: one lens, one recoil, one hinge.
          expect(arriving.perspective, `${where} lens`).toBe(leaving.perspective);
          expect(arriving.scale, `${where} recoil`).toBe(leaving.scale);
          expect(arriving.hingeBack, `${where} hinge`).toBe(leaving.hingeBack);
          expect(arriving.hingeForward, `${where} hinge`).toBe(leaving.hingeForward);
          expect(leaving.hingeForward, `${where} hinge`).toBe(-leaving.hingeBack);
          expect(arriving.axis, `${where} axis`).toBe(plan.axis);
          expect(leaving.axis, `${where} axis`).toBe(plan.axis);
          // And the arriving face is the NEXT one round, never the same one.
          expect(arriving.rotation - leaving.rotation, `${where} quarter`)
            .toBeCloseTo(90 * plan.direction, 3);
          // The box is as deep as the side it turns about is long, so its
          // cross-section is square and the quarter turn is a real quarter.
          expect(Math.abs(leaving.hingeBack) * 2, `${where} depth`)
            .toBeCloseTo(plan.axis === 'y' ? width - COLUMN_LEFT : height, 6);
        }
      }
    }
  });

  it('starts square, lands square, and turns exactly ninety degrees', () => {
    for (const direction of [1, -1] as const) {
      const plan: CubeTurnPlan = { axis: 'y', direction, durationMs: 600 };
      const start = cubeTurnFrame(0, plan, 1_440, 900, COLUMN_LEFT);
      const end = cubeTurnFrame(1, plan, 1_440, 900, COLUMN_LEFT);
      expect(parseFace(start.outgoingTransform).rotation).toBe(0);
      expect(parseFace(start.incomingTransform).rotation).toBeCloseTo(90 * direction, 3);
      expect(parseFace(end.outgoingTransform).rotation).toBeCloseTo(-90 * direction, 3);
      expect(parseFace(end.incomingTransform).rotation).toBe(0);
      // Nothing is scaled at either end: the screen a reader lands on is the
      // screen they would have had with no turn at all.
      expect(parseFace(start.outgoingTransform).scale).toBe(1);
      expect(parseFace(end.incomingTransform).scale).toBe(1);
    }
  });

  it('draws the box back while it turns, and only while it turns', () => {
    const plan: CubeTurnPlan = { axis: 'y', direction: 1, durationMs: 600 };
    const scales = SAMPLES.map(
      (progress) => parseFace(cubeTurnFrame(progress, plan, 1_440, 900, COLUMN_LEFT).outgoingTransform).scale
    );
    expect(scales[0]).toBe(1);
    expect(scales.at(-1)).toBe(1);
    const deepest = Math.min(...scales);
    expect(deepest).toBeLessThan(0.95);
    expect(deepest).toBeGreaterThan(0.88);
  });

  it('turns the column about its own axis and leaves the rail out of it', () => {
    for (const [width, columnLeft] of [[1_440, 57], [2_560, 57], [432, 24]] as const) {
      const plan: CubeTurnPlan = { axis: 'y', direction: 1, durationMs: 600 };
      for (const progress of [0, 0.3, 0.7, 1]) {
        const frame = cubeTurnFrame(progress, plan, width, 900, columnLeft);
        // The box hinges on the COLUMN's centre. Turning about the viewport's
        // would swing the column's own edge through the rail.
        expect(frame.transformOrigin)
          .toBe(`${(columnLeft + (width - columnLeft) / 2).toFixed(3)}px 50%`);
        // And the two clips are complementary: everything the box may paint
        // starts where the rail stops, and the rail's still stops there too.
        expect(frame.columnClip).toBe(`inset(0 0 0 ${columnLeft.toFixed(3)}px)`);
        expect(frame.railClip).toBe(`inset(0 ${(width - columnLeft).toFixed(3)}px 0 0)`);
      }
    }
  });

  it('hands the front of the box to whichever face is facing the reader', () => {
    const plan: CubeTurnPlan = { axis: 'y', direction: 1, durationMs: 600 };
    const order = SAMPLES.map(
      (progress) => cubeTurnFrame(progress, plan, 1_440, 900, COLUMN_LEFT).outgoingOnTop
    );
    expect(order[0]).toBe(true);
    expect(order.at(-1)).toBe(false);
    // Exactly one handover. A second would be a face popping in front of the
    // one covering it, which is the artefact depth order exists to prevent.
    const handovers = order.filter((top, index) => index > 0 && top !== order[index - 1]);
    expect(handovers).toHaveLength(1);
  });
});
