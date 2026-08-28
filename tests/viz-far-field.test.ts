import { describe, expect, it } from 'vitest';
import {
  FAR_FIELD_ATTRIBUTES,
  FAR_FIELD_GLSL,
  FAR_FIELD_GLSL_VERTEX,
  FAR_FIELD_UNIFORMS,
  FAR_FIELD_WGSL,
} from '../src/viz/client-gl/renderer/far-field.js';
import {
  MARK_CAUSTIC_MAX_POINTS,
  MARK_CAUSTIC_MAX_SPECTRAL,
  clearMarkFieldLight,
  packMarkCaustic,
  readMarkFieldCaustic,
  type MarkFieldCaustic,
  writeMarkFieldCaustic,
} from '../src/viz/client-gl/mark-field-light.js';
import {
  CAUSTIC_BUNDLE_COUNT,
  CAUSTIC_CORNER_SLOTS,
  CAUSTIC_FIELD_GLSL,
  CAUSTIC_FIELD_WGSL,
  CAUSTIC_FOOTPRINT_EVALUATIONS_PER_BUNDLE,
  CAUSTIC_MAX_FOOTPRINT_EVALUATIONS,
  CAUSTIC_SECONDARY_BUNDLE_COUNT,
  CAUSTIC_SPECTRAL_SLOTS,
} from '../src/viz/client-gl/renderer/caustic-shader.js';
import {
  POINTER_LIGHT_GLSL,
  POINTER_LIGHT_WGSL,
} from '../src/viz/client-gl/renderer/shaders.js';

const TEST_CAUSTIC_OPTICS = [
  { r: 0.92, g: 0.68, b: 0.44, intensity: 0.50 },
  { r: 0.58, g: 0.86, b: 0.72, intensity: 0.40 },
  { r: 0.70, g: 0.62, b: 0.94, intensity: 0.30 },
  { r: 0.88, g: 0.76, b: 0.52, intensity: 0.20 },
] as const;

function fieldCast(
  points: readonly { x: number; y: number }[],
  overrides: Partial<MarkFieldCaustic> = {}
): MarkFieldCaustic {
  return {
    points,
    spectral: null,
    optics: TEST_CAUSTIC_OPTICS,
    secondary: null,
    ...overrides,
  };
}

describe('far-field shader contract', () => {
  const wgslVertexInput = FAR_FIELD_WGSL.split('struct VertexInput')[1]
    ?.split('}')[0] ?? '';

  it('keeps backticks out of the shader sources', () => {
    for (const [name, source] of Object.entries({
      FAR_FIELD_WGSL,
      FAR_FIELD_GLSL_VERTEX,
      FAR_FIELD_GLSL,
    })) {
      expect(source, `${name} must not contain a backtick`).not.toContain('`');
    }
  });

  it('declares every geometry attribute in both programs', () => {
    expect(FAR_FIELD_ATTRIBUTES.length).toBe(1);
    for (const { name, format } of FAR_FIELD_ATTRIBUTES) {
      expect(wgslVertexInput, `wgsl VertexInput missing ${name}`).toContain(`${name}:`);
      const components = Number(format.slice(-1));
      const glslType = components === 1 ? 'float' : `vec${components}`;
      expect(FAR_FIELD_GLSL_VERTEX, `glsl vertex missing ${name}`)
        .toContain(`in ${glslType} ${name};`);
    }
  });

  it('lays the uniform block out identically in JS and in WGSL', () => {
    const struct = FAR_FIELD_WGSL.split('struct FarFieldUniforms')[1]?.split('}')[0] ?? '';
    const wgslOrder = struct.trim().split('\n')
      .filter((line) => line.includes(':'))
      .map((line) => {
        const [name, type] = line.trim().replace(/,$/, '').split(':');
        return { name: name!.trim(), type: type!.trim() };
      });
    expect(wgslOrder).toEqual(FAR_FIELD_UNIFORMS.map(({ name, type }) => ({ name, type })));
  });

  it('declares every uniform in GLSL too, in the same order', () => {
    const glslTypes: Record<string, string> = {
      'vec4<f32>': 'vec4',
      'vec3<f32>': 'vec3',
      'vec2<f32>': 'vec2',
      f32: 'float',
    };
    const glslOrder: string[] = [];
    for (const line of FAR_FIELD_GLSL.split('\n')) {
      const match = /^\s*uniform\s+(\w+)\s+(\w+);/.exec(line);
      if (!match) continue;
      glslOrder.push(`${match[1]} ${match[2]}`);
    }
    expect(glslOrder).toEqual(
      FAR_FIELD_UNIFORMS.map(({ name, type }) => `${glslTypes[type]} ${name}`)
    );
  });

  it('ships the aurora, lanterns and screen-space pointer on both backends', () => {
    for (const source of [FAR_FIELD_WGSL, FAR_FIELD_GLSL]) {
      expect(source).toContain('fbm');
      expect(source).toContain('stainedField');
      expect(source).toContain('uMark0');
      expect(source).toContain('uPointerUv');
      expect(source).toContain('vScreenUv');
    }
    expect(FAR_FIELD_GLSL).toContain('dFdx');
    expect(FAR_FIELD_GLSL).toContain('dFdy');
    expect(FAR_FIELD_GLSL).toContain('fwidth');
    expect(FAR_FIELD_WGSL).toContain('dpdx');
    expect(FAR_FIELD_WGSL).toContain('dpdy');
    expect(FAR_FIELD_GLSL_VERTEX).toContain('1.0 - aPosition.y');
    expect(FAR_FIELD_WGSL).toContain('1.0 - input.aPosition.y');
  });

  it('draws the gem cast as overlapping facet caustics on both backends', () => {
    // The pools GLOW (radial falloffs); the cast DRAWS the silhouette
    // (containment + distance to the outline). A glass that lights the wall
    // without drawing its own shape on it is only half the physics.
    for (const source of [FAR_FIELD_WGSL, FAR_FIELD_GLSL]) {
      expect(source).toContain('causticField');
      expect(source).toContain('uCaustic0');
      expect(source).toContain('uCaustic5');
      expect(source).toContain('uCausticOptics0');
      expect(source).toContain('uCausticOptics3');
      expect(source).toContain('uCausticSecondary');
      expect(source).toContain('uCausticDetail');
    }
    const causticUniformNames = FAR_FIELD_UNIFORMS
      .filter((entry) => entry.name.startsWith('uCaustic'))
      .map((entry) => entry.name);
    expect(causticUniformNames).not.toContain('uCausticColor');
    expect(causticUniformNames.filter((name) => /^uCausticOptics[0-3]$/.test(name)))
      .toHaveLength(CAUSTIC_BUNDLE_COUNT);
    expect(causticUniformNames.some((name) => name.startsWith('uCausticSecondary')))
      .toBe(true);
  });

  it('lands the cast on one far-field receiver, never on the filled UI', () => {
    // The receiver is the backdrop behind the UI. Re-running the caustic in
    // the full-stage pointer filter doubled its hottest fragment work and
    // made buttons behave like a second wall at the same depth.
    expect(FAR_FIELD_GLSL).toContain(CAUSTIC_FIELD_GLSL);
    expect(FAR_FIELD_WGSL).toContain(CAUSTIC_FIELD_WGSL);
    for (const source of [POINTER_LIGHT_GLSL, POINTER_LIGHT_WGSL]) {
      expect(source).not.toContain('causticField');
      expect(source).not.toContain('uCaustic');
      expect(source).not.toContain('crystalCast');
    }
  });

  it('maps the traced wavelengths to red, green and blue channels in order', () => {
    // deltaPoint is the signed (red - blue) half-separation: the positive
    // trace is red, the mean trace is green, and the negative trace is blue.
    expect(CAUSTIC_FIELD_GLSL).toContain('vec3(red, green, blue)');
    expect(CAUSTIC_FIELD_WGSL).toContain('vec3<f32>(red, green, blue)');
  });

  it('keeps the analytic caustic bounded, spectrally honest and additive', () => {
    for (const source of [CAUSTIC_FIELD_GLSL, CAUSTIC_FIELD_WGSL]) {
      // Four CPU-traced primaries plus at most one real reflected branch stay
      // fixed-cost. Core and penumbra share each moment fit; neither brings
      // back the former generated Gaussian banks or fragment loops.
      expect(source).toContain('causticBundle');
      expect(source.match(/causticBundle\(/g)).toHaveLength(
        CAUSTIC_BUNDLE_COUNT + CAUSTIC_SECONDARY_BUNDLE_COUNT + 1
      );
      expect(source.match(/causticFootprint\(/g))
        .toHaveLength(CAUSTIC_FOOTPRINT_EVALUATIONS_PER_BUNDLE + 1);
      expect(source.length).toBeLessThan(10_000);
      expect(source).toContain('core');
      expect(source).toContain('penumbra');
      expect(source).not.toContain('exp(');
      expect(source).not.toContain('causticKernel');
      expect(source).not.toContain('causticSpectralFold');
      expect(source).not.toMatch(/\b(?:float|let)\s+shadow\b/);
      expect(source).not.toContain('mix(tint');
      expect(source).not.toMatch(/for\s*\(/);

      // Use the complete measured red/blue separation. No white average or
      // chroma limiter may renormalise the transported spectrum afterwards.
      expect(source).toContain('a + da * tracedBand');
      expect(source).toContain('a - da * tracedBand');
      expect(source).toMatch(/tracedBand\s*=\s*clamp\(band,\s*0\.0,\s*2\.0\)\s*;/);
      expect(source).not.toMatch(/tracedBand\s*=\s*clamp\([^;]+\)\s*\*/);
      expect(source).not.toMatch(/\b(?:float|let)\s+neutral\b/);
      expect(source).not.toMatch(/\b(?:float|let)\s+chroma\b/);
      expect(source).toContain('transmission');
      expect(source).toContain('detail');
      expect(source).not.toContain('prism');
    }
    for (const source of [FAR_FIELD_GLSL, FAR_FIELD_WGSL]) {
      expect(source).toMatch(/color \+= crystalCast\.rgb/);
      expect(source).not.toContain('crystalCast.a');
    }
    expect(CAUSTIC_CORNER_SLOTS).toBe(6);
    expect(CAUSTIC_SPECTRAL_SLOTS).toBe(6);
    expect(CAUSTIC_BUNDLE_COUNT).toBe(4);
    expect(CAUSTIC_SECONDARY_BUNDLE_COUNT).toBe(1);
    expect(CAUSTIC_FOOTPRINT_EVALUATIONS_PER_BUNDLE).toBe(3);
    expect(CAUSTIC_MAX_FOOTPRINT_EVALUATIONS).toBe(15);
    expect(CAUSTIC_MAX_FOOTPRINT_EVALUATIONS).toBe(
      (CAUSTIC_BUNDLE_COUNT + CAUSTIC_SECONDARY_BUNDLE_COUNT) *
      CAUSTIC_FOOTPRINT_EVALUATIONS_PER_BUNDLE
    );
  });

  it('keeps the caustic source legal without dynamic shader arrays', () => {
    // Six explicit slots keep the WebGL fallback free from dynamic indexing;
    // unlike the former implementation, that does not require generated
    // sample accumulation.
    expect(CAUSTIC_FIELD_GLSL).not.toMatch(/\[\s*\d+\s*\]/);
    expect(CAUSTIC_FIELD_GLSL).not.toContain('%');
    expect(CAUSTIC_FIELD_GLSL).toContain('vec4 c5');
    for (const source of [CAUSTIC_FIELD_GLSL, CAUSTIC_FIELD_WGSL]) {
      expect(source).toContain('transmission.a < 0.001');
      expect(source.match(/causticBundle\(/g)).toHaveLength(
        CAUSTIC_BUNDLE_COUNT + CAUSTIC_SECONDARY_BUNDLE_COUNT + 1
      );
    }
  });

  it('transports exactly four triangular caustic bundles to the receiver', () => {
    clearMarkFieldLight();
    expect(readMarkFieldCaustic()).toBeNull();

    const points = [
      { x: 4, y: 4 },
      { x: 24, y: 4 },
      { x: 24, y: 24 },
      { x: 4, y: 4 },
      { x: 24, y: 24 },
      { x: 4, y: 24 },
      { x: 6, y: 6 },
      { x: 22, y: 6 },
      { x: 22, y: 22 },
      { x: 6, y: 6 },
      { x: 22, y: 22 },
      { x: 6, y: 22 },
    ];
    writeMarkFieldCaustic(fieldCast(points));
    const cast = readMarkFieldCaustic();
    expect(cast).not.toBeNull();
    expect(cast!.points).toHaveLength(MARK_CAUSTIC_MAX_POINTS);
    expect(cast!.points[0]).toEqual(points[0]);
    expect(cast!.optics).toEqual(TEST_CAUSTIC_OPTICS);
    expect(cast!.spectral).toBeNull();
    expect(cast!.secondary).toBeNull();

    // The spectral band rides the same twelve corners: a short one is
    // dropped whole (never partially drawn), and a long one is clamped.
    const halfBand = points.map((point) => ({ x: point.x * 0.1, y: point.y * 0.1 }));
    writeMarkFieldCaustic(fieldCast(points, { spectral: halfBand }));
    expect(readMarkFieldCaustic()!.spectral).toHaveLength(MARK_CAUSTIC_MAX_SPECTRAL);
    writeMarkFieldCaustic(fieldCast(points, {
      spectral: halfBand.slice(0, MARK_CAUSTIC_MAX_SPECTRAL - 1),
    }));
    expect(readMarkFieldCaustic()!.spectral).toBeNull();
    writeMarkFieldCaustic(fieldCast(points, {
      spectral: [...halfBand, { x: 99, y: 99 }, { x: 99, y: 99 }],
    }));
    expect(readMarkFieldCaustic()!.spectral).toHaveLength(MARK_CAUSTIC_MAX_SPECTRAL);

    // The one reflected path carries its own three corners, spectral deltas
    // and optics. It is optional as a unit: malformed secondary geometry is
    // dropped without invalidating the four complete primary bundles.
    const secondary = {
      points: points.slice(0, 3),
      spectral: halfBand.slice(0, 3),
      optics: { r: 0.74, g: 0.82, b: 0.96, intensity: 0.08 },
    };
    writeMarkFieldCaustic(fieldCast(points, { spectral: halfBand, secondary }));
    expect(readMarkFieldCaustic()!.secondary).toEqual(secondary);
    writeMarkFieldCaustic(fieldCast(points, {
      secondary: { ...secondary, points: secondary.points.slice(0, 2) },
    }));
    expect(readMarkFieldCaustic()!.secondary).toBeNull();

    // More corners than slots are clamped to the published maximum.
    const many = Array.from({ length: MARK_CAUSTIC_MAX_POINTS + 3 }, (_, i) => ({
      x: i,
      y: i,
    }));
    writeMarkFieldCaustic(fieldCast(many));
    expect(readMarkFieldCaustic()!.points).toHaveLength(MARK_CAUSTIC_MAX_POINTS);

    // An incomplete four-bundle field is cleared, never partially drawn.
    writeMarkFieldCaustic(fieldCast(many.slice(0, 11)));
    expect(readMarkFieldCaustic()).toBeNull();

    // Four path-specific optical records are as integral as four triangles.
    writeMarkFieldCaustic(fieldCast(points, { optics: TEST_CAUSTIC_OPTICS.slice(0, 3) }));
    expect(readMarkFieldCaustic()).toBeNull();

    // The lantern clear sweeps the cast with it.
    writeMarkFieldCaustic(fieldCast(points));
    clearMarkFieldLight();
    expect(readMarkFieldCaustic()).toBeNull();
  });

  it('packs both ray triangles into renderer pixels with positive winding', () => {
    // ONE packer feeds the far-field receiver in renderer pixels. The shader
    // uses a single inward-normal rule, which
    // only holds on positive winding — and screen y runs opposite to the
    // mark's local y, so the hull order alone cannot promise it.
    const bounds = { left: 100, top: 50, width: 400, height: 200 };
    // Clockwise on screen: negative signed area before the flip.
    const clockwise = [
      { x: 100, y: 50 },
      { x: 100, y: 150 },
      { x: 300, y: 150 },
      { x: 300, y: 50 },
      { x: 300, y: 150 },
      { x: 100, y: 50 },
      { x: 120, y: 60 },
      { x: 120, y: 140 },
      { x: 280, y: 140 },
      { x: 280, y: 60 },
      { x: 280, y: 140 },
      { x: 120, y: 60 },
    ];
    const packed = packMarkCaustic(
      fieldCast(clockwise),
      bounds,
      800,
      400
    )!;
    expect(packed).not.toBeNull();
    // Renderer pixels: the bounds' origin maps to 0,0 and the scale doubles.
    expect(packed.corners.slice(0, 3)).toEqual([
      { x: 0, y: 0 },
      { x: 400, y: 200 },
      { x: 0, y: 200 },
    ]);
    for (const start of [0, 3, 6, 9]) {
      const [a, b, c] = packed.corners.slice(start, start + 3);
      const area = a!.x * b!.y + b!.x * c!.y + c!.x * a!.y -
        b!.x * a!.y - c!.x * b!.y - a!.x * c!.y;
      expect(area).toBeGreaterThan(0);
    }
    expect(packed.corners).toHaveLength(MARK_CAUSTIC_MAX_POINTS);
    expect(packed.optics).toEqual(TEST_CAUSTIC_OPTICS);
    expect(packed.secondary).toBeNull();

    // The spectral band packs through the SAME affine scale factors, without
    // the bounds' origin: a delta is a difference, so the translation cancels.
    // Bounds are half the renderer size, so the scale is exactly 2× here.
    const halfBand = clockwise.map((_point, index) => ({
      x: index + 0.25,
      y: -(index + 0.5),
    }));
    const spectralPacked = packMarkCaustic(
      fieldCast(clockwise, { spectral: halfBand }),
      bounds,
      800,
      400
    )!;
    expect(spectralPacked.spectral).toHaveLength(MARK_CAUSTIC_MAX_SPECTRAL);
    // Bundles 0 and 2 need their final two corners swapped to make the
    // winding positive. Their uniquely tagged deltas must make the same swap;
    // otherwise red/blue reconstruct around a different green corner.
    const windingOrder = [0, 2, 1, 3, 4, 5, 6, 8, 7, 9, 10, 11];
    expect(spectralPacked.spectral).toEqual(windingOrder.map((index) => ({
      x: (index + 0.25) * 2,
      y: -(index + 0.5) * 2,
    })));

    // A camera is not affine: each spectral endpoint must travel through the
    // mapping beside its own corner before the renderer-space delta is taken.
    const projective = (x: number, y: number) => {
      const divisor = 1 + y / 1_000;
      return { x: x / divisor, y: y / divisor };
    };
    const projectedBand = packMarkCaustic(
      fieldCast(clockwise, {
        spectral: halfBand,
        secondary: {
          points: clockwise.slice(0, 3),
          spectral: halfBand.slice(0, 3),
          optics: { r: 0.74, g: 0.82, b: 0.96, intensity: 0.08 },
        },
      }),
      bounds,
      800,
      400,
      projective
    )!;
    expect(projectedBand.spectral).toEqual(windingOrder.map((index) => {
      const point = clockwise[index]!;
      const delta = halfBand[index]!;
      const corner = projective(point.x, point.y);
      const endpoint = projective(point.x + delta.x, point.y + delta.y);
      return { x: endpoint.x - corner.x, y: endpoint.y - corner.y };
    }));

    expect(projectedBand.secondary).not.toBeNull();
    const secondaryOrder = [0, 2, 1];
    expect(projectedBand.secondary!.corners).toEqual(secondaryOrder.map((index) =>
      projective(clockwise[index]!.x, clockwise[index]!.y)
    ));
    expect(projectedBand.secondary!.spectral).toEqual(secondaryOrder.map((index) => {
      const point = clockwise[index]!;
      const delta = halfBand[index]!;
      const corner = projective(point.x, point.y);
      const endpoint = projective(point.x + delta.x, point.y + delta.y);
      return { x: endpoint.x - corner.x, y: endpoint.y - corner.y };
    }));
    expect(projectedBand.secondary!.optics)
      .toEqual({ r: 0.74, g: 0.82, b: 0.96, intensity: 0.08 });

    // Nothing published, nothing packed: the caller parks its own slots.
    expect(packMarkCaustic(null, bounds, 800, 400)).toBeNull();
  });
});
