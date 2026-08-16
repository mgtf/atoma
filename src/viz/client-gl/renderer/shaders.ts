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

