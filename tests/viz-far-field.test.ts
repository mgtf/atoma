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
  writeMarkFieldCaustic,
} from '../src/viz/client-gl/mark-field-light.js';
import {
  CAUSTIC_ARC_STEPS,
  CAUSTIC_FIELD_GLSL,
  CAUSTIC_FIELD_WGSL,
  CAUSTIC_FILL_SUBDIVISION,
  CAUSTIC_FILL_WEIGHT,
  CAUSTIC_FOLD_ARCS,
  CAUSTIC_SAMPLES_PER_BUNDLE,
} from '../src/viz/client-gl/renderer/caustic-shader.js';
import {
  POINTER_LIGHT_GLSL,
  POINTER_LIGHT_WGSL,
} from '../src/viz/client-gl/renderer/shaders.js';

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
      expect(source).toContain('uCausticColor');
      expect(source).toContain('uCausticDetail');
    }
    expect(FAR_FIELD_UNIFORMS.filter((entry) => entry.name.startsWith('uCaustic')))
      .toHaveLength(15);
  });

  it('takes the cast from the ONE shared source, on every surface', () => {
    // The cast lands on two surfaces: the aurora behind the UI and the
    // filled UI itself. Two hand-written containment tests would drift and
    // the diamond would stop lining up across the boundary.
    expect(FAR_FIELD_GLSL).toContain(CAUSTIC_FIELD_GLSL);
    expect(POINTER_LIGHT_GLSL).toContain(CAUSTIC_FIELD_GLSL);
    expect(FAR_FIELD_WGSL).toContain(CAUSTIC_FIELD_WGSL);
    expect(POINTER_LIGHT_WGSL).toContain(CAUSTIC_FIELD_WGSL);
  });

  it('maps the traced wavelengths to red, green and blue channels in order', () => {
    // deltaPoint is the signed (red - blue) half-separation: the positive
    // trace is red, the mean trace is green, and the negative trace is blue.
    expect(CAUSTIC_FIELD_GLSL).toContain('return vec3(red, green, blue);');
    expect(CAUSTIC_FIELD_WGSL).toContain('return vec3<f32>(red, green, blue);');
  });

  it('reconstructs sampled caustics and carries translucent shadow on both backends', () => {
    for (const source of [CAUSTIC_FIELD_GLSL, CAUSTIC_FIELD_WGSL]) {
      expect(source).toContain('causticKernel');
      expect(source).toContain('causticSpectralFold');
      expect(source).toContain('causticBundle');
      expect(source).toContain('centre');
      expect(source).toContain('shadow');
      expect(source).not.toContain('causticEdge');
      // One plain kernel remains: the radial-offset fold pair is gone, its
      // job taken by the two traced wavelengths it approximated.
      expect(source).not.toContain('causticFold(');
      // Four curved fold arcs plus the interior fill, plus four broader
      // shadow samples per bundle; causticField invokes the bundle for all
      // four traced facets. Every fold sample is the SPECTRAL triple — one
      // traced position per wavelength — and the fill and shadow stay plain.
      const arcs = CAUSTIC_FOLD_ARCS * (CAUSTIC_ARC_STEPS + 1);
      const fillGrid = CAUSTIC_FILL_SUBDIVISION;
      const fill = ((fillGrid - 1) * (fillGrid - 2)) / 2;
      expect(CAUSTIC_FOLD_ARCS).toBe(4);
      // The extra asymmetric fold adds detail without the 2× hot-path cost of
      // mirroring a second fold across all three edges.
      expect(arcs).toBe(84);
      expect(CAUSTIC_SAMPLES_PER_BUNDLE).toBe(arcs + fill);
      expect(source.split('causticSpectralFold(p,').length - 1).toBe(arcs);
      // fill + 4 shadow kernels + 3 calls inside the spectral fold's own
      // definition (green, red, blue) — one function, three wavelengths.
      expect(source.split('causticKernel(p,').length - 1).toBe(fill + 4 + 3);
      expect(source.match(/causticBundle\(/g)).toHaveLength(5);
      // The dense reconstruction never runs where any traced wavelength can
      // contribute. Its ROI includes both spectral extremes and the ACTUAL
      // bundle rim — never the global maximum that made a hero cast shade
      // most of the viewport.
      expect(source).toContain('spectralMin');
      expect(source).toContain('spectralMax');
      expect(source).toContain('cullPad');
      expect(source).toContain('foldRim * 4.6');
      expect(source).not.toContain('sqrt(reach)');
      // Filament width rides the bundle's own footprint, clamped — one fixed
      // pixel width is a blob on the header cast and a hairline on the hero's.
      expect(source).toContain('foldRim');
      expect(source).toMatch(/clamp\(\s*sqrt\(area\)/);
      // THE FRINGE IS TRACED, NOT PAINTED: the two extra wavelengths are the
      // SAME samples offset by each corner's signed half-separation, and the
      // band scalar can collapse them onto the mean trace in a uniform
      // branch. No radial heuristic may come back.
      expect(source).toContain('deltaPoint * band');
      expect(source).toContain('band < 0.004');
      expect(source).toContain('detailWeight');
      expect(source).toContain('detailRim');
      expect(source).toContain('detailAmount > 0.004');
      expect(source).not.toContain('prism');
      expect(source).not.toContain('fringe');
      // Fold filaments stay far heavier than fill: the cusped envelope must
      // outshine the body, or the cast degrades into the filled shape this
      // file bans.
      expect(CAUSTIC_FILL_WEIGHT).toBeLessThan(0.5);
      expect(source).toContain(`fill * ${CAUSTIC_FILL_WEIGHT.toFixed(2)}`);
      // Beam compression: a tight footprint is a hot sparkle, a spread one a
      // dim wash — brightness must ride the bundle's area, not a constant.
      expect(source).toContain('* press');
      // A caustic is CURVED folds, never the bundle's own straight edges: a
      // straight-edge sampler puts pure two-corner mixes back on the wall,
      // where every fold point must blend all three corners.
      expect(source).not.toMatch(/causticFold\(p, a \* [\d.]+ \+ b \* [\d.]+,/);
      expect(source).not.toMatch(/causticFold\(p, b \* [\d.]+ \+ c \* [\d.]+,/);
      expect(source).not.toMatch(/causticKernel\(p, a \* [\d.]+ \+ b \* [\d.]+,/);
      expect(source).not.toMatch(/causticKernel\(p, b \* [\d.]+ \+ c \* [\d.]+,/);
    }
    for (const source of [FAR_FIELD_GLSL, FAR_FIELD_WGSL]) {
      expect(source).toMatch(/color \*= 1\.0 - crystalCast\.a/);
      expect(source).toMatch(/color \+= crystalCast\.rgb/);
    }
    expect(POINTER_LIGHT_GLSL).toContain('sampleColor.rgb *= 1.0 - crystalCast.a');
    expect(POINTER_LIGHT_GLSL).toContain('sampleColor.rgb += crystalCast.rgb');
    expect(POINTER_LIGHT_WGSL).toContain('sampleColor.r *= 1.0 - crystalCast.a');
    expect(POINTER_LIGHT_WGSL).toContain('sampleColor.r += crystalCast.r');
  });

  it('keeps the shared caustic source legal in GLSL ES 1.00', () => {
    // The pointer-light program carries no `#version 300 es`, so Pixi
    // compiles it as ES 1.00. Array parameters, dynamic indexing and `%`
    // do not exist there — the corners are six explicit parameters and the
    // sample accumulation is unrolled for exactly that reason.
    expect(POINTER_LIGHT_GLSL).not.toContain('#version 300 es');
    expect(CAUSTIC_FIELD_GLSL).not.toMatch(/\[\s*\d+\s*\]/);
    expect(CAUSTIC_FIELD_GLSL).not.toContain('%');
    expect(CAUSTIC_FIELD_GLSL).toContain('vec4 c5');
    for (const source of [CAUSTIC_FIELD_GLSL, CAUSTIC_FIELD_WGSL]) {
      expect(source).toContain('intensity < 0.001');
      expect(source).toContain('lobe3');
    }
  });

  it('transports exactly four triangular caustic bundles', () => {
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
    writeMarkFieldCaustic({ points, spectral: null, intensity: 0.5, r: 0.2, g: 0.4, b: 0.8 });
    const cast = readMarkFieldCaustic();
    expect(cast).not.toBeNull();
    expect(cast!.points).toHaveLength(MARK_CAUSTIC_MAX_POINTS);
    expect(cast!.points[0]).toEqual(points[0]);
    expect(cast!.intensity).toBeCloseTo(0.5);
    expect(cast!.spectral).toBeNull();

    // The spectral band rides the same twelve corners: a short one is
    // dropped whole (never partially drawn), and a long one is clamped.
    const halfBand = points.map((point) => ({ x: point.x * 0.1, y: point.y * 0.1 }));
    writeMarkFieldCaustic({
      points,
      spectral: halfBand,
      intensity: 0.5,
      r: 0.2, g: 0.4, b: 0.8,
    });
    expect(readMarkFieldCaustic()!.spectral).toHaveLength(MARK_CAUSTIC_MAX_SPECTRAL);
    writeMarkFieldCaustic({
      points,
      spectral: halfBand.slice(0, MARK_CAUSTIC_MAX_SPECTRAL - 1),
      intensity: 0.5,
      r: 0.2, g: 0.4, b: 0.8,
    });
    expect(readMarkFieldCaustic()!.spectral).toBeNull();
    writeMarkFieldCaustic({
      points,
      spectral: [...halfBand, { x: 99, y: 99 }, { x: 99, y: 99 }],
      intensity: 0.5,
      r: 0.2, g: 0.4, b: 0.8,
    });
    expect(readMarkFieldCaustic()!.spectral).toHaveLength(MARK_CAUSTIC_MAX_SPECTRAL);

    // More corners than slots are clamped to the published maximum.
    const many = Array.from({ length: MARK_CAUSTIC_MAX_POINTS + 3 }, (_, i) => ({
      x: i,
      y: i,
    }));
    writeMarkFieldCaustic({ points: many, spectral: null, intensity: 0.1, r: 0, g: 0, b: 0 });
    expect(readMarkFieldCaustic()!.points).toHaveLength(MARK_CAUSTIC_MAX_POINTS);

    // An incomplete four-bundle field is cleared, never partially drawn.
    writeMarkFieldCaustic({
      points: many.slice(0, 11),
      spectral: null,
      intensity: 0.9,
      r: 1, g: 1, b: 1,
    });
    expect(readMarkFieldCaustic()).toBeNull();

    // The lantern clear sweeps the cast with it.
    writeMarkFieldCaustic({ points, spectral: null, intensity: 0.5, r: 0, g: 0, b: 0 });
    clearMarkFieldLight();
    expect(readMarkFieldCaustic()).toBeNull();
  });

  it('packs both ray triangles into renderer pixels with positive winding', () => {
    // ONE packer feeds both surfaces, so both resolve the same bundles in
    // the same pixels. The shaders use a single inward-normal rule, which
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
      { points: clockwise, spectral: null, intensity: 0.4, r: 1, g: 0.5, b: 0.25 },
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
    expect(packed.intensity).toBeCloseTo(0.4);

    // The spectral band packs through the SAME affine scale factors, without
    // the bounds' origin: a delta is a difference, so the translation cancels.
    // Bounds are half the renderer size, so the scale is exactly 2× here.
    const halfBand = clockwise.map((_point, index) => ({
      x: index + 0.25,
      y: -(index + 0.5),
    }));
    const spectralPacked = packMarkCaustic(
      { points: clockwise, spectral: halfBand, intensity: 0.4, r: 1, g: 0.5, b: 0.25 },
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
      { points: clockwise, spectral: halfBand, intensity: 0.4, r: 1, g: 0.5, b: 0.25 },
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

    // Nothing published, nothing packed: the caller parks its own slots.
    expect(packMarkCaustic(null, bounds, 800, 400)).toBeNull();
  });
});
