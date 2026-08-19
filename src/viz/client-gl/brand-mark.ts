import {
  createThickOctahedron,
  markInradius,
  type MarkOctant,
  type MarkVec3,
} from './mark-geometry.js';

/**
 * One full turn about the vertical axis. The crystal is a rigid solid: this is
 * the ONLY thing time does to its pose, and a slow rate is the point — at a
 * splash size a brisk turn reads as a spinning icon rather than as an object
 * standing there being lit.
 */
export const ATOMA_MARK_TURN_MS = 15_000;

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

/**
 * The bead, halved from the 1.95 it was authored at. Everything the bead emits
 * is expressed as a MULTIPLE of this radius — its body gradient, its bloom, the
 * hot centre the near glass transmits — so the whole light shrinks with it and
 * only the reach it throws across the crystal (`ATOMA_MARK_CORE_LIGHT_RADIUS`)
 * stays where it was: a smaller filament still lights the same room.
 */
export const ATOMA_MARK_CORE_RADIUS = 0.975;
export const ATOMA_MARK_CORE_RADIUS_PULSE = 0.04;

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

/**
 * What KIND of glass a rank's face is made of.
 *
 * The four quadrant faces — each one a top triangle and its bottom twin, so a
 * rank owns a whole wedge of the crystal — are four different glasses, cut in
 * ascending order of refinement along the composition chain: raw volcanic glass
 * for the elements, drawn glass for the molecules, lead crystal for the cells,
 * brilliant-cut diamond for the tissues. The rank COLOUR is untouched by this;
 * taxonomy owns hue, material owns how the surface behaves in light, and mixing
 * the two would make a rank unreadable the moment its material changed.
 *
 * Every field is a shading coefficient consumed by the shell shader, and all of
 * them are per-facet CONSTANTS: they are uploaded once with the geometry, never
 * per frame. What makes them visible is the bead — as the one light inside the
 * crystal travels, each wedge answers it differently.
 *
 * The table is now TWO physical quantities plus three behavioural ones. `ior`
 * and `roughness` are measurements; everything the surface does with light is
 * derived from them (`markF0`, `markSpecularPower`) rather than authored beside
 * them. The three hand-set knobs this replaced — a specular gain, a fresnel
 * gain and a free specular exponent — had drifted into contradicting each
 * other, which is how obsidian ended up with brighter edges than plain glass.
 *
 * - `ior` — index of refraction. Drives edge reflectance AND how far the glass
 *   displaces what is seen through it. See `markF0`.
 * - `roughness` — surface polish; the specular exponent derives from it.
 * - `absorption` — how strongly a UNIT OF DEPTH of this material swallows light,
 *   per model unit. This is the volumetric field: the shader multiplies it by
 *   the distance the view ray actually travels through the wall, so the same
 *   material is clear where the wall is presented flat and nearly solid where
 *   the ray takes the long way through it. Obsidian goes black in the depth of
 *   the wedge; diamond stays readable all the way to its edges.
 * - `dispersion` — how far the highlight splits into colour. Diamond's fire; a
 *   plain glass has almost none.
 * - `transmit` — how much of the interior bead's light this glass carries to the
 *   surface. Dark glass swallows it, diamond throws it.
 * - `body` — how much of the rank tint the lit body keeps under the key light.
 *   Diamond's colour is faint on purpose: its look lives in the highlights.
 */
export interface AtomaMarkMaterial {
  /** Name of the glass, for tests and for the record — never rendered. */
  glass: string;
  /**
   * Index of refraction, the real one for this glass. THE physical parameter:
   * it derives both how much light the surface reflects head-on (Schlick's F0)
   * and how far the surface bends what passes through it. Nothing else in the
   * table is allowed to restate either of those.
   */
  ior: number;
  /**
   * Microfacet roughness, 0 being an optically smooth polish, and the quantity
   * the specular exponent is derived FROM rather than a second, independent
   * spelling of the same idea.
   *
   * These are DELIBERATELY above the real figures. Optical glass sits near
   * 0.01-0.05, which converts to exponents in the thousands and lands every one
   * of the four on the same capped value — a mark whose glasses are no longer
   * told apart by their highlight at all. Held between 0.097 and 0.17 the four
   * exponents come out 211/149/100/67: distinct, ordered, and all clear of the
   * cap. Unlike `ior`, this column is a rendering compromise, not a measurement.
   */
  roughness: number;
  /** Beer-Lambert absorption per model unit of depth. */
  absorption: number;
  /** How far the highlight splits into colour. Diamond's fire. */
  dispersion: number;
  /** How much of the interior bead's light this glass carries to the surface. */
  transmit: number;
  /** How much of the rank tint the lit body keeps under the key light. */
  body: number;
}

/**
 * Reflectance at normal incidence, from the index of refraction.
 *
 * Schlick's F0 for a dielectric against air. This replaces the hand-set
 * `fresnelGain` the table used to carry, which had drifted incoherent: obsidian
 * was given 0.30 against plain glass's 0.24 even though the two have virtually
 * the same IOR, so the mark's edge brightness was ordering the ranks by nothing
 * physical at all.
 */
export function markF0(ior: number): number {
  const ratio = (ior - 1) / (ior + 1);
  return ratio * ratio;
}

/**
 * Blinn-Phong exponent for a given roughness.
 *
 * The shell's highlight is still a Blinn-Phong lobe — a full microfacet BRDF
 * buys nothing on eight flat facets lit by one key — but its exponent is no
 * longer an independent knob. Roughness is the authored quantity and this is
 * the conversion, so "smoother" cannot mean one thing in the table and another
 * in the shader.
 *
 * CAPPED, and the cap is not a fudge. A true polish converts to exponents in
 * the thousands, which is correct for glass and useless here: that lobe is
 * narrower than a pixel, and the mark is lit by ONE point light with no
 * environment to reflect. In a real renderer the missing highlight would be
 * made up by the reflected surroundings; against a near-black field there are
 * none, so an uncapped exponent means a crystal with no highlight at all. The
 * cap is where the lobe stops being resolvable at hero size — the four glasses
 * still order correctly beneath it.
 */
export const ATOMA_MARK_MAX_SPECULAR_POWER = 220;

export function markSpecularPower(roughness: number): number {
  const alpha = Math.max(roughness, 1e-3) ** 2;
  return Math.min(2 / alpha - 2, ATOMA_MARK_MAX_SPECULAR_POWER);
}

export const ATOMA_MARK_RANK_MATERIALS: Record<AtomaMarkRank, AtomaMarkMaterial> = {
  // Obsidian: natural volcanic glass. Its IOR is ordinary glass's — the two are
  // chemically close — so it is NOT the edges that tell it apart. It drinks
  // light by the millimetre, and that absorption is the whole of its identity.
  element: {
    glass: 'obsidian',
    ior: 1.5,
    roughness: 0.17,
    absorption: 14,
    dispersion: 0,
    transmit: 0.45,
    body: 0.58,
  },
  // Glass: the reference solid. Honest transmission through the depth of the
  // wall, no fire. Its absorption is what the others read against.
  molecule: {
    glass: 'glass',
    ior: 1.52,
    roughness: 0.14,
    absorption: 6,
    dispersion: 0.08,
    transmit: 1,
    body: 1,
  },
  // Lead crystal: the lead raises the index well above plain glass, which is
  // exactly why cut crystal holds light at its edges the way glass does not.
  cell: {
    glass: 'crystal',
    ior: 1.7,
    roughness: 0.115,
    absorption: 4.4,
    dispersion: 0.34,
    transmit: 1.15,
    body: 1.04,
  },
  // Diamond: index 2.42, four times glass's reflectance at normal incidence and
  // the strongest bend of the four. Real fire, and so little absorption that
  // the wedge stays clear through its whole depth.
  tissue: {
    glass: 'diamond',
    ior: 2.42,
    roughness: 0.097,
    absorption: 3.2,
    dispersion: 1,
    transmit: 1.32,
    body: 0.86,
  },
} as const;

export function markMaterialForOctant(octant: MarkOctant): AtomaMarkMaterial {
  return ATOMA_MARK_RANK_MATERIALS[markRankForOctant(octant)];
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

/**
 * Local box the mark is authored in; the renderer places its centre. The full
 * edge is exported because the shell's refraction pass renders this box into a
 * texture and the shader normalises local positions against it — the projected
 * geometry and the sampling coord have to agree on one number.
 */
const CENTER = { x: 14, y: 14 } as const;
export const ATOMA_MARK_LOCAL_SIZE = CENTER.x * 2;
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
 *
 * It is also the DEPTH OF MATERIAL each wedge is made of: absorption is
 * measured along the ray's path through this wall, so a wafer-thin shell would
 * make all four glasses look the same however different their coefficients are.
 * The bead's travel room shrinks with every unit added here, which is the trade
 * this number settles — `ATOMA_MARK_CAVITY_INRADIUS` minus the bead's clearance
 * must stay comfortably positive.
 *
 * Halved from the 0.2 it was cut at. Thinner walls SATURATE less, so the four
 * glasses actually separate a little further apart rather than all reaching
 * near-solid: obsidian is the only one that ever fills up.
 */
export const ATOMA_MARK_THICKNESS = 0.1;

/** The shell, built ONCE: 8 outer facets, 8 inner facets, flat normals. */
export const ATOMA_MARK_MESH = createThickOctahedron(
  ATOMA_MARK_RADIUS,
  ATOMA_MARK_THICKNESS
);

/**
 * The SHORTEST path a view ray can take through the wall, in model units.
 *
 * The wedges are not textured planes: they are slabs of material, and what a
 * slab does to light depends on how far through it the ray goes. An octahedron
 * facet's normal is (±1, ±1, ±1)/sqrt(3), so the most face-on a facet can ever
 * be to the camera is |n.z| = 1/sqrt(3) — that is the thinnest the material can
 * look, and every other orientation is a longer path through the same solid.
 * Everything volumetric in the shell shader is measured against this length.
 */
export const ATOMA_MARK_MIN_PATH = ATOMA_MARK_THICKNESS * Math.sqrt(3);

/**
 * Beer-Lambert opacity of PLAIN GLASS over that shortest path. Opacity is
 * normalised by it, so glass at its thinnest presentation is exactly the mark's
 * baseline density and every other material and angle is read as more or less
 * solid than that one reference — rather than each material carrying a hand-set
 * alpha that has nothing to do with its depth.
 */
export const ATOMA_MARK_OPACITY_REFERENCE =
  1 - Math.exp(-ATOMA_MARK_RANK_MATERIALS.molecule.absorption * ATOMA_MARK_MIN_PATH);

/**
 * How near the camera a facet is: 0 at the far wall, 1 at the near one, from
 * the facet's own rotated depth.
 *
 * The shell picks a facet's alpha and its tint shade from this. It used to pick
 * them from a BINARY — whether the facet fell behind or in front of the bead —
 * and the bead crosses the cavity several times a second, so every facet it
 * passed flipped its alpha and dropped its tint to 40% in a single frame. That
 * was the pulse: the crystal appeared to breathe between clear and opaque on
 * the bead's rhythm rather than on its own rotation. A facet's own depth moves
 * only as the mark turns, so the interior still reads dark behind and the glass
 * still reads clear in front, and nothing jumps.
 *
 * The span is the depth of a facet centroid at full presentation: an outer
 * centroid sits at radius/3 along each axis, so its length is radius/sqrt(3).
 */
export const ATOMA_MARK_FACET_DEPTH_SPAN = ATOMA_MARK_RADIUS / Math.sqrt(3);

export function markFacetNearness(depth: number): number {
  const t = clamp((depth + ATOMA_MARK_FACET_DEPTH_SPAN) /
    (2 * ATOMA_MARK_FACET_DEPTH_SPAN));
  return t * t * (3 - 2 * t);
}

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
  // yaw about y, then pitch about x, then roll about z. Rest yaw is 1.55, not
  // the 0.42 the mark first shipped with: the 250 ms turn film showed that
  // opening pose as a dead obsidian table, and 1.55 is the angle where a
  // key-facing facet actually catches a glint.
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
  // RIGID POSE. The mesh turns at one constant rate about the vertical axis
  // and nothing else: pitch, roll and scale are FIXED, so the silhouette stays
  // congruent with itself at every moment and only its aspect changes as the
  // octahedron presents a face, then an edge. Nothing here may flex.
  const yaw = 1.55 + seconds * Math.PI * 2 / (ATOMA_MARK_TURN_MS / 1000);
  const pitch = -0.2;
  const roll = 0.08;
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
    scale: 1,
    yaw,
  };
}
