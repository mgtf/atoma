import { describe, expect, it } from 'vitest';
import {
  ATOMA_MARK_CORE_LIGHT_RADIUS,
  ATOMA_MARK_CORE_RADIUS,
  ATOMA_MARK_CORE_RADIUS_PULSE,
  ATOMA_MARK_MESH,
  ATOMA_MARK_PROJECTION_SCALE,
  ATOMA_MARK_RANK_COLORS,
  ATOMA_MARK_TURN_MS,
  buildAtomaMarkFrame,
  markColorForOctant,
} from '../src/viz/client-gl/brand-mark.js';
import type { MarkOctant } from '../src/viz/client-gl/mark-geometry.js';

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
  it('keeps one depth-sorted shell of sixteen facets over all four ranks', () => {
    const frame = buildAtomaMarkFrame(0);
    expect(frame.facets).toHaveLength(16);
    // Eight outer hull faces and eight cavity faces, each keyed by octant so
    // the four composition ranks divide them evenly — two facets per rank per
    // hull instead of the six-way tier split the bipyramid carried.
    const parts = { outer: 0, inner: 0 };
    const ranks = new Set<string>();
    for (const facet of ATOMA_MARK_MESH.facets) {
      parts[facet.part] += 1;
      ranks.add(facet.octant.join(','));
    }
    expect(parts).toEqual({ outer: 8, inner: 8 });
    expect(ranks.size).toBe(8);

    // The order is a permutation of the facets, sorted far → near.
    expect([...frame.order].sort((left, right) => left - right)).toEqual(
      frame.facets.map((_facet, index) => index)
    );
    for (let index = 1; index < frame.order.length; index += 1) {
      expect(
        frame.facets[frame.order[index]!]!.centroid[2],
        `order index ${index}`
      ).toBeGreaterThanOrEqual(frame.facets[frame.order[index - 1]!]!.centroid[2]);
    }
    // Every facet projects to a real triangle inside the 28×28 local box.
    for (const facet of ATOMA_MARK_MESH.facets) {
      const corners = facet.points.map((point) => frame.projected[point]!);
      const a = corners[0]!;
      const b = corners[1]!;
      const c = corners[2]!;
      const twiceArea = Math.abs(
        a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)
      );
      expect(twiceArea, `facet ${facet.triangle}`).toBeGreaterThan(0.1);
      for (const point of corners) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(28);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(28);
      }
    }
  });

  it('gives every rank distinct top and bottom material colors', () => {
    expect(Object.keys(ATOMA_MARK_RANK_COLORS).sort()).toEqual(
      ['cell', 'element', 'molecule', 'tissue']
    );
    const pairs = Object.values(ATOMA_MARK_RANK_COLORS);
    const colors = pairs.flatMap(({ top, bottom }) => [top, bottom]);
    expect(new Set(colors)).toHaveLength(8);

    const colorDistance = (left: number, right: number) => Math.hypot(
      (left >> 16 & 0xff) - (right >> 16 & 0xff),
      (left >> 8 & 0xff) - (right >> 8 & 0xff),
      (left & 0xff) - (right & 0xff)
    );
    for (const pair of pairs) {
      expect(colorDistance(pair.top, pair.bottom)).toBeGreaterThan(60);
    }
  });

  it('keys facet color on the octant, with the y sign picking top or bottom', () => {
    // The rank wraps once around the vertical axis: keyed by the (x, z)
    // quadrant, so neighbouring facets are neighbouring composition ranks.
    const rankByQuadrant = {
      '1,1': 'element',
      '-1,1': 'molecule',
      '-1,-1': 'cell',
      '1,-1': 'tissue',
    } as const;
    const octants: MarkOctant[] = [
      [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
      [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
    ];
    for (const octant of octants) {
      const rank = rankByQuadrant[`${octant[0]},${octant[2]}`];
      const pair = ATOMA_MARK_RANK_COLORS[rank];
      expect(markColorForOctant(octant), octant.join(','))
        .toBe(octant[1] === 1 ? pair.top : pair.bottom);
    }
  });

  it('turns briskly and changes face lighting without becoming frantic', () => {
    expect(ATOMA_MARK_TURN_MS).toBeGreaterThanOrEqual(8_000);
    expect(ATOMA_MARK_TURN_MS).toBeLessThanOrEqual(12_000);

    const start = buildAtomaMarkFrame(0);
    const quarterTurn = buildAtomaMarkFrame(ATOMA_MARK_TURN_MS / 4);
    expect(quarterTurn.yaw - start.yaw).toBeGreaterThan(1.45);
    expect(quarterTurn.yaw - start.yaw).toBeLessThan(1.75);

    // A quarter turn must move the projection: the crystal visibly rotates,
    // not wobbles. Rank colours are fixed per facet now, so the projection is
    // where a turn shows up.
    const key = (frame: ReturnType<typeof buildAtomaMarkFrame>) =>
      frame.projected.map((point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`);
    expect(key(quarterTurn).some(
      (position, index) => position !== key(start)[index]
    )).toBe(true);
  });

  it('keeps the whole bead inside the outline it lights', () => {
    expect(ATOMA_MARK_CORE_RADIUS).toBeGreaterThanOrEqual(1.7);
    expect(ATOMA_MARK_CORE_RADIUS).toBeLessThan(2);

    const frames = Array.from(
      { length: 4_001 },
      (_value, index) => buildAtomaMarkFrame(index * 100)
    );
    // The bead is held off the eight FACE PLANES in three dimensions now, so its
    // projected clearance is no longer the 2D constant it used to equal — what
    // has to hold is the visual claim: the drawn disc never reaches the
    // silhouette, so it can never be painted outside the crystal it lights.
    const margins = frames.map(({ corePosition, silhouette }) =>
      distanceFromHull(corePosition, silhouette));
    expect(Math.min(...margins)).toBeGreaterThan(
      ATOMA_MARK_CORE_RADIUS + ATOMA_MARK_CORE_RADIUS_PULSE
    );
    // Room to spare is not room unused: it must still cross the volume, in
    // measured depth as well as across the picture, or the light stops travelling.
    const travel = frames.map(({ corePosition }) =>
      Math.hypot(corePosition.x - 14, corePosition.y - 14));
    expect(Math.max(...travel)).toBeGreaterThan(4);
    const depths = frames.map((frame) => frame.coreDepth);
    expect(Math.min(...depths)).toBeLessThan(-0.5);
    expect(Math.max(...depths)).toBeGreaterThan(0.5);
    for (const depth of depths) {
      expect(depth).toBeGreaterThanOrEqual(-1);
      expect(depth).toBeLessThanOrEqual(1);
    }

    // The bead REFLECTS off the walls rather than sliding along them or passing
    // through. Found rather than hardcoded: the previous version pinned three
    // timestamps that only bracketed a turning point at one particular bounce
    // rate, so changing the rate broke a test about reflection.
    const xs = Array.from({ length: 600 }, (_value, index) =>
      buildAtomaMarkFrame(index * 20).corePosition.x);
    const reversals = xs.filter((x, index) =>
      index > 0 && index < xs.length - 1 &&
      ((x > xs[index - 1]! && x > xs[index + 1]!) ||
       (x < xs[index - 1]! && x < xs[index + 1]!)));
    expect(reversals.length).toBeGreaterThan(2);
  });

  it('publishes the silhouette the renderer clips the light with', () => {
    // The mask geometry cannot be re-derived in the renderer: a second hull
    // would be free to disagree with the one the bead is constrained against.
    const key = (point: Point) => `${point.x.toFixed(6)},${point.y.toFixed(6)}`;
    for (const elapsedMs of [0, 640, 3_300, 17_900]) {
      const frame = buildAtomaMarkFrame(elapsedMs);
      const outerHull = convexHull(frame.projected.filter(
        (_point, index) => index < ATOMA_MARK_MESH.outerPointCount
      ));
      expect(new Set(frame.silhouette.map(key))).toEqual(new Set(outerHull.map(key)));
      expect(distanceFromHull(frame.corePosition, frame.silhouette))
        .toBeGreaterThan(0);
    }
  });

  it('splits the shell into near glass and far walls, with nothing straddling', () => {
    // This is what puts the bead INSIDE: the renderer paints away-facing walls,
    // then the bead, then camera-facing glass over it. The solid is convex, so
    // every away-facing face must be behind every camera-facing one — if that
    // ever fails, one wall would be painted on the wrong side of the bead.
    for (let ms = 0; ms < 20_000; ms += 137) {
      const frame = buildAtomaMarkFrame(ms);
      const cameraFacing = frame.facets.map((facet, index) => {
        const outer = ATOMA_MARK_MESH.facets[index]!.part === 'outer';
        return outer ? facet.normal[2] > 0 : facet.normal[2] < 0;
      });
      const walls = frame.facets.filter((_facet, index) => !cameraFacing[index]!);
      const glass = frame.facets.filter((_facet, index) => cameraFacing[index]!);
      expect(walls.length, `at ${ms}ms`).toBeGreaterThan(0);
      expect(glass.length, `at ${ms}ms`).toBeGreaterThan(0);
      expect(
        Math.max(...walls.map((facet) => facet.centroid[2])),
        `at ${ms}ms`
      ).toBeLessThan(Math.min(...glass.map((facet) => facet.centroid[2])));
      // The near glass of the outer hull must sit nearer than the cavity's near
      // glass — a viewer looking through the outer wall sees the cavity BEHIND it,
      // never in front. `order` is far → near, so the outer facet comes LAST.
      const outerNear = frame.order.filter((index) =>
        ATOMA_MARK_MESH.facets[index]!.part === 'outer');
      const innerNear = frame.order.filter((index) =>
        ATOMA_MARK_MESH.facets[index]!.part === 'inner');
      if (outerNear.length > 0 && innerNear.length > 0) {
        expect(
          frame.facets[outerNear.at(-1)!]!.centroid[2],
          `at ${ms}ms`
        ).toBeGreaterThan(frame.facets[innerNear.at(-1)!]!.centroid[2]);
      }
    }
  });

  it('travels its light across the facets instead of glazing all of them', () => {
    // The shader receives the bead as a point light in MODEL space with a reach
    // converted from the projected radius; this is the same falloff the CPU
    // applies to the glow it paints, so the range contract holds in both.
    const reach = ATOMA_MARK_CORE_LIGHT_RADIUS / ATOMA_MARK_PROJECTION_SCALE;
    const seen = new Map<number, { min: number; max: number }>();
    for (let ms = 0; ms < 30_000; ms += 61) {
      const frame = buildAtomaMarkFrame(ms);
      for (const [index, facet] of frame.facets.entries()) {
        const distance = Math.hypot(
          facet.centroid[0] - frame.core3[0],
          facet.centroid[1] - frame.core3[1],
          facet.centroid[2] - frame.core3[2]
        );
        const reachT = Math.max(0, Math.min(1, 1 - distance / reach));
        const lit = reachT * reachT * (3 - 2 * reachT);
        expect(lit).toBeGreaterThanOrEqual(0);
        expect(lit).toBeLessThanOrEqual(1);
        const range = seen.get(index) ??
          { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
        range.min = Math.min(range.min, lit);
        range.max = Math.max(range.max, lit);
        seen.set(index, range);
      }
    }
    expect(seen.size).toBe(16);
    for (const [index, range] of seen) {
      expect(range.max, `facet ${index} is never lit`).toBeGreaterThan(0.4);
      expect(range.min, `facet ${index} is always lit`).toBeLessThan(0.05);
    }
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
