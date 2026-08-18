/**
 * Thick-shell regular octahedron: the brand mark's mesh.
 *
 * Two closed surfaces in one triangle soup with FLAT normals — the outer hull
 * and an inner hull by homothety. Flat normals mean vertices are per-face and
 * never shared, which is what keeps the rank facets reading as distinct planes
 * instead of a smooth blob.
 *
 * NO SIDE BANDS. Joining each outer edge to its inner twin sounds like what
 * closes a shell, but for a homothetic pair those four points are coplanar WITH
 * THE CENTRE: the quad's plane passes through the origin, so it faces neither
 * out nor in (`dot(normal, centroid) === 0`) and it sits buried between two
 * surfaces that already bound a closed solid. Bands are real geometry only for
 * an OPEN shell — faces cut into frames, where the band becomes the visible
 * thick edge. If the mark ever goes skeletal, they come back with the windows.
 *
 * Framework-free on purpose: the projection, the depth sort and the lighting all
 * consume this, and none of them should need a GPU to be tested.
 */

export type MarkVec3 = readonly [number, number, number];

/** Which of the eight sign octants a facet belongs to; the palette keys off it. */
export type MarkOctant = readonly [1 | -1, 1 | -1, 1 | -1];

export type MarkFacetPart = 'outer' | 'inner';

export interface MarkFacet {
  /** Index into the returned triangle list (three vertices per entry). */
  triangle: number;
  /**
   * The facet's three corners as indices into `hullPoints`, already wound the
   * way its normal asks for. The renderer rotates twelve points per frame and
   * scatters them through these, rather than transforming forty-eight.
   */
  points: readonly [number, number, number];
  part: MarkFacetPart;
  /** The sign octant of the hull face this facet belongs to. */
  octant: MarkOctant;
  normal: MarkVec3;
  centroid: MarkVec3;
}

export interface MarkMesh {
  /** xyz per vertex, three vertices per triangle. */
  positions: Float32Array;
  /** One flat normal repeated per triangle vertex. */
  normals: Float32Array;
  facets: MarkFacet[];
  /** The twelve distinct corners: the six outer poles, then the six inner ones. */
  hullPoints: MarkVec3[];
  /** How many of `hullPoints` belong to the outer hull; the rest are the cavity. */
  outerPointCount: number;
  vertexCount: number;
  radius: number;
  inradius: number;
  /** Homothety factor of the inner hull. */
  innerScale: number;
}

/** Distance from the centre to a face plane of a regular octahedron. */
export function markInradius(radius: number): number {
  return radius / Math.sqrt(3);
}

/** Vertex distance from the centre for a given edge length. */
export function markRadiusForEdge(edgeLength: number): number {
  return edgeLength / Math.SQRT2;
}

const AXES = [0, 1, 2] as const;

function scale(vector: MarkVec3, amount: number): MarkVec3 {
  return [vector[0] * amount, vector[1] * amount, vector[2] * amount];
}

function subtract(a: MarkVec3, b: MarkVec3): MarkVec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: MarkVec3, b: MarkVec3): MarkVec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: MarkVec3, b: MarkVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(vector: MarkVec3): MarkVec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function centroidOf(a: MarkVec3, b: MarkVec3, c: MarkVec3): MarkVec3 {
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

/**
 * The six vertices of a regular octahedron, one pair per axis. Index 2*axis is
 * the positive pole, 2*axis+1 the negative one, so an octant maps to a face by
 * picking one pole per axis.
 */
export function markOctahedronVertices(radius: number): MarkVec3[] {
  return AXES.flatMap((axis) => [1, -1].map((sign): MarkVec3 => [
    axis === 0 ? radius * sign : 0,
    axis === 1 ? radius * sign : 0,
    axis === 2 ? radius * sign : 0,
  ]));
}

const OCTANTS: MarkOctant[] = [1, -1].flatMap((x) =>
  [1, -1].flatMap((y) => [1, -1].map((z): MarkOctant => [x as 1 | -1, y as 1 | -1, z as 1 | -1]))
);

function vertexIndex(axis: 0 | 1 | 2, sign: 1 | -1) {
  return axis * 2 + (sign === 1 ? 0 : 1);
}

/** The eight faces as vertex-index triples, tagged with their octant. */
export function markOctahedronFaces(): { indices: readonly [number, number, number]; octant: MarkOctant }[] {
  return OCTANTS.map((octant) => ({
    indices: [
      vertexIndex(0, octant[0]),
      vertexIndex(1, octant[1]),
      vertexIndex(2, octant[2]),
    ] as const,
    octant,
  }));
}

/**
 * Builds the shell. `thickness` is measured inward from the face planes, so it
 * must stay under the inradius — at the inradius the inner hull collapses to a
 * point and the mark stops being a shell.
 */
export function createThickOctahedron(radius: number, thickness: number): MarkMesh {
  if (!(radius > 0)) throw new RangeError(`mark radius must be positive, got ${radius}`);
  const inradius = markInradius(radius);
  if (!(thickness > 0) || thickness >= inradius) {
    throw new RangeError(
      `mark thickness must be within (0, ${inradius.toFixed(4)}), got ${thickness}`
    );
  }
  const innerScale = 1 - thickness / inradius;

  const outer = markOctahedronVertices(radius);
  const inner = outer.map((vertex) => scale(vertex, innerScale));
  const hullPoints = [...outer, ...inner];
  const outerPointCount = outer.length;
  const faces = markOctahedronFaces();

  const positions: number[] = [];
  const normals: number[] = [];
  const facets: MarkFacet[] = [];

  /**
   * Winds the triangle so its flat normal points the way the caller asked for:
   * `outward` for a surface the viewer sees from outside the solid, inward for
   * the cavity. Every hull face here is a plane through the centre's line of
   * sight, so the centroid IS the outward direction.
   */
  const pushTriangle = (
    indexA: number,
    indexB: number,
    indexC: number,
    outward: boolean,
    part: MarkFacetPart,
    octant: MarkOctant
  ) => {
    const a = hullPoints[indexA]!;
    let firstIndex = indexB;
    let secondIndex = indexC;
    let first = hullPoints[firstIndex]!;
    let second = hullPoints[secondIndex]!;
    let normal = normalize(cross(subtract(first, a), subtract(second, a)));
    const centroid = centroidOf(a, first, second);
    if (dot(normal, centroid) < 0 === outward) {
      [firstIndex, secondIndex] = [secondIndex, firstIndex];
      first = hullPoints[firstIndex]!;
      second = hullPoints[secondIndex]!;
      normal = normalize(cross(subtract(first, a), subtract(second, a)));
    }
    facets.push({
      triangle: positions.length / 9,
      points: [indexA, firstIndex, secondIndex],
      part,
      octant,
      normal,
      centroid,
    });
    positions.push(...a, ...first, ...second);
    normals.push(...normal, ...normal, ...normal);
  };

  for (const { indices, octant } of faces) {
    const [i, j, k] = indices;
    pushTriangle(i, j, k, true, 'outer', octant);
  }
  for (const { indices, octant } of faces) {
    const [i, j, k] = indices;
    pushTriangle(
      i + outerPointCount,
      j + outerPointCount,
      k + outerPointCount,
      false,
      'inner',
      octant
    );
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    facets,
    hullPoints,
    outerPointCount,
    vertexCount: positions.length / 3,
    radius,
    inradius,
    innerScale,
  };
}
