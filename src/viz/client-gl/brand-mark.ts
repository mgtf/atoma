import {
  createThickOctahedron,
  markInradius,
  type MarkFacetPart,
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
 * Rest yaw of the rigid pose, in radians. Not 0: the 250 ms turn film showed
 * a face-on table as dead obsidian, and this is the angle where a key-facing
 * facet actually catches a glint. Film frame 0 and slider 0° are this pose.
 */
export const ATOMA_MARK_REST_YAW = 1.55;

/**
 * Degrees of the authored turn at `elapsedMs`. 0 is the rest pose (film frame
 * 0); a full period wraps back to 0 so the slider and `buildAtomaMarkFrame`
 * cannot drift from each other.
 */
export function markTurnDegreesFromElapsedMs(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs)) return 0;
  const elapsed = Math.max(0, elapsedMs);
  const turn = elapsed % ATOMA_MARK_TURN_MS;
  return turn / ATOMA_MARK_TURN_MS * 360;
}

/** Inverse of `markTurnDegreesFromElapsedMs` on [0, 360). 360 wraps to 0. */
export function markElapsedMsFromTurnDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped / 360 * ATOMA_MARK_TURN_MS;
}

/** Integer degree the slider shows and `--degree` consumes: 0..359. */
export function markTurnDegreesRounded(elapsedMs: number): number {
  const rounded = Math.round(markTurnDegreesFromElapsedMs(elapsedMs));
  return ((rounded % 360) + 360) % 360;
}

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
  // Gold-sheen obsidian: volcanic glass with a brass flash, not a steel card.
  // The other three wedges already own teal, amber and violet; this one is
  // the warm metal the grey pair was failing to be.
  element: { top: 0xefc14a, bottom: 0xa35d12 },
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
 * Optical material coefficients understood by the ONE shell shader.
 *
 * The live crystal is diamond on every face. The former progression — raw
 * volcanic glass for elements, drawn glass for molecules, lead crystal for
 * cells and diamond for tissues — remains below as an INACTIVE authored
 * palette so it can be restored deliberately without reconstructing its
 * measurements. Rank COLOUR is independent: taxonomy owns hue, material owns
 * how the surface behaves in light.
 *
 * Every field is a shading coefficient consumed by the shell shader. Values are
 * uploaded once per facet with the geometry, never per frame. Today every facet
 * receives the same diamond object; keeping the per-facet lane is what makes
 * restoring the inactive palette a data change instead of a shader rewrite.
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

/**
 * Inactive four-material palette retained for a possible future restoration.
 * Renderers must consume `ATOMA_MARK_ACTIVE_MATERIALS`, never this archive.
 */
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
    transmit: 0.7,
    body: 0.76,
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

/**
 * The only live material. All four entries deliberately share the same object,
 * so shell faces and CPU light spills cannot drift into a partial restoration.
 */
export const ATOMA_MARK_DIAMOND_MATERIAL = ATOMA_MARK_RANK_MATERIALS.tissue;
export const ATOMA_MARK_ACTIVE_MATERIALS: Record<AtomaMarkRank, AtomaMarkMaterial> = {
  element: ATOMA_MARK_DIAMOND_MATERIAL,
  molecule: ATOMA_MARK_DIAMOND_MATERIAL,
  cell: ATOMA_MARK_DIAMOND_MATERIAL,
  tissue: ATOMA_MARK_DIAMOND_MATERIAL,
} as const;

/** Shared normalisation for every material-weighted light path. */
export const ATOMA_MARK_ACTIVE_MAX_TRANSMIT = Math.max(
  ...Object.values(ATOMA_MARK_ACTIVE_MATERIALS).map((material) => material.transmit)
);

export function markMaterialForOctant(octant: MarkOctant): AtomaMarkMaterial {
  const rank = markRankForOctant(octant);
  // Former per-rank shader selection, intentionally kept for easy restoration:
  // return ATOMA_MARK_RANK_MATERIALS[rank];
  return ATOMA_MARK_ACTIVE_MATERIALS[rank];
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
/**
 * Model-space Z of the pointer lamp. Camera-side is +Z; the hull's radius is
 * `ATOMA_MARK_RADIUS`, so this sits clearly in FRONT of every vertex. Close
 * enough that L varies across a facet (a traveling glint) instead of becoming
 * a second directional from the camera.
 */
export const ATOMA_MARK_LAMP_Z = 2.15;

/** Model-space size of the shell. The projected hull lands just inside the box. */
export const ATOMA_MARK_RADIUS = 1.28;
/**
 * Camera on +Z, looking at the origin. The ONE pinhole: hull vertices and
 * the bead disc both scale by `CAMERA_Z / (CAMERA_Z - z)`. 2.5 radii puts
 * the camera in front of the pointer lamp and close enough that a bead
 * crossing the cavity, and a vertex swinging toward the lens, change size
 * together instead of the hull barely foreshortening while the bead is
 * faked larger on its own.
 */
export const ATOMA_MARK_CAMERA_Z = ATOMA_MARK_RADIUS * 2.5;
/**
 * Wall thickness, inward from the face planes. Thin enough that the cavity is
 * still most of the volume — the bead lives in there — and thick enough that
 * the offset between the two outlines reads as a wall rather than as an
 * antialiasing artefact once the mark is a splash-sized hero.
 *
 * It is also the DEPTH OF DIAMOND each wedge is made of: absorption is
 * measured along the ray's path through this wall, so a wafer-thin shell would
 * make the volume disappear however accurate the active coefficients are.
 * The bead's travel room shrinks with every unit added here, which is the trade
 * this number settles — `ATOMA_MARK_CAVITY_INRADIUS` minus the bead's clearance
 * must stay comfortably positive.
 *
 * Halved from the 0.2 it was cut at. This preserves room for the bead while the
 * archived palette still retains the geometry it was authored against.
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
 * Scene-density calibration over the shortest path. The value 6 preserves the
 * established transparency of the all-diamond cut; it is a display exposure,
 * not a second live material. Absorption itself still comes exclusively from
 * `ATOMA_MARK_ACTIVE_MATERIALS`.
 */
const ATOMA_MARK_OPACITY_CALIBRATION = 6;
export const ATOMA_MARK_OPACITY_REFERENCE =
  1 - Math.exp(-ATOMA_MARK_OPACITY_CALIBRATION * ATOMA_MARK_MIN_PATH);

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

/**
 * The FRONT glass: an outer hull face that points at the camera. Those must
 * be drawn in the scene mesh. The shell used to split on the bead's Z, so any
 * camera-facing face the bead had overtaken went into the backdrop-only group
 * — and that group is hidden after the refraction pass. The lower half of a
 * wedge vanished around 255–260° of the turn, even with the bead undrawn:
 * the bouncing light still owns a Z, and the split still read it.
 */
export function markFacetIsFrontGlass(part: MarkFacetPart, normalZ: number): boolean {
  return part === 'outer' && normalZ > 0;
}

/**
 * The cavity face of a camera-facing wedge. The front glass already volumes
 * that slab; drawing this inner triangle as a CARD over the far hull hid
 * the interior. It still must not carry body or Lambert. It DOES carry the
 * bead's virtual image, so a copy of the filament can sit on the glass you
 * are looking through — the shader drops everything else on this predicate.
 */
export function markFacetIsNearCavityWall(part: MarkFacetPart, normalZ: number): boolean {
  return part === 'inner' && normalZ < 0;
}

/**
 * An outer hull face that points AWAY from the camera. The bead's light
 * leaves the crystal through these, toward the scene field behind it. Front
 * glass is the other half of the same partition; an exactly edge-on face
 * (normal Z of 0) throws neither at the viewer nor at the field.
 */
export function markFacetIsRearGlass(part: MarkFacetPart, normalZ: number): boolean {
  return part === 'outer' && normalZ < 0;
}

/**
 * How far along a rear face's outward normal the stained pool sits, in model
 * units. Past the hull, onto the field — not a second glow glued to the gem.
 */
export const ATOMA_MARK_REAR_LIGHT_THROW = ATOMA_MARK_RADIUS * 1.85;

/**
 * Local radius of one rear-face pool, in the 28×28 box. Converted to far-field
 * pixels (`markHaloSpread`) so the aurora field, not a Pixi disc, is what
 * receives the stained light.
 */
export const ATOMA_MARK_REAR_LIGHT_RADIUS = 20;

/** Distance from the centre to a cavity wall: the room the bead bounces in. */
export const ATOMA_MARK_CAVITY_INRADIUS =
  markInradius(ATOMA_MARK_RADIUS) * ATOMA_MARK_MESH.innerScale;

const CORE_MODEL_CLEARANCE = ATOMA_MARK_CORE_EDGE_CLEARANCE / PROJECTION_SCALE;

export interface AtomaMarkRearSpill {
  /** Outer facet index this light escaped through. */
  facet: number;
  x: number;
  y: number;
  /** 0..1, material-weighted: diamond throws more than obsidian. */
  intensity: number;
  /** Rank colour of the face that stained this light. */
  color: number;
}

export interface AtomaMarkFacetFrame {
  /** Index into `ATOMA_MARK_MESH.facets`. */
  facet: number;
  /** Rotated flat normal: outward for the hull, into the cavity for the wall. */
  normal: MarkVec3;
  /** Rotated centroid; the depth sort and the cavity/bead groups read its z. */
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
   * Backdrop, behind the bead: far hull and the cavity walls the bead has
   * not yet passed. Drawn into the refraction texture, then hidden.
   */
  backOrder: readonly number[];
  /**
   * Backdrop, in front of the bead but behind the front glass: near cavity
   * walls. Same hidden pass, AFTER the bead, so the filament stays inside.
   * Near cavity walls are image-only (no body) so they cannot veil the hull.
   */
  midOrder: readonly number[];
  /**
   * Scene mesh: every camera-facing outer facet. Independent of the bead —
   * a light inside the crystal must not delete the glass in front of it.
   */
  frontOrder: readonly number[];
  /**
   * Light that left through a rear face, as pools on the scene field. One
   * entry per camera-away outer facet the bead still reaches. Colour is the
   * rank of that face; the renderer paints these BEHIND the crystal, unmasked.
   */
  rearSpills: readonly AtomaMarkRearSpill[];
  /** Bead centre, rotated model space: the shader's point light position. */
  core3: MarkVec3;
  /** Bead centre projected, for the glow the CPU paints. */
  corePosition: AtomaMarkPoint;
  /** Bead depth as -1 (far wall) → +1 (near wall) of its own travel room. */
  coreDepth: number;
  /**
   * Drawn size of the bead: the same pinhole scale `project` applies to a
   * hull vertex at this Z. Not a second depth curve.
   */
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
  // yaw about y, then pitch about x, then roll about z. Rest yaw is
  // ATOMA_MARK_REST_YAW, not the 0.42 the mark first shipped with.
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

/**
 * Pinhole scale at model Z. `1` on the mid-plane; grows as a point comes
 * toward the camera, shrinks as it recedes. Hull and bead both use this.
 */
export function markPerspectiveAt(z: number) {
  return ATOMA_MARK_CAMERA_Z / Math.max(ATOMA_MARK_CAMERA_Z - z, 1e-4);
}

/**
 * The ONE projection. The shell shader takes positions already projected here,
 * precisely so a second implementation cannot drift from this one.
 */
function project(vertex: MarkVec3): AtomaMarkPoint {
  const perspective = markPerspectiveAt(vertex[2]);
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

function collectRearSpills(
  facets: readonly AtomaMarkFacetFrame[],
  core3: MarkVec3,
  pulse: number
): AtomaMarkRearSpill[] {
  const maxTransmit = ATOMA_MARK_ACTIVE_MAX_TRANSMIT;
  const spills: AtomaMarkRearSpill[] = [];
  for (const [index, meshFacet] of ATOMA_MARK_MESH.facets.entries()) {
    const shaded = facets[index]!;
    if (!markFacetIsRearGlass(meshFacet.part, shaded.normal[2])) continue;
    const toFace: MarkVec3 = [
      shaded.centroid[0] - core3[0],
      shaded.centroid[1] - core3[1],
      shaded.centroid[2] - core3[2],
    ];
    const dist = Math.hypot(...toFace);
    if (dist < 1e-6) continue;
    const incidence = Math.max(dot(shaded.normal, [
      toFace[0] / dist,
      toFace[1] / dist,
      toFace[2] / dist,
    ]), 0);
    if (incidence <= 0) continue;
    // Octahedron |n.z| max is 1/sqrt(3); scale so a fully presented rear
    // table is 1.
    const rear = clamp(-shaded.normal[2] * Math.sqrt(3));
    const material = markMaterialForOctant(meshFacet.octant);
    // Colour is the taxonomy stain. Absorption already shaped the diamond in
    // the shell, so the field path only normalises its transmission here.
    const stain = 0.42 + 0.58 * (material.transmit / maxTransmit);
    const intensity = clamp(
      incidence * rear * stain * (0.82 + 0.18 * pulse)
    );
    if (intensity < 0.02) continue;
    const pos = throwRearPool(shaded);
    spills.push({
      facet: index,
      x: pos.x,
      y: pos.y,
      intensity,
      color: markColorForOctant(meshFacet.octant),
    });
  }
  return spills;
}

function throwRearPool(shaded: AtomaMarkFacetFrame): AtomaMarkPoint {
  return project([
    shaded.centroid[0] + shaded.normal[0] * ATOMA_MARK_REAR_LIGHT_THROW,
    shaded.centroid[1] + shaded.normal[1] * ATOMA_MARK_REAR_LIGHT_THROW,
    shaded.centroid[2] + shaded.normal[2] * ATOMA_MARK_REAR_LIGHT_THROW,
  ]);
}

function pointInTriangle(
  point: AtomaMarkPoint,
  a: AtomaMarkPoint,
  b: AtomaMarkPoint,
  c: AtomaMarkPoint
): boolean {
  const ab = cross2d(a, b, point);
  const bc = cross2d(b, c, point);
  const ca = cross2d(c, a, point);
  const hasNeg = ab < 0 || bc < 0 || ca < 0;
  const hasPos = ab > 0 || bc > 0 || ca > 0;
  return !(hasNeg && hasPos);
}

function triangleCoverage(
  point: AtomaMarkPoint,
  a: AtomaMarkPoint,
  b: AtomaMarkPoint,
  c: AtomaMarkPoint
): number {
  if (pointInTriangle(point, a, b, c)) return 1;
  const cx = (a.x + b.x + c.x) / 3;
  const cy = (a.y + b.y + c.y) / 3;
  const reach = Math.max(
    Math.hypot(a.x - cx, a.y - cy),
    Math.hypot(b.x - cx, b.y - cy),
    Math.hypot(c.x - cx, c.y - cy)
  );
  if (reach < 1e-6) return 0;
  const dist = Math.hypot(point.x - cx, point.y - cy);
  const t = dist / (reach * 1.35);
  if (t >= 1) return 0;
  return Math.exp(-t * t * 2.2);
}

/**
 * Pointer lamp as a 3D light in FRONT of the gem. Local coordinates are the
 * 28×28 box; inverse of `project` at z=0 for XY, then parked at
 * `ATOMA_MARK_LAMP_Z`. `on` falls off away from the silhouette so a cursor
 * across the screen does not become a second studio key.
 */
export function pointerLampForLocal(
  localX: number,
  localY: number
): { position: MarkVec3; uv: [number, number]; on: number } {
  if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
    return { position: [0, 0, ATOMA_MARK_LAMP_Z], uv: [0.5, 0.5], on: 0 };
  }
  const position: MarkVec3 = [
    (localX - CENTER.x) / PROJECTION_SCALE,
    (CENTER.y - localY) / PROJECTION_SCALE,
    ATOMA_MARK_LAMP_Z,
  ];
  const uv: [number, number] = [
    localX / ATOMA_MARK_LOCAL_SIZE,
    localY / ATOMA_MARK_LOCAL_SIZE,
  ];
  const fromCenter = Math.hypot(localX - CENTER.x, localY - CENTER.y);
  // Hull is ~12.5 projected units. Wider than that, the lamp is a nearby
  // studio key and paints the whole gem; bob-at-the-silhouette still couples.
  const gemReach = ATOMA_MARK_RADIUS * PROJECTION_SCALE * 1.65;
  const t = fromCenter / gemReach;
  const on = t >= 1 ? 0 : Math.exp(-t * t * 2.0);
  return { position, uv, on };
}

interface PointerEntryCoupling {
  /** 0..1 how much of the lamp couples into the glass at all. */
  gemEnter: number;
  /** Colour of the front facet the light enters through. */
  color: number;
  /** Which front facet dominates under the cursor, for its material. */
  octant: MarkOctant | null;
}

/**
 * ONE definition of how the pointer lamp couples INTO the glass: distance
 * falloff to the silhouette plus coverage of the front facet under the
 * cursor. Both the rear POOLS and the CAUSTIC cast consume this — two
 * entry models would drift, and the cast would stop matching the pools it
 * sits inside.
 */
function pointerEntryCoupling(
  frame: AtomaMarkFrame,
  localX: number,
  localY: number
): PointerEntryCoupling {
  const pointer: AtomaMarkPoint = { x: localX, y: localY };
  const fromCenter = Math.hypot(localX - CENTER.x, localY - CENTER.y);
  // Hull spans ~12.5 projected units from centre. A little extra so grazing
  // the aura still couples into the glass instead of cutting off at the edge.
  const gemReach = ATOMA_MARK_RADIUS * PROJECTION_SCALE * 1.35;
  const t = fromCenter / gemReach;
  const fromGem = t >= 1 ? 0 : Math.exp(-t * t * 2.2);

  let entryCoverage = 0;
  let entryColor = 0xdff1ff;
  let entryOctant: MarkOctant | null = null;
  for (const index of frame.frontOrder) {
    const meshFacet = ATOMA_MARK_MESH.facets[index]!;
    const corners = meshFacet.points.map((point) => frame.projected[point]!);
    const a = corners[0];
    const b = corners[1];
    const c = corners[2];
    if (!a || !b || !c) continue;
    const coverage = triangleCoverage(pointer, a, b, c);
    if (coverage <= entryCoverage) continue;
    entryCoverage = coverage;
    entryColor = markColorForOctant(meshFacet.octant);
    entryOctant = meshFacet.octant;
  }
  return {
    gemEnter: clamp(fromGem * 0.4 + entryCoverage * 0.85),
    color: entryColor,
    octant: entryOctant,
  };
}

/**
 * Pointer lamp in FRONT of the gem, shining through onto the far field.
 * Local coordinates are the 28×28 box. Coverage of a front table is the
 * window the lamp enters; each rear table is the window it leaves, stained
 * by both glasses. Far from the silhouette this is empty. The glass itself
 * reflects the lamp in the shell shader, not here.
 */
export function collectPointerFieldSpills(
  frame: AtomaMarkFrame,
  localX: number,
  localY: number
): AtomaMarkRearSpill[] {
  if (!Number.isFinite(localX) || !Number.isFinite(localY)) return [];
  const { gemEnter, color: entryColor, octant: entryOctant } = pointerEntryCoupling(
    frame,
    localX,
    localY
  );
  if (gemEnter < 0.02) return [];
  const maxTransmit = ATOMA_MARK_ACTIVE_MAX_TRANSMIT;
  // The entry stain rides the same facet the coupling picked: its material
  // sets how much light survives the first table. No dominant facet (grazing
  // lamp, far side of the falloff) still uses the active diamond response.
  const entryMaterial = entryOctant ? markMaterialForOctant(entryOctant) : null;
  const entryStain = entryMaterial
    ? 0.42 + 0.58 * (entryMaterial.transmit / maxTransmit)
    : 1;

  const spills: AtomaMarkRearSpill[] = [];
  for (const [index, meshFacet] of ATOMA_MARK_MESH.facets.entries()) {
    const shaded = frame.facets[index]!;
    if (!markFacetIsRearGlass(meshFacet.part, shaded.normal[2])) continue;
    const rear = clamp(-shaded.normal[2] * Math.sqrt(3));
    const material = markMaterialForOctant(meshFacet.octant);
    const exitStain = 0.42 + 0.58 * (material.transmit / maxTransmit);
    const intensity = clamp(gemEnter * rear * (entryStain * 0.45 + exitStain * 0.55));
    if (intensity < 0.02) continue;
    const pos = throwRearPool(shaded);
    spills.push({
      facet: index,
      x: pos.x,
      y: pos.y,
      intensity,
      color: mixColor(entryColor, markColorForOctant(meshFacet.octant), 0.55),
    });
  }
  return spills;
}

/** Same rear window, two lamps: add intensities and mix the stain. */
export function mergeFieldSpills(
  ...groups: readonly (readonly AtomaMarkRearSpill[])[]
): AtomaMarkRearSpill[] {
  const byFacet = new Map<number, AtomaMarkRearSpill>();
  for (const group of groups) {
    for (const spill of group) {
      const previous = byFacet.get(spill.facet);
      if (!previous) {
        byFacet.set(spill.facet, { ...spill });
        continue;
      }
      const total = previous.intensity + spill.intensity;
      const mix = total > 1e-6 ? spill.intensity / total : 0.5;
      byFacet.set(spill.facet, {
        facet: spill.facet,
        x: previous.x,
        y: previous.y,
        intensity: clamp(total),
        color: mixColor(previous.color, spill.color, mix),
      });
    }
  }
  return [...byFacet.values()];
}

/**
 * Receiver plane behind the crystal, in model units. The UI stays pixel-locked,
 * so traced wall hits use its fixed perspective rather than re-projecting a
 * silhouette approximation.
 */
const CAUSTIC_PLANE_Z = -2.4;
const CAUSTIC_RECEIVER_PERSPECTIVE = markPerspectiveAt(CAUSTIC_PLANE_Z);

/**
 * How far along the lamp ray the wall sits, as a multiple of the lamp's own
 * distance. Greater than 1: the ray is extrapolated BEYOND the gem, so the
 * cast lands on the far side of the centre from the lamp, like any shadow.
 * One definition — the projection and the falloff must agree on where the
 * wall is or the diamond would dim for a throw it never made.
 */
const CAUSTIC_THROW_RATIO = (ATOMA_MARK_LAMP_Z - CAUSTIC_PLANE_Z) / ATOMA_MARK_LAMP_Z;

/**
 * The on-axis lamp-to-wall distance, in model units: the throw a cast has
 * when the pointer sits dead centre on the gem. `markCausticFalloff`
 * normalises against it, so the centred cast is unattenuated and every other
 * position is dimmer than it.
 */
const CAUSTIC_REFERENCE_THROW = ATOMA_MARK_LAMP_Z - CAUSTIC_PLANE_Z;
/**
 * A finite receiver cannot collect a ray travelling almost parallel to it.
 * Treat anything beyond four on-axis throws as a miss: primary rays then use
 * the bounded roughness leak, while secondary rays simply stop. This keeps a
 * grazing denominator from turning one legitimate path into a fullscreen cast.
 */
const CAUSTIC_MAX_WALL_DISTANCE = CAUSTIC_REFERENCE_THROW * 4;
/** Maps physically small interface throughput into the dark HDR-style field. */
const CAUSTIC_DISPLAY_EXPOSURE = 3;

/**
 * How the cast dims as it is thrown further. The lamp is a point source, so
 * the light reaching the wall obeys the inverse square of the distance it
 * travelled — and moving the pointer off the gem's centre both slides the
 * cast sideways and lengthens that travel. This is the whole reason the
 * diamond fades as it slides away instead of staying a constant patch.
 *
 * Model units, lamp position relative to the gem's centre.
 */
export function markCausticFalloff(lampX: number, lampY: number): number {
  // Where the ray through the gem's centre lands, and how far it travelled.
  const anchorX = lampX * (1 - CAUSTIC_THROW_RATIO);
  const anchorY = lampY * (1 - CAUSTIC_THROW_RATIO);
  const travel = Math.hypot(
    anchorX - lampX,
    anchorY - lampY,
    CAUSTIC_REFERENCE_THROW
  );
  const ratio = CAUSTIC_REFERENCE_THROW / Math.max(travel, 1e-4);
  return clamp(ratio * ratio);
}

export interface MarkCausticCast {
  /** Four projected three-ray bundles, flattened as consecutive triangles. */
  points: readonly AtomaMarkPoint[];
  /**
   * The signed spectral HALF-SEPARATION at each of the same twelve corners:
   * (red hit − blue hit) / 2, in local box units. The green trace IS the mean
   * of the two wavelengths, so red sits at corner + delta and blue at
   * corner − delta — one delta carries both, and the consumer's `band` scalar
   * decides how far apart to draw them. Null when the active material does
   * not disperse (obsidian): there is one wavelength, not a zero-width band.
   */
  spectral: readonly AtomaMarkPoint[] | null;
  /**
   * Transport-derived RGB transmission and energy for each consecutive
   * three-ray bundle. The colour comes from the entry/exit facet coatings;
   * it is not a shader-authored lobe tint.
   */
  optics: readonly MarkCausticOptics[];
  /** One bounded Fresnel-reflected branch from the strongest primary bundle. */
  secondary: MarkCausticSecondary | null;
}

export interface MarkCausticOptics {
  /** Near-white spectral transmission after the entry and exit coatings. */
  r: number;
  g: number;
  b: number;
  /** 0..1 energy after coupling, distance falloff and Fresnel losses. */
  intensity: number;
}

export interface MarkCausticSecondary {
  /** One three-ray bundle produced by a real partial Fresnel reflection. */
  points: readonly AtomaMarkPoint[];
  /** Signed red-blue half-separation at the same three corners. */
  spectral: readonly AtomaMarkPoint[] | null;
  optics: MarkCausticOptics;
}

/**
 * The crystal's CAST on the far field. This is intentionally not its projected
 * silhouette: every camera-facing facet launches three rays. They obey Snell
 * at entry and exit, and bounded total internal reflection follows trapped
 * light through additional faces. The four strongest bundles are sampled by
 * the shared field shader, producing folds, gaps and concentrations instead
 * of one bright copy of the diamond outline.
 *
 * The reported intensity is already dimmed by `markCausticFalloff`: a cast
 * thrown further is a cast further from a point source. Consumers scale it,
 * they never re-derive it.
 */
export function projectMarkCaustic(
  frame: AtomaMarkFrame,
  localX: number,
  localY: number
): MarkCausticCast | null {
  if (!Number.isFinite(localX) || !Number.isFinite(localY)) return null;
  const coupling = pointerEntryCoupling(frame, localX, localY);
  if (coupling.gemEnter < 0.02) return null;

  // The lamp, in MODEL units, in front of the gem — the same placement
  // `pointerLampForLocal` gives the shell shader.
  const lampX = (localX - CENTER.x) / PROJECTION_SCALE;
  const lampY = (CENTER.y - localY) / PROJECTION_SCALE;
  const lampZ = ATOMA_MARK_LAMP_Z;
  const lamp: MarkVec3 = [lampX, lampY, lampZ];
  const material = ATOMA_MARK_DIAMOND_MATERIAL;
  const ior = material.ior;
  // The mesh is a thin hollow shell, not a solid gemstone. Collapse its inner
  // diamond→air and rear air→diamond pair into one thickness-weighted exit
  // ratio; the solid's full 2.42 would trap almost every ray in another object.
  const shellExitRatio = ATOMA_MARK_THICKNESS / ATOMA_MARK_RADIUS;

  /**
   * The two traced wavelengths, as indices of refraction. Real diamond spans
   * n≈2.407 (red) to n≈2.451 (blue); the band is scaled by the material's
   * `dispersion` so obsidian (0) traces one wavelength and diamond (1) traces
   * the full band. One material field decides both the highlight split and
   * this band — a second, disagreeing notion of "how dispersive" would put
   * the caustic's fringe where the shell's fire is not.
   */
  const CAUSTIC_SPECTRAL_BAND = 0.044;
  const band = CAUSTIC_SPECTRAL_BAND * material.dispersion;
  const iorRed = ior - band / 2;
  const iorBlue = ior + band / 2;
  const tracesWavelengths = band > 1e-4;

  const normalise = (value: MarkVec3): MarkVec3 => {
    const length = Math.max(Math.hypot(...value), 1e-9);
    return [value[0] / length, value[1] / length, value[2] / length];
  };
  const refract = (
    incident: MarkVec3,
    normal: MarkVec3,
    eta: number
  ): MarkVec3 | null => {
    const cosine = clamp(-dot(incident, normal), -1, 1);
    const discriminant = 1 - eta * eta * (1 - cosine * cosine);
    if (discriminant < 0) return null;
    return normalise([
      eta * incident[0] + (eta * cosine - Math.sqrt(discriminant)) * normal[0],
      eta * incident[1] + (eta * cosine - Math.sqrt(discriminant)) * normal[1],
      eta * incident[2] + (eta * cosine - Math.sqrt(discriminant)) * normal[2],
    ]);
  };
  const reflect = (direction: MarkVec3, normal: MarkVec3): MarkVec3 => {
    const reflectedDot = dot(direction, normal);
    return normalise([
      direction[0] - 2 * reflectedDot * normal[0],
      direction[1] - 2 * reflectedDot * normal[1],
      direction[2] - 2 * reflectedDot * normal[2],
    ]);
  };
  const fresnel = (wavelengthIor: number, cosine: number): number => {
    const ratio = (wavelengthIor - 1) / (wavelengthIor + 1);
    const f0 = ratio * ratio;
    return f0 + (1 - f0) * (1 - clamp(cosine)) ** 5;
  };
  const receiverPoint = (
    hit: MarkVec3,
    direction: MarkVec3
  ): AtomaMarkPoint | null => {
    if (direction[2] >= -1e-5) return null;
    const wallDistance = (CAUSTIC_PLANE_Z - hit[2]) / direction[2];
    if (
      !(wallDistance > 0) ||
      !Number.isFinite(wallDistance) ||
      wallDistance > CAUSTIC_MAX_WALL_DISTANCE
    ) return null;
    const wallX = hit[0] + direction[0] * wallDistance;
    const wallY = hit[1] + direction[1] * wallDistance;
    return {
      x: CENTER.x + wallX * PROJECTION_SCALE * CAUSTIC_RECEIVER_PERSPECTIVE,
      y: CENTER.y - wallY * PROJECTION_SCALE * CAUSTIC_RECEIVER_PERSPECTIVE,
    };
  };
  interface CausticInterfaceHit {
    hit: MarkVec3;
    facet: number;
    outward: MarkVec3;
    incoming: MarkVec3;
    exitDirection: MarkVec3;
    reflectance: number;
    tirBounces: number;
  }
  const nextTransmissiveInterface = (
    initialOrigin: MarkVec3,
    initialDirection: MarkVec3,
    wavelengthIor: number
  ): CausticInterfaceHit | null => {
    // Direction uses the collapsed thin-shell ratio. Energy still uses the
    // diamond Fresnel term: collapsing geometry must not erase its reflection.
    const exitEta = 1 + (wavelengthIor - 1) * shellExitRatio;
    let origin = initialOrigin;
    let direction = initialDirection;
    for (let bounce = 0; bounce < 8; bounce += 1) {
      let hitFacet = -1;
      let hitDistance = Number.POSITIVE_INFINITY;
      for (const [index, meshFacet] of ATOMA_MARK_MESH.facets.entries()) {
        if (meshFacet.part !== 'outer') continue;
        const facet = frame.facets[index]!;
        const denominator = dot(facet.normal, direction);
        if (denominator <= 1e-6) continue;
        const plane = dot(facet.normal, facet.centroid);
        const distance = (plane - dot(facet.normal, origin)) / denominator;
        if (distance > 1e-5 && distance < hitDistance) {
          hitDistance = distance;
          hitFacet = index;
        }
      }
      if (hitFacet < 0 || !Number.isFinite(hitDistance)) return null;
      const hit: MarkVec3 = [
        origin[0] + direction[0] * hitDistance,
        origin[1] + direction[1] * hitDistance,
        origin[2] + direction[2] * hitDistance,
      ];
      const outward = frame.facets[hitFacet]!.normal;
      const exitDirection = refract(
        direction,
        [-outward[0], -outward[1], -outward[2]],
        exitEta
      );
      if (exitDirection) {
        const cosine = clamp(dot(direction, outward));
        return {
          hit,
          facet: hitFacet,
          outward,
          incoming: direction,
          exitDirection,
          reflectance: fresnel(wavelengthIor, cosine),
          tirBounces: bounce,
        };
      }
      // Total internal reflection remains in the hollow shell and tries the
      // next table. This branch costs CPU only and is capped at eight faces.
      direction = reflect(direction, outward);
      origin = [
        hit[0] + direction[0] * 1e-4,
        hit[1] + direction[1] * 1e-4,
        hit[2] + direction[2] * 1e-4,
      ];
    }
    return null;
  };
  interface CausticSecondaryRay {
    point: AtomaMarkPoint;
    exitFacet: number;
    exitCosine: number;
    energy: number;
  }
  interface CausticSecondarySeed {
    origin: MarkVec3;
    direction: MarkVec3;
    wavelengthIor: number;
    energy: number;
  }
  interface CausticTracedRay {
    point: AtomaMarkPoint | null;
    exitFacet: number;
    entryCosine: number;
    exitCosine: number;
    energy: number;
    secondarySeed: CausticSecondarySeed | null;
  }
  const bounceRetention = Math.exp(
    -material.absorption * ATOMA_MARK_THICKNESS * 0.18
  );
  const trace = (
    sample: MarkVec3,
    entryFacet: number,
    wavelengthIor: number
  ): CausticTracedRay | null => {
    const entryNormal = frame.facets[entryFacet]!.normal;
    const incident = normalise([
      sample[0] - lamp[0],
      sample[1] - lamp[1],
      sample[2] - lamp[2],
    ]);
    const entryCosine = clamp(-dot(incident, entryNormal));
    const direction = refract(incident, entryNormal, 1 / wavelengthIor);
    if (!direction) return null;
    const origin: MarkVec3 = [
      sample[0] + direction[0] * 1e-4,
      sample[1] + direction[1] * 1e-4,
      sample[2] + direction[2] * 1e-4,
    ];
    const first = nextTransmissiveInterface(origin, direction, wavelengthIor);
    if (!first) return null;
    const entryEnergy = (1 - fresnel(wavelengthIor, entryCosine)) * entryCosine;
    const retained = bounceRetention ** first.tirBounces;
    const exitCosine = clamp(dot(first.incoming, first.outward));
    const primaryEnergy = entryEnergy * (1 - first.reflectance) * retained;

    // Preserve a seed instead of following every reflected branch. Once the
    // four primary bundles are ranked, only six rays from the strongest one
    // continue — 24 primary traces + 6 secondary traces, never 24 + 24.
    const reflected = reflect(first.incoming, first.outward);
    const reflectedOrigin: MarkVec3 = [
      first.hit[0] + reflected[0] * 1e-4,
      first.hit[1] + reflected[1] * 1e-4,
      first.hit[2] + reflected[2] * 1e-4,
    ];
    return {
      point: receiverPoint(first.hit, first.exitDirection),
      exitFacet: first.facet,
      entryCosine,
      exitCosine,
      energy: primaryEnergy,
      secondarySeed: {
        origin: reflectedOrigin,
        direction: reflected,
        wavelengthIor,
        energy: entryEnergy * first.reflectance * retained,
      },
    };
  };
  const followSecondary = (seed: CausticSecondarySeed): CausticSecondaryRay | null => {
    const second = nextTransmissiveInterface(
      seed.origin,
      seed.direction,
      seed.wavelengthIor
    );
    if (!second) return null;
    const point = receiverPoint(second.hit, second.exitDirection);
    if (!point) return null;
    return {
      point,
      exitFacet: second.facet,
      exitCosine: clamp(dot(second.incoming, second.outward)),
      energy: seed.energy * (1 - second.reflectance) *
        bounceRetention ** (second.tirBounces + 1),
    };
  };
  const leakedRay = (
    sample: MarkVec3,
    normal: MarkVec3,
    wavelengthIor: number
  ): AtomaMarkPoint => {
    // Finite pointer size and authored roughness leak a cone around an ideal
    // trapped ray. Use that cone's centroid, derived from thickness and IOR.
    const rayScale = (lampZ - CAUSTIC_PLANE_Z) /
      Math.max(lampZ - sample[2], 1e-4);
    const prismShift = ATOMA_MARK_THICKNESS * (wavelengthIor - 1) * rayScale;
    const wallX = lampX + (sample[0] - lampX) * rayScale + normal[0] * prismShift;
    const wallY = lampY + (sample[1] - lampY) * rayScale + normal[1] * prismShift;
    return {
      x: CENTER.x + wallX * PROJECTION_SCALE * CAUSTIC_RECEIVER_PERSPECTIVE,
      y: CENTER.y - wallY * PROJECTION_SCALE * CAUSTIC_RECEIVER_PERSPECTIVE,
    };
  };
  interface CausticLandedRay extends Omit<CausticTracedRay, 'point'> {
    point: AtomaMarkPoint;
  }
  /** Trace one sample at one wavelength, leaking where the trace misses the wall. */
  const land = (
    sample: MarkVec3,
    facetIndex: number,
    normal: MarkVec3,
    wavelengthIor: number
  ): CausticLandedRay => {
    const traced = trace(sample, facetIndex, wavelengthIor);
    if (traced?.point) return { ...traced, point: traced.point };
    return {
      point: leakedRay(sample, normal, wavelengthIor),
      exitFacet: traced?.exitFacet ?? facetIndex,
      entryCosine: traced?.entryCosine ?? 0.5,
      exitCosine: traced?.exitCosine ?? 0.5,
      // A finite source leaks a low-energy cone around a path that missed the
      // receiver. It must not rival a physically landed ray.
      energy: (traced?.energy ?? 0.35) * 0.35,
      secondarySeed: traced?.secondarySeed ?? null,
    };
  };

  interface CausticRgb {
    r: number;
    g: number;
    b: number;
  }
  const srgbToLinear = (channel: number): number => {
    const value = clamp(channel);
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };
  const coatingTransmission = (facetIndex: number, cosine: number): CausticRgb => {
    const color = markColorForOctant(ATOMA_MARK_MESH.facets[facetIndex]!.octant);
    // The logo's facet hues behave as thin brand coatings over colourless
    // diamond. Beer-Lambert optical depth grows at grazing incidence; the
    // 0.12 floor keeps the coating transmissive instead of turning it into ink.
    const depth = 0.055 / Math.max(0.32, clamp(cosine));
    const channel = (shift: number) => {
      const srgb = (color >> shift & 0xff) / 255;
      const pigment = 0.12 + srgbToLinear(srgb) * 0.88;
      return pigment ** depth;
    };
    return { r: channel(16), g: channel(8), b: channel(0) };
  };
  const pathTransmission = (
    entryFacet: number,
    exitFacet: number,
    entryCosine: number,
    exitCosine: number
  ): CausticRgb => {
    const entry = coatingTransmission(entryFacet, entryCosine);
    const exit = coatingTransmission(exitFacet, exitCosine);
    return {
      r: entry.r * exit.r,
      g: entry.g * exit.g,
      b: entry.b * exit.b,
    };
  };
  const averageOptics = (
    paths: readonly {
      exitFacet: number;
      entryCosine: number;
      exitCosine: number;
      energy: number;
    }[],
    entryFacet: number
  ): MarkCausticOptics => {
    let energy = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const path of paths) {
      const weight = Math.max(0, path.energy);
      const transmission = pathTransmission(
        entryFacet,
        path.exitFacet,
        path.entryCosine,
        path.exitCosine
      );
      energy += weight;
      r += transmission.r * weight;
      g += transmission.g * weight;
      b += transmission.b * weight;
    }
    const count = Math.max(1, paths.length);
    const safeEnergy = Math.max(energy, 1e-6);
    return {
      r: clamp(r / safeEnergy),
      g: clamp(g / safeEnergy),
      b: clamp(b / safeEnergy),
      intensity: clamp(energy / count),
    };
  };

  const bundles = ATOMA_MARK_MESH.facets.flatMap((meshFacet, facetIndex) => {
    const facet = frame.facets[facetIndex]!;
    // A convex octahedron presents exactly four outer faces to the camera.
    // Keep every strictly front-facing one: an arbitrary grazing-angle cutoff
    // briefly leaves only three bundles as each edge turns through profile,
    // which clears the whole four-bundle caustic and makes it blink.
    if (meshFacet.part !== 'outer' || facet.normal[2] <= 0) return [];
    const vertices = meshFacet.points.map((pointIndex) => frame.points[pointIndex]!);
    const samples = vertices.map((vertex, vertexIndex): MarkVec3 => {
      const otherA = vertices[(vertexIndex + 1) % 3]!;
      const otherB = vertices[(vertexIndex + 2) % 3]!;
      return [
        vertex[0] * 0.72 + (otherA[0] + otherB[0]) * 0.14,
        vertex[1] * 0.72 + (otherA[1] + otherB[1]) * 0.14,
        vertex[2] * 0.72 + (otherA[2] + otherB[2]) * 0.14,
      ];
    });
    const points = samples.map((sample) => {
      // Green is the MEAN trace, by construction: the barycentric rebuild in
      // the shader is linear, so (red+blue)/2 evaluated at any sample equals
      // the mean trace evaluated there. Tracing it a third time would be a
      // third ray for a value two already determine.
      const red = land(sample, facetIndex, facet.normal, tracesWavelengths ? iorRed : ior);
      const blue = land(sample, facetIndex, facet.normal, tracesWavelengths ? iorBlue : ior);
      return {
        red,
        blue,
        corner: {
          x: (red.point.x + blue.point.x) / 2,
          y: (red.point.y + blue.point.y) / 2,
        },
        delta: tracesWavelengths
          ? {
              x: (red.point.x - blue.point.x) / 2,
              y: (red.point.y - blue.point.y) / 2,
            }
          : null,
      };
    });
    const entryRay = normalise([
      facet.centroid[0] - lamp[0],
      facet.centroid[1] - lamp[1],
      facet.centroid[2] - lamp[2],
    ]);
    const primaryPaths = points.flatMap((point) => [point.red, point.blue]);
    return [{
      points,
      facetIndex,
      optics: averageOptics(primaryPaths, facetIndex),
      score: clamp(-dot(entryRay, facet.normal)) * facet.normal[2],
    }];
  }).sort((left, right) => right.score - left.score).slice(0, 4);
  if (bundles.length < 4) return null;
  // Published green corners: the mean trace every consumer already draws.
  const corners = bundles.flatMap((bundle) =>
    bundle.points.map((point) => point.corner)
  );
  // Signed half-separation per corner, the same twelve again. Deltas ride the
  // transport rather than absolute positions so the winding fix applies once,
  // to green — and a degenerate band collapses to zero instead of to a second
  // copy of the bundle.
  const spectral = tracesWavelengths
    ? bundles.flatMap((bundle) =>
        bundle.points.flatMap((point) => (point.delta ? [point.delta] : []))
      )
    : null;
  const castIntensity = coupling.gemEnter * markCausticFalloff(lampX, lampY);
  const optics = bundles.map((bundle): MarkCausticOptics => ({
    ...bundle.optics,
    intensity: clamp(
      bundle.optics.intensity * castIntensity * CAUSTIC_DISPLAY_EXPOSURE
    ),
  }));
  const secondarySource = bundles
    .map((bundle, index) => ({
      bundle,
      intensity: optics[index]!.intensity,
    }))
    .filter(({ bundle }) => bundle.points.every((point) =>
      point.red.secondarySeed !== null && point.blue.secondarySeed !== null
    ))
    .sort((left, right) => right.intensity - left.intensity)[0] ?? null;
  let secondary: MarkCausticSecondary | null = null;
  if (secondarySource) {
    const secondaryPairs = secondarySource.bundle.points.map((point) => ({
      primaryRed: point.red,
      primaryBlue: point.blue,
      red: followSecondary(point.red.secondarySeed!),
      blue: followSecondary(point.blue.secondarySeed!),
    }));
    if (secondaryPairs.every((pair) => pair.red !== null && pair.blue !== null)) {
      const complete = secondaryPairs.map((pair) => ({
        ...pair,
        red: pair.red!,
        blue: pair.blue!,
      }));
      const secondaryOptics = averageOptics(
        complete.flatMap((pair) => [
          { ...pair.red, entryCosine: pair.primaryRed.entryCosine },
          { ...pair.blue, entryCosine: pair.primaryBlue.entryCosine },
        ]),
        secondarySource.bundle.facetIndex
      );
      secondary = {
        points: complete.map((pair) => ({
          x: (pair.red.point.x + pair.blue.point.x) / 2,
          y: (pair.red.point.y + pair.blue.point.y) / 2,
        })),
        spectral: tracesWavelengths
          ? complete.map((pair) => ({
              x: (pair.red.point.x - pair.blue.point.x) / 2,
              y: (pair.red.point.y - pair.blue.point.y) / 2,
            }))
          : null,
        optics: {
          ...secondaryOptics,
          // A reflected branch is real but subordinate. The cap also prevents
          // a near-grazing Fresnel spike from reading as a second light source.
          intensity: Math.min(
            secondaryOptics.intensity * castIntensity * CAUSTIC_DISPLAY_EXPOSURE,
            secondarySource.intensity * 0.32
          ),
        },
      };
    }
  }
  return {
    points: corners,
    spectral,
    optics,
    secondary,
  };
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
  const yaw = ATOMA_MARK_REST_YAW +
    Math.max(0, elapsedMs) / ATOMA_MARK_TURN_MS * Math.PI * 2;
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
  const frontOrder = order.filter((index) =>
    markFacetIsFrontGlass(ATOMA_MARK_MESH.facets[index]!.part, facets[index]!.normal[2])
  );
  const backOrder: number[] = [];
  const midOrder: number[] = [];
  for (const index of order) {
    const part = ATOMA_MARK_MESH.facets[index]!.part;
    const normalZ = facets[index]!.normal[2];
    if (markFacetIsFrontGlass(part, normalZ)) continue;
    // Near cavity walls carry only the bead's virtual image (the shader
    // drops their body). Mid, so they sit in front of the real filament
    // and behind the front glass — a reflection on the glass you look
    // through, never a card over the far hull.
    if (markFacetIsNearCavityWall(part, normalZ)) {
      midOrder.push(index);
      continue;
    }
    if (facets[index]!.centroid[2] <= core3[2]) backOrder.push(index);
    else midOrder.push(index);
  }

  const outerHull = projected.filter(
    (_point, index) => index < ATOMA_MARK_MESH.outerPointCount
  );
  const rearSpills = collectRearSpills(facets, core3, pulse);
  const coreDepth = clamp(
    core3[2] / Math.max(1e-6, ATOMA_MARK_CAVITY_INRADIUS - CORE_MODEL_CLEARANCE),
    -1,
    1
  );
  return {
    points,
    projected,
    facets,
    order,
    backOrder,
    midOrder,
    frontOrder,
    rearSpills,
    core3,
    corePosition: project(core3),
    coreDepth,
    coreScale: markPerspectiveAt(core3[2]),
    silhouette: convexHull(outerHull),
    pulse,
    scale: 1,
    yaw,
  };
}
