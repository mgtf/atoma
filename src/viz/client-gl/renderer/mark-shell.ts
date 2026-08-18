import { Buffer, BufferUsage, Geometry, Mesh, Shader } from 'pixi.js';

/** A mesh with our own geometry and program, not Pixi's textured default. */
type ShellMesh = Mesh<Geometry, Shader>;
import {
  ATOMA_MARK_CORE_LIGHT_RADIUS,
  ATOMA_MARK_MESH,
  ATOMA_MARK_PROJECTION_SCALE,
  markColorForOctant,
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
 * How opaque a facet is, by the role it plays in THIS frame rather than by
 * which hull it belongs to. Everything behind the bead is the interior the light
 * lands on and stays fairly solid; everything in front of it is the glass the
 * light is seen through. Swap them and the bead is a sticker again.
 */
const ALPHA_BEHIND_CORE = 0.88;
const ALPHA_IN_FRONT_OF_CORE = 0.52;

/**
 * How much of its own colour a facet keeps by role. The far side is the INTERIOR
 * of a dark crystal: leave it at full tint and every near facet composites with
 * a complementary hue behind it, which averages to grey — the mark loses the
 * rank colours exactly where it has the most of them. Dark behind, saturated in
 * front, and the bead's light is what brings the interior back up.
 */
const SHADE_BEHIND_CORE = 0.4;
const SHADE_IN_FRONT_OF_CORE = 1;

/** Model-space reach of the bead's light, converted from its projected radius. */
const CORE_REACH_MODEL = ATOMA_MARK_CORE_LIGHT_RADIUS / ATOMA_MARK_PROJECTION_SCALE;

const LIGHT_DIRECTION = ((): [number, number, number] => {
  const raw: [number, number, number] = [-0.38, 0.72, 1.05];
  const length = Math.hypot(...raw);
  return [raw[0] / length, raw[1] / length, raw[2] / length];
})();

export interface MarkShell {
  /** Facets behind the bead. Added to the scene BEFORE it. */
  back: ShellMesh;
  /** Facets in front of the bead: the glass it is seen through. */
  front: ShellMesh;
  update(frame: AtomaMarkFrame): void;
}

function channels(color: number): [number, number, number] {
  return [
    (color >> 16 & 0xff) / 255,
    (color >> 8 & 0xff) / 255,
    (color & 0xff) / 255,
  ];
}

/**
 * The shell as two Pixi meshes over ONE set of vertex buffers, differing only in
 * which facets their index buffer selects. Two meshes rather than one because
 * the bead has to be drawn between them, and a mesh cannot be interleaved with
 * anything.
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

  // The outer/inner flag never changes; rank colour is fixed per facet but its
  // SHADE follows the facet's role in the current frame, so it is written with
  // the geometry rather than once here.
  const rankTints = ATOMA_MARK_MESH.facets.map((facet) =>
    channels(markColorForOctant(facet.octant)));
  for (const facet of ATOMA_MARK_MESH.facets) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = facet.triangle * 3 + corner;
      surfaces[vertex * 2 + 1] = facet.part === 'outer' ? 1 : 0;
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

  const attributes = {
    aPosition: { buffer: positionBuffer, format: 'float32x2' },
    aWorld: { buffer: worldBuffer, format: 'float32x3' },
    aNormal: { buffer: normalBuffer, format: 'float32x3' },
    aTint: { buffer: tintBuffer, format: 'float32x3' },
    aSurface: { buffer: surfaceBuffer, format: 'float32x2' },
  } as const;

  // Fixed-size index buffers, padded with DEGENERATE triangles: the draw count
  // is part of the geometry, so a shorter group has to rasterise nothing rather
  // than shrink the buffer and reallocate one every frame.
  const backIndices = new Uint32Array(INDEX_COUNT);
  const frontIndices = new Uint32Array(INDEX_COUNT);
  const backGeometry = new Geometry({
    attributes,
    indexBuffer: new Buffer({
      data: backIndices,
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
      markUniforms: {
        uCore: { value: new Float32Array(3), type: 'vec3<f32>' },
        uLightDir: { value: new Float32Array(LIGHT_DIRECTION), type: 'vec3<f32>' },
        uCoreTint: { value: new Float32Array([0.87, 0.945, 1]), type: 'vec3<f32>' },
        uCoreReach: { value: CORE_REACH_MODEL, type: 'f32' },
        uCoreIntensity: { value: 1.35, type: 'f32' },
        uAmbient: { value: 0.34, type: 'f32' },
        uPulse: { value: 0, type: 'f32' },
      },
    },
  });

  const back = new Mesh({ geometry: backGeometry, shader });
  back.label = 'mark-shell-back';
  const front = new Mesh({ geometry: frontGeometry, shader });
  front.label = 'mark-shell-front';

  const uniforms = shader.resources['markUniforms'].uniforms as {
    uCore: Float32Array;
    uPulse: number;
  };

  const writeGroup = (
    indices: Uint32Array,
    order: readonly number[],
    from: number,
    to: number
  ) => {
    let cursor = 0;
    for (let entry = from; entry < to; entry += 1) {
      const base = order[entry]! * 3;
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
    front,
    update(frame: AtomaMarkFrame) {
      for (const [index, facet] of ATOMA_MARK_MESH.facets.entries()) {
        const shaded = frame.facets[index]!;
        const behindCore = frame.order.indexOf(index) < frame.coreSplit;
        const alpha = behindCore ? ALPHA_BEHIND_CORE : ALPHA_IN_FRONT_OF_CORE;
        const shade = behindCore ? SHADE_BEHIND_CORE : SHADE_IN_FRONT_OF_CORE;
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
      writeGroup(backIndices, frame.order, 0, frame.coreSplit);
      writeGroup(frontIndices, frame.order, frame.coreSplit, frame.order.length);

      positionBuffer.update();
      worldBuffer.update();
      normalBuffer.update();
      surfaceBuffer.update();
      tintBuffer.update();
      backGeometry.indexBuffer.update();
      frontGeometry.indexBuffer.update();

      uniforms.uCore[0] = frame.core3[0];
      uniforms.uCore[1] = frame.core3[1];
      uniforms.uCore[2] = frame.core3[2];
      uniforms.uPulse = frame.pulse;
    },
  };
}
