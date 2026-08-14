import { describe, expect, it } from 'vitest';
import {
  ATOMA_MARK_CORE_EDGE_CLEARANCE,
  ATOMA_MARK_CORE_RADIUS,
  ATOMA_MARK_FACE_COLORS,
  ATOMA_MARK_TURN_MS,
  buildAtomaMarkFrame,
} from '../src/viz/client-gl/brand-mark.js';

interface Point {
  x: number;
  y: number;
}

function cross2d(origin: Point, a: Point, b: Point) {
  return (a.x - origin.x) * (b.y - origin.y) -
    (a.y - origin.y) * (b.x - origin.x);
}

function convexHull(points: readonly Point[]) {
  const sorted = [...points].sort((left, right) => left.x - right.x || left.y - right.y);
  const half = (candidates: readonly Point[]) => {
    const result: Point[] = [];
    for (const point of candidates) {
      while (
        result.length >= 2 &&
        cross2d(result.at(-2)!, result.at(-1)!, point) <= 0
      ) {
        result.pop();
      }
      result.push(point);
    }
    return result;
  };
  const lower = half(sorted);
  const upper = half([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function distanceFromHull(point: Point, hull: readonly Point[]) {
  return Math.min(...hull.map((start, index) => {
    const end = hull[(index + 1) % hull.length]!;
    return cross2d(start, end, point) / Math.hypot(end.x - start.x, end.y - start.y);
  }));
}

describe('Atoma GPU brand mark', () => {
  it('keeps one readable, depth-sorted crystal with all three rank colors', () => {
    const frame = buildAtomaMarkFrame(0);
    expect(frame.faces).toHaveLength(6);
    expect(new Set(frame.faces.map((face) => face.tier))).toEqual(new Set([1, 2, 3]));

    for (let index = 1; index < frame.faces.length; index += 1) {
      expect(frame.faces[index]!.depth).toBeGreaterThanOrEqual(frame.faces[index - 1]!.depth);
    }
    for (const face of frame.faces) {
      const [a, b, c] = face.points;
      const twiceArea = Math.abs(
        a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)
      );
      expect(twiceArea).toBeGreaterThan(0.1);
      expect(face.fillColor).toBeGreaterThanOrEqual(0);
      expect(face.fillColor).toBeLessThanOrEqual(0xffffff);
    }
  });

  it('gives every rank side distinct top and bottom material colors', () => {
    expect(ATOMA_MARK_FACE_COLORS).toEqual({
      1: { top: 0x0f9f92, bottom: 0x2563eb },
      2: { top: 0xf59e0b, bottom: 0xea580c },
      3: { top: 0x8b5cf6, bottom: 0xdb2777 },
    });
    const pairs = Object.values(ATOMA_MARK_FACE_COLORS);
    const colors = pairs.flatMap(({ top, bottom }) => [top, bottom]);
    expect(new Set(colors)).toHaveLength(6);

    const colorDistance = (left: number, right: number) => Math.hypot(
      (left >> 16 & 0xff) - (right >> 16 & 0xff),
      (left >> 8 & 0xff) - (right >> 8 & 0xff),
      (left & 0xff) - (right & 0xff)
    );
    for (const pair of pairs) {
      expect(colorDistance(pair.top, pair.bottom)).toBeGreaterThan(60);
    }
  });

  it('turns briskly and changes face lighting without becoming frantic', () => {
    expect(ATOMA_MARK_TURN_MS).toBeGreaterThanOrEqual(8_000);
    expect(ATOMA_MARK_TURN_MS).toBeLessThanOrEqual(12_000);

    const start = buildAtomaMarkFrame(0);
    const quarterTurn = buildAtomaMarkFrame(ATOMA_MARK_TURN_MS / 4);
    expect(quarterTurn.yaw - start.yaw).toBeGreaterThan(1.45);
    expect(quarterTurn.yaw - start.yaw).toBeLessThan(1.75);

    const startColors = new Map(start.faces.map((face) => [face.id, face.fillColor]));
    expect(quarterTurn.faces.some((face) => startColors.get(face.id) !== face.fillColor)).toBe(true);
  });

  it('keeps the complete smaller core bouncing inside the rotating crystal', () => {
    expect(ATOMA_MARK_CORE_RADIUS).toBeGreaterThanOrEqual(1.7);
    expect(ATOMA_MARK_CORE_RADIUS).toBeLessThan(2);

    const frames = Array.from(
      { length: 4_001 },
      (_value, index) => buildAtomaMarkFrame(index * 100)
    );
    const clearances = frames.map(({ corePosition, faces }) => {
      const points = faces.flatMap((face) => [...face.points]);
      return distanceFromHull(corePosition, convexHull(points));
    });
    expect(Math.min(...clearances)).toBeGreaterThanOrEqual(
      ATOMA_MARK_CORE_EDGE_CLEARANCE - 1e-9
    );
    expect(Math.min(...clearances)).toBeLessThan(
      ATOMA_MARK_CORE_EDGE_CLEARANCE + 0.06
    );

    const beforeBounce = buildAtomaMarkFrame(1_800).corePosition.x;
    const atBounce = buildAtomaMarkFrame(1_923).corePosition.x;
    const afterBounce = buildAtomaMarkFrame(2_100).corePosition.x;
    expect(atBounce).toBeGreaterThan(beforeBounce);
    expect(atBounce).toBeGreaterThan(afterBounce);
  });

  it('bounds its breathing motion and core pulse', () => {
    for (const elapsedMs of [0, 250, 1_000, 5_000, 30_000]) {
      const frame = buildAtomaMarkFrame(elapsedMs);
      expect(frame.scale).toBeGreaterThanOrEqual(0.978);
      expect(frame.scale).toBeLessThanOrEqual(1.002);
      expect(frame.pulse).toBeGreaterThanOrEqual(0);
      expect(frame.pulse).toBeLessThanOrEqual(1);
    }
  });
});
