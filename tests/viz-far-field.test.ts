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
    }
    expect(FAR_FIELD_UNIFORMS.filter((entry) => entry.name.startsWith('uCaustic')))
      .toHaveLength(7);
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

  it('reconstructs sampled caustics and carries translucent shadow on both backends', () => {
    for (const source of [CAUSTIC_FIELD_GLSL, CAUSTIC_FIELD_WGSL]) {
      expect(source).toContain('causticKernel');
      expect(source).toContain('causticBundle');
      expect(source).toContain('centre');
      expect(source).toContain('shadow');
      expect(source).not.toContain('causticEdge');
      // Three curved fold arcs plus the interior fill, plus four broader
      // shadow samples per bundle; causticField invokes the bundle for all
      // four traced facets.
      const arcs = 3 * (CAUSTIC_ARC_STEPS + 1);
      const fillGrid = CAUSTIC_FILL_SUBDIVISION;
      const fill = ((fillGrid - 1) * (fillGrid - 2)) / 2;
      expect(CAUSTIC_SAMPLES_PER_BUNDLE).toBe(arcs + fill);
      expect(source.split('causticKernel(p,').length - 1)
        .toBe(CAUSTIC_SAMPLES_PER_BUNDLE + 4);
      expect(source.match(/causticBundle\(/g)).toHaveLength(5);
      // The dense reconstruction never runs where the bundle cannot reach:
      // every pixel outside the centroid's reach plus the widest kernel's
      // support exits before the unrolled sums.
      expect(source).toContain('cull * cull');
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
    writeMarkFieldCaustic({ points, intensity: 0.5, r: 0.2, g: 0.4, b: 0.8 });
    const cast = readMarkFieldCaustic();
    expect(cast).not.toBeNull();
    expect(cast!.points).toHaveLength(MARK_CAUSTIC_MAX_POINTS);
    expect(cast!.points[0]).toEqual(points[0]);
    expect(cast!.intensity).toBeCloseTo(0.5);

    // More corners than slots are clamped to the published maximum.
    const many = Array.from({ length: MARK_CAUSTIC_MAX_POINTS + 3 }, (_, i) => ({
      x: i,
      y: i,
    }));
    writeMarkFieldCaustic({ points: many, intensity: 0.1, r: 0, g: 0, b: 0 });
    expect(readMarkFieldCaustic()!.points).toHaveLength(MARK_CAUSTIC_MAX_POINTS);

    // An incomplete four-bundle field is cleared, never partially drawn.
    writeMarkFieldCaustic({ points: many.slice(0, 11), intensity: 0.9, r: 1, g: 1, b: 1 });
    expect(readMarkFieldCaustic()).toBeNull();

    // The lantern clear sweeps the cast with it.
    writeMarkFieldCaustic({ points, intensity: 0.5, r: 0, g: 0, b: 0 });
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
      { points: clockwise, intensity: 0.4, r: 1, g: 0.5, b: 0.25 },
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

    // Nothing published, nothing packed: the caller parks its own slots.
    expect(packMarkCaustic(null, bounds, 800, 400)).toBeNull();
  });
});
