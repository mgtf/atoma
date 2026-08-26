/**
 * THE crystal's cast, as shader source. One definition per dialect, shared by
 * every surface the cast lands on: the far-field aurora behind the UI, and the
 * pointer-light filter that lights the filled UI itself. Two hand-written
 * copies of a containment test would drift, and the cast would then draw one
 * shape on the backdrop and a different one on the buttons in front of it.
 *
 * Four three-ray bundles arrive in RENDERER PIXELS, traced on the CPU at the
 * two ends of the active material's dispersion band: green is the mean trace,
 * and each corner carries its signed half-separation (red − blue)/2. The
 * shader reconstructs a caustic from each bundle as CURVED FOLD FILAMENTS,
 * never the bundle's own geometry: sampling the triangle's straight edges
 * draws the triangle on the wall, which is a projection of the transport, not
 * a caustic. Each fold is a quadratic arc from vertex to vertex, bowed toward
 * the bundle's centroid. One edge carries a second, unequally bowed fold, so
 * one traced facet produces a nested, lopsided cusp instead of the single
 * rounded triangle a viewer reads as a drawn ring. A faint wide-kernel
 * interior fill carries the body glow.
 *
 * Four properties make it read as light rather than as a shape:
 *
 * - FILAMENT WIDTH RIDES THE FOOTPRINT. The kernels are sized from the
 *   bundle's own area, clamped: a header-sized cast keeps tight sparkle
 *   filaments and a hero-sized cast grows them with itself, instead of one
 *   fixed pixel width that is a blob at 50px and a hairline at 900px.
 * - BRIGHTNESS RIDES BEAM COMPRESSION (inverse footprint area): a tight
 *   bundle is a hot sparkle, a spread one a dim wash.
 * - THE FRINGE IS TRACED, NOT PAINTED. Every fold sample is evaluated at
 *   green + delta·band and green − delta·band as well as at green, so the
 *   red, green and blue filaments are three reconstructions of three real
 *   Snell traces — the arc bows, the cusps and the spectral smear all move
 *   together because they are the same samples at three wavelengths, not one
 *   trace tinted by a heuristic. `band` is the independent Scene Tuning
 *   dispersion scalar: 1 draws the traced band, 0 collapses the wavelengths
 *   onto the mean trace, and the collapse branch is uniform so it skips the
 *   two extra wavelength kernels.
 * - THE INTERPOLATION IS EXACT. Deltas are interpolated at the SAME
 *   barycentric weights as the green point; the traced hit position is affine
 *   in its corner set, so the interpolated wavelength position equals the
 *   wavelength trace evaluated at that sample.
 *
 * GLSL constraint: the pointer-light program carries no `#version 300 es`, so
 * Pixi compiles it as GLSL ES 1.00, where array parameters, dynamic indexing
 * and `%` are unavailable. Every arc point is a FIXED barycentric combination
 * of the three corners, so the whole sampling pattern is generated HERE, in
 * TypeScript, and unrolled flat into both dialects. A per-bundle spatial
 * early-out (centroid reach plus the widest kernel's support) keeps the dense
 * reconstruction off every pixel the bundle cannot touch.
 */

/** Fold filament radius bounds, renderer pixels: sqrt(area) scaled, clamped. */
export const CAUSTIC_FOLD_RIM_MIN_PX = 9;
export const CAUSTIC_FOLD_RIM_MAX_PX = 24;
/** Filament radius as a fraction of the bundle footprint's linear size. */
const CAUSTIC_FOLD_RIM_FRACTION = 0.085;
/** Fill kernels: wider than the folds, the faint body glow between them. */
const CAUSTIC_FILL_RIM_RATIO = 1.7;
/** Shadow kernels: the broad dark contact patch beneath the cast. */
const CAUSTIC_SHADOW_RIM_RATIO = 4.6;
const CAUSTIC_SHADOW_INNER_RIM_RATIO = 3.9;
/** Number of curved folds reconstructed across one triangular ray bundle. */
export const CAUSTIC_FOLD_ARCS = 4;
/** Steps per fold arc: four folds stay near the former three-fold GPU budget. */
export const CAUSTIC_ARC_STEPS = 20;
/** Edge subdivision whose INTERIOR points seed the fill glow. */
export const CAUSTIC_FILL_SUBDIVISION = 8;
/** Interior fill weight: well under the folds, or the cast reads as a filled shape. */
export const CAUSTIC_FILL_WEIGHT = 0.15;
/**
 * How far the folds crossing each edge bow toward the centroid. The first
 * edge carries a second fold; keeping that detail asymmetric avoids both a
 * drawn concentric ring and the shader cost of doubling every edge.
 */
const CAUSTIC_ARC_BOWS = [
  [0.22, 0.48],
  [0.58],
  [0.72],
] as const;
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
/** Six vec4 slots for the same twelve corners' signed half-separations. */
export const CAUSTIC_SPECTRAL_SLOTS = 6;

type Bary = [number, number, number];

/**
 * One point of the fold arc that replaces edge i0→i1: a quadratic Bézier whose
 * control point is the edge midpoint pulled toward the centroid by `bow` —
 * expanded to a fixed barycentric triple so the shader needs only mixes of a,
 * b and c.
 */
function arcPoint(i0: number, i1: number, i2: number, t: number, bow: number): Bary {
  const u = 1 - t;
  const edgeControl = (1 - bow) / 2 + bow / 3;
  const weight = (k: number): number => {
    const control = k === i2 ? bow / 3 : edgeControl;
    return (k === i0 ? u * u : 0) + (k === i1 ? t * t : 0) + 2 * u * t * control;
  };
  return [weight(0), weight(1), weight(2)];
}

const CAUSTIC_PRIMARY_FOLD_SAMPLES: Bary[] = (() => {
  const samples: Bary[] = [];
  const arcs = [
    [0, 1, 2, CAUSTIC_ARC_BOWS[0][1]],
    [1, 2, 0, CAUSTIC_ARC_BOWS[1][0]],
    [2, 0, 1, CAUSTIC_ARC_BOWS[2][0]],
  ] as const;
  for (const [i0, i1, i2, bow] of arcs) {
    for (let step = 0; step <= CAUSTIC_ARC_STEPS; step++) {
      samples.push(arcPoint(i0, i1, i2, step / CAUSTIC_ARC_STEPS, bow));
    }
  }
  return samples;
})();

/** The asymmetric inner fold controlled by the live detail scalar. */
const CAUSTIC_DETAIL_FOLD_SAMPLES: Bary[] = Array.from(
  { length: CAUSTIC_ARC_STEPS + 1 },
  (_, step) => arcPoint(0, 1, 2, step / CAUSTIC_ARC_STEPS, CAUSTIC_ARC_BOWS[0][0])
);

const CAUSTIC_FOLD_SAMPLES = [
  ...CAUSTIC_PRIMARY_FOLD_SAMPLES,
  ...CAUSTIC_DETAIL_FOLD_SAMPLES,
];

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

/**
 * The dialect-neutral barycentric point: valid GLSL ES 1.00 and WGSL alike.
 * `names` picks which corner triple the mix is taken over — the positions
 * (a, b, c) or their spectral half-separations (da, db, dc).
 */
function samplePoint(weights: Bary, names: readonly [string, string, string] = ['a', 'b', 'c']): string {
  const terms: string[] = [];
  for (const [index, name] of names.entries()) {
    const weight = weights[index]!;
    if (weight < 1e-9) continue;
    terms.push(weight > 1 - 1e-9 ? name : `${name} * ${weight.toFixed(4)}`);
  }
  return terms.join(' + ');
}

/**
 * Unrolled kernel sum. `radius` is an EXPRESSION (the adaptive rim variable),
 * not a literal.
 */
function kernelSum(
  fn: string,
  samples: Bary[],
  radius: string,
  extraArgs: string,
  indent: string
): string {
  return samples
    .map((sample) => `${fn}(p, ${samplePoint(sample)}, ${radius}${extraArgs})`)
    .join(` +\n${indent}`);
}

/**
 * Unrolled SPECTRAL fold sum. Each sample evaluates the green point from the
 * corner mix and the wavelength offset from the SAME mix over the corners'
 * half-separations — affine in both, so the interpolated wavelength position
 * equals the wavelength trace at that sample.
 */
function spectralKernelSum(
  samples: Bary[],
  radius: string,
  band: string,
  indent: string
): string {
  const GREEN: readonly [string, string, string] = ['a', 'b', 'c'];
  const DELTA: readonly [string, string, string] = ['da', 'db', 'dc'];
  return samples
    .map((sample) =>
      `causticSpectralFold(p, ${samplePoint(sample, GREEN)}, ` +
      `${samplePoint(sample, DELTA)}, ${radius}, ${band})`
    )
    .join(` +\n${indent}`);
}

/** Effective gaussian support, expressed in multiples of the kernel radius. */
const CAUSTIC_CULL_RADIUS_RATIO = 1.6;

export const CAUSTIC_FIELD_GLSL = /* glsl */ `
  float causticKernel(vec2 p, vec2 samplePoint, float radius) {
    vec2 delta = (p - samplePoint) / radius;
    return exp(-2.4 * dot(delta, delta));
  }

  vec3 causticSpectralFold(
    vec2 p, vec2 greenPoint, vec2 deltaPoint, float radius, float band
  ) {
    float green = causticKernel(p, greenPoint, radius);
    // Uniform branch: band is a uniform, so collapsing the wavelengths skips
    // both extra kernels for the whole draw rather than paying them.
    if (band < 0.004) return vec3(green);
    float red = causticKernel(p, greenPoint + deltaPoint * band, radius);
    float blue = causticKernel(p, greenPoint - deltaPoint * band, radius);
    return vec3(red, green, blue);
  }

  vec4 causticBundle(
    vec2 p, vec2 a, vec2 b, vec2 c, float intensity, vec3 tint,
    vec2 da, vec2 db, vec2 dc, float band, float detail
  ) {
    if (intensity < 0.001) return vec4(0.0);
    vec2 centre = (a + b + c) / 3.0;
    float area = abs(
      (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    ) * 0.5;
    float foldRim = clamp(
      sqrt(area) * ${CAUSTIC_FOLD_RIM_FRACTION.toFixed(3)},
      ${CAUSTIC_FOLD_RIM_MIN_PX.toFixed(1)}, ${CAUSTIC_FOLD_RIM_MAX_PX.toFixed(1)}
    );
    // Cull against the REAL spectral footprint. The former fixed pad used the
    // largest possible rim for every bundle, making a hero cast shade most of
    // the viewport with 259 gaussian kernels per bundle. Every fold sample is
    // a convex mix of these wavelength corners; every fill/shadow centre is a
    // convex mix of the green corners, so this AABB plus the widest kernel's
    // effective support cannot clip a contribution the old cull retained.
    vec2 redA = a + da * band;
    vec2 redB = b + db * band;
    vec2 redC = c + dc * band;
    vec2 blueA = a - da * band;
    vec2 blueB = b - db * band;
    vec2 blueC = c - dc * band;
    vec2 spectralMin = min(min(min(redA, redB), redC), min(min(blueA, blueB), blueC));
    vec2 spectralMax = max(max(max(redA, redB), redC), max(max(blueA, blueB), blueC));
    float cullPad = foldRim * ${CAUSTIC_SHADOW_RIM_RATIO.toFixed(1)} *
      ${CAUSTIC_CULL_RADIUS_RATIO.toFixed(1)};
    if (any(lessThan(p, spectralMin - vec2(cullPad))) ||
        any(greaterThan(p, spectralMax + vec2(cullPad)))) return vec4(0.0);
    vec2 innerA = (a * 2.0 + b + c) * 0.25;
    vec2 innerB = (a + b * 2.0 + c) * 0.25;
    vec2 innerC = (a + b + c * 2.0) * 0.25;
    float press = clamp(
      ${CAUSTIC_PRESS_REF.toFixed(1)} / (area + ${CAUSTIC_PRESS_SOFT.toFixed(1)}),
      ${CAUSTIC_PRESS_MIN.toFixed(2)}, ${CAUSTIC_PRESS_MAX.toFixed(2)}
    );
    // Detail is independent from dispersion: it sharpens the three primary
    // folds and fades in the asymmetric fourth fold. Identity 1 reproduces
    // the shipped reconstruction exactly; 0 leaves a broad three-fold cast.
    float detailAmount = clamp(detail, 0.0, 2.0);
    float detailRim = foldRim / mix(0.75, 1.25, detailAmount * 0.5);
    float detailWeight = min(detailAmount, 1.5);
    float fillRim = detailRim * ${CAUSTIC_FILL_RIM_RATIO.toFixed(2)};
    vec3 primaryFolds =
      ${spectralKernelSum(CAUSTIC_PRIMARY_FOLD_SAMPLES, 'detailRim', 'band', '      ')};
    vec3 detailFold = vec3(0.0);
    if (detailAmount > 0.004) {
      detailFold =
        ${spectralKernelSum(CAUSTIC_DETAIL_FOLD_SAMPLES, 'detailRim', 'band', '        ')};
    }
    vec3 spectral = primaryFolds + detailFold * detailWeight;
    float fill =
      ${kernelSum('causticKernel', CAUSTIC_FILL_SAMPLES, 'fillRim', '', '      ')};
    vec3 light = clamp(
      (spectral + vec3(fill * ${CAUSTIC_FILL_WEIGHT.toFixed(2)}))
        * ${CAUSTIC_SUM_GAIN.toFixed(3)} * press,
      0.0, 1.0
    );
    float shadow = (
      causticKernel(p, centre, foldRim * ${CAUSTIC_SHADOW_RIM_RATIO.toFixed(1)}) +
      causticKernel(p, innerA, foldRim * ${CAUSTIC_SHADOW_INNER_RIM_RATIO.toFixed(1)}) +
      causticKernel(p, innerB, foldRim * ${CAUSTIC_SHADOW_INNER_RIM_RATIO.toFixed(1)}) +
      causticKernel(p, innerC, foldRim * ${CAUSTIC_SHADOW_INNER_RIM_RATIO.toFixed(1)})
    ) * 0.25;
    return vec4(
      tint * intensity * light * ${CAUSTIC_LIGHT_GAIN.toFixed(2)},
      intensity * shadow * ${CAUSTIC_SHADOW_GAIN.toFixed(2)}
    );
  }

  vec4 causticField(
    vec2 p,
    vec4 c0, vec4 c1, vec4 c2, vec4 c3, vec4 c4, vec4 c5,
    vec4 s0, vec4 s1, vec4 s2, vec4 s3, vec4 s4, vec4 s5,
    float intensity,
    vec3 tint,
    float band,
    float detail
  ) {
    vec4 lobe0 = causticBundle(
      p, c0.xy, c0.zw, c1.xy, intensity,
      mix(tint, vec3(1.0, 0.48, 0.18), 0.18),
      s0.xy, s0.zw, s1.xy, band, detail
    );
    vec4 lobe1 = causticBundle(
      p, c1.zw, c2.xy, c2.zw, intensity * 0.88,
      mix(tint, vec3(0.16, 0.68, 1.0), 0.20),
      s1.zw, s2.xy, s2.zw, band, detail
    );
    vec4 lobe2 = causticBundle(
      p, c3.xy, c3.zw, c4.xy, intensity * 0.76,
      mix(tint, vec3(0.40, 1.0, 0.62), 0.14),
      s3.xy, s3.zw, s4.xy, band, detail
    );
    vec4 lobe3 = causticBundle(
      p, c4.zw, c5.xy, c5.zw, intensity * 0.68,
      mix(tint, vec3(0.74, 0.42, 1.0), 0.16),
      s4.zw, s5.xy, s5.zw, band, detail
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

  fn causticSpectralFold(
    p: vec2<f32>, greenPoint: vec2<f32>, deltaPoint: vec2<f32>,
    radius: f32, band: f32,
  ) -> vec3<f32> {
    let green = causticKernel(p, greenPoint, radius);
    // Uniform branch, twin of the GLSL one.
    if (band < 0.004) {
      return vec3<f32>(green);
    }
    let red = causticKernel(p, greenPoint + deltaPoint * band, radius);
    let blue = causticKernel(p, greenPoint - deltaPoint * band, radius);
    return vec3<f32>(red, green, blue);
  }

  fn causticBundle(
    p: vec2<f32>, a: vec2<f32>, b: vec2<f32>, c: vec2<f32>,
    intensity: f32, tint: vec3<f32>,
    da: vec2<f32>, db: vec2<f32>, dc: vec2<f32>, band: f32, detail: f32,
  ) -> vec4<f32> {
    if (intensity < 0.001) {
      return vec4<f32>(0.0);
    }
    let centre = (a + b + c) / 3.0;
    let area = abs(
      (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    ) * 0.5;
    let foldRim = clamp(
      sqrt(area) * ${CAUSTIC_FOLD_RIM_FRACTION.toFixed(3)},
      ${CAUSTIC_FOLD_RIM_MIN_PX.toFixed(1)}, ${CAUSTIC_FOLD_RIM_MAX_PX.toFixed(1)},
    );
    // Twin of the GLSL ROI above: include both traced wavelengths before
    // adding the actual shadow kernel's support.
    let redA = a + da * band;
    let redB = b + db * band;
    let redC = c + dc * band;
    let blueA = a - da * band;
    let blueB = b - db * band;
    let blueC = c - dc * band;
    let spectralMin = min(min(min(redA, redB), redC), min(min(blueA, blueB), blueC));
    let spectralMax = max(max(max(redA, redB), redC), max(max(blueA, blueB), blueC));
    let cullPad = foldRim * ${CAUSTIC_SHADOW_RIM_RATIO.toFixed(1)} *
      ${CAUSTIC_CULL_RADIUS_RATIO.toFixed(1)};
    if (any(p < spectralMin - vec2<f32>(cullPad)) ||
        any(p > spectralMax + vec2<f32>(cullPad))) {
      return vec4<f32>(0.0);
    }
    let innerA = (a * 2.0 + b + c) * 0.25;
    let innerB = (a + b * 2.0 + c) * 0.25;
    let innerC = (a + b + c * 2.0) * 0.25;
    let press = clamp(
      ${CAUSTIC_PRESS_REF.toFixed(1)} / (area + ${CAUSTIC_PRESS_SOFT.toFixed(1)}),
      ${CAUSTIC_PRESS_MIN.toFixed(2)}, ${CAUSTIC_PRESS_MAX.toFixed(2)},
    );
    // Twin of the GLSL detail control above.
    let detailAmount = clamp(detail, 0.0, 2.0);
    let detailRim = foldRim / mix(0.75, 1.25, detailAmount * 0.5);
    let detailWeight = min(detailAmount, 1.5);
    let fillRim = detailRim * ${CAUSTIC_FILL_RIM_RATIO.toFixed(2)};
    let primaryFolds =
      ${spectralKernelSum(CAUSTIC_PRIMARY_FOLD_SAMPLES, 'detailRim', 'band', '      ')};
    var detailFold = vec3<f32>(0.0);
    if (detailAmount > 0.004) {
      detailFold =
        ${spectralKernelSum(CAUSTIC_DETAIL_FOLD_SAMPLES, 'detailRim', 'band', '        ')};
    }
    let spectral = primaryFolds + detailFold * detailWeight;
    let fill =
      ${kernelSum('causticKernel', CAUSTIC_FILL_SAMPLES, 'fillRim', '', '      ')};
    let light = clamp(
      (spectral + vec3<f32>(fill * ${CAUSTIC_FILL_WEIGHT.toFixed(2)}))
        * ${CAUSTIC_SUM_GAIN.toFixed(3)} * press,
      vec3<f32>(0.0), vec3<f32>(1.0),
    );
    let shadow = (
      causticKernel(p, centre, foldRim * ${CAUSTIC_SHADOW_RIM_RATIO.toFixed(1)}) +
      causticKernel(p, innerA, foldRim * ${CAUSTIC_SHADOW_INNER_RIM_RATIO.toFixed(1)}) +
      causticKernel(p, innerB, foldRim * ${CAUSTIC_SHADOW_INNER_RIM_RATIO.toFixed(1)}) +
      causticKernel(p, innerC, foldRim * ${CAUSTIC_SHADOW_INNER_RIM_RATIO.toFixed(1)})
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
    s0: vec4<f32>, s1: vec4<f32>, s2: vec4<f32>,
    s3: vec4<f32>, s4: vec4<f32>, s5: vec4<f32>,
    intensity: f32, tint: vec3<f32>, band: f32, detail: f32,
  ) -> vec4<f32> {
    let lobe0 = causticBundle(
      p, c0.xy, c0.zw, c1.xy, intensity,
      mix(tint, vec3<f32>(1.0, 0.48, 0.18), vec3<f32>(0.18)),
      s0.xy, s0.zw, s1.xy, band, detail,
    );
    let lobe1 = causticBundle(
      p, c1.zw, c2.xy, c2.zw, intensity * 0.88,
      mix(tint, vec3<f32>(0.16, 0.68, 1.0), vec3<f32>(0.20)),
      s1.zw, s2.xy, s2.zw, band, detail,
    );
    let lobe2 = causticBundle(
      p, c3.xy, c3.zw, c4.xy, intensity * 0.76,
      mix(tint, vec3<f32>(0.40, 1.0, 0.62), vec3<f32>(0.14)),
      s3.xy, s3.zw, s4.xy, band, detail,
    );
    let lobe3 = causticBundle(
      p, c4.zw, c5.xy, c5.zw, intensity * 0.68,
      mix(tint, vec3<f32>(0.74, 0.42, 1.0), vec3<f32>(0.16)),
      s4.zw, s5.xy, s5.zw, band, detail,
    );
    let shadow = 1.0 -
      (1.0 - lobe0.a) * (1.0 - lobe1.a) *
      (1.0 - lobe2.a) * (1.0 - lobe3.a);
    return vec4<f32>(lobe0.rgb + lobe1.rgb + lobe2.rgb + lobe3.rgb, shadow);
  }
`;
