import { describe, expect, it } from 'vitest';
import {
  ATOMA_MARK_CORE_LIGHT_RADIUS,
  ATOMA_MARK_CORE_RADIUS,
  ATOMA_MARK_CAVITY_INRADIUS,
  ATOMA_MARK_CORE_RADIUS_PULSE,
  ATOMA_MARK_FACET_DEPTH_SPAN,
  ATOMA_MARK_CAMERA_Z,
  ATOMA_MARK_LAMP_Z,
  ATOMA_MARK_MAX_SPECULAR_POWER,
  ATOMA_MARK_MESH,
  ATOMA_MARK_PROJECTION_SCALE,
  ATOMA_MARK_RANK_COLORS,
  ATOMA_MARK_MIN_PATH,
  ATOMA_MARK_OPACITY_REFERENCE,
  ATOMA_MARK_RADIUS,
  ATOMA_MARK_RANK_MATERIALS,
  ATOMA_MARK_THICKNESS,
  ATOMA_MARK_TURN_MS,
  ATOMA_MARK_REST_YAW,
  buildAtomaMarkFrame,
  collectPointerFieldSpills,
  mergeFieldSpills,
  pointerLampForLocal,
  markColorForOctant,
  markElapsedMsFromTurnDegrees,
  markF0,
  markPerspectiveAt,
  markFacetIsFrontGlass,
  markFacetIsNearCavityWall,
  markFacetIsRearGlass,
  markFacetNearness,
  markMaterialForOctant,
  markSpecularPower,
  markTurnDegreesFromElapsedMs,
  markTurnDegreesRounded,
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
    // Every facet projects to a real triangle inside the 28×28 local box —
    // including poses where a near vertex has grown under the pinhole.
    for (const elapsedMs of [0, 640, 3_300, 7_500, 11_200, 17_900]) {
      const pose = elapsedMs === 0 ? frame : buildAtomaMarkFrame(elapsedMs);
      for (const facet of ATOMA_MARK_MESH.facets) {
        const corners = facet.points.map((point) => pose.projected[point]!);
        const a = corners[0]!;
        const b = corners[1]!;
        const c = corners[2]!;
        const twiceArea = Math.abs(
          a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)
        );
        expect(twiceArea, `facet ${facet.triangle} @${elapsedMs}`).toBeGreaterThan(0.1);
        for (const point of corners) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(28);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeLessThanOrEqual(28);
        }
      }
    }
  });

  it('projects the hull and the bead with one pinhole camera', () => {
    // Camera sits in front of every vertex and in front of the pointer lamp,
    // so nothing crosses the projection plane.
    expect(ATOMA_MARK_CAMERA_Z).toBeGreaterThan(ATOMA_MARK_RADIUS);
    expect(ATOMA_MARK_CAMERA_Z).toBeGreaterThan(ATOMA_MARK_LAMP_Z);
    expect(markPerspectiveAt(0)).toBeCloseTo(1, 12);
    expect(markPerspectiveAt(0.4)).toBeGreaterThan(markPerspectiveAt(-0.4));

    for (const elapsedMs of [0, 640, 3_300, 17_900]) {
      const pose = buildAtomaMarkFrame(elapsedMs);
      expect(pose.coreScale).toBeCloseTo(markPerspectiveAt(pose.core3[2]), 12);
      for (const [index, vertex] of pose.points.entries()) {
        const scale = markPerspectiveAt(vertex[2]);
        expect(pose.projected[index]!.x, `vx ${index}`)
          .toBeCloseTo(14 + vertex[0] * ATOMA_MARK_PROJECTION_SCALE * scale, 10);
        expect(pose.projected[index]!.y, `vy ${index}`)
          .toBeCloseTo(14 - vertex[1] * ATOMA_MARK_PROJECTION_SCALE * scale, 10);
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
    const chroma = (color: number) => {
      const r = color >> 16 & 0xff;
      const g = color >> 8 & 0xff;
      const b = color & 0xff;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      return max === 0 ? 0 : (max - min) / max;
    };
    // Gold-sheen, not the steel-grey card the element wedge used to be.
    expect(chroma(ATOMA_MARK_RANK_COLORS.element.top)).toBeGreaterThan(0.55);
    expect(chroma(ATOMA_MARK_RANK_COLORS.element.bottom)).toBeGreaterThan(0.55);
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

  it('turns once every fifteen seconds, slowly and at a constant rate', () => {
    // A splash-sized mark that spins reads as a loading icon. Fifteen seconds
    // is the rate; the bound is tight because "slower" is the whole point.
    expect(ATOMA_MARK_TURN_MS).toBe(15_000);

    const start = buildAtomaMarkFrame(0);
    expect(start.yaw).toBeCloseTo(ATOMA_MARK_REST_YAW, 5);
    const quarterTurn = buildAtomaMarkFrame(ATOMA_MARK_TURN_MS / 4);
    expect(quarterTurn.yaw - start.yaw).toBeCloseTo(Math.PI / 2, 9);
    // Constant rate: equal slices of time are equal slices of angle, so no
    // easing or wobble can hide inside the yaw.
    for (const elapsedMs of [1_000, 4_000, 9_500]) {
      expect(
        buildAtomaMarkFrame(elapsedMs).yaw - start.yaw,
        `yaw at ${elapsedMs}ms`
      ).toBeCloseTo(elapsedMs / ATOMA_MARK_TURN_MS * Math.PI * 2, 9);
    }
    // A full turn brings the hull back to where it started.
    const key = (frame: ReturnType<typeof buildAtomaMarkFrame>) =>
      frame.projected.map((point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`);
    expect(key(buildAtomaMarkFrame(ATOMA_MARK_TURN_MS))).toEqual(key(start));
    // ...and a quarter of one visibly moves it.
    expect(key(quarterTurn).some(
      (position, index) => position !== key(start)[index]
    )).toBe(true);
  });

  it('maps turn degrees onto the same yaw the frame builder uses', () => {
    expect(markElapsedMsFromTurnDegrees(90)).toBeCloseTo(ATOMA_MARK_TURN_MS / 4, 5);
    expect(markTurnDegreesFromElapsedMs(ATOMA_MARK_TURN_MS / 4)).toBeCloseTo(90, 5);
    expect(markTurnDegreesRounded(0)).toBe(0);
    expect(markTurnDegreesRounded(ATOMA_MARK_TURN_MS)).toBe(0);
    expect(markElapsedMsFromTurnDegrees(360)).toBeCloseTo(0, 5);
    expect(markElapsedMsFromTurnDegrees(-90)).toBeCloseTo(ATOMA_MARK_TURN_MS * 0.75, 5);
    expect(buildAtomaMarkFrame(markElapsedMsFromTurnDegrees(0)).yaw)
      .toBeCloseTo(ATOMA_MARK_REST_YAW, 5);
    expect(
      buildAtomaMarkFrame(markElapsedMsFromTurnDegrees(90)).yaw -
        buildAtomaMarkFrame(0).yaw
    ).toBeCloseTo(Math.PI / 2, 9);
  });

  it('cuts each rank wedge from a different glass', () => {
    // Four faces in the user's sense — a top triangle and its bottom twin —
    // and four materials: obsidian, glass, crystal, diamond.
    expect(Object.keys(ATOMA_MARK_RANK_MATERIALS).sort()).toEqual(
      ['cell', 'element', 'molecule', 'tissue']
    );
    const materials = Object.values(ATOMA_MARK_RANK_MATERIALS);
    expect(materials.map((material) => material.glass).sort()).toEqual(
      ['crystal', 'diamond', 'glass', 'obsidian']
    );

    for (const material of materials) {
      const { glass } = material;
      // Above air, and below diamond's 2.42 — the range real transparent
      // solids occupy. A value outside it is a typo, not a material.
      expect(material.ior, `${glass} ior`).toBeGreaterThan(1);
      expect(material.ior, `${glass} ior`).toBeLessThanOrEqual(2.42);
      expect(material.roughness, `${glass} roughness`).toBeGreaterThan(0);
      expect(material.roughness, `${glass} roughness`).toBeLessThan(0.3);
      expect(material.absorption, `${glass} absorption`).toBeGreaterThan(0);
      expect(material.dispersion, `${glass} dispersion`).toBeGreaterThanOrEqual(0);
      expect(material.dispersion, `${glass} dispersion`).toBeLessThanOrEqual(1);
      expect(material.transmit, `${glass} transmit`).toBeGreaterThan(0);
      expect(material.body, `${glass} body`).toBeGreaterThan(0);
    }

    // The four must be TOLD APART on a 28px mark, so every shading coefficient
    // is distinct across the set — a material table whose faces differ only in
    // the third decimal is a table nobody can see.
    for (const field of [
      'ior', 'roughness', 'absorption', 'dispersion', 'transmit', 'body',
    ] as const) {
      expect(
        new Set(materials.map((material) => material[field])),
        `every rank differs in ${field}`
      ).toHaveLength(4);
    }

    // Refinement ascends the composition chain: raw volcanic glass at the
    // elements, brilliant-cut diamond at the tissues.
    const { element, molecule, cell, tissue } = ATOMA_MARK_RANK_MATERIALS;
    expect([element.glass, molecule.glass, cell.glass, tissue.glass]).toEqual(
      ['obsidian', 'glass', 'crystal', 'diamond']
    );
    // Index ascends the chain, and it is the REAL index of each glass. Obsidian
    // and plain glass sit almost together on purpose: they are chemically close,
    // so what tells them apart is absorption, never their edges.
    expect(element.ior).toBeLessThan(molecule.ior);
    expect(molecule.ior).toBeLessThan(cell.ior);
    expect(cell.ior).toBeLessThan(tissue.ior);
    expect(tissue.ior).toBeCloseTo(2.42, 6);
    expect(Math.abs(element.ior - molecule.ior)).toBeLessThan(0.05);
    // Smoother as it refines, so the derived exponent tightens the same way.
    expect(markSpecularPower(tissue.roughness))
      .toBeGreaterThan(markSpecularPower(cell.roughness));
    expect(tissue.dispersion).toBeGreaterThan(cell.dispersion);
    expect(cell.dispersion).toBeGreaterThan(molecule.dispersion);
    expect(element.transmit).toBeLessThan(molecule.transmit);
    expect(element.absorption).toBeGreaterThan(tissue.absorption);

    // F0 is Schlick's, and the ordering it produces is the POINT of moving to
    // an index: the old hand-set fresnelGain gave obsidian 0.30 against plain
    // glass's 0.24 despite near-identical indices, so the mark's edges ordered
    // the ranks by nothing physical. Diamond's edges are ~4x glass's now
    // because 2.42 says so.
    expect(markF0(1)).toBeCloseTo(0, 12);
    expect(markF0(molecule.ior)).toBeCloseTo(0.0426, 3);
    expect(markF0(tissue.ior)).toBeCloseTo(0.1724, 3);
    expect(markF0(tissue.ior) / markF0(molecule.ior)).toBeGreaterThan(3.5);
    expect(markF0(element.ior)).toBeLessThan(markF0(molecule.ior));

    // The derived exponent stays resolvable. An optical polish converts to
    // thousands, which on one point light and no environment is a crystal with
    // no highlight at all — the cap is what keeps the four distinguishable.
    for (const material of materials) {
      expect(markSpecularPower(material.roughness), `${material.glass} power`)
        .toBeLessThan(ATOMA_MARK_MAX_SPECULAR_POWER);
      expect(markSpecularPower(material.roughness), `${material.glass} power`)
        .toBeGreaterThan(1);
    }
  });

  it('makes each wedge a SOLID of its material, not a surfaced facet', () => {
    // A face is a slab: what it does to light must depend on how far the ray
    // travels through it. This pins the volume model the shell shader runs —
    // Beer-Lambert over the path, normalised to plain glass at the thinnest
    // presentation a facet can offer — so a wafer-thin wall or a per-material
    // constant alpha cannot come back and flatten the four glasses into one.
    expect(ATOMA_MARK_MIN_PATH).toBeCloseTo(ATOMA_MARK_THICKNESS * Math.sqrt(3), 12);
    // Enough depth for absorption to separate the materials at all.
    expect(ATOMA_MARK_THICKNESS).toBeGreaterThanOrEqual(0.09);
    // ...and not so much that the bead loses the room it travels in.
    expect(ATOMA_MARK_CAVITY_INRADIUS).toBeGreaterThan(
      (ATOMA_MARK_CORE_RADIUS + ATOMA_MARK_CORE_RADIUS_PULSE + 0.45) /
        ATOMA_MARK_PROJECTION_SCALE + 0.1
    );

    const opacity = (absorption: number, path: number) =>
      (1 - Math.exp(-absorption * path)) / ATOMA_MARK_OPACITY_REFERENCE;
    const { element, molecule, cell, tissue } = ATOMA_MARK_RANK_MATERIALS;
    // Plain glass at its most face-on IS the baseline: that is what the
    // reference normalises, and it is what the other three are read against.
    expect(opacity(molecule.absorption, ATOMA_MARK_MIN_PATH)).toBeCloseTo(1, 12);
    for (const material of [element, molecule, cell, tissue]) {
      // Depth reads as substance: the long way through the same slab is always
      // more solid than the short way, for every material.
      const thin = opacity(material.absorption, ATOMA_MARK_MIN_PATH);
      const deep = opacity(material.absorption, ATOMA_MARK_THICKNESS / 0.16);
      expect(deep, `${material.glass} deepens`).toBeGreaterThan(thin);
      expect(deep, `${material.glass} saturates`).toBeGreaterThan(0.95);
    }
    // At one and the same geometry the four are ORDERED by their material:
    // obsidian nearly solid where diamond is still clear.
    const thin = (material: { absorption: number }) =>
      opacity(material.absorption, ATOMA_MARK_MIN_PATH);
    expect(thin(element)).toBeGreaterThan(thin(molecule));
    expect(thin(molecule)).toBeGreaterThan(thin(cell));
    expect(thin(cell)).toBeGreaterThan(thin(tissue));
  });

  it('never lets a facet jump its density on the bead going past', () => {
    // The reported defect: the shell chose alpha and tint from whether a facet
    // fell behind or in front of the BEAD, and the bead crosses the cavity
    // several times a second — so facets flipped density in one frame and the
    // whole crystal read as pulsing between opaque and clear. Density now comes
    // from the facet's OWN depth, which only the rotation moves.
    expect(markFacetNearness(-ATOMA_MARK_FACET_DEPTH_SPAN)).toBeCloseTo(0, 12);
    expect(markFacetNearness(ATOMA_MARK_FACET_DEPTH_SPAN)).toBeCloseTo(1, 12);
    expect(markFacetNearness(0)).toBeCloseTo(0.5, 12);
    // Bounded past the span rather than overshooting: a rotated centroid can
    // sit a hair outside it once perspective is in play.
    expect(markFacetNearness(-99)).toBe(0);
    expect(markFacetNearness(99)).toBe(1);

    // Continuous, and slow: over one frame at 60fps no facet may move its
    // density by more than a few percent, whatever the bead is doing.
    let worst = 0;
    let previous = buildAtomaMarkFrame(0);
    for (let ms = 16; ms <= ATOMA_MARK_TURN_MS; ms += 16) {
      const frame = buildAtomaMarkFrame(ms);
      for (const [index, facet] of frame.facets.entries()) {
        worst = Math.max(worst, Math.abs(
          markFacetNearness(facet.centroid[2]) -
            markFacetNearness(previous.facets[index]!.centroid[2])
        ));
      }
      previous = frame;
    }
    expect(worst).toBeLessThan(0.02);
  });

  it('gives a rank the same glass on both of its triangles', () => {
    // Material follows the rank, so the top facet and the bottom facet of one
    // wedge are the same glass while their colours differ. Colour is taxonomy;
    // material is surface. Neither may start speaking for the other.
    const octants: MarkOctant[] = [
      [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
      [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
    ];
    for (const octant of octants) {
      const twin: MarkOctant = [octant[0], octant[1] === 1 ? -1 : 1, octant[2]];
      expect(markMaterialForOctant(octant), octant.join(','))
        .toBe(markMaterialForOctant(twin));
      expect(markColorForOctant(octant)).not.toBe(markColorForOctant(twin));
    }
    // All four glasses actually reach the mesh.
    expect(new Set(
      ATOMA_MARK_MESH.facets.map((facet) => markMaterialForOctant(facet.octant).glass)
    )).toHaveLength(4);
  });

  it('keeps the whole bead inside the outline it lights', () => {
    // Half the bead it was authored at, and the pulse halved with it: the
    // light's PROPORTIONS are the contract, not its absolute size.
    expect(ATOMA_MARK_CORE_RADIUS).toBeCloseTo(0.975, 6);
    expect(ATOMA_MARK_CORE_RADIUS_PULSE / ATOMA_MARK_CORE_RADIUS)
      .toBeCloseTo(0.08 / 1.95, 6);

    const frames = Array.from(
      { length: 4_001 },
      (_value, index) => buildAtomaMarkFrame(index * 100)
    );
    // The bead is held off the eight FACE PLANES in three dimensions now, so its
    // projected clearance is no longer the 2D constant it used to equal — what
    // has to hold is the visual claim: the drawn disc never reaches the
    // silhouette, so it can never be painted outside the crystal it lights.
    // Size is the hull's pinhole at the bead's Z, so the check is per frame:
    // a near bead is larger, and that larger disc still has to fit.
    for (const frame of frames) {
      const drawn =
        ATOMA_MARK_CORE_RADIUS * frame.coreScale * (1 + frame.pulse * 0.035);
      expect(distanceFromHull(frame.corePosition, frame.silhouette))
        .toBeGreaterThan(drawn);
    }
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
    const near = frames.reduce((left, right) =>
      left.coreDepth > right.coreDepth ? left : right);
    const far = frames.reduce((left, right) =>
      left.coreDepth < right.coreDepth ? left : right);
    expect(near.coreScale).toBeGreaterThan(far.coreScale);
    expect(near.coreScale).toBeCloseTo(markPerspectiveAt(near.core3[2]), 12);
    expect(far.coreScale).toBeCloseTo(markPerspectiveAt(far.core3[2]), 12);
    expect(near.coreScale / far.coreScale).toBeGreaterThan(1.2);
    expect(far.coreScale).toBeLessThan(1);
    expect(near.coreScale).toBeGreaterThan(1);

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

  it('keeps every camera-facing outer facet in the front glass, even when the bead is nearer', () => {
    // 255–260°: the bead sits near the camera, so a Z-split against it sent
    // the LOWER triangle of each near wedge into the hidden backdrop pass.
    // The user saw one (then two) upper faces and nothing else — with the
    // bead undrawn. Front glass is camera-facing outer hull, full stop.
    for (const degrees of [0, 90, 180, 250, 255, 256, 257, 258, 259, 260, 261, 359]) {
      const frame = buildAtomaMarkFrame(markElapsedMsFromTurnDegrees(degrees));
      const front = new Set(frame.frontOrder);
      const back = new Set(frame.backOrder);
      const mid = new Set(frame.midOrder);
      let facingOuter = 0;
      let nearCavity = 0;
      for (const [index, facet] of ATOMA_MARK_MESH.facets.entries()) {
        const normalZ = frame.facets[index]!.normal[2];
        const isFront = markFacetIsFrontGlass(facet.part, normalZ);
        const isNearCavity = markFacetIsNearCavityWall(facet.part, normalZ);
        expect(front.has(index), `facet ${index} at ${degrees}°`).toBe(isFront);
        if (isNearCavity) {
          expect(mid.has(index), `near cavity ${index} at ${degrees}° image-only`)
            .toBe(true);
          expect(back.has(index), `near cavity ${index} at ${degrees}° not far`)
            .toBe(false);
        } else {
          expect(
            back.has(index) || mid.has(index),
            `facet ${index} at ${degrees}°`
          ).toBe(!isFront);
        }
        if (isFront) facingOuter += 1;
        if (isNearCavity) nearCavity += 1;
      }
      expect(front.size + back.size + mid.size, `${degrees}° partition`)
        .toBe(16);
      expect(nearCavity, `${degrees}° near cavity`).toBeGreaterThan(0);
      expect([...front].some((index) => back.has(index) || mid.has(index))).toBe(false);
      expect(facingOuter, `${degrees}° has a hull toward the camera`).toBeGreaterThanOrEqual(2);
      expect(frame.frontOrder).toHaveLength(facingOuter);
      const tops = frame.frontOrder.filter(
        (index) => ATOMA_MARK_MESH.facets[index]!.octant[1] === 1
      );
      const bottoms = frame.frontOrder.filter(
        (index) => ATOMA_MARK_MESH.facets[index]!.octant[1] === -1
      );
      expect(tops.length, `${degrees}° top`).toBeGreaterThan(0);
      expect(bottoms.length, `${degrees}° bottom`).toBeGreaterThan(0);
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

  it('keeps a rigid pose: no breathing, pulse bounded to the light alone', () => {
    // The mesh must not appear to deform: scale is pinned to 1 and pitch/roll
    // are constants, so only the yaw advances and only the bead's light pulses.
    for (const elapsedMs of [0, 250, 1_000, 5_000, 30_000]) {
      const frame = buildAtomaMarkFrame(elapsedMs);
      expect(frame.scale).toBe(1);
      expect(frame.pulse).toBeGreaterThanOrEqual(0);
      expect(frame.pulse).toBeLessThanOrEqual(1);
    }
    // RIGID MOTION: every pairwise distance between hull points is preserved
    // across time. The silhouette's own width legitimately changes — a rigid
    // octahedron presents a face, then an edge, as it turns — but the MESH
    // cannot stretch, and pairwise distances are exactly what stretching breaks.
    const start = buildAtomaMarkFrame(0);
    for (const elapsedMs of [1_700, 9_999, 30_000]) {
      const frame = buildAtomaMarkFrame(elapsedMs);
      for (let i = 0; i < frame.points.length; i += 1) {
        for (let j = i + 1; j < frame.points.length; j += 1) {
          const before = Math.hypot(
            start.points[i]![0] - start.points[j]![0],
            start.points[i]![1] - start.points[j]![1],
            start.points[i]![2] - start.points[j]![2]
          );
          const after = Math.hypot(
            frame.points[i]![0] - frame.points[j]![0],
            frame.points[i]![1] - frame.points[j]![1],
            frame.points[i]![2] - frame.points[j]![2]
          );
          expect(after, `edge ${i}-${j} at ${elapsedMs}ms`).toBeCloseTo(before, 9);
        }
      }
    }
  });

  it('throws the bead through each rear face onto the field, stained by that face', () => {
    // The bead is a lantern, not a marble: light that leaves through a rear
    // table has to land ON THE SCENE, in that face's rank colour, instead of
    // dying at the hull. Pools sit past the face that stained them.
    for (const degrees of [0, 90, 180, 257, 359]) {
      const frame = buildAtomaMarkFrame(markElapsedMsFromTurnDegrees(degrees));
      let rearCount = 0;
      for (const [index, facet] of ATOMA_MARK_MESH.facets.entries()) {
        const z = frame.facets[index]!.normal[2];
        const isRear = markFacetIsRearGlass(facet.part, z);
        const isFront = markFacetIsFrontGlass(facet.part, z);
        expect(isFront && isRear, `${degrees}° facet ${index} both`).toBe(false);
        if (facet.part === 'outer' && z !== 0) {
          expect(isFront || isRear, `${degrees}° facet ${index} neither`).toBe(true);
        }
        if (isRear) rearCount += 1;
      }
      expect(frame.rearSpills.length, `${degrees}°`).toBe(rearCount);
      expect(rearCount, `${degrees}° has a back of the lantern`).toBeGreaterThanOrEqual(3);
      const spilled = new Set(frame.rearSpills.map((spill) => spill.facet));
      for (const [index, facet] of ATOMA_MARK_MESH.facets.entries()) {
        if (!markFacetIsRearGlass(facet.part, frame.facets[index]!.normal[2])) continue;
        expect(spilled.has(index), `${degrees}° missing rear ${index}`).toBe(true);
      }
      for (const spill of frame.rearSpills) {
        const mesh = ATOMA_MARK_MESH.facets[spill.facet]!;
        expect(spill.color).toBe(markColorForOctant(mesh.octant));
        expect(spill.intensity).toBeGreaterThan(0);
        expect(spill.intensity).toBeLessThanOrEqual(1);
        const corners = mesh.points.map((point) => frame.projected[point]!);
        const faceX = (corners[0]!.x + corners[1]!.x + corners[2]!.x) / 3;
        const faceY = (corners[0]!.y + corners[1]!.y + corners[2]!.y) / 3;
        const faceR = Math.hypot(faceX - 14, faceY - 14);
        const poolR = Math.hypot(spill.x - 14, spill.y - 14);
        expect(poolR, `${degrees}° pool ${spill.facet} on the field`)
          .toBeGreaterThan(faceR);
      }
    }
  });

  it('throws the pointer through the gem onto the field when the lamp is over it', () => {
    const frame = buildAtomaMarkFrame(0);
    const through = collectPointerFieldSpills(frame, 14, 14);
    expect(through.length).toBeGreaterThan(0);
    expect(collectPointerFieldSpills(frame, 80, 80)).toEqual([]);
    const front = frame.frontOrder[0]!;
    const mesh = ATOMA_MARK_MESH.facets[front]!;
    const corners = mesh.points.map((point) => frame.projected[point]!);
    const over = {
      x: (corners[0]!.x + corners[1]!.x + corners[2]!.x) / 3,
      y: (corners[0]!.y + corners[1]!.y + corners[2]!.y) / 3,
    };
    const stained = collectPointerFieldSpills(frame, over.x, over.y);
    expect(stained.length).toBeGreaterThan(0);
    const entry = markColorForOctant(mesh.octant);
    const channelDelta = (color: number) => Math.abs((color >> 16 & 0xff) - (entry >> 16 & 0xff));
    const mean = stained.reduce((sum, spill) => sum + channelDelta(spill.color), 0)
      / stained.length;
    const unstained = frame.rearSpills.reduce((sum, spill) => sum + channelDelta(spill.color), 0)
      / Math.max(1, frame.rearSpills.length);
    expect(mean, 'pointer beam keeps the entry-face stain').toBeLessThan(unstained + 1e-6);
    for (const spill of through) {
      const cornersOf = ATOMA_MARK_MESH.facets[spill.facet]!.points
        .map((point) => frame.projected[point]!);
      const faceR = Math.hypot(
        (cornersOf[0]!.x + cornersOf[1]!.x + cornersOf[2]!.x) / 3 - 14,
        (cornersOf[0]!.y + cornersOf[1]!.y + cornersOf[2]!.y) / 3 - 14
      );
      expect(Math.hypot(spill.x - 14, spill.y - 14)).toBeGreaterThan(faceR);
    }
  });

  it('parks the pointer lamp in front of the gem, not on its surface', () => {
    const centre = pointerLampForLocal(14, 14);
    expect(centre.position[0]).toBeCloseTo(0);
    expect(centre.position[1]).toBeCloseTo(0);
    expect(centre.position[2]).toBe(ATOMA_MARK_LAMP_Z);
    expect(centre.position[2]).toBeGreaterThan(ATOMA_MARK_RADIUS);
    expect(centre.on).toBeGreaterThan(0.9);
    expect(centre.uv[0]).toBeCloseTo(0.5);
    expect(centre.uv[1]).toBeCloseTo(0.5);

    const right = pointerLampForLocal(14 + ATOMA_MARK_PROJECTION_SCALE, 14);
    expect(right.position[0]).toBeCloseTo(1);
    expect(right.position[1]).toBeCloseTo(0);

    const up = pointerLampForLocal(14, 14 - ATOMA_MARK_PROJECTION_SCALE);
    expect(up.position[1]).toBeCloseTo(1);

    expect(pointerLampForLocal(80, 80).on).toBe(0);
    expect(pointerLampForLocal(Number.NaN, 14).on).toBe(0);
    // A cursor standing off to the side of the gem must not still be a
    // studio key aimed at the middle of the crystal.
    expect(pointerLampForLocal(0, 14).on).toBeLessThan(0.45);
  });

  it('adds pointer and bead lamps on the same rear window instead of dropping one', () => {
    const merged = mergeFieldSpills(
      [{ facet: 1, x: 10, y: 10, intensity: 0.4, color: 0xff0000 }],
      [{ facet: 1, x: 99, y: 99, intensity: 0.3, color: 0x0000ff }]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.intensity).toBeCloseTo(0.7);
    expect(merged[0]!.x).toBe(10);
    expect(merged[0]!.color).not.toBe(0xff0000);
    expect(merged[0]!.color).not.toBe(0x0000ff);
  });
});
