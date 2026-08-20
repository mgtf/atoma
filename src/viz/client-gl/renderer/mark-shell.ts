import { Buffer, BufferUsage, Geometry, Mesh, Shader, Texture } from 'pixi.js';

/** A mesh with our own geometry and program, not Pixi's textured default. */
type ShellMesh = Mesh<Geometry, Shader>;
import {
  ATOMA_MARK_CORE_LIGHT_RADIUS,
  ATOMA_MARK_CORE_RADIUS,
  ATOMA_MARK_LAMP_Z,
  ATOMA_MARK_MESH,
  ATOMA_MARK_LOCAL_SIZE,
  ATOMA_MARK_MIN_PATH,
  ATOMA_MARK_OPACITY_REFERENCE,
  ATOMA_MARK_PROJECTION_SCALE,
  ATOMA_MARK_THICKNESS,
  markColorForOctant,
  markF0,
  markFacetNearness,
  markMaterialForOctant,
  markSpecularPower,
  type AtomaMarkFrame,
} from '../brand-mark.js';
import {
  MARK_SHELL_GLSL,
  MARK_SHELL_GLSL_VERTEX,
  MARK_SHELL_WGSL,
} from './shaders.js';

const FACET_COUNT = ATOMA_MARK_MESH.facets.length;
const VERTEX_COUNT = FACET_COUNT * 3;
const INDEX_COUNT = VERTEX_COUNT;

/**
 * How opaque a CAVITY facet is. The outer hull no longer has a counterpart:
 * since the front glass draws the interior it transmits, what an outer facet
 * hides is Beer-Lambert over its path and nothing else, so the hand-set ceiling
 * that used to sit here (0.44) became dead weight and was removed.
 *
 * The history is worth keeping because two earlier spellings were both bugs.
 * Keying this on the facet's position — first against the bead, then against
 * its own depth — is a pulse on a solid that TURNS: every facet takes both
 * roles once per revolution, so any gap between two values reads as the crystal
 * breathing between clear and opaque.
 */
const ALPHA_INNER = 0.86;

/**
 * How much of its own colour a facet keeps, on the depth ramp. The far side is
 * the INTERIOR of a dark crystal: leave it at full tint and every near facet
 * composites with a complementary hue behind it, which averages to grey — the
 * mark loses the rank colours exactly where it has the most of them. Dark
 * behind, saturated in front, and the bead's light brings the interior back up.
 *
 * Depth is allowed to move COLOUR because a face that darkens as it swings away
 * reads as shading, which is what a turning solid does. It is not allowed to
 * move alpha, which reads as the material changing.
 */
const SHADE_FAR = 0.84;
const SHADE_NEAR = 1;

/** Model-space reach of the bead's light, converted from its projected radius. */
const CORE_REACH_MODEL = ATOMA_MARK_CORE_LIGHT_RADIUS / ATOMA_MARK_PROJECTION_SCALE;
/** Analytic filament loudness. Zero when the inspect checkbox hides the bead. */
export const MARK_SHELL_CORE_INTENSITY = 0.88;

function unit(raw: [number, number, number]): [number, number, number] {
  const length = Math.hypot(...raw);
  return [raw[0] / length, raw[1] / length, raw[2] / length];
}

/**
 * The key, and the only DIFFUSE directional. A fill from the opposite side was
 * tried and reverted: on a near-black field what reads as transparency is not
 * alpha at all, it is seeing the far facets THROUGH the near one, and that is a
 * contrast between the two. Any light that lifts the near facet's floor buries
 * what is behind it, so the fill made the crystal read as solid — the brighter
 * it got, the more opaque it looked. On this mark, adding light SUBTRACTS glass.
 * A second directional exists in the shader as a SPECULAR-ONLY window, aimed
 * orthogonal to this key; a highlight does not lift the floor.
 */
const LIGHT_DIRECTION = unit([-0.38, 0.72, 1.05]);

/**
 * The vertex attributes the shell's geometry supplies, by name and format.
 *
 * Pixi binds attributes BY NAME against whatever each shader declares, and the
 * two backends disagree about what a mismatch costs: WebGL logs a warning and
 * draws with the attribute missing, while WebGPU refuses the pipeline outright
 * and the mark stops rendering entirely. Neither failure is visible to the
 * headless view tests, which never build a shader — so the list is declared
 * ONCE here, the geometry is built from it, and `viz-brand-mark-shell` holds
 * both shader sources to it without needing a GPU.
 */
export const MARK_SHELL_ATTRIBUTES = [
  { name: 'aPosition', format: 'float32x2' },
  { name: 'aWorld', format: 'float32x3' },
  { name: 'aNormal', format: 'float32x3' },
  { name: 'aTint', format: 'float32x3' },
  { name: 'aSurface', format: 'float32x2' },
  { name: 'aMaterial', format: 'float32x4' },
  { name: 'aFinish', format: 'float32x3' },
  { name: 'aBary', format: 'float32x3' },
] as const;

/**
 * The shell's uniform block: every member, IN ORDER, with its WGSL type.
 *
 * The order is load-bearing and its violation is silent. Pixi lays the WebGPU
 * uniform buffer out from THIS list alone (`createUboElementsWGSL` walks the
 * declaration order applying std140 alignment) and never reads the hand-written
 * MarkUniforms struct in the shader — so if the two orders disagree, every
 * member past the first difference reads its neighbour's bytes. WebGL is immune:
 * it binds uniforms by name, one at a time, and does not care about order at all.
 *
 * That asymmetry already cost a whole debugging session. uPulse sat last here
 * and fourth-from-last in the struct, so uOpacityRef — the DENOMINATOR of every
 * facet's opacity — was served the pulse sine instead. It crosses zero, the
 * max(x, 1e-4) guard turned that into a multiply by ten thousand, and the four
 * wedges swung between clear and fully opaque every 1.9 seconds. On WebGPU only.
 * Every fix aimed at the shading was aimed at the wrong thing.
 *
 * `viz-brand-mark-shell` holds this list, the WGSL struct and the GLSL uniforms
 * to the same order and the same types, without needing a GPU.
 */
export const MARK_SHELL_UNIFORMS = [
  { name: 'uCore', type: 'vec3<f32>' },
  { name: 'uLightDir', type: 'vec3<f32>' },
  { name: 'uCoreTint', type: 'vec3<f32>' },
  // Pointer lamp in FRONT of the gem. xyz is model-space position; w is 0
  // when the cursor is away or inactive. Packed as vec4 so WebGPU cannot
  // hide `on` in the padding after a vec3 — that was a silent no-op.
  { name: 'uLamp', type: 'vec4<f32>' },
  { name: 'uCoreReach', type: 'f32' },
  { name: 'uCoreIntensity', type: 'f32' },
  { name: 'uAmbient', type: 'f32' },
  { name: 'uPulse', type: 'f32' },
  // The volume the four glasses are made OF: the wall's own depth, the shortest
  // path any facet can present, and plain glass's opacity over that path — the
  // reference every material is read against.
  { name: 'uWall', type: 'f32' },
  { name: 'uMinPath', type: 'f32' },
  { name: 'uOpacityRef', type: 'f32' },
  // CHROMATIC TRANSMISSION. How far apart the three channels are pulled when
  // sampling what lies behind a facet, and the size of one texel step in the
  // backdrop texture, so the offset is expressed in pixels rather than in a
  // unit that changes with the mark's scale.
  { name: 'uSplit', type: 'f32' },
  // How far a facet displaces what is behind it, and how strongly that
  // displaced interior is composited. Separate from uSplit on purpose: every
  // glass here refracts, only diamond disperses much.
  { name: 'uBend', type: 'f32' },
  { name: 'uMaxBend', type: 'f32' },
  // 1, and it should stay there: the facet now draws the transmitted image
  // itself, so anything above unity is the interior counted more than once.
  // It was 1.15 while the refraction was only a corrective difference.
  { name: 'uRefract', type: 'f32' },
  // 1 normally, 0 while the backdrop texture is being rendered — see
  // `setRefracting`. Both shells share this shader, so without the switch the
  // back facets sample the texture they are being drawn into.
  { name: 'uRefractOn', type: 'f32' },
  // Scene-wide scales for the two Schlick terms. The MATERIAL decides the
  // ratios between the four glasses; these only set how loud that whole family
  // is against the dark field, and neither may vary per material.
  { name: 'uSpecular', type: 'f32' },
  { name: 'uRim', type: 'f32' },
  { name: 'uLocalSize', type: 'f32' },
  { name: 'uBackdropTexel', type: 'vec2<f32>' },
  // Filament radius in MODEL units. The inner specular treats the bead as an
  // area light of this size, so a glint widens when the bead is against a wall
  // instead of staying a point-light needle.
  { name: 'uCoreRadius', type: 'f32' },
  // Local UV of the cursor in the 28×28 box: the catch follows this, not a
  // Blinn lobe the octahedron almost never fires.
  { name: 'uLampUv', type: 'vec2<f32>' },
  // Scene reflection. 1 when a Pixi env capture is bound; 0 on the header
  // mark and during the interior backdrop pass (shared shader).
  { name: 'uEnvOn', type: 'f32' },
  // How far a reflected ray travels across the env texture, in UV. Authored
  // so a downward facet on the arrival gate reaches the tagline and Continue.
  { name: 'uEnvJump', type: 'f32' },
  // Screen-space pointer in the SAME UV as vClipUv. z is 0 when the cursor
  // is away; w is a short jump so the reflected silhouette sits next to the
  // HTML cursor instead of under it. Packed as vec4 after two tightly packed
  // floats so WebGPU cannot insert padding between uEnvJump and this.
  { name: 'uPointerClip', type: 'vec4<f32>' },
] as const;

/**
 * Peak separation / displacement floors, in backdrop pixels. Authored against
 * a header-sized texture (~70px). The arrival gate's backdrop is hundreds of
 * pixels; a 3px ceiling there is a rounding error and the interior does not
 * shear at all.
 */
const CHROMATIC_SPLIT_FLOOR_PX = 2.4;
const REFRACTION_BEND_FLOOR_PX = 5.5;
const REFRACTION_MAX_BEND_FLOOR_PX = 3;
const CHROMATIC_SPLIT_FRACTION = 0.0045;
const REFRACTION_BEND_FRACTION = 0.038;
const REFRACTION_MAX_BEND_FRACTION = 0.024;

/** Bend/split/ceiling for a backdrop of `widthPx`. */
export function refractionForBackdrop(widthPx: number): {
  split: number;
  bend: number;
  maxBend: number;
} {
  const width = Math.max(0, widthPx);
  return {
    split: Math.max(CHROMATIC_SPLIT_FLOOR_PX, width * CHROMATIC_SPLIT_FRACTION),
    bend: Math.max(REFRACTION_BEND_FLOOR_PX, width * REFRACTION_BEND_FRACTION),
    maxBend: Math.max(REFRACTION_MAX_BEND_FLOOR_PX, width * REFRACTION_MAX_BEND_FRACTION),
  };
}

/** Initial value per uniform, built fresh per shell so buffers are not shared. */
const uniformValues: Record<
  (typeof MARK_SHELL_UNIFORMS)[number]['name'],
  () => Float32Array | number
> = {
  uCore: () => new Float32Array(3),
  uLightDir: () => new Float32Array(LIGHT_DIRECTION),
  uCoreTint: () => new Float32Array([0.87, 0.945, 1]),
  uLamp: () => new Float32Array([0, 0, ATOMA_MARK_LAMP_Z, 0]),
  uCoreReach: () => CORE_REACH_MODEL,
  uCoreIntensity: () => MARK_SHELL_CORE_INTENSITY,
  uAmbient: () => 0.15,
  uPulse: () => 0,
  uWall: () => ATOMA_MARK_THICKNESS,
  uMinPath: () => ATOMA_MARK_MIN_PATH,
  uOpacityRef: () => ATOMA_MARK_OPACITY_REFERENCE,
  uSplit: () => CHROMATIC_SPLIT_FLOOR_PX,
  uBend: () => REFRACTION_BEND_FLOOR_PX,
  uMaxBend: () => REFRACTION_MAX_BEND_FLOOR_PX,
  uRefract: () => 1,
  uRefractOn: () => 1,
  uSpecular: () => 2.7,
  uRim: () => 1.15,
  uLocalSize: () => ATOMA_MARK_LOCAL_SIZE,
  uBackdropTexel: () => new Float32Array([0, 0]),
  uCoreRadius: () => ATOMA_MARK_CORE_RADIUS / ATOMA_MARK_PROJECTION_SCALE,
  uLampUv: () => new Float32Array([0.5, 0.5]),
  uEnvOn: () => 0,
  uEnvJump: () => 0.42,
  uPointerClip: () => new Float32Array([0, 0, 0, 0.018]),
};

export interface MarkShell {
  /**
   * Hands the FRONT half the texture holding everything drawn behind it, plus
   * the size of one of its texels. Called once per resize, not per frame: the
   * texture object is stable, only its contents change.
   */
  setBackdrop(texture: Texture, widthPx: number, heightPx: number): void;
  /**
   * Hands the FRONT glass a screen-space capture of the Pixi scene WITHOUT
   * the gem. Empty texture + uEnvOn 0 keeps the layout valid when the header
   * mark skips the pass.
   */
  setEnv(texture: Texture, on: boolean): void;
  /**
   * Turns refraction sampling off for the duration of the backdrop pass. MUST
   * wrap that render: the back facets are outer facets too and share this
   * shader, so leaving it on feeds the texture back into itself.
   */
  setRefracting(on: boolean): void;
  /** Far hull and cavity behind the bead. Backdrop pass only. */
  back: ShellMesh;
  /** Cavity walls in front of the bead, still behind the front glass. Backdrop. */
  mid: ShellMesh;
  /** Camera-facing outer hull: the glass drawn in the scene. */
  front: ShellMesh;
  update(frame: AtomaMarkFrame, options?: {
    beadVisible?: boolean;
    lamp?: {
      position: readonly [number, number, number];
      uv: readonly [number, number];
      on: number;
    };
    pointerClip?: {
      uv: readonly [number, number];
      on: number;
    };
  }): void;
}

function channels(color: number): [number, number, number] {
  return [
    (color >> 16 & 0xff) / 255,
    (color >> 8 & 0xff) / 255,
    (color & 0xff) / 255,
  ];
}

/**
 * The shell as three Pixi meshes over ONE set of vertex buffers, differing
 * only in which facets their index buffer selects. Three rather than one
 * because the bead has to sit BETWEEN the far cavity and the near cavity
 * inside the backdrop, and the front glass has to stay in the scene even
 * when the bead has overtaken a camera-facing face in Z. A mesh cannot be
 * interleaved with a Pixi sprite, so the groups are separate draws.
 *
 * Returns null where no document exists: Pixi compiles a GLSL program by probing
 * a throwaway canvas, so the shader cannot be built in the headless view tests.
 * They cover geometry, layer order and the frame maths; the shell itself is
 * proven by `viz:smoke`, which runs it on a real WebGPU adapter AND on the WebGL
 * fallback.
 */
export function createMarkShell(): MarkShell | null {
  if (typeof document === 'undefined') return null;

  const positions = new Float32Array(VERTEX_COUNT * 2);
  const world = new Float32Array(VERTEX_COUNT * 3);
  const normals = new Float32Array(VERTEX_COUNT * 3);
  const tints = new Float32Array(VERTEX_COUNT * 3);
  const surfaces = new Float32Array(VERTEX_COUNT * 2);
  // The four glasses. Written ONCE: a rank's material is a property of the
  // crystal, not of the frame, so these buffers are never touched again.
  const materials = new Float32Array(VERTEX_COUNT * 4);
  const finishes = new Float32Array(VERTEX_COUNT * 3);
  const bary = new Float32Array(VERTEX_COUNT * 3);
  const baryCorners: readonly [number, number, number][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  // The outer/inner flag never changes; rank colour is fixed per facet but its
  // SHADE follows the facet's role in the current frame, so it is written with
  // the geometry rather than once here.
  const rankTints = ATOMA_MARK_MESH.facets.map((facet) =>
    channels(markColorForOctant(facet.octant)));
  for (const facet of ATOMA_MARK_MESH.facets) {
    const material = markMaterialForOctant(facet.octant);
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = facet.triangle * 3 + corner;
      surfaces[vertex * 2 + 1] = facet.part === 'outer' ? 1 : 0;
      // The shader receives DERIVED quantities, never the authored ones: the
      // exponent from roughness, the normal-incidence reflectance from the IOR,
      // and the bend strength from the IOR too. The derivation happens ONCE, on
      // the CPU, so the two shader programs cannot disagree about the formula.
      materials.set(
        [
          markSpecularPower(material.roughness),
          material.dispersion,
          markF0(material.ior),
          material.absorption,
        ],
        vertex * 4
      );
      finishes.set(
        [material.ior - 1, material.transmit, material.body],
        vertex * 3
      );
      bary.set(baryCorners[corner]!, vertex * 3);
    }
  }

  const positionBuffer = new Buffer({
    data: positions,
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
  });
  const worldBuffer = new Buffer({
    data: world,
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
  });
  const normalBuffer = new Buffer({
    data: normals,
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
  });
  const tintBuffer = new Buffer({
    data: tints,
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
  });
  const surfaceBuffer = new Buffer({
    data: surfaces,
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
  });
  // Static, so no COPY_DST: nothing ever writes to these again.
  const materialBuffer = new Buffer({ data: materials, usage: BufferUsage.VERTEX });
  const finishBuffer = new Buffer({ data: finishes, usage: BufferUsage.VERTEX });
  const baryBuffer = new Buffer({ data: bary, usage: BufferUsage.VERTEX });

  const buffers: Record<string, Buffer> = {
    aPosition: positionBuffer,
    aWorld: worldBuffer,
    aNormal: normalBuffer,
    aTint: tintBuffer,
    aSurface: surfaceBuffer,
    aMaterial: materialBuffer,
    aFinish: finishBuffer,
    aBary: baryBuffer,
  };
  const attributes = Object.fromEntries(MARK_SHELL_ATTRIBUTES.map(({ name, format }) => [
    name,
    { buffer: buffers[name]!, format },
  ]));

  // Fixed-size index buffers, padded with DEGENERATE triangles: the draw count
  // is part of the geometry, so a shorter group has to rasterise nothing rather
  // than shrink the buffer and reallocate one every frame.
  const backIndices = new Uint32Array(INDEX_COUNT);
  const midIndices = new Uint32Array(INDEX_COUNT);
  const frontIndices = new Uint32Array(INDEX_COUNT);
  const backGeometry = new Geometry({
    attributes,
    indexBuffer: new Buffer({
      data: backIndices,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    }),
    topology: 'triangle-list',
  });
  const midGeometry = new Geometry({
    attributes,
    indexBuffer: new Buffer({
      data: midIndices,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    }),
    topology: 'triangle-list',
  });
  const frontGeometry = new Geometry({
    attributes,
    indexBuffer: new Buffer({
      data: frontIndices,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    }),
    topology: 'triangle-list',
  });

  const shader = Shader.from({
    gl: {
      vertex: MARK_SHELL_GLSL_VERTEX,
      fragment: MARK_SHELL_GLSL,
    },
    gpu: {
      vertex: { source: MARK_SHELL_WGSL, entryPoint: 'mainVertex' },
      fragment: { source: MARK_SHELL_WGSL, entryPoint: 'mainFragment' },
    },
    resources: {
      markUniforms: Object.fromEntries(MARK_SHELL_UNIFORMS.map(({ name, type }) => [
        name,
        { value: uniformValues[name](), type },
      ])),
    },
  });

  // The backdrop starts EMPTY rather than absent. A resource that appears later
  // would change the bind-group layout mid-life, which WebGPU refuses; a 1x1
  // transparent texture keeps the layout fixed from the first draw, and a zero
  // texel size makes every channel sample the same point until a real texture
  // arrives — so the effect is inert, not wrong, before the first render pass.
  shader.resources['uBackdrop'] = Texture.EMPTY.source;
  shader.resources['uBackdropSampler'] = Texture.EMPTY.source.style;
  shader.resources['uEnv'] = Texture.EMPTY.source;
  shader.resources['uEnvSampler'] = Texture.EMPTY.source.style;

  const back = new Mesh({ geometry: backGeometry, shader });
  back.label = 'mark-shell-back';
  const mid = new Mesh({ geometry: midGeometry, shader });
  mid.label = 'mark-shell-mid';
  const front = new Mesh({ geometry: frontGeometry, shader });
  front.label = 'mark-shell-front';

  const uniforms = shader.resources['markUniforms'].uniforms as {
    uCore: Float32Array;
    uCoreIntensity: number;
    uPulse: number;
    uRefractOn: number;
    uBackdropTexel: Float32Array;
    uSplit: number;
    uBend: number;
    uMaxBend: number;
    uLamp: Float32Array;
    uLampUv: Float32Array;
    uEnvOn: number;
    uPointerClip: Float32Array;
  };

  const writeGroup = (indices: Uint32Array, group: readonly number[]) => {
    let cursor = 0;
    for (const facet of group) {
      const base = facet * 3;
      indices[cursor] = base;
      indices[cursor + 1] = base + 1;
      indices[cursor + 2] = base + 2;
      cursor += 3;
    }
    // Degenerate tail: three identical corners cover no pixels.
    indices.fill(0, cursor);
  };

  return {
    back,
    mid,
    front,
    setRefracting(on: boolean) {
      uniforms.uRefractOn = on ? 1 : 0;
    },
    setBackdrop(texture: Texture, widthPx: number, heightPx: number) {
      shader.resources['uBackdrop'] = texture.source;
      shader.resources['uBackdropSampler'] = texture.source.style;
      const texel = uniforms.uBackdropTexel;
      texel[0] = widthPx > 0 ? 1 / widthPx : 0;
      texel[1] = heightPx > 0 ? 1 / heightPx : 0;
      const refraction = refractionForBackdrop(widthPx);
      uniforms.uSplit = refraction.split;
      uniforms.uBend = refraction.bend;
      uniforms.uMaxBend = refraction.maxBend;
    },
    setEnv(texture: Texture, on: boolean) {
      shader.resources['uEnv'] = texture.source;
      shader.resources['uEnvSampler'] = texture.source.style;
      uniforms.uEnvOn = on ? 1 : 0;
    },
    update(frame: AtomaMarkFrame, options?: {
      beadVisible?: boolean;
      lamp?: {
        position: readonly [number, number, number];
        uv: readonly [number, number];
        on: number;
      };
      pointerClip?: {
        uv: readonly [number, number];
        on: number;
      };
    }) {
      const beadVisible = options?.beadVisible !== false;
      for (const [index, facet] of ATOMA_MARK_MESH.facets.entries()) {
        const shaded = frame.facets[index]!;
        const near = markFacetNearness(shaded.centroid[2]);
        // Outer facets ignore this: their coverage is derived in the shader.
        const alpha = facet.part === 'outer' ? 0 : ALPHA_INNER;
        const shade = SHADE_FAR + (SHADE_NEAR - SHADE_FAR) * near;
        const rank = rankTints[index]!;
        for (const [corner, point] of facet.points.entries()) {
          const vertex = facet.triangle * 3 + corner;
          const projected = frame.projected[point]!;
          positions[vertex * 2] = projected.x;
          positions[vertex * 2 + 1] = projected.y;
          const rotated = frame.points[point]!;
          world.set(rotated, vertex * 3);
          normals.set(shaded.normal, vertex * 3);
          surfaces[vertex * 2] = alpha;
          tints[vertex * 3] = rank[0] * shade;
          tints[vertex * 3 + 1] = rank[1] * shade;
          tints[vertex * 3 + 2] = rank[2] * shade;
        }
      }
      writeGroup(backIndices, beadVisible
        ? frame.backOrder
        : [...frame.backOrder, ...frame.midOrder]);
      writeGroup(midIndices, beadVisible ? frame.midOrder : []);
      writeGroup(frontIndices, frame.frontOrder);

      positionBuffer.update();
      worldBuffer.update();
      normalBuffer.update();
      surfaceBuffer.update();
      tintBuffer.update();
      backGeometry.indexBuffer.update();
      midGeometry.indexBuffer.update();
      frontGeometry.indexBuffer.update();

      if (beadVisible) {
        uniforms.uCore[0] = frame.core3[0];
        uniforms.uCore[1] = frame.core3[1];
        uniforms.uCore[2] = frame.core3[2];
        uniforms.uCoreIntensity = MARK_SHELL_CORE_INTENSITY;
        uniforms.uPulse = frame.pulse;
      } else {
        // Empty cavity: no filament in the texture, no analytic wall light,
        // no Z to split the hull against. The inspect checkbox is a kill
        // switch, not a hide-the-sprite.
        uniforms.uCore[0] = 0;
        uniforms.uCore[1] = 0;
        uniforms.uCore[2] = 0;
        uniforms.uCoreIntensity = 0;
        uniforms.uPulse = 0;
      }
      const lamp = options?.lamp;
      const lampOn = lamp && Number.isFinite(lamp.on) ? Math.max(0, lamp.on) : 0;
      if (lamp && lampOn > 0) {
        uniforms.uLamp[0] = lamp.position[0];
        uniforms.uLamp[1] = lamp.position[1];
        uniforms.uLamp[2] = lamp.position[2];
        uniforms.uLamp[3] = lampOn;
        uniforms.uLampUv[0] = lamp.uv[0];
        uniforms.uLampUv[1] = lamp.uv[1];
      } else {
        uniforms.uLamp[3] = 0;
      }
      const pointerClip = options?.pointerClip;
      const pointerOn = pointerClip && Number.isFinite(pointerClip.on)
        ? Math.max(0, pointerClip.on)
        : 0;
      if (pointerClip && pointerOn > 0) {
        uniforms.uPointerClip[0] = pointerClip.uv[0];
        uniforms.uPointerClip[1] = pointerClip.uv[1];
        uniforms.uPointerClip[2] = pointerOn;
      } else {
        uniforms.uPointerClip[2] = 0;
      }
    },
  };
}
