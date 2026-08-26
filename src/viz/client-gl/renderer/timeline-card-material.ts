import {
  Assets,
  Buffer,
  BufferUsage,
  Container,
  Geometry,
  Mesh,
  Shader,
  Texture,
} from 'pixi.js';

const FACE_VERTEX_COUNT = 9;
const FACE_INDEX_COUNT = 24;
const FLOATS_PER_VERTEX = 8;
const VERTEX_STRIDE_BYTES = FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;
const INITIAL_FACE_CAPACITY = 8;

export const TIMELINE_CARD_MATERIAL_LABEL = 'timeline-card-material-batch';

export const TIMELINE_CARD_MATERIAL_ATTRIBUTES = [
  { name: 'aPosition', format: 'float32x2' },
  { name: 'aMaterialPx', format: 'float32x2' },
  { name: 'aBaseColor', format: 'float32x4' },
] as const;

export const TIMELINE_CARD_MATERIAL_UNIFORMS = [
  { name: 'uLightPx', type: 'vec2<f32>' },
  { name: 'uLightStrength', type: 'f32' },
] as const;

export const TIMELINE_CARD_MATERIAL_WGSL = /* wgsl */ `
  struct GlobalUniforms {
    uProjectionMatrix: mat3x3<f32>,
    uWorldTransformMatrix: mat3x3<f32>,
    uWorldColorAlpha: vec4<f32>,
    uResolution: vec2<f32>,
  }

  struct LocalUniforms {
    uTransformMatrix: mat3x3<f32>,
    uColor: vec4<f32>,
    uRound: f32,
  }

  struct TimelineCardUniforms {
    uLightPx: vec2<f32>,
    uLightStrength: f32,
  }

  @group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
  @group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
  @group(2) @binding(0) var<uniform> timelineCardUniforms: TimelineCardUniforms;
  @group(2) @binding(1) var uSandDiffuse: texture_2d<f32>;
  @group(2) @binding(2) var uSandDiffuseSampler: sampler;
  @group(2) @binding(3) var uSandNormal: texture_2d<f32>;
  @group(2) @binding(4) var uSandNormalSampler: sampler;

  struct VertexInput {
    @location(0) aPosition: vec2<f32>,
    @location(1) aMaterialPx: vec2<f32>,
    @location(2) aBaseColor: vec4<f32>,
  }

  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vMaterialPx: vec2<f32>,
    @location(1) vScreenPx: vec2<f32>,
    @location(2) vColor: vec4<f32>,
  }

  @vertex
  fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let worldMatrix = globalUniforms.uWorldTransformMatrix *
      localUniforms.uTransformMatrix;
    let world = worldMatrix * vec3<f32>(input.aPosition, 1.0);
    let clip = globalUniforms.uProjectionMatrix * world;
    out.position = vec4<f32>(clip.xy, 0.0, 1.0);
    out.vMaterialPx = input.aMaterialPx;
    out.vScreenPx = world.xy;
    out.vColor = input.aBaseColor * localUniforms.uColor *
      globalUniforms.uWorldColorAlpha;
    return out;
  }

  @fragment
  fn mainFragment(
    @location(0) vMaterialPx: vec2<f32>,
    @location(1) vScreenPx: vec2<f32>,
    @location(2) vColor: vec4<f32>,
  ) -> @location(0) vec4<f32> {
    // Both bitmaps describe the same CC0 sand surface, so one correlated UV
    // preserves their authored detail. This is two reads total per pixel.
    let materialUv = vMaterialPx / 173.0;
    let grain = textureSample(
      uSandDiffuse,
      uSandDiffuseSampler,
      materialUv
    ).r;
    let mapped = textureSample(
      uSandNormal,
      uSandNormalSampler,
      materialUv
    ).xyz * 2.0 - vec3<f32>(1.0);
    let surfaceNormal = normalize(vec3<f32>(
      mapped.xy * 0.44,
      max(0.28, mapped.z)
    ));

    let ambientLight = normalize(vec3<f32>(-0.46, -0.72, 0.82));
    let pointerLight = normalize(vec3<f32>(
      timelineCardUniforms.uLightPx - vScreenPx,
      112.0
    ));
    let pointerMix = min(0.78, timelineCardUniforms.uLightStrength * 0.72);
    let lightDirection = normalize(mix(ambientLight, pointerLight, pointerMix));
    let diffuseLight = max(0.0, dot(surfaceNormal, lightDirection));

    let grainGain = mix(0.92, 1.055, grain);
    let reliefGain = 1.0 + (diffuseLight - 0.78) *
      (0.13 + pointerMix * 0.04);
    let viewDirection = vec3<f32>(0.0, 0.0, 1.0);
    let halfVector = normalize(lightDirection + viewDirection);
    // The diffuse grain is also a roughness proxy. That gives the normal map
    // a varied specular response without paying for a third bitmap sample.
    let glossExponent = mix(52.0, 28.0, grain);
    let specular = pow(max(dot(surfaceNormal, halfVector), 0.0), glossExponent) *
      (0.016 + pointerMix * 0.050);
    let lit = max(vColor.rgb * grainGain * reliefGain, vec3<f32>(0.0)) +
      vec3<f32>(0.86, 0.94, 1.0) * specular;
    let alpha = clamp(vColor.a, 0.0, 1.0);
    return vec4<f32>(lit * alpha, alpha);
  }
`;

export const TIMELINE_CARD_MATERIAL_GLSL_VERTEX = /* glsl */ `#version 300 es
  in vec2 aPosition;
  in vec2 aMaterialPx;
  in vec4 aBaseColor;

  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;
  uniform vec4 uColor;
  uniform vec4 uWorldColorAlpha;

  out vec2 vMaterialPx;
  out vec2 vScreenPx;
  out vec4 vColor;

  void main() {
    mat3 worldMatrix = uWorldTransformMatrix * uTransformMatrix;
    vec3 world = worldMatrix * vec3(aPosition, 1.0);
    vec3 clip = uProjectionMatrix * world;
    gl_Position = vec4(clip.xy, 0.0, 1.0);
    vMaterialPx = aMaterialPx;
    vScreenPx = world.xy;
    vColor = aBaseColor * uColor * uWorldColorAlpha;
  }
`;

export const TIMELINE_CARD_MATERIAL_GLSL = /* glsl */ `#version 300 es
  precision highp float;

  in vec2 vMaterialPx;
  in vec2 vScreenPx;
  in vec4 vColor;

  uniform vec2 uLightPx;
  uniform float uLightStrength;
  uniform sampler2D uSandDiffuse;
  uniform sampler2D uSandNormal;

  out vec4 finalColor;

  void main() {
    vec2 materialUv = vMaterialPx / 173.0;
    float grain = texture(uSandDiffuse, materialUv).r;
    vec3 mapped = texture(uSandNormal, materialUv).xyz * 2.0 - 1.0;
    vec3 surfaceNormal = normalize(vec3(
      mapped.xy * 0.44,
      max(0.28, mapped.z)
    ));

    vec3 ambientLight = normalize(vec3(-0.46, -0.72, 0.82));
    vec3 pointerLight = normalize(vec3(uLightPx - vScreenPx, 112.0));
    float pointerMix = min(0.78, uLightStrength * 0.72);
    vec3 lightDirection = normalize(mix(ambientLight, pointerLight, pointerMix));
    float diffuseLight = max(0.0, dot(surfaceNormal, lightDirection));

    float grainGain = mix(0.92, 1.055, grain);
    float reliefGain = 1.0 + (diffuseLight - 0.78) *
      (0.13 + pointerMix * 0.04);
    vec3 viewDirection = vec3(0.0, 0.0, 1.0);
    vec3 halfVector = normalize(lightDirection + viewDirection);
    float glossExponent = mix(52.0, 28.0, grain);
    float specular = pow(max(dot(surfaceNormal, halfVector), 0.0), glossExponent) *
      (0.016 + pointerMix * 0.050);
    vec3 lit = max(vColor.rgb * grainGain * reliefGain, vec3(0.0)) +
      vec3(0.86, 0.94, 1.0) * specular;
    float alpha = clamp(vColor.a, 0.0, 1.0);
    finalColor = vec4(lit * alpha, alpha);
  }
`;

interface TimelineCardUniformValues {
  uLightPx: Float32Array;
  uLightStrength: number;
}

interface DiagnosticTimelineMaterialMesh extends Mesh<Geometry, Shader> {
  /** Read-only browser-smoke evidence for the faces held by this one draw. */
  timelineCardIds: string[];
  timelineCardCount: number;
}

export interface TimelineCardMaterialLayers {
  underlay: Container;
  overlay: Container;
}

export interface TimelineCardFaceOptions {
  id: string;
  width: number;
  height: number;
  chamfer: number;
  color: number;
  alpha: number;
  x: number;
  y: number;
  scaleX?: number;
  scaleY?: number;
  skewX?: number;
}

export interface TimelineCardMaterialFace {
  update(
    x: number,
    y: number,
    scaleX: number,
    scaleY: number,
    skewX: number,
    color: number,
    alpha: number
  ): void;
}

function createIndexData(capacity: number): Uint32Array {
  const indices = new Uint32Array(capacity * FACE_INDEX_COUNT);
  for (let face = 0; face < capacity; face += 1) {
    const vertexBase = face * FACE_VERTEX_COUNT;
    const indexBase = face * FACE_INDEX_COUNT;
    for (let corner = 0; corner < 8; corner += 1) {
      const offset = indexBase + corner * 3;
      indices[offset] = vertexBase;
      indices[offset + 1] = vertexBase + corner + 1;
      indices[offset + 2] = vertexBase + (corner + 1) % 8 + 1;
    }
  }
  return indices;
}

function localFacePoints(width: number, height: number, chamfer: number): Float32Array {
  return new Float32Array([
    width / 2, height / 2,
    chamfer, 0,
    width - chamfer, 0,
    width, chamfer,
    width, height - chamfer,
    width - chamfer, height,
    chamfer, height,
    0, height - chamfer,
    0, chamfer,
  ]);
}

function materialPhase(id: string): readonly [number, number] {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  }
  return [(hash & 0xffff) % 173, (hash >>> 16) % 173];
}

/**
 * One persistent shader, geometry and mesh for every visible RUNS card.
 *
 * The card chrome remains ordinary Graphics in two scene-owned layers. Only
 * the material faces live here, so diffuse + normal cost one direct draw and
 * no card-sized render texture. Fixed-capacity index buffers use transparent,
 * degenerate tail faces; changing the visible count never reallocates them.
 */
export class TimelineCardMaterial {
  readonly shader: Shader;
  readonly geometry: Geometry;
  readonly mesh: DiagnosticTimelineMaterialMesh;
  private readonly uniforms: TimelineCardUniformValues;
  private vertexData = new Float32Array(
    INITIAL_FACE_CAPACITY * FACE_VERTEX_COUNT * FLOATS_PER_VERTEX
  );
  private indexData = createIndexData(INITIAL_FACE_CAPACITY);
  private readonly vertexBuffer: Buffer;
  private readonly indexBuffer: Buffer;
  private capacity = INITIAL_FACE_CAPACITY;
  private faceCount = 0;
  private generation = 0;
  private dirty = false;
  private stack: Container | null = null;
  private layers: TimelineCardMaterialLayers | null = null;
  private uniformBufferPinned = false;

  constructor(diffuse: Texture, normal: Texture) {
    this.vertexBuffer = new Buffer({
      data: this.vertexData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label: 'timeline-card-material-vertices',
      shrinkToFit: false,
    });
    this.indexBuffer = new Buffer({
      data: this.indexData,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
      label: 'timeline-card-material-indices',
      shrinkToFit: false,
    });
    // Persistent resources must not age out while WebGL remains on a quiet
    // non-RUNS view. WebGPU GC is disabled globally for the Pixi 8.19 bug,
    // but the material owns its lifetime on both backends.
    this.vertexBuffer.autoGarbageCollect = false;
    this.indexBuffer.autoGarbageCollect = false;
    this.geometry = new Geometry({
      attributes: {
        aPosition: {
          buffer: this.vertexBuffer,
          format: 'float32x2',
          stride: VERTEX_STRIDE_BYTES,
          offset: 0,
        },
        aMaterialPx: {
          buffer: this.vertexBuffer,
          format: 'float32x2',
          stride: VERTEX_STRIDE_BYTES,
          offset: 2 * Float32Array.BYTES_PER_ELEMENT,
        },
        aBaseColor: {
          buffer: this.vertexBuffer,
          format: 'float32x4',
          stride: VERTEX_STRIDE_BYTES,
          offset: 4 * Float32Array.BYTES_PER_ELEMENT,
        },
      },
      indexBuffer: this.indexBuffer,
      topology: 'triangle-list',
    });
    this.geometry.autoGarbageCollect = false;

    this.shader = Shader.from({
      gl: {
        vertex: TIMELINE_CARD_MATERIAL_GLSL_VERTEX,
        fragment: TIMELINE_CARD_MATERIAL_GLSL,
      },
      gpu: {
        vertex: { source: TIMELINE_CARD_MATERIAL_WGSL, entryPoint: 'mainVertex' },
        fragment: { source: TIMELINE_CARD_MATERIAL_WGSL, entryPoint: 'mainFragment' },
      },
      resources: {
        timelineCardUniforms: {
          uLightPx: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uLightStrength: { value: 0, type: 'f32' },
        },
        uSandDiffuse: diffuse.source,
        uSandDiffuseSampler: diffuse.source.style,
        uSandNormal: normal.source,
        uSandNormalSampler: normal.source.style,
      },
    });
    this.uniforms = this.shader.resources['timelineCardUniforms']
      .uniforms as TimelineCardUniformValues;
    this.mesh = new Mesh({ geometry: this.geometry, shader: this.shader }) as
      DiagnosticTimelineMaterialMesh;
    this.mesh.label = TIMELINE_CARD_MATERIAL_LABEL;
    this.mesh.timelineCardIds = [];
    this.mesh.timelineCardCount = 0;
    this.mesh.eventMode = 'none';
    this.mesh.visible = false;
  }

  /** Detach the retained mesh before the old scene recursively destroys. */
  beginRender(): void {
    this.mesh.removeFromParent();
    this.stack = null;
    this.layers = null;
    this.generation += 1;
    this.faceCount = 0;
    this.mesh.timelineCardIds.length = 0;
    this.mesh.timelineCardCount = 0;
    this.mesh.visible = false;
    // Old faces are still part of the fixed index draw. Zeroing every slot
    // makes its tail transparent and degenerate when the next view has fewer
    // visible cards than this one.
    this.vertexData.fill(0);
    this.dirty = true;
  }

  layersFor(parent: Container): TimelineCardMaterialLayers {
    if (this.stack) {
      if (this.stack.parent !== parent) {
        throw new Error('timeline card material cannot span multiple parents in one render');
      }
      return this.layers!;
    }
    const stack = new Container();
    stack.label = 'timeline-card-stack';
    stack.eventMode = 'passive';
    const underlay = new Container();
    underlay.label = 'timeline-card-underlay';
    underlay.eventMode = 'none';
    const overlay = new Container();
    overlay.label = 'timeline-card-overlay';
    overlay.eventMode = 'passive';
    stack.addChild(underlay, this.mesh, overlay);
    parent.addChild(stack);
    this.stack = stack;
    this.layers = { underlay, overlay };
    return this.layers;
  }

  createFace(options: TimelineCardFaceOptions): TimelineCardMaterialFace {
    const index = this.faceCount;
    this.ensureCapacity(index + 1);
    this.faceCount += 1;
    this.mesh.timelineCardIds.push(options.id);
    this.mesh.timelineCardCount = this.faceCount;
    this.mesh.visible = true;
    const points = localFacePoints(options.width, options.height, options.chamfer);
    const phase = materialPhase(options.id);
    const generation = this.generation;
    let previous: readonly number[] | null = null;
    const update = (
      x: number,
      y: number,
      scaleX: number,
      scaleY: number,
      skewX: number,
      color: number,
      alpha: number
    ): void => {
      if (generation !== this.generation || index >= this.faceCount) return;
      const next = [x, y, scaleX, scaleY, skewX, color, alpha] as const;
      if (previous?.every((value, stateIndex) => value === next[stateIndex])) return;
      previous = next;
      this.writeFace(
        index,
        points,
        phase,
        x,
        y,
        scaleX,
        scaleY,
        skewX,
        color,
        alpha
      );
    };
    update(
      options.x,
      options.y,
      options.scaleX ?? 1,
      options.scaleY ?? 1,
      options.skewX ?? 0,
      options.color,
      options.alpha
    );
    return { update };
  }

  updateLight(x: number, y: number, strength: number): void {
    this.uniforms.uLightPx[0] = x;
    this.uniforms.uLightPx[1] = y;
    this.uniforms.uLightStrength = strength;
    if (this.uniformBufferPinned) return;
    // Pixi creates the UBO lazily on the first shader sync.
    const group = this.shader.resources['timelineCardUniforms'] as unknown as {
      buffer?: { autoGarbageCollect: boolean };
    };
    if (group.buffer) {
      group.buffer.autoGarbageCollect = false;
      this.uniformBufferPinned = true;
    }
  }

  /** One upload after every card animation callback and before Pixi renders. */
  flush(): void {
    if (!this.dirty) return;
    this.vertexBuffer.update(this.vertexData.byteLength);
    this.dirty = false;
  }

  destroy(): void {
    this.mesh.removeFromParent();
    if (!this.mesh.destroyed) this.mesh.destroy();
    this.geometry.destroy(true);
    this.shader.destroy();
    this.stack = null;
    this.layers = null;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.capacity) return;
    let capacity = this.capacity;
    while (capacity < required) capacity *= 2;
    const vertices = new Float32Array(
      capacity * FACE_VERTEX_COUNT * FLOATS_PER_VERTEX
    );
    vertices.set(this.vertexData);
    const indices = createIndexData(capacity);
    this.capacity = capacity;
    this.vertexData = vertices;
    this.indexData = indices;
    this.vertexBuffer.data = vertices;
    this.indexBuffer.data = indices;
  }

  private writeFace(
    index: number,
    points: Float32Array,
    phase: readonly [number, number],
    x: number,
    y: number,
    scaleX: number,
    scaleY: number,
    skewX: number,
    color: number,
    alpha: number
  ): void {
    // Same zero-rotation/skew-Y transform Pixi applies to the two chrome
    // containers. Baking it into the shared mesh keeps all three layers
    // registered during entrance, hover and press motion.
    const a = scaleX;
    const c = Math.sin(skewX) * scaleY;
    const d = Math.cos(skewX) * scaleY;
    const red = (color >> 16 & 0xff) / 0xff;
    const green = (color >> 8 & 0xff) / 0xff;
    const blue = (color & 0xff) / 0xff;
    const opacity = Math.max(0, Math.min(1, alpha));
    let write = index * FACE_VERTEX_COUNT * FLOATS_PER_VERTEX;
    for (let point = 0; point < FACE_VERTEX_COUNT; point += 1) {
      const localX = points[point * 2]!;
      const localY = points[point * 2 + 1]!;
      this.vertexData[write] = x + localX * a + localY * c;
      this.vertexData[write + 1] = y + localY * d;
      // Object-space UVs move with the card instead of swimming over it while
      // scrolling. The stable id phase keeps adjacent faces from cloning the
      // same patch of sand.
      this.vertexData[write + 2] = localX + phase[0];
      this.vertexData[write + 3] = localY + phase[1];
      this.vertexData[write + 4] = red;
      this.vertexData[write + 5] = green;
      this.vertexData[write + 6] = blue;
      this.vertexData[write + 7] = opacity;
      write += FLOATS_PER_VERTEX;
    }
    this.dirty = true;
  }
}

export async function loadTimelineCardMaterial(): Promise<TimelineCardMaterial> {
  const [diffuse, normal] = await Promise.all([
    Assets.load<Texture>('/textures/timeline-sand-diffuse.webp'),
    Assets.load<Texture>('/textures/timeline-sand-normal.png'),
  ]);
  diffuse.label = 'timeline-sand-diffuse';
  diffuse.source.label = 'timeline-sand-diffuse';
  diffuse.source.style.addressMode = 'repeat';
  diffuse.source.style.update();
  normal.label = 'timeline-sand-normal';
  normal.source.label = 'timeline-sand-normal';
  normal.source.style.addressMode = 'repeat';
  normal.source.style.update();
  return new TimelineCardMaterial(diffuse, normal);
}
