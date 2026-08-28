import { Buffer, BufferUsage, Geometry, Mesh, Shader } from 'pixi.js';

/** A mesh with our own geometry and program, not Pixi's textured default. */
type FieldMesh = Mesh<Geometry, Shader>;
import {
  packMarkCaustic,
  readMarkFieldCaustic,
  readMarkFieldLight,
} from '../mark-field-light.js';
import {
  CAUSTIC_CORNER_SLOTS,
  CAUSTIC_FIELD_GLSL,
  CAUSTIC_FIELD_WGSL,
  CAUSTIC_SECONDARY_CORNER_SLOTS,
  CAUSTIC_SECONDARY_SPECTRAL_SLOTS,
  CAUSTIC_SPECTRAL_SLOTS,
} from './caustic-shader.js';
import {
  pointerClientToRenderer,
  readPointerLight,
  type PointerLightBounds,
} from '../pointer-light.js';
import { effectiveFarAlpha, VIZ_VISUAL_DEPTH } from '../visual-depth.js';
import { prefersReducedMotion } from './motion.js';
import { readTuning } from '../tuning-live.js';

/** Survives `ambientRoot.removeChildren()` so the aurora is not rebuilt every scene. */
export const FAR_FIELD_LABEL = 'far-field';

/**
 * How quickly the pointer stain eases on the field. Same lambda the Three.js
 * backdrop used (`MathUtils.damp(..., 14, dt)`).
 */
const POINTER_DAMP_LAMBDA = 14;

const C = {
  markGain: VIZ_VISUAL_DEPTH.far.markGain.toFixed(2),
  motionRate: VIZ_VISUAL_DEPTH.far.motionRate.toFixed(3),
  gridFrequency: VIZ_VISUAL_DEPTH.far.gridFrequency.toFixed(1),
  colorGain: VIZ_VISUAL_DEPTH.far.colorGain.toFixed(2),
  pointerHalo: VIZ_VISUAL_DEPTH.far.pointerHaloRadius.toFixed(1),
  pointerCore: VIZ_VISUAL_DEPTH.far.pointerCoreRadius.toFixed(1),
  pointerGain: VIZ_VISUAL_DEPTH.far.pointerGain.toFixed(2),
  fieldAlpha: effectiveFarAlpha().toFixed(4),
};

export const FAR_FIELD_ATTRIBUTES = [
  { name: 'aPosition', format: 'float32x2' },
] as const;

/**
 * Uniform block IN ORDER. Pixi lays the WebGPU UBO from this list alone;
 * the hand-written FarFieldUniforms struct must match or every member past
 * the first difference reads its neighbour. Mark colors are vec4 so a vec3
 * cannot hide the next float in padding.
 */
export const FAR_FIELD_UNIFORMS = [
  { name: 'uTime', type: 'f32' },
  { name: 'uPointerStrength', type: 'f32' },
  { name: 'uResolution', type: 'vec2<f32>' },
  { name: 'uPointerUv', type: 'vec2<f32>' },
  { name: 'uMark0', type: 'vec4<f32>' },
  { name: 'uMark1', type: 'vec4<f32>' },
  { name: 'uMark2', type: 'vec4<f32>' },
  { name: 'uMark3', type: 'vec4<f32>' },
  { name: 'uMarkColor0', type: 'vec4<f32>' },
  { name: 'uMarkColor1', type: 'vec4<f32>' },
  { name: 'uMarkColor2', type: 'vec4<f32>' },
  { name: 'uMarkColor3', type: 'vec4<f32>' },
  { name: 'uCaustic0', type: 'vec4<f32>' },
  { name: 'uCaustic1', type: 'vec4<f32>' },
  { name: 'uCaustic2', type: 'vec4<f32>' },
  { name: 'uCaustic3', type: 'vec4<f32>' },
  { name: 'uCaustic4', type: 'vec4<f32>' },
  { name: 'uCaustic5', type: 'vec4<f32>' },
  { name: 'uCausticOptics0', type: 'vec4<f32>' },
  { name: 'uCausticOptics1', type: 'vec4<f32>' },
  { name: 'uCausticOptics2', type: 'vec4<f32>' },
  { name: 'uCausticOptics3', type: 'vec4<f32>' },
  // The spectral half-separation per corner, two corners per vec4: red draws
  // at corner + delta, blue at corner − delta. `uCausticBand` scales how far
  // apart the two wavelengths are drawn — 1 is the traced band, 0 collapses
  // them onto the mean trace. Detail independently sharpens/fades folds.
  { name: 'uCausticSpec0', type: 'vec4<f32>' },
  { name: 'uCausticSpec1', type: 'vec4<f32>' },
  { name: 'uCausticSpec2', type: 'vec4<f32>' },
  { name: 'uCausticSpec3', type: 'vec4<f32>' },
  { name: 'uCausticSpec4', type: 'vec4<f32>' },
  { name: 'uCausticSpec5', type: 'vec4<f32>' },
  { name: 'uCausticSecondary0', type: 'vec4<f32>' },
  { name: 'uCausticSecondary1', type: 'vec4<f32>' },
  { name: 'uCausticSecondarySpec0', type: 'vec4<f32>' },
  { name: 'uCausticSecondarySpec1', type: 'vec4<f32>' },
  { name: 'uCausticSecondaryOptics', type: 'vec4<f32>' },
  { name: 'uCausticBand', type: 'f32' },
  { name: 'uCausticDetail', type: 'f32' },
] as const;

const uniformValues: Record<
  (typeof FAR_FIELD_UNIFORMS)[number]['name'],
  () => Float32Array | number
> = {
  uTime: () => 0,
  uPointerStrength: () => 0,
  uResolution: () => new Float32Array([1, 1]),
  uPointerUv: () => new Float32Array([-2, -2]),
  uMark0: () => new Float32Array([0, 0, 0, 1]),
  uMark1: () => new Float32Array([0, 0, 0, 1]),
  uMark2: () => new Float32Array([0, 0, 0, 1]),
  uMark3: () => new Float32Array([0, 0, 0, 1]),
  uMarkColor0: () => new Float32Array(4),
  uMarkColor1: () => new Float32Array(4),
  uMarkColor2: () => new Float32Array(4),
  uMarkColor3: () => new Float32Array(4),
  uCaustic0: () => new Float32Array([-1e6, -1e6, -1e6, -1e6]),
  uCaustic1: () => new Float32Array([-1e6, -1e6, -1e6, -1e6]),
  uCaustic2: () => new Float32Array([-1e6, -1e6, -1e6, -1e6]),
  uCaustic3: () => new Float32Array([-1e6, -1e6, -1e6, -1e6]),
  uCaustic4: () => new Float32Array([-1e6, -1e6, -1e6, -1e6]),
  uCaustic5: () => new Float32Array([-1e6, -1e6, -1e6, -1e6]),
  uCausticOptics0: () => new Float32Array(4),
  uCausticOptics1: () => new Float32Array(4),
  uCausticOptics2: () => new Float32Array(4),
  uCausticOptics3: () => new Float32Array(4),
  uCausticSpec0: () => new Float32Array(4),
  uCausticSpec1: () => new Float32Array(4),
  uCausticSpec2: () => new Float32Array(4),
  uCausticSpec3: () => new Float32Array(4),
  uCausticSpec4: () => new Float32Array(4),
  uCausticSpec5: () => new Float32Array(4),
  uCausticSecondary0: () => new Float32Array([-1e6, -1e6, -1e6, -1e6]),
  uCausticSecondary1: () => new Float32Array([-1e6, -1e6, -1e6, -1e6]),
  uCausticSecondarySpec0: () => new Float32Array(4),
  uCausticSecondarySpec1: () => new Float32Array(4),
  uCausticSecondaryOptics: () => new Float32Array(4),
  uCausticBand: () => 1,
  uCausticDetail: () => 1,
};

export const FAR_FIELD_GLSL_VERTEX = /* glsl */ `#version 300 es
  in vec2 aPosition;
  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;
  out vec2 vUv;
  out vec2 vScreenUv;

  void main() {
    mat3 matrix = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    vec3 clip = matrix * vec3(aPosition, 1.0);
    gl_Position = vec4(clip.xy, 0.0, 1.0);
    vUv = aPosition;
    vScreenUv = vec2(aPosition.x, 1.0 - aPosition.y);
  }
`;

export const FAR_FIELD_GLSL = /* glsl */ `#version 300 es
  precision highp float;
  in vec2 vUv;
  in vec2 vScreenUv;
  out vec4 finalColor;
  uniform float uTime;
  uniform float uPointerStrength;
  uniform vec2 uResolution;
  uniform vec2 uPointerUv;
  uniform vec4 uMark0;
  uniform vec4 uMark1;
  uniform vec4 uMark2;
  uniform vec4 uMark3;
  uniform vec4 uMarkColor0;
  uniform vec4 uMarkColor1;
  uniform vec4 uMarkColor2;
  uniform vec4 uMarkColor3;
  uniform vec4 uCaustic0;
  uniform vec4 uCaustic1;
  uniform vec4 uCaustic2;
  uniform vec4 uCaustic3;
  uniform vec4 uCaustic4;
  uniform vec4 uCaustic5;
  uniform vec4 uCausticOptics0;
  uniform vec4 uCausticOptics1;
  uniform vec4 uCausticOptics2;
  uniform vec4 uCausticOptics3;
  uniform vec4 uCausticSpec0;
  uniform vec4 uCausticSpec1;
  uniform vec4 uCausticSpec2;
  uniform vec4 uCausticSpec3;
  uniform vec4 uCausticSpec4;
  uniform vec4 uCausticSpec5;
  uniform vec4 uCausticSecondary0;
  uniform vec4 uCausticSecondary1;
  uniform vec4 uCausticSecondarySpec0;
  uniform vec4 uCausticSecondarySpec1;
  uniform vec4 uCausticSecondaryOptics;
  uniform float uCausticBand;
  uniform float uCausticDetail;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), f.x),
      f.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
      value += amplitude * noise(p);
      p = p * 2.03 + vec2(13.7, 9.2);
      amplitude *= 0.5;
    }
    return value;
  }

  vec3 stainedField(vec2 screenUv, vec2 resolution, vec4 mark, vec3 tint) {
    if (mark.z < 0.001) return vec3(0.0);
    vec2 delta = (screenUv - mark.xy) * resolution;
    float dist = length(delta) / max(mark.w, 1.0);
    float halo = exp(-3.2 * dist * dist);
    float core = exp(-8.0 * dist * dist);
    return tint * mark.z * ${C.markGain} * (halo * 0.48 + core * 0.18);
  }

${CAUSTIC_FIELD_GLSL}

  void main() {
    float aspect = uResolution.x / max(1.0, uResolution.y);
    vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
    float t = uTime * ${C.motionRate};

    float fieldA = fbm(p * 3.2 + vec2(t, -t * 0.7));
    float fieldB = fbm(p * 5.6 - vec2(t * 0.8, t));
    float aurora = smoothstep(0.25, 0.9, fieldA * 0.8 + fieldB * 0.42);

    vec2 gridUv = abs(fract((p + 0.5) * ${C.gridFrequency}) - 0.5) /
      fwidth(p * ${C.gridFrequency});
    float grid = 1.0 - min(min(gridUv.x, gridUv.y), 1.0);
    grid *= 0.022 + 0.016 * sin(uTime * 0.24 + p.y * 20.0);

    float radial = exp(-2.7 * dot(p, p));
    float scan = pow(max(0.0, sin((p.y + t) * 42.0)), 28.0) * 0.055;
    float star = step(0.9975, hash(floor((p + t * 0.04) * 150.0)));

    vec3 navy = vec3(0.012, 0.025, 0.065);
    vec3 blue = vec3(0.055, 0.26, 0.58);
    vec3 cyan = vec3(0.08, 0.72, 0.78);
    vec3 violet = vec3(0.38, 0.12, 0.72);
    vec3 color = navy;
    color += mix(blue, violet, fieldB) * aurora * 0.2;
    color += cyan * radial * (0.042 + fieldA * 0.03);
    color += vec3(0.28, 0.52, 0.9) * grid;
    color += cyan * scan * 0.72;
    color += vec3(0.7, 0.86, 1.0) * star * 0.21;
    color = mix(navy, color, ${C.colorGain});

    vec2 pointerDelta = (vScreenUv - uPointerUv) * uResolution;
    float pointerDistance = length(pointerDelta);
    float pointerHalo = exp(-2.2 * pow(pointerDistance / ${C.pointerHalo}, 2.0));
    float pointerCore = exp(-2.8 * pow(pointerDistance / ${C.pointerCore}, 2.0));
    float relief = clamp(abs(dFdx(fieldA)) + abs(dFdy(fieldA)) + abs(dFdx(fieldB)), 0.0, 0.55);
    vec3 pointerTint = mix(vec3(0.24, 0.58, 1.0), vec3(0.82, 0.96, 1.0), pointerCore);
    color += pointerTint * uPointerStrength * ${C.pointerGain} *
      (pointerHalo * (0.14 + relief * 0.18) + pointerCore * 0.10);

    color += stainedField(vScreenUv, uResolution, uMark0, uMarkColor0.rgb);
    color += stainedField(vScreenUv, uResolution, uMark1, uMarkColor1.rgb);
    color += stainedField(vScreenUv, uResolution, uMark2, uMarkColor2.rgb);
    color += stainedField(vScreenUv, uResolution, uMark3, uMarkColor3.rgb);

    // The gem's CAST: additive like the pools, so it reads as the shape the
    // light is landing through, not a decal over the field. The polygon
    // arrives in renderer pixels, so the fragment goes there too.
    vec4 crystalCast = causticField(
      vec2(vScreenUv.x, 1.0 - vScreenUv.y) * uResolution,
      uCaustic0, uCaustic1, uCaustic2, uCaustic3, uCaustic4, uCaustic5,
      uCausticSpec0, uCausticSpec1, uCausticSpec2,
      uCausticSpec3, uCausticSpec4, uCausticSpec5,
      uCausticOptics0, uCausticOptics1, uCausticOptics2, uCausticOptics3,
      uCausticSecondary0, uCausticSecondary1,
      uCausticSecondarySpec0, uCausticSecondarySpec1,
      uCausticSecondaryOptics,
      uCausticBand,
      uCausticDetail
    );
    color += crystalCast.rgb * ${C.markGain};

    float vignette = smoothstep(1.0, 0.12, length(p));
    finalColor = vec4(color * (0.62 + vignette * 0.38), ${C.fieldAlpha});
  }
`;

export const FAR_FIELD_WGSL = /* wgsl */ `
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

  struct FarFieldUniforms {
    uTime: f32,
    uPointerStrength: f32,
    uResolution: vec2<f32>,
    uPointerUv: vec2<f32>,
    uMark0: vec4<f32>,
    uMark1: vec4<f32>,
    uMark2: vec4<f32>,
    uMark3: vec4<f32>,
    uMarkColor0: vec4<f32>,
    uMarkColor1: vec4<f32>,
    uMarkColor2: vec4<f32>,
    uMarkColor3: vec4<f32>,
    uCaustic0: vec4<f32>,
    uCaustic1: vec4<f32>,
    uCaustic2: vec4<f32>,
    uCaustic3: vec4<f32>,
    uCaustic4: vec4<f32>,
    uCaustic5: vec4<f32>,
    uCausticOptics0: vec4<f32>,
    uCausticOptics1: vec4<f32>,
    uCausticOptics2: vec4<f32>,
    uCausticOptics3: vec4<f32>,
    uCausticSpec0: vec4<f32>,
    uCausticSpec1: vec4<f32>,
    uCausticSpec2: vec4<f32>,
    uCausticSpec3: vec4<f32>,
    uCausticSpec4: vec4<f32>,
    uCausticSpec5: vec4<f32>,
    uCausticSecondary0: vec4<f32>,
    uCausticSecondary1: vec4<f32>,
    uCausticSecondarySpec0: vec4<f32>,
    uCausticSecondarySpec1: vec4<f32>,
    uCausticSecondaryOptics: vec4<f32>,
    uCausticBand: f32,
    uCausticDetail: f32,
  }

  @group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
  @group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
  @group(2) @binding(0) var<uniform> farFieldUniforms: FarFieldUniforms;

  struct VertexInput {
    @location(0) aPosition: vec2<f32>,
  }

  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vUv: vec2<f32>,
    @location(1) vScreenUv: vec2<f32>,
  }

  fn hash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453123);
  }

  fn noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2<f32>(1.0, 0.0)), f.x),
      mix(hash(i + vec2<f32>(0.0, 1.0)), hash(i + vec2<f32>(1.0)), f.x),
      f.y
    );
  }

  fn fbm(start: vec2<f32>) -> f32 {
    var p = start;
    var value = 0.0;
    var amplitude = 0.5;
    for (var i: i32 = 0; i < 4; i += 1) {
      value += amplitude * noise(p);
      p = p * 2.03 + vec2<f32>(13.7, 9.2);
      amplitude *= 0.5;
    }
    return value;
  }

  fn stainedField(screenUv: vec2<f32>, resolution: vec2<f32>, mark: vec4<f32>, tint: vec3<f32>) -> vec3<f32> {
    if (mark.z < 0.001) {
      return vec3<f32>(0.0);
    }
    let delta = (screenUv - mark.xy) * resolution;
    let dist = length(delta) / max(mark.w, 1.0);
    let halo = exp(-3.2 * dist * dist);
    let core = exp(-8.0 * dist * dist);
    return tint * mark.z * ${C.markGain} * (halo * 0.48 + core * 0.18);
  }

${CAUSTIC_FIELD_WGSL}

  fn fwidth2(v: vec2<f32>) -> vec2<f32> {
    return abs(dpdx(v)) + abs(dpdy(v));
  }

  @vertex
  fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let matrix = globalUniforms.uProjectionMatrix *
      globalUniforms.uWorldTransformMatrix *
      localUniforms.uTransformMatrix;
    let clip = matrix * vec3<f32>(input.aPosition, 1.0);
    out.position = vec4<f32>(clip.xy, 0.0, 1.0);
    out.vUv = input.aPosition;
    out.vScreenUv = vec2<f32>(input.aPosition.x, 1.0 - input.aPosition.y);
    return out;
  }

  @fragment
  fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
    let aspect = farFieldUniforms.uResolution.x / max(1.0, farFieldUniforms.uResolution.y);
    let p = (input.vUv - vec2<f32>(0.5)) * vec2<f32>(aspect, 1.0);
    let t = farFieldUniforms.uTime * ${C.motionRate};

    let fieldA = fbm(p * 3.2 + vec2<f32>(t, -t * 0.7));
    let fieldB = fbm(p * 5.6 - vec2<f32>(t * 0.8, t));
    let aurora = smoothstep(0.25, 0.9, fieldA * 0.8 + fieldB * 0.42);

    let gridUv = abs(fract((p + vec2<f32>(0.5)) * ${C.gridFrequency}) - vec2<f32>(0.5)) /
      fwidth2(p * ${C.gridFrequency});
    var grid = 1.0 - min(min(gridUv.x, gridUv.y), 1.0);
    grid *= 0.022 + 0.016 * sin(farFieldUniforms.uTime * 0.24 + p.y * 20.0);

    let radial = exp(-2.7 * dot(p, p));
    let scan = pow(max(0.0, sin((p.y + t) * 42.0)), 28.0) * 0.055;
    let star = step(0.9975, hash(floor((p + vec2<f32>(t * 0.04)) * 150.0)));

    let navy = vec3<f32>(0.012, 0.025, 0.065);
    let blue = vec3<f32>(0.055, 0.26, 0.58);
    let cyan = vec3<f32>(0.08, 0.72, 0.78);
    let violet = vec3<f32>(0.38, 0.12, 0.72);
    var color = navy;
    color += mix(blue, violet, fieldB) * aurora * 0.2;
    color += cyan * radial * (0.042 + fieldA * 0.03);
    color += vec3<f32>(0.28, 0.52, 0.9) * grid;
    color += cyan * scan * 0.72;
    color += vec3<f32>(0.7, 0.86, 1.0) * star * 0.21;
    color = mix(navy, color, ${C.colorGain});

    let pointerDelta = (input.vScreenUv - farFieldUniforms.uPointerUv) * farFieldUniforms.uResolution;
    let pointerDistance = length(pointerDelta);
    let pointerHalo = exp(-2.2 * pow(pointerDistance / ${C.pointerHalo}, 2.0));
    let pointerCore = exp(-2.8 * pow(pointerDistance / ${C.pointerCore}, 2.0));
    let relief = clamp(abs(dpdx(fieldA)) + abs(dpdy(fieldA)) + abs(dpdx(fieldB)), 0.0, 0.55);
    let pointerTint = mix(vec3<f32>(0.24, 0.58, 1.0), vec3<f32>(0.82, 0.96, 1.0), pointerCore);
    color += pointerTint * farFieldUniforms.uPointerStrength * ${C.pointerGain} *
      (pointerHalo * (0.14 + relief * 0.18) + pointerCore * 0.10);

    color += stainedField(input.vScreenUv, farFieldUniforms.uResolution, farFieldUniforms.uMark0, farFieldUniforms.uMarkColor0.xyz);
    color += stainedField(input.vScreenUv, farFieldUniforms.uResolution, farFieldUniforms.uMark1, farFieldUniforms.uMarkColor1.xyz);
    color += stainedField(input.vScreenUv, farFieldUniforms.uResolution, farFieldUniforms.uMark2, farFieldUniforms.uMarkColor2.xyz);
    color += stainedField(input.vScreenUv, farFieldUniforms.uResolution, farFieldUniforms.uMark3, farFieldUniforms.uMarkColor3.xyz);

    // The gem's CAST: additive like the pools, so it reads as the shape the
    // light is landing through, not a decal over the field. The polygon
    // arrives in renderer pixels, so the fragment goes there too.
    let crystalCast = causticField(
      vec2<f32>(input.vScreenUv.x, 1.0 - input.vScreenUv.y) * farFieldUniforms.uResolution,
      farFieldUniforms.uCaustic0,
      farFieldUniforms.uCaustic1,
      farFieldUniforms.uCaustic2,
      farFieldUniforms.uCaustic3,
      farFieldUniforms.uCaustic4,
      farFieldUniforms.uCaustic5,
      farFieldUniforms.uCausticSpec0,
      farFieldUniforms.uCausticSpec1,
      farFieldUniforms.uCausticSpec2,
      farFieldUniforms.uCausticSpec3,
      farFieldUniforms.uCausticSpec4,
      farFieldUniforms.uCausticSpec5,
      farFieldUniforms.uCausticOptics0,
      farFieldUniforms.uCausticOptics1,
      farFieldUniforms.uCausticOptics2,
      farFieldUniforms.uCausticOptics3,
      farFieldUniforms.uCausticSecondary0,
      farFieldUniforms.uCausticSecondary1,
      farFieldUniforms.uCausticSecondarySpec0,
      farFieldUniforms.uCausticSecondarySpec1,
      farFieldUniforms.uCausticSecondaryOptics,
      farFieldUniforms.uCausticBand,
      farFieldUniforms.uCausticDetail,
    );
    color += crystalCast.rgb * ${C.markGain};

    let vignette = smoothstep(1.0, 0.12, length(p));
    return vec4<f32>(color * (0.62 + vignette * 0.38), ${C.fieldAlpha});
  }
`;

export interface FarField {
  mesh: FieldMesh;
  tick(
    deltaSeconds: number,
    screenW: number,
    screenH: number,
    bounds: PointerLightBounds,
    mapClientToRenderer?: (x: number, y: number) => { x: number; y: number }
  ): void;
}

function fieldUv(
  clientX: number,
  clientY: number,
  bounds: PointerLightBounds,
  screenW: number,
  screenH: number,
  mapClientToRenderer: (x: number, y: number) => { x: number; y: number } =
    (x, y) => pointerClientToRenderer(x, y, bounds, screenW, screenH)
) {
  const local = mapClientToRenderer(clientX, clientY);
  return {
    x: local.x / Math.max(1, screenW),
    y: 1 - local.y / Math.max(1, screenH),
  };
}

/**
 * Fullscreen aurora mesh. Null where no document exists: Pixi compiles GLSL
 * by probing a throwaway canvas, so headless view tests never build one.
 */
export function createFarField(): FarField | null {
  if (typeof document === 'undefined') return null;

  const positions = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const geometry = new Geometry({
    attributes: {
      aPosition: {
        buffer: new Buffer({ data: positions, usage: BufferUsage.VERTEX }),
        format: 'float32x2',
      },
    },
    indexBuffer: new Buffer({ data: indices, usage: BufferUsage.INDEX }),
    topology: 'triangle-list',
  });

  const shader = Shader.from({
    gl: {
      vertex: FAR_FIELD_GLSL_VERTEX,
      fragment: FAR_FIELD_GLSL,
    },
    gpu: {
      vertex: { source: FAR_FIELD_WGSL, entryPoint: 'mainVertex' },
      fragment: { source: FAR_FIELD_WGSL, entryPoint: 'mainFragment' },
    },
    resources: {
      farFieldUniforms: Object.fromEntries(FAR_FIELD_UNIFORMS.map(({ name, type }) => [
        name,
        { value: uniformValues[name](), type },
      ])),
    },
  });

  const mesh = new Mesh({ geometry, shader });
  mesh.label = FAR_FIELD_LABEL;
  mesh.eventMode = 'none';
  mesh.cullable = false;

  const uniforms = shader.resources['farFieldUniforms'].uniforms as {
    uTime: number;
    uPointerStrength: number;
    uResolution: Float32Array;
    uPointerUv: Float32Array;
    uMark0: Float32Array;
    uMark1: Float32Array;
    uMark2: Float32Array;
    uMark3: Float32Array;
    uMarkColor0: Float32Array;
    uMarkColor1: Float32Array;
    uMarkColor2: Float32Array;
    uMarkColor3: Float32Array;
    uCaustic0: Float32Array;
    uCaustic1: Float32Array;
    uCaustic2: Float32Array;
    uCaustic3: Float32Array;
    uCaustic4: Float32Array;
    uCaustic5: Float32Array;
    uCausticOptics0: Float32Array;
    uCausticOptics1: Float32Array;
    uCausticOptics2: Float32Array;
    uCausticOptics3: Float32Array;
    uCausticSpec0: Float32Array;
    uCausticSpec1: Float32Array;
    uCausticSpec2: Float32Array;
    uCausticSpec3: Float32Array;
    uCausticSpec4: Float32Array;
    uCausticSpec5: Float32Array;
    uCausticSecondary0: Float32Array;
    uCausticSecondary1: Float32Array;
    uCausticSecondarySpec0: Float32Array;
    uCausticSecondarySpec1: Float32Array;
    uCausticSecondaryOptics: Float32Array;
    uCausticBand: number;
    uCausticDetail: number;
  };
  const marks = [uniforms.uMark0, uniforms.uMark1, uniforms.uMark2, uniforms.uMark3];
  const colors = [
    uniforms.uMarkColor0,
    uniforms.uMarkColor1,
    uniforms.uMarkColor2,
    uniforms.uMarkColor3,
  ];
  const causticSlots = [
    uniforms.uCaustic0,
    uniforms.uCaustic1,
    uniforms.uCaustic2,
    uniforms.uCaustic3,
    uniforms.uCaustic4,
    uniforms.uCaustic5,
  ];
  const spectralSlots = [
    uniforms.uCausticSpec0,
    uniforms.uCausticSpec1,
    uniforms.uCausticSpec2,
    uniforms.uCausticSpec3,
    uniforms.uCausticSpec4,
    uniforms.uCausticSpec5,
  ];
  const causticOptics = [
    uniforms.uCausticOptics0,
    uniforms.uCausticOptics1,
    uniforms.uCausticOptics2,
    uniforms.uCausticOptics3,
  ];
  const secondarySlots = [
    uniforms.uCausticSecondary0,
    uniforms.uCausticSecondary1,
  ];
  const secondarySpectralSlots = [
    uniforms.uCausticSecondarySpec0,
    uniforms.uCausticSecondarySpec1,
  ];

  let elapsed = 0;

  return {
    mesh,
    tick(deltaSeconds, screenW, screenH, bounds, mapClientToRenderer) {
      const width = Math.max(1, screenW);
      const height = Math.max(1, screenH);
      mesh.scale.set(width, height);
      uniforms.uResolution[0] = width;
      uniforms.uResolution[1] = height;
      const dt = Math.max(0, deltaSeconds);
      if (!prefersReducedMotion()) elapsed += dt;
      uniforms.uTime = elapsed;
      const pointer = readPointerLight();
      const pointerUv = fieldUv(
        pointer.clientX,
        pointer.clientY,
        bounds,
        width,
        height,
        mapClientToRenderer
      );
      uniforms.uPointerUv[0] = pointerUv.x;
      uniforms.uPointerUv[1] = pointerUv.y;
      const target = pointer.active ? 1 : 0;
      uniforms.uPointerStrength +=
        (target - uniforms.uPointerStrength) * (1 - Math.exp(-POINTER_DAMP_LAMBDA * dt));
      const lantern = readMarkFieldLight();
      for (let index = 0; index < 4; index += 1) {
        const spill = lantern[index];
        const mark = marks[index]!;
        const color = colors[index]!;
        if (!spill) {
          mark[2] = 0;
          continue;
        }
        const uv = fieldUv(
          spill.clientX,
          spill.clientY,
          bounds,
          width,
          height,
          mapClientToRenderer
        );
        mark[0] = uv.x;
        mark[1] = uv.y;
        mark[2] = spill.intensity;
        mark[3] = spill.radiusPx;
        color[0] = spill.r;
        color[1] = spill.g;
        color[2] = spill.b;
      }
      // The cast lives on this ONE receiver plane behind the UI. Filled controls
      // occlude it naturally instead of paying for a second full-screen copy at
      // an incompatible depth.
      const cast = packMarkCaustic(
        readMarkFieldCaustic(),
        bounds,
        width,
        height,
        mapClientToRenderer
      );
      if (cast) {
        for (let index = 0; index < CAUSTIC_CORNER_SLOTS; index += 1) {
          const slot = causticSlots[index]!;
          const first = cast.corners[index * 2]!;
          const second = cast.corners[index * 2 + 1]!;
          slot[0] = first.x;
          slot[1] = first.y;
          slot[2] = second.x;
          slot[3] = second.y;
        }
      } else {
        // Parked far offscreen AND at zero intensity: the shader's own guard
        // is the one that matters, this only keeps the slots meaningless.
        for (const slot of causticSlots) {
          slot.fill(-1e6);
        }
      }
      for (let index = 0; index < causticOptics.length; index += 1) {
        const target = causticOptics[index]!;
        const optical = cast?.optics[index];
        target[0] = optical?.r ?? 0;
        target[1] = optical?.g ?? 0;
        target[2] = optical?.b ?? 0;
        target[3] = optical?.intensity ?? 0;
      }
      // The traced spectral band: one signed half-separation per corner,
      // packed two corners per vec4. No band published collapses the whole
      // set to zero, which draws both wavelengths on the mean trace —
      // exactly what a glass that does not disperse should do.
      for (let slot = 0; slot < CAUSTIC_SPECTRAL_SLOTS; slot += 1) {
        const target = spectralSlots[slot]!;
        for (let half = 0; half < 2; half += 1) {
          const delta = cast?.spectral?.[slot * 2 + half];
          target[half * 2] = delta?.x ?? 0;
          target[half * 2 + 1] = delta?.y ?? 0;
        }
      }
      // One physically traced partial-reflection branch. Unused halves are
      // parked offscreen/zeroed exactly like the primary transport.
      for (let slot = 0; slot < CAUSTIC_SECONDARY_CORNER_SLOTS; slot += 1) {
        const target = secondarySlots[slot]!;
        for (let half = 0; half < 2; half += 1) {
          const point = cast?.secondary?.corners[slot * 2 + half];
          target[half * 2] = point?.x ?? -1e6;
          target[half * 2 + 1] = point?.y ?? -1e6;
        }
      }
      for (let slot = 0; slot < CAUSTIC_SECONDARY_SPECTRAL_SLOTS; slot += 1) {
        const target = secondarySpectralSlots[slot]!;
        for (let half = 0; half < 2; half += 1) {
          const delta = cast?.secondary?.spectral?.[slot * 2 + half];
          target[half * 2] = delta?.x ?? 0;
          target[half * 2 + 1] = delta?.y ?? 0;
        }
      }
      const secondaryOptical = cast?.secondary?.optics;
      uniforms.uCausticSecondaryOptics[0] = secondaryOptical?.r ?? 0;
      uniforms.uCausticSecondaryOptics[1] = secondaryOptical?.g ?? 0;
      uniforms.uCausticSecondaryOptics[2] = secondaryOptical?.b ?? 0;
      uniforms.uCausticSecondaryOptics[3] = secondaryOptical?.intensity ?? 0;
      const tuning = readTuning();
      uniforms.uCausticBand = tuning.causticDispersion;
      uniforms.uCausticDetail = tuning.causticDetail;
    },
  };
}
