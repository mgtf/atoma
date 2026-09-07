/**
 * The crystal cast reconstructed from the four traced facet bundles.
 *
 * A bundle contains three transported rays at the mean wavelength and their
 * measured spectral offsets. The former shader expanded those twelve rays
 * into hundreds of Gaussian samples and several artist-authored curves per
 * fragment. Besides dominating the hero frame, those invented curves read as
 * coloured decals rather than concentrated light.
 *
 * This reconstruction treats each triangular bundle as a compact photon
 * footprint. Its centroid and covariance define one smooth, elliptical energy
 * distribution; red and blue evaluate the same moment fit at their traced
 * positions. Four overlapping footprints therefore get brighter where the
 * transported beams really overlap, with fixed work independent of footprint
 * size. The output is additive light only: receiver shadowing belongs to scene
 * geometry, not to a negative Gaussian painted around a caustic.
 *
 * GLSL remains ES 1.00-compatible even though the cast now lands only on the
 * far field. Keeping the source conservative makes it safe to reuse in either
 * Pixi backend without arrays, dynamic indexing, or generated source.
 */

/** Six vec4 slots, each carrying two hit points: twelve traced rays total. */
export const CAUSTIC_CORNER_SLOTS = 6;
/** Six vec4 slots for the same twelve corners' signed half-separations. */
export const CAUSTIC_SPECTRAL_SLOTS = 6;
/** The transport publishes exactly four triangular facet bundles. */
export const CAUSTIC_BUNDLE_COUNT = 4;
/** At most one real Fresnel-reflected branch survives CPU ranking. */
export const CAUSTIC_SECONDARY_BUNDLE_COUNT = 1;
/** Two vec4 slots carry the secondary triangle's three corners. */
export const CAUSTIC_SECONDARY_CORNER_SLOTS = 2;
/** Two matching slots carry its three signed spectral offsets. */
export const CAUSTIC_SECONDARY_SPECTRAL_SLOTS = 2;
/** Mean, red and blue moment fits: fixed work per visible bundle. */
export const CAUSTIC_FOOTPRINT_EVALUATIONS_PER_BUNDLE = 3;
/** Hard ceiling across four primary bundles and one secondary branch. */
export const CAUSTIC_MAX_FOOTPRINT_EVALUATIONS =
  (CAUSTIC_BUNDLE_COUNT + CAUSTIC_SECONDARY_BUNDLE_COUNT) *
  CAUSTIC_FOOTPRINT_EVALUATIONS_PER_BUNDLE;

const CAUSTIC_BLUR_MIN_PX = 4;
const CAUSTIC_BLUR_MAX_PX = 12;
const CAUSTIC_BLUR_AREA_FRACTION = 0.035;
const CAUSTIC_CULL_EDGE_FRACTION = 0.38;
const CAUSTIC_CULL_PAD_MIN_PX = 18;
const CAUSTIC_CULL_PAD_MAX_PX = 96;
const CAUSTIC_ENERGY_GAIN = 0.42;
const CAUSTIC_PRESS_REF = 24000;
const CAUSTIC_PRESS_SOFT = 3200;
const CAUSTIC_PRESS_MIN = 0.32;
const CAUSTIC_PRESS_MAX = 1.35;

/** Conservative receiver bounds, using the shader's exact bundle-culling pad. */
export function causticReceiverBounds(
  cast: import('../mark-field-light.js').MarkCausticUniforms,
  band: number
): { left: number; top: number; right: number; bottom: number } {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const include = (
    corners: readonly { x: number; y: number }[],
    spectral: readonly { x: number; y: number }[] | null
  ) => {
    for (let start = 0; start < corners.length; start += 3) {
      const triangle = corners.slice(start, start + 3);
      let edge = 0;
      let spectralReach = 0;
      for (let index = 0; index < triangle.length; index += 1) {
        const point = triangle[index]!;
        const next = triangle[(index + 1) % triangle.length]!;
        edge = Math.max(edge, Math.hypot(point.x - next.x, point.y - next.y));
        const delta = spectral?.[start + index];
        if (delta) spectralReach = Math.max(spectralReach, Math.hypot(delta.x, delta.y));
      }
      const pad = Math.min(CAUSTIC_CULL_PAD_MAX_PX,
        Math.max(CAUSTIC_CULL_PAD_MIN_PX, edge * CAUSTIC_CULL_EDGE_FRACTION)) +
        spectralReach * Math.min(2, Math.max(0, band));
      for (const point of triangle) {
        left = Math.min(left, point.x - pad);
        top = Math.min(top, point.y - pad);
        right = Math.max(right, point.x + pad);
        bottom = Math.max(bottom, point.y + pad);
      }
    }
  };
  include(cast.corners, cast.spectral);
  if (cast.secondary) include(cast.secondary.corners, cast.secondary.spectral);
  return { left, top, right, bottom };
}

export const CAUSTIC_FIELD_GLSL = /* glsl */ `
  float causticCross(vec2 a, vec2 b) {
    return a.x * b.y - a.y * b.x;
  }

  // Moment-matched photon footprint. The covariance comes from the three
  // transported rays themselves; the small isotropic term is the receiver's
  // finite blur and also keeps a focused/degenerate bundle numerically safe.
  float causticFootprint(
    vec2 p, vec2 a, vec2 b, vec2 c, float blur, float focus
  ) {
    vec2 centre = (a + b + c) / 3.0;
    vec2 va = a - centre;
    vec2 vb = b - centre;
    vec2 vc = c - centre;
    float xx = (va.x * va.x + vb.x * vb.x + vc.x * vc.x) / 3.0 + blur * blur;
    float xy = (va.x * va.y + vb.x * vb.y + vc.x * vc.y) / 3.0;
    float yy = (va.y * va.y + vb.y * vb.y + vc.y * vc.y) / 3.0 + blur * blur;
    float determinant = max(xx * yy - xy * xy, 1.0);
    vec2 delta = p - centre;
    float distance2 = max(0.0, (
      yy * delta.x * delta.x - 2.0 * xy * delta.x * delta.y +
      xx * delta.y * delta.y
    ) / determinant);
    float penumbra = 1.0 - smoothstep(0.08, 4.2, distance2 * focus);
    float core = 1.0 - smoothstep(0.015, 0.72, distance2 * focus);
    return penumbra * penumbra * 0.66 + core * core * 0.34;
  }

  vec4 causticBundle(
    vec2 p, vec2 a, vec2 b, vec2 c, vec4 transmission,
    vec2 da, vec2 db, vec2 dc, float band, float detail
  ) {
    if (transmission.a < 0.001) return vec4(0.0);

    float area = abs(causticCross(b - a, c - a)) * 0.5;
    vec2 edge0 = b - a;
    vec2 edge1 = c - b;
    vec2 edge2 = a - c;
    float edge = sqrt(max(max(dot(edge0, edge0), dot(edge1, edge1)), dot(edge2, edge2)));
    float tracedBand = clamp(band, 0.0, 2.0);
    float spectralReach = sqrt(
      max(max(dot(da, da), dot(db, db)), dot(dc, dc))
    ) * tracedBand;
    vec2 footprintMin = min(min(a, b), c);
    vec2 footprintMax = max(max(a, b), c);
    float cullPad = clamp(
      edge * ${CAUSTIC_CULL_EDGE_FRACTION.toFixed(2)},
      ${CAUSTIC_CULL_PAD_MIN_PX.toFixed(1)}, ${CAUSTIC_CULL_PAD_MAX_PX.toFixed(1)}
    ) + spectralReach;
    if (any(lessThan(p, footprintMin - vec2(cullPad))) ||
        any(greaterThan(p, footprintMax + vec2(cullPad)))) return vec4(0.0);

    float blur = clamp(
      sqrt(max(area, 1.0)) * ${CAUSTIC_BLUR_AREA_FRACTION.toFixed(3)},
      ${CAUSTIC_BLUR_MIN_PX.toFixed(1)}, ${CAUSTIC_BLUR_MAX_PX.toFixed(1)}
    );
    float focus = mix(0.82, 1.34, clamp(detail * 0.5, 0.0, 1.0));
    float green = causticFootprint(p, a, b, c, blur, focus);
    vec3 spectral = vec3(green);
    if (tracedBand > 0.002) {
      float red = causticFootprint(
        p, a + da * tracedBand, b + db * tracedBand, c + dc * tracedBand,
        blur, focus
      );
      float blue = causticFootprint(
        p, a - da * tracedBand, b - db * tracedBand, c - dc * tracedBand,
        blur, focus
      );
      spectral = vec3(red, green, blue);
    }

    // Overlap recombines to white by itself; separated wavelengths retain
    // their spectral fringe. RGB transmission came from the traced coatings.
    vec3 beam = spectral;
    float press = clamp(
      ${CAUSTIC_PRESS_REF.toFixed(1)} / (area + ${CAUSTIC_PRESS_SOFT.toFixed(1)}),
      ${CAUSTIC_PRESS_MIN.toFixed(2)}, ${CAUSTIC_PRESS_MAX.toFixed(2)}
    );
    return vec4(
      clamp(transmission.rgb, vec3(0.0), vec3(1.0)) * beam *
        transmission.a * press * ${CAUSTIC_ENERGY_GAIN.toFixed(2)},
      0.0
    );
  }

  vec4 causticField(
    vec2 p,
    vec4 c0, vec4 c1, vec4 c2, vec4 c3, vec4 c4, vec4 c5,
    vec4 s0, vec4 s1, vec4 s2, vec4 s3, vec4 s4, vec4 s5,
    vec4 o0, vec4 o1, vec4 o2, vec4 o3,
    vec4 secondary0, vec4 secondary1,
    vec4 secondarySpec0, vec4 secondarySpec1,
    vec4 secondaryOptics,
    float band,
    float detail
  ) {
    vec3 radiance =
      causticBundle(
        p, c0.xy, c0.zw, c1.xy, o0,
        s0.xy, s0.zw, s1.xy, band, detail
      ).rgb +
      causticBundle(
        p, c1.zw, c2.xy, c2.zw, o1,
        s1.zw, s2.xy, s2.zw, band, detail
      ).rgb +
      causticBundle(
        p, c3.xy, c3.zw, c4.xy, o2,
        s3.xy, s3.zw, s4.xy, band, detail
      ).rgb +
      causticBundle(
        p, c4.zw, c5.xy, c5.zw, o3,
        s4.zw, s5.xy, s5.zw, band, detail
      ).rgb +
      causticBundle(
        p, secondary0.xy, secondary0.zw, secondary1.xy, secondaryOptics,
        secondarySpec0.xy, secondarySpec0.zw, secondarySpec1.xy, band, detail
      ).rgb;
    // A soft shoulder preserves overlap brightness without clipping to white.
    radiance = radiance / (vec3(1.0) + radiance * 0.72);
    return vec4(radiance, 0.0);
  }
`;

export const CAUSTIC_FIELD_WGSL = /* wgsl */ `
  fn causticCross(a: vec2<f32>, b: vec2<f32>) -> f32 {
    return a.x * b.y - a.y * b.x;
  }

  // Twin of the GLSL moment fit above.
  fn causticFootprint(
    p: vec2<f32>, a: vec2<f32>, b: vec2<f32>, c: vec2<f32>,
    blur: f32, focus: f32,
  ) -> f32 {
    let centre = (a + b + c) / 3.0;
    let va = a - centre;
    let vb = b - centre;
    let vc = c - centre;
    let xx = (va.x * va.x + vb.x * vb.x + vc.x * vc.x) / 3.0 + blur * blur;
    let xy = (va.x * va.y + vb.x * vb.y + vc.x * vc.y) / 3.0;
    let yy = (va.y * va.y + vb.y * vb.y + vc.y * vc.y) / 3.0 + blur * blur;
    let determinant = max(xx * yy - xy * xy, 1.0);
    let delta = p - centre;
    let distance2 = max(0.0, (
      yy * delta.x * delta.x - 2.0 * xy * delta.x * delta.y +
      xx * delta.y * delta.y
    ) / determinant);
    let penumbra = 1.0 - smoothstep(0.08, 4.2, distance2 * focus);
    let core = 1.0 - smoothstep(0.015, 0.72, distance2 * focus);
    return penumbra * penumbra * 0.66 + core * core * 0.34;
  }

  fn causticBundle(
    p: vec2<f32>, a: vec2<f32>, b: vec2<f32>, c: vec2<f32>,
    transmission: vec4<f32>,
    da: vec2<f32>, db: vec2<f32>, dc: vec2<f32>, band: f32, detail: f32,
  ) -> vec4<f32> {
    if (transmission.a < 0.001) {
      return vec4<f32>(0.0);
    }

    let area = abs(causticCross(b - a, c - a)) * 0.5;
    let edge0 = b - a;
    let edge1 = c - b;
    let edge2 = a - c;
    let edge = sqrt(max(max(dot(edge0, edge0), dot(edge1, edge1)), dot(edge2, edge2)));
    let tracedBand = clamp(band, 0.0, 2.0);
    let spectralReach = sqrt(
      max(max(dot(da, da), dot(db, db)), dot(dc, dc))
    ) * tracedBand;
    let footprintMin = min(min(a, b), c);
    let footprintMax = max(max(a, b), c);
    let cullPad = clamp(
      edge * ${CAUSTIC_CULL_EDGE_FRACTION.toFixed(2)},
      ${CAUSTIC_CULL_PAD_MIN_PX.toFixed(1)}, ${CAUSTIC_CULL_PAD_MAX_PX.toFixed(1)},
    ) + spectralReach;
    if (any(p < footprintMin - vec2<f32>(cullPad)) ||
        any(p > footprintMax + vec2<f32>(cullPad))) {
      return vec4<f32>(0.0);
    }

    let blur = clamp(
      sqrt(max(area, 1.0)) * ${CAUSTIC_BLUR_AREA_FRACTION.toFixed(3)},
      ${CAUSTIC_BLUR_MIN_PX.toFixed(1)}, ${CAUSTIC_BLUR_MAX_PX.toFixed(1)},
    );
    let focus = mix(0.82, 1.34, clamp(detail * 0.5, 0.0, 1.0));
    let green = causticFootprint(p, a, b, c, blur, focus);
    var spectral = vec3<f32>(green);
    if (tracedBand > 0.002) {
      let red = causticFootprint(
        p, a + da * tracedBand, b + db * tracedBand, c + dc * tracedBand,
        blur, focus,
      );
      let blue = causticFootprint(
        p, a - da * tracedBand, b - db * tracedBand, c - dc * tracedBand,
        blur, focus,
      );
      spectral = vec3<f32>(red, green, blue);
    }

    let beam = spectral;
    let press = clamp(
      ${CAUSTIC_PRESS_REF.toFixed(1)} / (area + ${CAUSTIC_PRESS_SOFT.toFixed(1)}),
      ${CAUSTIC_PRESS_MIN.toFixed(2)}, ${CAUSTIC_PRESS_MAX.toFixed(2)},
    );
    return vec4<f32>(
      clamp(transmission.rgb, vec3<f32>(0.0), vec3<f32>(1.0)) * beam *
        transmission.a * press * ${CAUSTIC_ENERGY_GAIN.toFixed(2)},
      0.0,
    );
  }

  fn causticField(
    p: vec2<f32>,
    c0: vec4<f32>, c1: vec4<f32>, c2: vec4<f32>,
    c3: vec4<f32>, c4: vec4<f32>, c5: vec4<f32>,
    s0: vec4<f32>, s1: vec4<f32>, s2: vec4<f32>,
    s3: vec4<f32>, s4: vec4<f32>, s5: vec4<f32>,
    o0: vec4<f32>, o1: vec4<f32>, o2: vec4<f32>, o3: vec4<f32>,
    secondary0: vec4<f32>, secondary1: vec4<f32>,
    secondarySpec0: vec4<f32>, secondarySpec1: vec4<f32>,
    secondaryOptics: vec4<f32>, band: f32, detail: f32,
  ) -> vec4<f32> {
    var radiance =
      causticBundle(
        p, c0.xy, c0.zw, c1.xy, o0,
        s0.xy, s0.zw, s1.xy, band, detail,
      ).rgb +
      causticBundle(
        p, c1.zw, c2.xy, c2.zw, o1,
        s1.zw, s2.xy, s2.zw, band, detail,
      ).rgb +
      causticBundle(
        p, c3.xy, c3.zw, c4.xy, o2,
        s3.xy, s3.zw, s4.xy, band, detail,
      ).rgb +
      causticBundle(
        p, c4.zw, c5.xy, c5.zw, o3,
        s4.zw, s5.xy, s5.zw, band, detail,
      ).rgb +
      causticBundle(
        p, secondary0.xy, secondary0.zw, secondary1.xy, secondaryOptics,
        secondarySpec0.xy, secondarySpec0.zw, secondarySpec1.xy,
        band, detail,
      ).rgb;
    radiance = radiance / (vec3<f32>(1.0) + radiance * 0.72);
    return vec4<f32>(radiance, 0.0);
  }
`;
