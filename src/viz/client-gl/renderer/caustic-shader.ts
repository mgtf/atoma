/**
 * THE crystal's cast, as shader source. One definition per dialect, shared by
 * every surface the cast lands on: the far-field aurora behind the UI, and the
 * pointer-light filter that lights the filled UI itself. Two hand-written
 * copies of a containment test would drift, and the cast would then draw one
 * shape on the backdrop and a different one on the buttons in front of it.
 *
 * Four three-ray bundles arrive in RENDERER PIXELS. The shader reconstructs a
 * caustic from each bundle as CURVED FOLD FILAMENTS, never the bundle's own
 * geometry: sampling the triangle's straight edges draws the triangle on the
 * wall, which is a projection of the transport, not a caustic. Each fold is a
 * quadratic arc from vertex to vertex, bowed toward the bundle's centroid, so
 * the envelope is a cusped curved figure — the shape light actually folds
 * into. The vertices are sampled by two arcs each, which doubles them into
 * bright cusps for free, and a faint wide-kernel interior fill carries the
 * body glow. Brightness scales with BEAM COMPRESSION (inverse footprint
 * area): a tight bundle is a hot sparkle, a spread one a dim wash.
 *
 * GLSL constraint: the pointer-light program carries no `#version 300 es`, so
 * Pixi compiles it as GLSL ES 1.00, where array parameters, dynamic indexing
 * and `%` are unavailable. Every arc point is a FIXED barycentric combination
 * of the three corners, so the whole sampling pattern is generated HERE, in
 * TypeScript, and unrolled flat into both dialects. A per-bundle spatial
 * early-out (centroid reach plus the widest kernel's support) keeps the dense
 * reconstruction off every pixel the bundle cannot touch.
 */

/** Base kernel scale in renderer pixels: shadow radii and the receiver throw derive from it. */
export const CAUSTIC_RIM_PX = 24;
/** Fold kernels: tight, along the bowed arcs, the bright caustic filaments. */
export const CAUSTIC_FOLD_RIM_PX = 12;
/** Fill kernels: wide, in the bundle's interior, the faint body glow. */
export const CAUSTIC_FILL_RIM_PX = 20;
/** Steps per fold arc: each arc contributes this many segments (+1 points). */
export const CAUSTIC_ARC_STEPS = 25;
/** Edge subdivision whose INTERIOR points seed the fill glow. */
export const CAUSTIC_FILL_SUBDIVISION = 8;
/** Interior fill weight: well under the folds, or the cast reads as a filled shape. */
export const CAUSTIC_FILL_WEIGHT = 0.15;
/** How far each fold arc bows from the straight edge toward the centroid. */
const CAUSTIC_ARC_BOW = 0.45;
const CAUSTIC_SUM_GAIN = 0.3;
const CAUSTIC_LIGHT_GAIN = 0.52;
const CAUSTIC_SHADOW_GAIN = 0.12;
/**
 * Beam compression: light * clamp(REF / (area + SOFT), MIN, MAX). REF is the
 * footprint (renderer px²) at which a bundle is at nominal brightness; SOFT
 * keeps a degenerate sliver finite; the clamps bound the sparkle dynamics.
 */
const CAUSTIC_PRESS_REF = 26000;
const CAUSTIC_PRESS_SOFT = 1200;
const CAUSTIC_PRESS_MIN = 0.55;
const CAUSTIC_PRESS_MAX = 2.4;

/** Six vec4 slots, each carrying two hit points: twelve traced rays total. */
export const CAUSTIC_CORNER_SLOTS = 6;

type Bary = [number, number, number];

/**
 * One point of the fold arc that replaces edge i0→i1: a quadratic Bézier whose
 * control point is the edge midpoint pulled toward the centroid — expanded to
 * a fixed barycentric triple so the shader needs only mixes of a, b and c.
 */
function arcPoint(i0: number, i1: number, i2: number, t: number): Bary {
  const u = 1 - t;
  const edgeControl = (1 - CAUSTIC_ARC_BOW) / 2 + CAUSTIC_ARC_BOW / 3;
  const weight = (k: number): number => {
    const control = k === i2 ? CAUSTIC_ARC_BOW / 3 : edgeControl;
    return (k === i0 ? u * u : 0) + (k === i1 ? t * t : 0) + 2 * u * t * control;
  };
  return [weight(0), weight(1), weight(2)];
}

const CAUSTIC_FOLD_SAMPLES: Bary[] = (() => {
  const samples: Bary[] = [];
  for (const [i0, i1, i2] of [
    [0, 1, 2],
    [1, 2, 0],
    [2, 0, 1],
  ] as const) {
    for (let step = 0; step <= CAUSTIC_ARC_STEPS; step++) {
      samples.push(arcPoint(i0, i1, i2, step / CAUSTIC_ARC_STEPS));
    }
  }
  return samples;
})();

const CAUSTIC_FILL_SAMPLES: Bary[] = (() => {
  const n = CAUSTIC_FILL_SUBDIVISION;
  const samples: Bary[] = [];
  for (let i = 1; i < n; i++) {
    for (let j = 1; j < n - i; j++) {
      samples.push([i / n, j / n, (n - i - j) / n]);
    }
  }
  return samples;
})();

/** Light samples reconstructed inside ONE bundle (fold arcs + interior fill). */
export const CAUSTIC_SAMPLES_PER_BUNDLE =
  CAUSTIC_FOLD_SAMPLES.length + CAUSTIC_FILL_SAMPLES.length;

/** The dialect-neutral barycentric point: valid GLSL ES 1.00 and WGSL alike. */
function samplePoint(weights: Bary): string {
  const terms: string[] = [];
  for (const [name, weight] of [
    ['a', weights[0]],
    ['b', weights[1]],
    ['c', weights[2]],
  ] as const) {
    if (weight < 1e-9) continue;
    terms.push(weight > 1 - 1e-9 ? name : `${name} * ${weight.toFixed(4)}`);
  }
  return terms.join(' + ');
}

function kernelSum(samples: Bary[], radius: number, indent: string): string {
  return samples
    .map((sample) => `causticKernel(p, ${samplePoint(sample)}, ${radius.toFixed(1)})`)
    .join(` +\n${indent}`);
}

/**
 * Beyond the widest kernel's effective support the gaussian is numerically
 * zero, so a pixel further than the bundle's reach plus this pad from its
 * centroid owes nothing to the reconstruction. The widest kernel is the shadow's.
 */
const CAUSTIC_CULL_PAD = CAUSTIC_RIM_PX * 2.5 * 1.6;

export const CAUSTIC_FIELD_GLSL = /* glsl */ `
  float causticKernel(vec2 p, vec2 samplePoint, float radius) {
    vec2 delta = (p - samplePoint) / radius;
    return exp(-2.4 * dot(delta, delta));
  }

  vec4 causticBundle(
    vec2 p, vec2 a, vec2 b, vec2 c, float intensity, vec3 tint
  ) {
    if (intensity < 0.001) return vec4(0.0);
    vec2 centre = (a + b + c) / 3.0;
    vec2 away = p - centre;
    float reach = max(
      dot(a - centre, a - centre),
      max(dot(b - centre, b - centre), dot(c - centre, c - centre))
    );
    float cull = sqrt(reach) + ${CAUSTIC_CULL_PAD.toFixed(1)};
    if (dot(away, away) > cull * cull) return vec4(0.0);
    vec2 innerA = (a * 2.0 + b + c) * 0.25;
    vec2 innerB = (a + b * 2.0 + c) * 0.25;
    vec2 innerC = (a + b + c * 2.0) * 0.25;
    float area = abs(
      (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    ) * 0.5;
    float press = clamp(
      ${CAUSTIC_PRESS_REF.toFixed(1)} / (area + ${CAUSTIC_PRESS_SOFT.toFixed(1)}),
      ${CAUSTIC_PRESS_MIN.toFixed(2)}, ${CAUSTIC_PRESS_MAX.toFixed(2)}
    );
    float fold =
      ${kernelSum(CAUSTIC_FOLD_SAMPLES, CAUSTIC_FOLD_RIM_PX, '      ')};
    float fill =
      ${kernelSum(CAUSTIC_FILL_SAMPLES, CAUSTIC_FILL_RIM_PX, '      ')};
    float light = clamp(
      (fold + fill * ${CAUSTIC_FILL_WEIGHT.toFixed(2)})
        * ${CAUSTIC_SUM_GAIN.toFixed(3)} * press,
      0.0, 1.0
    );
    float shadow = (
      causticKernel(p, centre, ${CAUSTIC_RIM_PX.toFixed(1)} * 2.5) +
      causticKernel(p, innerA, ${CAUSTIC_RIM_PX.toFixed(1)} * 2.1) +
      causticKernel(p, innerB, ${CAUSTIC_RIM_PX.toFixed(1)} * 2.1) +
      causticKernel(p, innerC, ${CAUSTIC_RIM_PX.toFixed(1)} * 2.1)
    ) * 0.25;
    return vec4(
      tint * intensity * light * ${CAUSTIC_LIGHT_GAIN.toFixed(2)},
      intensity * shadow * ${CAUSTIC_SHADOW_GAIN.toFixed(2)}
    );
  }

  vec4 causticField(
    vec2 p,
    vec4 c0, vec4 c1, vec4 c2, vec4 c3, vec4 c4, vec4 c5,
    float intensity,
    vec3 tint
  ) {
    vec4 lobe0 = causticBundle(
      p, c0.xy, c0.zw, c1.xy, intensity,
      mix(tint, vec3(1.0, 0.48, 0.18), 0.18)
    );
    vec4 lobe1 = causticBundle(
      p, c1.zw, c2.xy, c2.zw, intensity * 0.88,
      mix(tint, vec3(0.16, 0.68, 1.0), 0.20)
    );
    vec4 lobe2 = causticBundle(
      p, c3.xy, c3.zw, c4.xy, intensity * 0.76,
      mix(tint, vec3(0.40, 1.0, 0.62), 0.14)
    );
    vec4 lobe3 = causticBundle(
      p, c4.zw, c5.xy, c5.zw, intensity * 0.68,
      mix(tint, vec3(0.74, 0.42, 1.0), 0.16)
    );
    float shadow = 1.0 -
      (1.0 - lobe0.a) * (1.0 - lobe1.a) *
      (1.0 - lobe2.a) * (1.0 - lobe3.a);
    return vec4(lobe0.rgb + lobe1.rgb + lobe2.rgb + lobe3.rgb, shadow);
  }
`;

export const CAUSTIC_FIELD_WGSL = /* wgsl */ `
  fn causticKernel(p: vec2<f32>, samplePoint: vec2<f32>, radius: f32) -> f32 {
    let delta = (p - samplePoint) / radius;
    return exp(-2.4 * dot(delta, delta));
  }

  fn causticBundle(
    p: vec2<f32>, a: vec2<f32>, b: vec2<f32>, c: vec2<f32>,
    intensity: f32, tint: vec3<f32>,
  ) -> vec4<f32> {
    if (intensity < 0.001) {
      return vec4<f32>(0.0);
    }
    let centre = (a + b + c) / 3.0;
    let away = p - centre;
    let reach = max(
      dot(a - centre, a - centre),
      max(dot(b - centre, b - centre), dot(c - centre, c - centre)),
    );
    let cull = sqrt(reach) + ${CAUSTIC_CULL_PAD.toFixed(1)};
    if (dot(away, away) > cull * cull) {
      return vec4<f32>(0.0);
    }
    let innerA = (a * 2.0 + b + c) * 0.25;
    let innerB = (a + b * 2.0 + c) * 0.25;
    let innerC = (a + b + c * 2.0) * 0.25;
    let area = abs(
      (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    ) * 0.5;
    let press = clamp(
      ${CAUSTIC_PRESS_REF.toFixed(1)} / (area + ${CAUSTIC_PRESS_SOFT.toFixed(1)}),
      ${CAUSTIC_PRESS_MIN.toFixed(2)}, ${CAUSTIC_PRESS_MAX.toFixed(2)},
    );
    let fold =
      ${kernelSum(CAUSTIC_FOLD_SAMPLES, CAUSTIC_FOLD_RIM_PX, '      ')};
    let fill =
      ${kernelSum(CAUSTIC_FILL_SAMPLES, CAUSTIC_FILL_RIM_PX, '      ')};
    let light = clamp(
      (fold + fill * ${CAUSTIC_FILL_WEIGHT.toFixed(2)})
        * ${CAUSTIC_SUM_GAIN.toFixed(3)} * press,
      0.0, 1.0,
    );
    let shadow = (
      causticKernel(p, centre, ${CAUSTIC_RIM_PX.toFixed(1)} * 2.5) +
      causticKernel(p, innerA, ${CAUSTIC_RIM_PX.toFixed(1)} * 2.1) +
      causticKernel(p, innerB, ${CAUSTIC_RIM_PX.toFixed(1)} * 2.1) +
      causticKernel(p, innerC, ${CAUSTIC_RIM_PX.toFixed(1)} * 2.1)
    ) * 0.25;
    return vec4<f32>(
      tint * intensity * light * ${CAUSTIC_LIGHT_GAIN.toFixed(2)},
      intensity * shadow * ${CAUSTIC_SHADOW_GAIN.toFixed(2)},
    );
  }

  fn causticField(
    p: vec2<f32>,
    c0: vec4<f32>, c1: vec4<f32>, c2: vec4<f32>,
    c3: vec4<f32>, c4: vec4<f32>, c5: vec4<f32>,
    intensity: f32, tint: vec3<f32>,
  ) -> vec4<f32> {
    let lobe0 = causticBundle(
      p, c0.xy, c0.zw, c1.xy, intensity,
      mix(tint, vec3<f32>(1.0, 0.48, 0.18), vec3<f32>(0.18)),
    );
    let lobe1 = causticBundle(
      p, c1.zw, c2.xy, c2.zw, intensity * 0.88,
      mix(tint, vec3<f32>(0.16, 0.68, 1.0), vec3<f32>(0.20)),
    );
    let lobe2 = causticBundle(
      p, c3.xy, c3.zw, c4.xy, intensity * 0.76,
      mix(tint, vec3<f32>(0.40, 1.0, 0.62), vec3<f32>(0.14)),
    );
    let lobe3 = causticBundle(
      p, c4.zw, c5.xy, c5.zw, intensity * 0.68,
      mix(tint, vec3<f32>(0.74, 0.42, 1.0), vec3<f32>(0.16)),
    );
    let shadow = 1.0 -
      (1.0 - lobe0.a) * (1.0 - lobe1.a) *
      (1.0 - lobe2.a) * (1.0 - lobe3.a);
    return vec4<f32>(lobe0.rgb + lobe1.rgb + lobe2.rgb + lobe3.rgb, shadow);
  }
`;
