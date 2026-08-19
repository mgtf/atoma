import type { VizEvent } from '../../client/types.js';
import {
  POINTER_LIGHT_CORE_RADIUS_PX,
  POINTER_LIGHT_RADIUS_PX,
} from '../pointer-light.js';

/**
 * GPU shader sources and per-event shader-mode selection.
 *
 * Extracted from gpu-renderer.ts (2026-08-15 decomposition): the shaders are
 * pure source constants with both GLSL and WGSL variants — the two-backend
 * contract (WebGPU with WebGL fallback) means every visual effect ships both
 * or ships neither.
 */
export function gpuCardShaderMode(event: VizEvent): number {
  if (event.kind === 'llm') return 0;
  if (event.kind === 'tool') return 1;
  if (event.kind === 'trust') return 2;
  if (event.kind === 'skill') return 3;
  if (event.kind === 'cache') return 4;
  if (event.kind === 'registry') return 5;
  return 6;
}

export const POINTER_LIGHT_GLSL_VERTEX = /* glsl */ `
  in vec2 aPosition;
  out vec2 vTextureCoord;
  out vec2 vScreenPx;
  uniform vec4 uInputSize;
  uniform vec4 uOutputFrame;
  uniform vec4 uOutputTexture;

  void main() {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y =
      position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) -
      uOutputTexture.z;
    gl_Position = vec4(position, 0.0, 1.0);
    vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
    vScreenPx = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  }
`;

export const POINTER_LIGHT_GLSL = /* glsl */ `
  in vec2 vTextureCoord;
  in vec2 vScreenPx;
  out vec4 finalColor;
  uniform sampler2D uTexture;
  uniform vec4 uInputPixel;
  uniform vec2 uLightPx;
  uniform float uStrength;
  uniform float uRadiusScale;
  uniform float uHueShift;

  float luminance(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
  }

  vec3 rotateHue(vec3 color, float degrees) {
    if (abs(degrees) < 0.001) return color;
    float angle = radians(degrees);
    vec3 axis = vec3(0.57735027);
    float cosA = cos(angle);
    return max(
      vec3(0.0),
      color * cosA + cross(axis, color) * sin(angle) +
        axis * dot(axis, color) * (1.0 - cosA)
    );
  }

  void main() {
    vec2 uv = vTextureCoord;
    vec4 sampleColor = texture(uTexture, uv);
    float sampleLuminance = luminance(sampleColor.rgb);
    vec4 rightSample = texture(uTexture, uv + vec2(uInputPixel.z, 0.0));
    vec4 downSample = texture(uTexture, uv + vec2(0.0, uInputPixel.w));
    vec2 gradient = vec2(
      luminance(rightSample.rgb) - sampleLuminance,
      luminance(downSample.rgb) - sampleLuminance
    );
    vec2 alphaGradient = vec2(
      rightSample.a - sampleColor.a,
      downSample.a - sampleColor.a
    );
    vec2 outwardNormal = -(gradient + alphaGradient * 0.16);
    vec2 toLight = normalize(uLightPx - vScreenPx + vec2(0.001));
    float normalLength = length(outwardNormal);
    float facing = max(0.0, dot(outwardNormal / max(0.001, normalLength), toLight));
    float edgeResponse = clamp(normalLength * 4.4, 0.0, 1.0);
    float distancePx = length(vScreenPx - uLightPx);
    float scale = max(0.05, uRadiusScale);
    float halo = exp(-2.2 * pow(distancePx / (${POINTER_LIGHT_RADIUS_PX.toFixed(1)} * scale), 2.0));
    float core = exp(-2.8 * pow(distancePx / (${POINTER_LIGHT_CORE_RADIUS_PX.toFixed(1)} * scale), 2.0));
    vec3 lightColor = rotateHue(
      mix(vec3(0.20, 0.56, 1.0), vec3(0.78, 0.95, 1.0), core),
      uHueShift
    );
    // NO additive core term. A bright centre reads as a lamp pasted on top of
    // the scene; what sells a light under the cursor is edges catching it, so
    // the response is carried by the facing/edge term alone.
    float illumination = halo * (0.075 + edgeResponse * (0.24 + facing * 0.36));
    sampleColor.rgb += lightColor * illumination * uStrength * sampleColor.a;
    finalColor = sampleColor;
  }
`;

export const POINTER_LIGHT_WGSL = /* wgsl */ `
  struct GlobalFilterUniforms {
    uInputSize: vec4<f32>,
    uInputPixel: vec4<f32>,
    uInputClamp: vec4<f32>,
    uOutputFrame: vec4<f32>,
    uGlobalFrame: vec4<f32>,
    uOutputTexture: vec4<f32>,
  };

  struct PointerLightUniforms {
    uLightPx: vec2<f32>,
    uStrength: f32,
    uRadiusScale: f32,
    uHueShift: f32,
  };

  @group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
  @group(0) @binding(1) var uTexture: texture_2d<f32>;
  @group(0) @binding(2) var uSampler: sampler;
  @group(1) @binding(0) var<uniform> pointerLight: PointerLightUniforms;

  struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) screenPx: vec2<f32>,
  };

  fn rotateHue(color: vec3<f32>, degrees: f32) -> vec3<f32> {
    if (abs(degrees) < 0.001) { return color; }
    let angle = radians(degrees);
    let axis = vec3<f32>(0.57735027);
    let cosA = cos(angle);
    return max(
      vec3<f32>(0.0),
      color * cosA + cross(axis, color) * sin(angle) +
        axis * dot(axis, color) * (1.0 - cosA)
    );
  }

  fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
    var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
    position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
  }

  fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
    return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
  }

  @vertex
  fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
    let screenPx = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
    return VSOutput(filterVertexPosition(aPosition), filterTextureCoord(aPosition), screenPx);
  }

  fn luminance(color: vec3<f32>) -> f32 {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
  }

  @fragment
  fn mainFragment(
    @location(0) uv: vec2<f32>,
    @location(1) screenPx: vec2<f32>
  ) -> @location(0) vec4<f32> {
    var sampleColor = textureSample(uTexture, uSampler, uv);
    let sampleLuminance = luminance(sampleColor.rgb);
    let gradient = vec2(dpdx(sampleLuminance), dpdy(sampleLuminance));
    let alphaGradient = vec2(dpdx(sampleColor.a), dpdy(sampleColor.a));
    let outwardNormal = -(gradient + alphaGradient * 0.16);
    let toLight = normalize(pointerLight.uLightPx - screenPx + vec2(0.001));
    let normalLength = length(outwardNormal);
    let facing = max(0.0, dot(outwardNormal / max(0.001, normalLength), toLight));
    let edgeResponse = clamp(normalLength * 4.4, 0.0, 1.0);
    let distancePx = length(screenPx - pointerLight.uLightPx);
    let scale = max(0.05, pointerLight.uRadiusScale);
    let halo = exp(-2.2 * pow(distancePx / (${POINTER_LIGHT_RADIUS_PX.toFixed(1)} * scale), 2.0));
    let core = exp(-2.8 * pow(distancePx / (${POINTER_LIGHT_CORE_RADIUS_PX.toFixed(1)} * scale), 2.0));
    let lightColor = rotateHue(
      mix(vec3(0.20, 0.56, 1.0), vec3(0.78, 0.95, 1.0), core),
      pointerLight.uHueShift
    );
    // Twin of the GLSL above — no additive core, same edge-carried response.
    let illumination = halo * (0.075 + edgeResponse * (0.24 + facing * 0.36));
    sampleColor.r += lightColor.r * illumination * pointerLight.uStrength * sampleColor.a;
    sampleColor.g += lightColor.g * illumination * pointerLight.uStrength * sampleColor.a;
    sampleColor.b += lightColor.b * illumination * pointerLight.uStrength * sampleColor.a;
    return sampleColor;
  }
`;

export const CARD_FILTER_GLSL_VERTEX = /* glsl */ `
  in vec2 aPosition;
  out vec2 vTextureCoord;
  uniform vec4 uInputSize;
  uniform vec4 uOutputFrame;
  uniform vec4 uOutputTexture;

  void main() {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y =
      position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) -
      uOutputTexture.z;
    gl_Position = vec4(position, 0.0, 1.0);
    vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
  }
`;

export const CARD_FILTER_GLSL = /* glsl */ `
  in vec2 vTextureCoord;
  out vec4 finalColor;
  uniform sampler2D uTexture;
  uniform float uTime;
  uniform float uMode;
  uniform float uHover;
  uniform float uSelected;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    vec2 uv = vTextureCoord;
    vec4 sampleColor = texture(uTexture, uv);
    float edge = 1.0 - smoothstep(0.0, 0.11, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
    float t = uTime;
    float fx = 0.0;
    vec3 tint = vec3(0.22, 0.55, 1.0);

    if (uMode < 0.5) {
      // LLM: travelling reasoning waves and token bands.
      float wave = sin(uv.x * 28.0 - t * 2.4 + sin(uv.y * 10.0 + t));
      float band = pow(max(0.0, sin((uv.x + uv.y * 0.35) * 42.0 - t * 3.2)), 16.0);
      fx = 0.055 * wave + 0.22 * band + edge * 0.08;
      tint = vec3(0.28, 0.48, 1.0);
    } else if (uMode < 1.5) {
      // Tool: terminal grid, packet scan and deterministic digital noise.
      vec2 gridUv = abs(fract(uv * vec2(36.0, 9.0)) - 0.5);
      float grid = step(gridUv.x, 0.025) + step(gridUv.y, 0.035);
      float packet = pow(max(0.0, sin(uv.x * 70.0 - t * 5.0)), 24.0);
      float noise = hash(floor(uv * 120.0) + floor(t * 8.0));
      fx = grid * 0.07 + packet * 0.24 + (noise - 0.5) * 0.025;
      tint = vec3(0.05, 0.82, 0.96);
    } else if (uMode < 2.5) {
      // Trust: shield-like radial pulse with a stable gold edge.
      vec2 p = uv - 0.5;
      float ring = pow(max(0.0, sin(length(p) * 46.0 - t * 1.8)), 18.0);
      float shield = 1.0 - smoothstep(0.08, 0.5, abs(abs(p.x) + p.y * 0.55 - 0.24));
      fx = ring * 0.16 + shield * 0.08 + edge * 0.11;
      tint = vec3(1.0, 0.68, 0.12);
    } else if (uMode < 3.5) {
      // Skill: magenta plasma, deliberately organic rather than gridded.
      float plasma =
        sin(uv.x * 18.0 + t * 1.9) +
        sin(uv.y * 15.0 - t * 1.5) +
        sin((uv.x + uv.y) * 13.0 + t);
      fx = plasma * 0.035 + edge * 0.09;
      tint = vec3(0.92, 0.22, 0.82);
    } else if (uMode < 4.5) {
      // Cache: crystalline diagonals and a fast replay glint.
      float crystal = pow(max(0.0, sin((uv.x - uv.y) * 58.0 + t * 2.8)), 22.0);
      float replay = pow(max(0.0, sin(uv.x * 22.0 - t * 6.0)), 32.0);
      fx = crystal * 0.12 + replay * 0.28 + edge * 0.07;
      tint = vec3(0.08, 0.9, 0.92);
    } else if (uMode < 5.5) {
      // Registry: violet circuit traces with stable node intersections.
      vec2 circuitUv = abs(fract(uv * vec2(24.0, 8.0)) - 0.5);
      float traces = step(circuitUv.x, 0.028) * step(0.17, circuitUv.y);
      float nodes = step(length(circuitUv), 0.075);
      fx = traces * 0.11 + nodes * (0.16 + 0.08 * sin(t * 2.0)) + edge * 0.08;
      tint = vec3(0.62, 0.35, 1.0);
    } else {
      // Lifecycle/other: restrained state pulse.
      fx = sin((uv.x + uv.y) * 24.0 - t * 1.4) * 0.035 + edge * 0.06;
      tint = vec3(0.45, 0.62, 0.92);
    }

    float intensity = 0.46 + uHover * 0.72 + uSelected * 0.58;
    sampleColor.rgb += tint * fx * intensity * sampleColor.a;
    sampleColor.rgb += tint * edge * (uHover * 0.055 + uSelected * 0.065) * sampleColor.a;
    finalColor = sampleColor;
  }
`;

export const CARD_FILTER_WGSL = /* wgsl */ `
  struct GlobalFilterUniforms {
    uInputSize: vec4<f32>,
    uInputPixel: vec4<f32>,
    uInputClamp: vec4<f32>,
    uOutputFrame: vec4<f32>,
    uGlobalFrame: vec4<f32>,
    uOutputTexture: vec4<f32>,
  };

  struct CardUniforms {
    uTime: f32,
    uMode: f32,
    uHover: f32,
    uSelected: f32,
  };

  @group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
  @group(0) @binding(1) var uTexture: texture_2d<f32>;
  @group(0) @binding(2) var uSampler: sampler;
  @group(1) @binding(0) var<uniform> cardUniforms: CardUniforms;

  struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
  };

  fn rotateHue(color: vec3<f32>, degrees: f32) -> vec3<f32> {
    if (abs(degrees) < 0.001) { return color; }
    let angle = radians(degrees);
    let axis = vec3<f32>(0.57735027);
    let cosA = cos(angle);
    return max(
      vec3<f32>(0.0),
      color * cosA + cross(axis, color) * sin(angle) +
        axis * dot(axis, color) * (1.0 - cosA)
    );
  }

  fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
    var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
    position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
  }

  fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
    return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
  }

  @vertex
  fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
    return VSOutput(filterVertexPosition(aPosition), filterTextureCoord(aPosition));
  }

  fn hash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  @fragment
  fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    var sampleColor = textureSample(uTexture, uSampler, uv);
    let edgeDistance = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    let edge = 1.0 - smoothstep(0.0, 0.11, edgeDistance);
    let t = cardUniforms.uTime;
    var fx = 0.0;
    var tint = vec3(0.22, 0.55, 1.0);

    if (cardUniforms.uMode < 0.5) {
      let wave = sin(uv.x * 28.0 - t * 2.4 + sin(uv.y * 10.0 + t));
      let band = pow(max(0.0, sin((uv.x + uv.y * 0.35) * 42.0 - t * 3.2)), 16.0);
      fx = 0.055 * wave + 0.22 * band + edge * 0.08;
      tint = vec3(0.28, 0.48, 1.0);
    } else if (cardUniforms.uMode < 1.5) {
      let gridUv = abs(fract(uv * vec2(36.0, 9.0)) - vec2(0.5));
      let grid = select(0.0, 1.0, gridUv.x <= 0.025) + select(0.0, 1.0, gridUv.y <= 0.035);
      let packet = pow(max(0.0, sin(uv.x * 70.0 - t * 5.0)), 24.0);
      let digitalNoise = hash(floor(uv * 120.0) + floor(vec2(t * 8.0)));
      fx = grid * 0.07 + packet * 0.24 + (digitalNoise - 0.5) * 0.025;
      tint = vec3(0.05, 0.82, 0.96);
    } else if (cardUniforms.uMode < 2.5) {
      let p = uv - vec2(0.5);
      let ring = pow(max(0.0, sin(length(p) * 46.0 - t * 1.8)), 18.0);
      let shield = 1.0 - smoothstep(0.08, 0.5, abs(abs(p.x) + p.y * 0.55 - 0.24));
      fx = ring * 0.16 + shield * 0.08 + edge * 0.11;
      tint = vec3(1.0, 0.68, 0.12);
    } else if (cardUniforms.uMode < 3.5) {
      let plasma =
        sin(uv.x * 18.0 + t * 1.9) +
        sin(uv.y * 15.0 - t * 1.5) +
        sin((uv.x + uv.y) * 13.0 + t);
      fx = plasma * 0.035 + edge * 0.09;
      tint = vec3(0.92, 0.22, 0.82);
    } else if (cardUniforms.uMode < 4.5) {
      let crystal = pow(max(0.0, sin((uv.x - uv.y) * 58.0 + t * 2.8)), 22.0);
      let replay = pow(max(0.0, sin(uv.x * 22.0 - t * 6.0)), 32.0);
      fx = crystal * 0.12 + replay * 0.28 + edge * 0.07;
      tint = vec3(0.08, 0.9, 0.92);
    } else if (cardUniforms.uMode < 5.5) {
      let circuitUv = abs(fract(uv * vec2(24.0, 8.0)) - vec2(0.5));
      let traces = select(0.0, 1.0, circuitUv.x <= 0.028) * select(0.0, 1.0, circuitUv.y >= 0.17);
      let nodes = select(0.0, 1.0, length(circuitUv) <= 0.075);
      fx = traces * 0.11 + nodes * (0.16 + 0.08 * sin(t * 2.0)) + edge * 0.08;
      tint = vec3(0.62, 0.35, 1.0);
    } else {
      fx = sin((uv.x + uv.y) * 24.0 - t * 1.4) * 0.035 + edge * 0.06;
      tint = vec3(0.45, 0.62, 0.92);
    }

    let intensity = 0.46 + cardUniforms.uHover * 0.72 + cardUniforms.uSelected * 0.58;
    sampleColor.r += tint.r * fx * intensity * sampleColor.a;
    sampleColor.g += tint.g * fx * intensity * sampleColor.a;
    sampleColor.b += tint.b * fx * intensity * sampleColor.a;
    sampleColor.r += tint.r * edge * (cardUniforms.uHover * 0.055 + cardUniforms.uSelected * 0.065) * sampleColor.a;
    sampleColor.g += tint.g * edge * (cardUniforms.uHover * 0.055 + cardUniforms.uSelected * 0.065) * sampleColor.a;
    sampleColor.b += tint.b * edge * (cardUniforms.uHover * 0.055 + cardUniforms.uSelected * 0.065) * sampleColor.a;
    return sampleColor;
  }
`;


// ---------------------------------------------------------------------------
// Brand mark shell
//
// The mark is a MESH: a thick-shell regular octahedron, eight outer facets and
// eight cavity facets, drawn by these two programs. Positions arrive already
// projected by `buildAtomaMarkFrame` — the vertex stage only maps the local
// 28×28 box through Pixi's matrices, so there is exactly one projection in the
// codebase and a shader cannot drift from it.
//
// The fragment stage is where the bead becomes a real light: its falloff is the
// same smoothstep as `coreLightFalloff` in `brand-mark.ts` (change one, change
// the other), applied PER PIXEL against each facet's own flat normal. That is
// what the 2D version could only fake with a flat glaze per face.
//
// Two programs, one behaviour: WGSL for the WebGPU backend, GLSL ES 3 for the
// WebGL fallback. Pixi binds `globalUniforms` and `localUniforms` itself; the
// mark's own values live in `markUniforms`.
// ---------------------------------------------------------------------------

export const MARK_SHELL_WGSL = /* wgsl */ `
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

  struct MarkUniforms {
    uCore: vec3<f32>,
    uLightDir: vec3<f32>,
    uCoreTint: vec3<f32>,
    uCoreReach: f32,
    uCoreIntensity: f32,
    uAmbient: f32,
    uPulse: f32,
    uWall: f32,
    uMinPath: f32,
    uOpacityRef: f32,
    uSplit: f32,
    uBend: f32,
    uMaxBend: f32,
    uRefract: f32,
    uRefractOn: f32,
    uSpecular: f32,
    uRim: f32,
    uLocalSize: f32,
    uBackdropTexel: vec2<f32>,
    uCoreRadius: f32,
  }

  @group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
  @group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
  @group(2) @binding(0) var<uniform> markUniforms: MarkUniforms;
  // What is BEHIND this facet: the back half of the shell plus the bead, drawn
  // into their own texture before the front half runs. Sampling it is the only
  // way a facet can bend what it transmits, because nothing else in the pipeline
  // knows what the interior looks like at this pixel.
  @group(2) @binding(1) var uBackdrop: texture_2d<f32>;
  @group(2) @binding(2) var uBackdropSampler: sampler;

  struct VertexInput {
    @location(0) aPosition: vec2<f32>,
    @location(1) aWorld: vec3<f32>,
    @location(2) aNormal: vec3<f32>,
    @location(3) aTint: vec3<f32>,
    @location(4) aSurface: vec2<f32>,
    @location(5) aMaterial: vec4<f32>,
    @location(6) aFinish: vec3<f32>,
  }

  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vWorld: vec3<f32>,
    @location(1) vNormal: vec3<f32>,
    @location(2) vTint: vec3<f32>,
    @location(3) vSurface: vec2<f32>,
    @location(4) vColor: vec4<f32>,
    @location(5) vMaterial: vec4<f32>,
    @location(6) vFinish: vec3<f32>,
    // Where this pixel lands in the backdrop texture, 0..1. Derived from the
    // SAME clip position the rasteriser uses, so the sample cannot drift from
    // the geometry it belongs to.
    @location(7) vScreen: vec2<f32>,
  }

  @vertex
  fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let matrix = globalUniforms.uProjectionMatrix *
      globalUniforms.uWorldTransformMatrix *
      localUniforms.uTransformMatrix;
    let clip = matrix * vec3<f32>(input.aPosition, 1.0);
    out.position = vec4<f32>(clip.xy, 0.0, 1.0);
    out.vWorld = input.aWorld;
    out.vNormal = input.aNormal;
    out.vTint = input.aTint;
    out.vSurface = input.aSurface;
    out.vColor = localUniforms.uColor * globalUniforms.uWorldColorAlpha;
    out.vMaterial = input.aMaterial;
    out.vFinish = input.aFinish;
    // The backdrop texture holds the mark's own 28x28 box and nothing else, so
    // the sampling coord comes from the LOCAL position — not from clip space,
    // which spans the whole viewport and would have every facet sampling an
    // unrelated part of the screen.
    out.vScreen = input.aPosition / markUniforms.uLocalSize;
    return out;
  }

  @fragment
  fn mainFragment(
    @location(0) vWorld: vec3<f32>,
    @location(1) vNormal: vec3<f32>,
    @location(2) vTint: vec3<f32>,
    @location(3) vSurface: vec2<f32>,
    @location(4) vColor: vec4<f32>,
    @location(5) vMaterial: vec4<f32>,
    @location(6) vFinish: vec3<f32>,
    @location(7) vScreen: vec2<f32>,
  ) -> @location(0) vec4<f32> {
    let normal = normalize(vNormal);
    let outer = vSurface.y;
    // The glass this face is cut from: obsidian, glass, crystal or diamond, one
    // per rank wedge. See ATOMA_MARK_RANK_MATERIALS for what each field means.
    // Derived on the CPU from the material's IOR and roughness; see
    // ATOMA_MARK_RANK_MATERIALS. Nothing here is a free-floating look knob.
    let specularPower = vMaterial.x;
    let dispersion = vMaterial.y;
    let f0 = vMaterial.z;
    let absorption = vMaterial.w;
    // IOR minus one: the strength of the bend, zero for a material that does
    // not refract at all.
    let iorBend = vFinish.x;
    let transmit = vFinish.y;
    let body = vFinish.z;

    // VIEW. The mark is a 3D object, not an orthographic sticker. A ray from
    // the camera to a pixel at the edge of the box is not the same ray as the
    // one through the centre. On eight FLAT facets a constant view makes N·H
    // constant too, so a directional key glazes a whole face at once — which
    // is why the crystal read as painted triangles. Varying V across the face
    // is what lets a highlight become a spot.
    //
    // 0.72 is a stylised half-width: the authored camera is farther than that,
    // but a smaller offset left N·H almost constant across a flat facet, so
    // the key glazed the whole triangle. Stretching V is what turns a glaze
    // into a spot. vScreen is y-down Pixi; world Y is up.
    let viewOffset = vec2<f32>(vScreen.x - 0.5, 0.5 - vScreen.y) * 0.72;
    let viewDir = normalize(vec3<f32>(viewOffset.x, viewOffset.y, 1.0));
    let nDotV = min(abs(dot(normal, viewDir)), 1.0);

    // SOLID, not surfaced — but the two consequences of that are split on
    // purpose. OPACITY is Beer-Lambert at the material's REFERENCE depth, so a
    // wedge is exactly as dense as its own glass and stays that dense whichever
    // way it turns. BULK is the EXTRA material a grazing ray crosses beyond
    // that depth, and it is spent on COLOUR: obsidian goes black through the
    // thick of the wedge while diamond stays clear through the same geometry.
    // Alpha itself must not follow the live path. An octahedron facet swings
    // from face-on to edge-on every turn, so a path-driven alpha made each of
    // the four wedges breathe between clear and solid on the rotation — read as
    // a pulsing opacity, which is not what a block of glass does.
    // Path uses N·V, not N·Z: the extra length is along the actual view ray.
    let path = markUniforms.uWall / max(nDotV, 0.16);
    let opacity = (1.0 - exp(-absorption * markUniforms.uMinPath)) /
      max(markUniforms.uOpacityRef, 1e-4);
    let bulk = 1.0 - exp(-absorption * max(path - markUniforms.uMinPath, 0.0) * 0.35);

    let toCore = markUniforms.uCore - vWorld;
    let distance = length(toCore);
    let coreDir = toCore / max(distance, 1e-4);
    let reach = clamp(1.0 - distance / markUniforms.uCoreReach, 0.0, 1.0);
    let falloff = reach * reach * (3.0 - 2.0 * reach);
    let incidence = max(dot(normal, coreDir), 0.0);
    let core = falloff * (0.34 + 0.66 * incidence) *
      markUniforms.uCoreIntensity * (0.86 + 0.14 * markUniforms.uPulse) *
      transmit * mix(1.0, 0.45, bulk);

    let sun = max(dot(normal, markUniforms.uLightDir), 0.0);
    let half = normalize(markUniforms.uLightDir + viewDir);
    let facing = max(dot(normal, half), 0.0);
    // FIRE. The same highlight raised to three exponents: a tighter exponent is
    // a smaller spot, so blue collapses into the core while red keeps a wide
    // skirt — the order a prism throws. Dispersion is how far a material is
    // allowed down that path; plain glass stays white.
    let spectral = vec3<f32>(
      pow(facing, specularPower * 0.68),
      pow(facing, specularPower),
      pow(facing, specularPower * 1.5)
    );
    // Schlick at V·H, the microfacet half-angle: how much the surface reflects
    // the key toward the eye. N·H was a stand-in that made the Fresnel of the
    // highlight disagree with the Fresnel of the body on the same pixel.
    let specF = f0 + (1.0 - f0) * pow(1.0 - max(dot(viewDir, half), 0.0), 5.0);
    // GEOMETRY. Specular on a face the key does not see is a glaze on the dark
    // side. Smith's height-correlated form, in the cheap Schlick shape: N·L
    // and N·V, correlated, so grazing and back-facing both go to zero.
    // NORMALISATION. A tighter Blinn-Phong lobe packs the same energy into a
    // smaller spot, which is why diamond fire is bright and obsidian's smear
    // is not — without this the four glasses shared one peak and only differed
    // in width. 51 is (glass's exponent + 2) / 2, so typical-pose geo * specNorm
    // stays near 1 and uSpecular remains the scene-wide loudness.
    let geo = sun * nDotV / max(sun + nDotV - sun * nDotV, 1e-4);
    let specNorm = (specularPower + 2.0) / 51.0;
    let highlight = mix(vec3<f32>(spectral.y), spectral, dispersion) *
      specF * geo * specNorm * markUniforms.uSpecular * outer;
    // STUDIO WINDOW. Specular only. A fill that lifts the body was tried and
    // reverted: on a near-black field what reads as transparency is seeing
    // the far facets through the near one, and any light that lifts the near
    // facet's floor buries them. A highlight does not lift the floor. Aimed
    // orthogonal to the key so the two catch different faces.
    let windowDir = normalize(vec3<f32>(0.85, 0.35, 0.15));
    let windowHalf = normalize(windowDir + viewDir);
    let windowFacing = max(dot(normal, windowHalf), 0.0);
    let windowNdotL = max(dot(normal, windowDir), 0.0);
    let windowGeo = windowNdotL * nDotV /
      max(windowNdotL + nDotV - windowNdotL * nDotV, 1e-4);
    let windowSpecF = f0 + (1.0 - f0) *
      pow(1.0 - max(dot(viewDir, windowHalf), 0.0), 5.0);
    let windowHighlight = vec3<f32>(0.78, 0.88, 1.0) *
      pow(windowFacing, specularPower) * windowSpecF * windowGeo * specNorm *
      markUniforms.uSpecular * outer * 0.28;
    // FRESNEL, Schlick's approximation proper: F0 + (1 - F0)(1 - cos0)^5.
    //
    // Both halves used to be wrong. The exponent was 2.2, a curve that rises far
    // too early, and there was no F0 at all — the material carried a hand-set
    // fresnelGain instead, which had drifted to give obsidian stronger edges
    // than plain glass despite near-identical indices. F0 comes from the IOR
    // now, so diamond's edges are four times glass's because its index says so.
    let fresnel = f0 + (1.0 - f0) * pow(1.0 - nDotV, 5.0);
    // ENERGY. A dielectric reflects F of the light and lets 1-F into the body.
    // Without this the body, the highlight and the transmitted interior were
    // three independent adds, so grazing edges stacked a painted face, a
    // highlight AND a full interior — the opposite of glass, which becomes a
    // mirror there and hides what is behind it.
    let bounce = 1.0 - fresnel;

    // INNER SPECULAR. The bead is the only point light, so L varies across a
    // facet and the highlight is a spot that TRAVELS as the bead bounces —
    // which is why a gem with a light inside looks alive. Outer facets see
    // this light as TRANSMITTED, not as a reflection (the bead is behind the
    // surface), so the glint is gated on the cavity.
    let coreHalf = normalize(coreDir + viewDir);
    let coreFacing = max(dot(normal, coreHalf), 0.0);
    let coreSpecF = f0 + (1.0 - f0) * pow(1.0 - max(dot(viewDir, coreHalf), 0.0), 5.0);
    let coreGeo = incidence * nDotV /
      max(incidence + nDotV - incidence * nDotV, 1e-4);
    // AREA LIGHT. The bead has size. A point-light exponent stays needle-thin
    // even when the filament is against the wall; the solid angle of a sphere
    // of this radius at this distance is what widens the glint.
    let coreSoft = specularPower * distance /
      max(distance + markUniforms.uCoreRadius, 1e-4);
    let coreSpectral = vec3<f32>(
      pow(coreFacing, coreSoft * 0.68),
      pow(coreFacing, coreSoft),
      pow(coreFacing, coreSoft * 1.5)
    );
    let coreHighlight = mix(vec3<f32>(coreSpectral.y), coreSpectral, dispersion) *
      coreSpecF * coreGeo * specNorm * falloff *
      markUniforms.uCoreIntensity * (0.86 + 0.14 * markUniforms.uPulse) *
      (1.0 - outer);

    // TIR does not belong here. The cavity is air, so the inner walls are seen
    // from air: air-to-glass, where TIR cannot happen. Applying the critical
    // angle to N·V turned almost every octahedron face into a mirror (typical
    // nDotV is 1/sqrt(3) = 0.577, and diamond's cos(critical) is 0.91), which
    // is chrome, not glass. The inner specular above is the real reflection.

    // EDGE FRINGE. A prism separates by ANGLE, so the separation is widest where
    // the ray leaves the glass most obliquely — the rim of the silhouette and
    // every visible arete, never the middle of a face. FRESNEL already measures
    // exactly that obliquity, so the fringe rides it rather than introducing a
    // second, disagreeing notion of grazing.
    //
    // The three channels peak at three different obliquities: red turns least
    // and so peaks a little inside the edge, blue turns most and hugs it. The
    // result sweeps red-through-violet across the last few pixels of a facet.
    // Width and strength are DISPERSION's alone, so obsidian gets nothing,
    // plain glass a hint of warmth, and diamond a full spectrum.
    let fringeBand = 1.0 - fresnel;
    let fringe = vec3<f32>(
      exp(-fringeBand * fringeBand * 42.0),
      exp(-fringeBand * fringeBand * 78.0),
      exp(-fringeBand * fringeBand * 130.0)
    ) * dispersion * outer;

    // CHROMATIC TRANSMISSION. The interior seen THROUGH this facet, sampled once
    // per channel along the refraction direction. Offset scales with three
    // things and each is load-bearing: DISPERSION, so obsidian bends nothing and
    // diamond bends most; BULK, so the deeper the ray goes through the wedge the
    // further the channels drift apart, which is what ties the effect to the
    // volume rather than to the surface; and OUTER, so only the hull refracts —
    // the cavity walls are already behind the bead and must not smear it twice.
    //
    // The direction is the refracted incident ray's screen-space remainder.
    // A facet presenting flat to the view still displaces nothing; an oblique
    // one shears the interior along Snell rather than along its own normal.
    // REFRACTION, and it is NOT the same thing as dispersion.
    //
    // Every glass here bends light: obsidian's index is 1.5, so it displaces
    // what is behind it exactly as plain glass does. What it does not do is
    // SPLIT that displacement by wavelength — that is dispersion, and only
    // diamond has much of it. The two were fused before: BEND was gated on
    // dispersion, so obsidian refracted nothing at all, which is wrong for a
    // material with an ordinary index.
    //
    // Snell's law, the real one. The small-angle stand-in was normal.xy *
    // (IOR-1), which ignores the view: two pixels on the same flat facet
    // bent identically, so the interior sheared as a rigid stamp. refract()
    // takes the actual incident ray, so the displacement varies across a
    // face the way a lens does, and diamond's eta is what makes it bend
    // further than glass — iorBend must not also scale the offset or the
    // index is counted twice.
    let backdropUv = vScreen;
    // CLAMPED in texel units. A grazing facet drives BULK to saturation and the
    // raw displacement past what the backdrop can resolve — the sampler then
    // steps over whole texels between neighbouring pixels and the edge breaks
    // into a coloured checkerboard. That is aliasing, not a strong effect, and
    // no gain reduction fixes it: the ceiling has to be a distance the texture
    // can actually supply.
    // FADED OUT at grazing, on top of the clamp. Right at the silhouette the
    // facet is edge-on, the wedge is only a few pixels wide, and the
    // displacement swings hard between neighbouring pixels — the clamp caps its
    // SIZE but not that swing. A real refraction has little to show there
    // either, since the ray travels along the surface rather than through it.
    //
    // BULK stays in the product. Removing it was tried on the theory that it
    // double-counted obliquity, and it measurably made the aliasing WORSE
    // (high-frequency energy 90 -> 102 on the worst frame): its 0.35 floor is
    // what holds the displacement down on face-on facets, which is most of the
    // mark most of the time.
    // uRefractOn is 0 WHILE THE BACKDROP IS BEING RENDERED. The back and front
    // shells share one shader, and the back facets are OUTER too, so during
    // the pass they were running this very sampler against last frame's texture
    // and their output was written straight back into it. That closed loop is
    // what the pixel-grid checkerboard was — it compounded every frame until it
    // saturated. It survived a clamp, a grazing fade and 2x supersampling
    // because none of those break a feedback path; only refusing to sample
    // during the pass does.
    let grazingFade = smoothstep(0.05, 0.24, nDotV) * markUniforms.uRefractOn;
    let eta = 1.0 / max(iorBend + 1.0, 1.001);
    let frontNormal = select(normal, -normal, dot(normal, viewDir) < 0.0);
    let refracted = refract(-viewDir, frontNormal, eta);
    let rawBend = refracted.xy * markUniforms.uBend *
      mix(0.55, 1.0, bulk) * outer * grazingFade;
    let bendLength = length(rawBend);
    let bend = select(
      rawBend,
      rawBend * markUniforms.uMaxBend / max(bendLength, 1e-4),
      bendLength > markUniforms.uMaxBend
    );
    let offset = bend * markUniforms.uBackdropTexel;
    // The dispersive HALF-SPREAD around that common displacement: red bends
    // least, blue most. Zero for obsidian, which refracts without splitting.
    let spread = offset * dispersion * markUniforms.uSplit;
    let straight = textureSample(uBackdrop, uBackdropSampler, backdropUv + offset);
    let shiftR = textureSample(uBackdrop, uBackdropSampler,
      backdropUv + offset - spread).r;
    let shiftB = textureSample(uBackdrop, uBackdropSampler,
      backdropUv + offset + spread).b;
    // What refraction ADDS is the difference between the displaced sample and
    // the undisplaced one, PER CHANNEL — red against red, blue against blue.
    //
    // Subtracting the green channel from all three instead, as this first did,
    // is not a colour difference at all: it zeroes green by construction and
    // leaves red and blue carrying absolute brightness, so every lit part of the
    // interior gained flat magenta whether or not anything was displaced. The
    // rank hues did not survive it.
    //
    // Where the offset is zero — a facet presenting flat, or obsidian, which
    // bends nothing — the two samples are the same texel and this is exactly
    // zero. That is the property worth having: the effect cannot tint anything
    // it did not actually displace.
    let split = clamp(
      vec3<f32>(shiftR - straight.r, 0.0, shiftB - straight.b),
      vec3<f32>(-0.25),
      vec3<f32>(0.25)
    ) * transmit;

    // TRANSMISSION. The glass DRAWS what is behind it, rather than letting the
    // alpha blend show it through.
    //
    // This used to be a corrective difference against the undisplaced interior,
    // which only worked because alpha was capped at 0.44 and the blend below
    // was doing the real transmitting. That cap was the last arbitrary number
    // in the material model: how much a glass hides is Beer-Lambert over the
    // path, and nothing else. So the facet now samples the interior at the BENT
    // position and attenuates it by the same absorption that drives its
    // opacity — obsidian swallows what is behind it, diamond passes it almost
    // whole — and alpha is free to approach 1.
    //
    // The bead behind a diamond facet is therefore seen genuinely displaced,
    // not merely fringed: the displacement is the transmitted image itself.
    let attenuation = exp(-absorption * path);
    let transmitted = straight.rgb * attenuation * transmit * bounce;

    // The facet's OWN shading: body, wall scatter, highlights, edges. Body and
    // chromatic split ride BOUNCE so they yield to the mirror at grazing; the
    // highlight and rim ARE that mirror.
    // WALL SCATTER. The bead lights the glass it sits behind. Outer facets
    // used to ignore the analytic core (it is the same light as TRANSMITTED),
    // so a face the key did not hit was a flat painted triangle. A little of
    // that core as SURFACE, not as interior, is the wall glowing — a gradient
    // toward the bead, which is what a lit cavity does to the near glass.
    let scatter = vTint * core * bounce * outer * 0.45;
    let surface = vTint * body *
        (vec3<f32>(markUniforms.uAmbient) + vec3<f32>(1.0, 0.94, 0.84) * (0.42 * sun)) *
        mix(1.0, 0.58, bulk) * bounce +
      scatter +
      highlight * 0.9 +
      windowHighlight +
      coreHighlight * 1.15 +
      fringe * 0.55 +
      split * 0.9 * bounce +
      vec3<f32>(0.75, 0.88, 1.0) * (fresnel * markUniforms.uRim);

    // CORE and TRANSMITTED are the SAME light counted two ways: CORE is the
    // bead computed analytically against this facet, TRANSMITTED is that same
    // bead read out of the backdrop texture. Adding both was double-counting —
    // the interior came out twice as bright as it should and washed the rank
    // tints out from underneath.
    //
    // Outer facets take the sampled version, which is the physical one and the
    // only one that carries the refracted displacement. Cavity facets have no
    // backdrop behind them and keep the analytic term, which is what gives the
    // crystal its lit interior.
    let interior = mix(
      markUniforms.uCoreTint * core,
      transmitted * markUniforms.uRefract,
      outer
    );
    let lit = surface + interior;
    // The bead only NUDGES alpha. It crosses the cavity several times a second,
    // so whatever it adds here reads as flicker rather than as light; its
    // brightness belongs in LIT, where it lands on colour instead of density.
    // Fresnel is scaled DOWN into alpha. At full weight diamond's edges alone
    // moved alpha by half, and a facet goes from face-on to edge-on every turn:
    // that is a density swing wearing the costume of an edge highlight. It keeps
    // its full weight in LIT, where it belongs.
    // ALPHA is COVERAGE, not density. The facet paints its own shading plus the
    // interior it transmits, so it must replace the undistorted behind rather
    // than let a second copy blend through. How much of the interior you SEE is
    // in TRANSMITTED (Beer-Lambert over the path). Using 1 - attenuation *
    // transmit as outer alpha punched a hole in diamond — its transmit is 1.32,
    // so that expression went negative, and the undistorted bead ghosted next
    // to the refracted one.
    //
    // The cavity facets keep the old behaviour: they have nothing behind them
    // worth transmitting and are what gives the crystal its interior body, so
    // vSurface.x still scales them.
    let alpha = clamp(
      mix(vSurface.x * opacity, 1.0, outer) + core * 0.1,
      0.0,
      1.0
    );
    return vec4<f32>(lit * alpha, alpha) * vColor;
  }
`;

export const MARK_SHELL_GLSL_VERTEX = /* glsl */ `
  in vec2 aPosition;
  in vec3 aWorld;
  in vec3 aNormal;
  in vec3 aTint;
  in vec2 aSurface;
  in vec4 aMaterial;
  in vec3 aFinish;

  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;
  uniform vec4 uColor;
  uniform vec4 uWorldColorAlpha;
  uniform float uLocalSize;

  out vec3 vWorld;
  out vec3 vNormal;
  out vec3 vTint;
  out vec2 vSurface;
  out vec4 vColor;
  out vec4 vMaterial;
  out vec3 vFinish;
  out vec2 vScreen;

  void main() {
    mat3 matrix = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((matrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vWorld = aWorld;
    vNormal = aNormal;
    vTint = aTint;
    vSurface = aSurface;
    vColor = uColor * uWorldColorAlpha;
    vMaterial = aMaterial;
    vFinish = aFinish;
    vScreen = aPosition / uLocalSize;
  }
`;

export const MARK_SHELL_GLSL = /* glsl */ `
  precision highp float;

  in vec3 vWorld;
  in vec3 vNormal;
  in vec3 vTint;
  in vec2 vSurface;
  in vec4 vColor;
  in vec4 vMaterial;
  in vec3 vFinish;
  in vec2 vScreen;
  out vec4 finalColor;

  uniform sampler2D uBackdrop;

  uniform vec3 uCore;
  uniform vec3 uLightDir;
  uniform vec3 uCoreTint;
  uniform float uCoreReach;
  uniform float uCoreIntensity;
  uniform float uAmbient;
  uniform float uPulse;
  uniform float uWall;
  uniform float uMinPath;
  uniform float uOpacityRef;
  uniform float uSplit;
  uniform float uBend;
  uniform float uMaxBend;
  uniform float uRefract;
  uniform float uRefractOn;
  uniform float uSpecular;
  uniform float uRim;
  uniform float uLocalSize;
  uniform vec2 uBackdropTexel;
  uniform float uCoreRadius;

  void main() {
    vec3 normal = normalize(vNormal);
    float outer = vSurface.y;
    // Same four glasses as the WGSL path; keep the two in step.
    float specularPower = vMaterial.x;
    float dispersion = vMaterial.y;
    float f0 = vMaterial.z;
    float absorption = vMaterial.w;
    float iorBend = vFinish.x;
    float transmit = vFinish.y;
    float body = vFinish.z;

    // Same view ray as the WGSL path; keep the two in step.
    vec2 viewOffset = vec2(vScreen.x - 0.5, 0.5 - vScreen.y) * 0.72;
    vec3 viewDir = normalize(vec3(viewOffset.x, viewOffset.y, 1.0));
    float nDotV = min(abs(dot(normal, viewDir)), 1.0);

    // Same volume model as the WGSL path; keep the two in step. Opacity at the
    // material's reference depth, bulk for the extra length a grazing ray takes.
    float path = uWall / max(nDotV, 0.16);
    float opacity = (1.0 - exp(-absorption * uMinPath)) / max(uOpacityRef, 1e-4);
    float bulk = 1.0 - exp(-absorption * max(path - uMinPath, 0.0) * 0.35);

    vec3 toCore = uCore - vWorld;
    float dist = length(toCore);
    vec3 coreDir = toCore / max(dist, 1e-4);
    float reach = clamp(1.0 - dist / uCoreReach, 0.0, 1.0);
    float falloff = reach * reach * (3.0 - 2.0 * reach);
    float incidence = max(dot(normal, coreDir), 0.0);
    float core = falloff * (0.34 + 0.66 * incidence) *
      uCoreIntensity * (0.86 + 0.14 * uPulse) * transmit * mix(1.0, 0.45, bulk);

    float sun = max(dot(normal, uLightDir), 0.0);
    vec3 halfVector = normalize(uLightDir + viewDir);
    float facing = max(dot(normal, halfVector), 0.0);
    vec3 spectral = vec3(
      pow(facing, specularPower * 0.68),
      pow(facing, specularPower),
      pow(facing, specularPower * 1.5)
    );
    float specF = f0 + (1.0 - f0) * pow(1.0 - max(dot(viewDir, halfVector), 0.0), 5.0);
    float geo = sun * nDotV / max(sun + nDotV - sun * nDotV, 1e-4);
    float specNorm = (specularPower + 2.0) / 51.0;
    vec3 highlight = mix(vec3(spectral.y), spectral, dispersion) *
      specF * geo * specNorm * uSpecular * outer;
    vec3 windowDir = normalize(vec3(0.85, 0.35, 0.15));
    vec3 windowHalf = normalize(windowDir + viewDir);
    float windowFacing = max(dot(normal, windowHalf), 0.0);
    float windowNdotL = max(dot(normal, windowDir), 0.0);
    float windowGeo = windowNdotL * nDotV /
      max(windowNdotL + nDotV - windowNdotL * nDotV, 1e-4);
    float windowSpecF = f0 + (1.0 - f0) *
      pow(1.0 - max(dot(viewDir, windowHalf), 0.0), 5.0);
    vec3 windowHighlight = vec3(0.78, 0.88, 1.0) *
      pow(windowFacing, specularPower) * windowSpecF * windowGeo * specNorm *
      uSpecular * outer * 0.28;
    // Same Schlick as the WGSL path; keep the two in step.
    float fresnel = f0 + (1.0 - f0) * pow(1.0 - nDotV, 5.0);
    float bounce = 1.0 - fresnel;

    // Same inner specular as the WGSL path; keep the two in step.
    vec3 coreHalf = normalize(coreDir + viewDir);
    float coreFacing = max(dot(normal, coreHalf), 0.0);
    float coreSpecF = f0 + (1.0 - f0) * pow(1.0 - max(dot(viewDir, coreHalf), 0.0), 5.0);
    float coreGeo = incidence * nDotV /
      max(incidence + nDotV - incidence * nDotV, 1e-4);
    float coreSoft = specularPower * dist / max(dist + uCoreRadius, 1e-4);
    vec3 coreSpectral = vec3(
      pow(coreFacing, coreSoft * 0.68),
      pow(coreFacing, coreSoft),
      pow(coreFacing, coreSoft * 1.5)
    );
    vec3 coreHighlight = mix(vec3(coreSpectral.y), coreSpectral, dispersion) *
      coreSpecF * coreGeo * specNorm * falloff *
      uCoreIntensity * (0.86 + 0.14 * uPulse) *
      (1.0 - outer);

    // Same chromatic transmission as the WGSL path; keep the two in step.
    // Same refraction/dispersion split as the WGSL path; keep the two in step.
    // Same texel clamp as the WGSL path; keep the two in step.
    // Same grazing fade as the WGSL path; keep the two in step.
    float grazingFade = smoothstep(0.05, 0.24, nDotV) * uRefractOn;
    float eta = 1.0 / max(iorBend + 1.0, 1.001);
    vec3 frontNormal = dot(normal, viewDir) < 0.0 ? -normal : normal;
    vec3 refracted = refract(-viewDir, frontNormal, eta);
    vec2 rawBend = refracted.xy * uBend * mix(0.55, 1.0, bulk) * outer * grazingFade;
    float bendLength = length(rawBend);
    vec2 bend = bendLength > uMaxBend
      ? rawBend * uMaxBend / max(bendLength, 1e-4)
      : rawBend;
    vec2 offset = bend * uBackdropTexel;
    vec2 spread = offset * dispersion * uSplit;
    vec4 straight = texture(uBackdrop, vScreen + offset);
    float shiftR = texture(uBackdrop, vScreen + offset - spread).r;
    float shiftB = texture(uBackdrop, vScreen + offset + spread).b;
    vec3 split = clamp(
      vec3(shiftR - straight.r, 0.0, shiftB - straight.b),
      -0.25,
      0.25
    ) * transmit;

    // Same transmission as the WGSL path; keep the two in step.
    float attenuation = exp(-absorption * path);
    vec3 transmitted = straight.rgb * attenuation * transmit * bounce;

    // Same edge fringe as the WGSL path; keep the two in step.
    float fringeBand = 1.0 - fresnel;
    vec3 fringe = vec3(
      exp(-fringeBand * fringeBand * 42.0),
      exp(-fringeBand * fringeBand * 78.0),
      exp(-fringeBand * fringeBand * 130.0)
    ) * dispersion * outer;

    // Same split as the WGSL path; keep the two in step.
    vec3 scatter = vTint * core * bounce * outer * 0.45;
    vec3 surface = vTint * body *
      (vec3(uAmbient) + vec3(1.0, 0.94, 0.84) * (0.42 * sun)) *
      mix(1.0, 0.58, bulk) * bounce +
      scatter +
      highlight * 0.9 +
      windowHighlight +
      coreHighlight * 1.15 +
      fringe * 0.55 +
      split * 0.9 * bounce +
      vec3(0.75, 0.88, 1.0) * (fresnel * uRim);
    vec3 interior = mix(uCoreTint * core, transmitted * uRefract, outer);
    vec3 lit = surface + interior;
    // Same coverage model as the WGSL path; keep the two in step.
    float alpha = clamp(
      mix(vSurface.x * opacity, 1.0, outer) + core * 0.1,
      0.0,
      1.0
    );
    finalColor = vec4(lit * alpha, alpha) * vColor;
  }
`;
