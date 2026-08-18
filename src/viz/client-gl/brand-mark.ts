import {
  createThickOctahedron,
  markInradius,
  type MarkOctant,
  type MarkVec3,
} from './mark-geometry.js';

export const ATOMA_MARK_TURN_MS = 10_000;

/**
 * Bounce rate of the core bead, as three triangle-wave frequencies. Kept
 * deliberately incommensurate so the reflected path does not fall into a short
 * repeating orbit — a mark that visibly loops every few seconds reads as a
 * looping GIF rather than as something alive. The third axis is DEPTH: the bead
 * travels inside a volume, not across a picture of one.
 */
export const ATOMA_MARK_CORE_SPEED_U = 0.85;
export const ATOMA_MARK_CORE_SPEED_V = 0.6;
export const ATOMA_MARK_CORE_SPEED_W = 0.47;

/**
 * The bead is a LIGHT, not just a dot: this is how far its illumination reaches
 * across the crystal, in projected units (the hull spans about 12.5 units from
 * centre to vertex), and how it falls off.
 *
 * `coreLightFalloff` is implemented TWICE — here for the parts the CPU shades
 * (the bead's own glow) and in the shell shader for the walls it lights. Change
 * one and change the other; the shader comment names this function.
 */
export const ATOMA_MARK_CORE_LIGHT_RADIUS = 9;

/** Smooth 1→0 over the light's reach; 0 beyond it. */
export function coreLightFalloff(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 1;
  if (distance >= ATOMA_MARK_CORE_LIGHT_RADIUS) return 0;
  const t = 1 - distance / ATOMA_MARK_CORE_LIGHT_RADIUS;
  return t * t * (3 - 2 * t);
}

export const ATOMA_MARK_CORE_RADIUS = 1.95;
export const ATOMA_MARK_CORE_RADIUS_PULSE = 0.08;

/**
 * A slice of glass the bead never crosses. The bead is a light seen THROUGH the
 * near wall of the shell, and this margin is what makes that wall readable — a
 * bead that kisses the surface it lights reads as stuck to the outside.
 */
export const ATOMA_MARK_CORE_GLASS_MARGIN = 0.45;
export const ATOMA_MARK_CORE_EDGE_CLEARANCE =
  ATOMA_MARK_CORE_RADIUS +
  ATOMA_MARK_CORE_RADIUS_PULSE +
  ATOMA_MARK_CORE_GLASS_MARGIN;

/**
 * The four composition ranks, in the order the model composes them:
 * Element → Molecule → Cell → Tissue. Elements are the tools, and they earn a
 * facet because they are a rank of the public model, not a decoration.
 *
 * Each rank owns one facet per hemisphere: `top` for the four upper octants,
 * `bottom` for the four lower ones, which is what makes the eight facets of a
 * regular octahedron divide evenly by taxonomy instead of by convenience.
 */
export const ATOMA_MARK_RANK_COLORS = {
  element: { top: 0x7fb3cc, bottom: 0x3d5a75 },
  molecule: { top: 0x0f9f92, bottom: 0x2563eb },
  cell: { top: 0xf59e0b, bottom: 0xea580c },
  tissue: { top: 0x8b5cf6, bottom: 0xdb2777 },
} as const;

export type AtomaMarkRank = keyof typeof ATOMA_MARK_RANK_COLORS;

/**
 * Ranks laid out in ANGULAR order around the vertical axis, so the composition
 * chain wraps once around the crystal and neighbouring facets are neighbouring
 * ranks. Keyed by the octant's (x, z) quadrant; the y sign picks top/bottom.
 */
const RANK_BY_QUADRANT: Record<string, AtomaMarkRank> = {
  '1,1': 'element',
  '-1,1': 'molecule',
  '-1,-1': 'cell',
  '1,-1': 'tissue',
};

export function markRankForOctant(octant: MarkOctant): AtomaMarkRank {
  const rank = RANK_BY_QUADRANT[`${octant[0]},${octant[2]}`];
  if (!rank) throw new RangeError(`no rank for octant ${octant.join(',')}`);
  return rank;
}

export function markColorForOctant(octant: MarkOctant): number {
  const pair = ATOMA_MARK_RANK_COLORS[markRankForOctant(octant)];
  return octant[1] === 1 ? pair.top : pair.bottom;
}

export interface AtomaMarkPoint {
  x: number;
  y: number;
}

/** Channel-wise colour blend. Shared with the renderer's bead gradient. */
export function mixColor(from: number, to: number, amount: number) {
  const t = clamp(amount);
  const channel = (shift: number) => Math.round(
    (from >> shift & 0xff) * (1 - t) + (to >> shift & 0xff) * t
  );
  return channel(16) << 16 | channel(8) << 8 | channel(0);
}

/** Local box the mark is authored in; the renderer places its centre. */
const CENTER = { x: 14, y: 14 } as const;
/**
 * Projected units per model unit. Exported because the shell shader is fed
 * lengths in MODEL units while the bead's constants are authored in projected
 * ones, and one factor has to convert between them.
 */
export const ATOMA_MARK_PROJECTION_SCALE = 9.8;
const PROJECTION_SCALE = ATOMA_MARK_PROJECTION_SCALE;
const PERSPECTIVE_DEPTH = 0.055;

/** Model-space size of the shell. The projected hull lands just inside the box. */
export const ATOMA_MARK_RADIUS = 1.28;
/**
 * Wall thickness, inward from the face planes. Thin enough that the cavity is
 * still most of the volume — the bead lives in there — and thick enough that
 * the offset between the two outlines reads as a wall rather than as an
 * antialiasing artefact once the mark is a splash-sized hero.
 */
export const ATOMA_MARK_THICKNESS = 0.13;

/** The shell, built ONCE: 8 outer facets, 8 inner facets, flat normals. */
export const ATOMA_MARK_MESH = createThickOctahedron(
  ATOMA_MARK_RADIUS,
  ATOMA_MARK_THICKNESS
);

/** Distance from the centre to a cavity wall: the room the bead bounces in. */
export const ATOMA_MARK_CAVITY_INRADIUS =
  markInradius(ATOMA_MARK_RADIUS) * ATOMA_MARK_MESH.innerScale;

const CORE_MODEL_CLEARANCE = ATOMA_MARK_CORE_EDGE_CLEARANCE / PROJECTION_SCALE;

export interface AtomaMarkFacetFrame {
  /** Index into `ATOMA_MARK_MESH.facets`. */
  facet: number;
  /** Rotated flat normal: outward for the hull, into the cavity for the wall. */
  normal: MarkVec3;
  /** Rotated centroid; the depth sort and the bead split read its z. */
  centroid: MarkVec3;
}

export interface AtomaMarkFrame {
  /** Rotated positions of the mesh's 12 hull points, model space. */
  points: MarkVec3[];
  /** The same points projected into the 28×28 local box. */
  projected: AtomaMarkPoint[];
  facets: AtomaMarkFacetFrame[];
  /** Facet indices sorted far → near. */
  order: number[];
  /**
   * How many entries of `order` sit BEHIND the bead. The renderer draws those,
   * then the bead, then the rest — so the bead is inside the shell by
   * construction rather than by tuning.
   */
  coreSplit: number;
  /** Bead centre, rotated model space: the shader's point light position. */
  core3: MarkVec3;
  /** Bead centre projected, for the glow the CPU paints. */
  corePosition: AtomaMarkPoint;
  /** Bead depth as -1 (far wall) → +1 (near wall) of its own travel room. */
  coreDepth: number;
  /** Perspective factor at the bead's depth; the renderer scales the bead by it. */
  coreScale: number;
  /** Convex outline of the projected hull: the mask that keeps light inside. */
  silhouette: AtomaMarkPoint[];
  pulse: number;
  scale: number;
  yaw: number;
}

function clamp(value: number, low = 0, high = 1) {
  return Math.max(low, Math.min(high, value));
}

function dot(a: MarkVec3, b: MarkVec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function triangleWave(value: number) {
  const phase = (value % 4 + 4) % 4;
  return phase < 2 ? phase - 1 : 3 - phase;
}

function cross2d(origin: AtomaMarkPoint, a: AtomaMarkPoint, b: AtomaMarkPoint) {
  return (a.x - origin.x) * (b.y - origin.y) -
    (a.y - origin.y) * (b.x - origin.x);
}

function convexHull(points: readonly AtomaMarkPoint[]) {
  const sorted = [...points].sort((left, right) => left.x - right.x || left.y - right.y);
  const half = (candidates: readonly AtomaMarkPoint[]) => {
    const result: AtomaMarkPoint[] = [];
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

/**
 * Rotation rows, view aligned. Returned as rows so the same three vectors serve
 * the CPU here and, if a shader ever needs them, three `vec3<f32>` uniforms —
 * WGSL's `mat3x3` padding rules make a matrix the fussier thing to upload.
 */
function rotationRows(yaw: number, pitch: number, roll: number): [MarkVec3, MarkVec3, MarkVec3] {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  // yaw about y, then pitch about x, then roll about z — the order the mark has
  // always turned in, kept so the pose at t=0 is the pose it always had.
  return [
    [cy * cr + sy * sp * sr, cp * sr, -sy * cr + cy * sp * sr],
    [-cy * sr + sy * sp * cr, cp * cr, sy * sr + cy * sp * cr],
    [sy * cp, -sp, cy * cp],
  ];
}

function apply(rows: readonly [MarkVec3, MarkVec3, MarkVec3], vector: MarkVec3): MarkVec3 {
  return [dot(rows[0], vector), dot(rows[1], vector), dot(rows[2], vector)];
}

/** The inverse rotation: for an orthonormal basis, its transpose. */
function applyTransposed(
  rows: readonly [MarkVec3, MarkVec3, MarkVec3],
  vector: MarkVec3
): MarkVec3 {
  return [
    rows[0][0] * vector[0] + rows[1][0] * vector[1] + rows[2][0] * vector[2],
    rows[0][1] * vector[0] + rows[1][1] * vector[1] + rows[2][1] * vector[2],
    rows[0][2] * vector[0] + rows[1][2] * vector[1] + rows[2][2] * vector[2],
  ];
}

function perspectiveAt(z: number) {
  return 1 + z * PERSPECTIVE_DEPTH;
}

/**
 * The ONE projection. The shell shader takes positions already projected here,
 * precisely so a second implementation cannot drift from this one.
 */
function project(vertex: MarkVec3): AtomaMarkPoint {
  const perspective = perspectiveAt(vertex[2]);
  return {
    x: CENTER.x + vertex[0] * PROJECTION_SCALE * perspective,
    y: CENTER.y - vertex[1] * PROJECTION_SCALE * perspective,
  };
}

/**
 * Three triangle waves produce a continuous reflected path through the CAVITY.
 * Two of them keep the screen-space wander the mark always had; the third moves
 * the bead toward and away from the camera. The walls that stop it are the eight
 * cavity planes, inset by the bead's own radius — so a bead at its limit is
 * touching a wall the viewer can see, and never floats past the outline.
 */
function bouncingCore(seconds: number, rows: readonly [MarkVec3, MarkVec3, MarkVec3]): MarkVec3 {
  const u = triangleWave(seconds * ATOMA_MARK_CORE_SPEED_U + 1);
  const v = triangleWave(seconds * ATOMA_MARK_CORE_SPEED_V + 1);
  const w = triangleWave(seconds * ATOMA_MARK_CORE_SPEED_W + 1);
  const raw: MarkVec3 = [(u + v) / 2, (u - v) / 2, w * 0.85];
  const distance = Math.hypot(...raw);
  if (distance < 1e-6) return [0, 0, 0];

  const direction: MarkVec3 = [raw[0] / distance, raw[1] / distance, raw[2] / distance];
  const travelFraction = Math.max(Math.abs(u), Math.abs(v), Math.abs(w));
  const room = ATOMA_MARK_CAVITY_INRADIUS - CORE_MODEL_CLEARANCE;
  if (!(room > 0)) return [0, 0, 0];

  // The path is authored in VIEW space, so the bead keeps wandering across the
  // picture the way it always did; the cavity it is clamped against turns with
  // the crystal, so the direction goes back to MODEL space to be measured.
  const model = applyTransposed(rows, direction);
  // A regular octahedron is |x| + |y| + |z| <= inradius * sqrt(3), and inset by
  // the bead's clearance it is the same shape — so the reach along a direction
  // is one division instead of a loop over eight planes.
  const l1 = Math.abs(model[0]) + Math.abs(model[1]) + Math.abs(model[2]);
  const travel = room * Math.sqrt(3) / Math.max(1e-6, l1) * travelFraction;
  return [direction[0] * travel, direction[1] * travel, direction[2] * travel];
}

/**
 * Builds one deterministic frame of the mark. Rotation, projection, depth order
 * and the bead's position are all pure, so the animated mark stays testable
 * without a GPU: the shader below it only shades what this hands it.
 */
export function buildAtomaMarkFrame(elapsedMs: number): AtomaMarkFrame {
  const seconds = Math.max(0, elapsedMs) / 1000;
  const yaw =
    0.42 +
    seconds * Math.PI * 2 / (ATOMA_MARK_TURN_MS / 1000) +
    Math.sin(seconds * 0.95) * 0.045;
  const pitch = -0.2 + Math.sin(seconds * 1.22) * 0.085;
  const roll = 0.08 + Math.cos(seconds * 0.72) * 0.032;
  const pulse = 0.5 + Math.sin(seconds * 3.35) * 0.5;
  const rows = rotationRows(yaw, pitch, roll);

  const points = ATOMA_MARK_MESH.hullPoints.map((point) => apply(rows, point));
  const projected = points.map(project);
  const facets = ATOMA_MARK_MESH.facets.map((facet): AtomaMarkFacetFrame => ({
    facet: facet.triangle,
    normal: apply(rows, facet.normal),
    centroid: apply(rows, facet.centroid),
  }));

  const core3 = bouncingCore(seconds, rows);
  const order = facets
    .map((_facet, index) => index)
    .sort((left, right) => facets[left]!.centroid[2] - facets[right]!.centroid[2]);
  const coreSplit = order.filter(
    (facet) => facets[facet]!.centroid[2] <= core3[2]
  ).length;

  const outerHull = projected.filter(
    (_point, index) => index < ATOMA_MARK_MESH.outerPointCount
  );
  return {
    points,
    projected,
    facets,
    order,
    coreSplit,
    core3,
    corePosition: project(core3),
    coreDepth: clamp(
      core3[2] / Math.max(1e-6, ATOMA_MARK_CAVITY_INRADIUS - CORE_MODEL_CLEARANCE),
      -1,
      1
    ),
    coreScale: perspectiveAt(core3[2]),
    silhouette: convexHull(outerHull),
    pulse,
    scale: 0.99 + Math.sin(seconds * 1.58) * 0.012,
    yaw,
  };
}
