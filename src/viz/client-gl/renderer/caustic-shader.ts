/**
 * THE crystal's cast, as shader source. One definition per dialect, shared by
 * every surface the cast lands on: the far-field aurora behind the UI, and the
 * pointer-light filter that lights the filled UI itself. Two hand-written
 * copies of a containment test would drift, and the cast would then draw one
 * shape on the backdrop and a different one on the buttons in front of it.
 *
 * The polygon arrives in RENDERER PIXELS, wound POSITIVE (see
 * `packMarkCaustic`, which is the only writer). Positive winding is what lets
 * every edge use the same inward normal without a per-edge flip.
 *
 * GLSL constraint: the pointer-light program carries no `#version 300 es`, so
 * Pixi compiles it as GLSL ES 1.00, where array parameters, dynamic indexing
 * and `%` are unavailable. The corners are therefore SIX EXPLICIT PARAMETERS
 * and the edge walk is unrolled — the same source then compiles unchanged in
 * the far-field's ES 3.00 program.
 */

/** Edge softness in pixels: how far the bright rim bleeds either side. */
const RIM_PX = 12;
/** Weight of the rim, where refracted rays pile up. */
const RIM_GAIN = 0.85;
/** Weight of the interior, which passes dimmer than its own outline. */
const BODY_GAIN = 0.55;
/** Below this a slot pair is a padding repeat, not an edge. */
const DEGENERATE_SPAN = 0.0001;
/** The sentinel a degenerate edge reports; above it there is no polygon. */
const NO_EDGE = '1.0e9';
const NO_POLYGON = '1.0e8';

/**
 * Corner count the shaders unroll to, and the slot count `packMarkCaustic`
 * fills. The gem's silhouette is the convex hull of six poles.
 */
export const CAUSTIC_CORNER_SLOTS = 6;

export const CAUSTIC_FIELD_GLSL = /* glsl */ `
  float causticEdge(vec2 p, vec2 a, vec2 b) {
    vec2 ab = b - a;
    float span = length(ab);
    // A padding slot repeats a real corner: no normal, so it constrains
    // nothing. Normalising it would poison the whole test with a NaN.
    if (span < ${DEGENERATE_SPAN}) return ${NO_EDGE};
    return dot(p - a, vec2(-ab.y, ab.x) / span);
  }

  vec3 causticField(
    vec2 p,
    vec2 c0, vec2 c1, vec2 c2, vec2 c3, vec2 c4, vec2 c5,
    float intensity,
    vec3 tint
  ) {
    if (intensity < 0.001) return vec3(0.0);
    float inner = min(
      min(min(causticEdge(p, c0, c1), causticEdge(p, c1, c2)),
          min(causticEdge(p, c2, c3), causticEdge(p, c3, c4))),
      min(causticEdge(p, c4, c5), causticEdge(p, c5, c0))
    );
    // Every edge degenerate means there is no shape to draw. Fail closed.
    if (inner > ${NO_POLYGON}) return vec3(0.0);
    float rim = exp(-abs(inner) / ${RIM_PX.toFixed(1)});
    float body = step(0.0, inner) * ${BODY_GAIN.toFixed(2)};
    return tint * intensity * (rim * ${RIM_GAIN.toFixed(2)} + body);
  }
`;

export const CAUSTIC_FIELD_WGSL = /* wgsl */ `
  fn causticEdge(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
    let ab = b - a;
    let span = length(ab);
    // A padding slot repeats a real corner: no normal, so it constrains
    // nothing. Normalising it would poison the whole test with a NaN.
    if (span < ${DEGENERATE_SPAN}) {
      return ${NO_EDGE};
    }
    return dot(p - a, vec2<f32>(-ab.y, ab.x) / span);
  }

  fn causticField(
    p: vec2<f32>,
    c0: vec2<f32>,
    c1: vec2<f32>,
    c2: vec2<f32>,
    c3: vec2<f32>,
    c4: vec2<f32>,
    c5: vec2<f32>,
    intensity: f32,
    tint: vec3<f32>,
  ) -> vec3<f32> {
    if (intensity < 0.001) {
      return vec3<f32>(0.0);
    }
    let inner = min(
      min(min(causticEdge(p, c0, c1), causticEdge(p, c1, c2)),
          min(causticEdge(p, c2, c3), causticEdge(p, c3, c4))),
      min(causticEdge(p, c4, c5), causticEdge(p, c5, c0))
    );
    // Every edge degenerate means there is no shape to draw. Fail closed.
    if (inner > ${NO_POLYGON}) {
      return vec3<f32>(0.0);
    }
    let rim = exp(-abs(inner) / ${RIM_PX.toFixed(1)});
    let body = step(0.0, inner) * ${BODY_GAIN.toFixed(2)};
    return tint * intensity * (rim * ${RIM_GAIN.toFixed(2)} + body);
  }
`;
