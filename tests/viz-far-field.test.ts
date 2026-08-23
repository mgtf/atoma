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
  CAUSTIC_FIELD_GLSL,
  CAUSTIC_FIELD_WGSL,
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

  it('draws the gem cast as a polygon caustic on both backends', () => {
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

  it('keeps the shared caustic source legal in GLSL ES 1.00', () => {
    // The pointer-light program carries no `#version 300 es`, so Pixi
    // compiles it as ES 1.00. Array parameters, dynamic indexing and `%`
    // do not exist there — the corners are six explicit parameters and the
    // edge walk is unrolled for exactly that reason.
    expect(POINTER_LIGHT_GLSL).not.toContain('#version 300 es');
    expect(CAUSTIC_FIELD_GLSL).not.toMatch(/\[\s*\d+\s*\]/);
    expect(CAUSTIC_FIELD_GLSL).not.toContain('%');
    expect(CAUSTIC_FIELD_GLSL).toContain('vec2 c5');
    // A padding slot repeats a real corner: the zero-length edge must be
    // skipped, not normalised (a NaN normal poisons the whole test).
    for (const source of [CAUSTIC_FIELD_GLSL, CAUSTIC_FIELD_WGSL]) {
      expect(source).toContain('span < 0.0001');
      // No polygon at all fails closed rather than washing the screen.
      expect(source).toContain('inner > 1.0e8');
    }
  });

  it('transports one caustic sample with clamped corners', () => {
    clearMarkFieldLight();
    expect(readMarkFieldCaustic()).toBeNull();

    const points = [
      { x: 4, y: 4 },
      { x: 24, y: 4 },
      { x: 24, y: 24 },
      { x: 4, y: 24 },
    ];
    writeMarkFieldCaustic({ points, intensity: 0.5, r: 0.2, g: 0.4, b: 0.8 });
    const cast = readMarkFieldCaustic();
    expect(cast).not.toBeNull();
    expect(cast!.points).toHaveLength(4);
    expect(cast!.points[0]).toEqual(points[0]);
    expect(cast!.intensity).toBeCloseTo(0.5);

    // More corners than slots are clamped to the published maximum.
    const many = Array.from({ length: MARK_CAUSTIC_MAX_POINTS + 3 }, (_, i) => ({
      x: i,
      y: i,
    }));
    writeMarkFieldCaustic({ points: many, intensity: 0.1, r: 0, g: 0, b: 0 });
    expect(readMarkFieldCaustic()!.points).toHaveLength(MARK_CAUSTIC_MAX_POINTS);

    // Fewer than three corners cannot be a shape: cleared, never drawn.
    writeMarkFieldCaustic({ points: many.slice(0, 2), intensity: 0.9, r: 1, g: 1, b: 1 });
    expect(readMarkFieldCaustic()).toBeNull();

    // The lantern clear sweeps the cast with it.
    writeMarkFieldCaustic({ points, intensity: 0.5, r: 0, g: 0, b: 0 });
    clearMarkFieldLight();
    expect(readMarkFieldCaustic()).toBeNull();
  });

  it('packs the cast into renderer pixels, wound positive and padded', () => {
    // ONE packer feeds both surfaces, so both resolve the same polygon in
    // the same pixels. The shaders use a single inward-normal rule, which
    // only holds on positive winding — and screen y runs opposite to the
    // mark's local y, so the hull order alone cannot promise it.
    const bounds = { left: 100, top: 50, width: 400, height: 200 };
    // Clockwise on screen: negative signed area before the flip.
    const clockwise = [
      { x: 100, y: 50 },
      { x: 100, y: 150 },
      { x: 300, y: 150 },
    ];
    const packed = packMarkCaustic(
      { points: clockwise, intensity: 0.4, r: 1, g: 0.5, b: 0.25 },
      bounds,
      800,
      400
    )!;
    expect(packed).not.toBeNull();
    // Renderer pixels: the bounds' origin maps to 0,0 and the scale doubles.
    // Order is reversed here, so the last corner in leads the polygon out.
    expect(packed.corners.slice(0, 3)).toEqual([
      { x: 400, y: 200 },
      { x: 0, y: 200 },
      { x: 0, y: 0 },
    ]);
    let area = 0;
    for (let index = 0; index < packed.corners.length; index += 1) {
      const a = packed.corners[index]!;
      const b = packed.corners[(index + 1) % packed.corners.length]!;
      area += a.x * b.y - b.x * a.y;
    }
    // Reversed on the way in, so the winding the shaders assume holds.
    expect(area).toBeGreaterThan(0);
    // Every slot filled: unused ones repeat the last real corner, so the
    // closing edge stays real and each padding edge collapses to zero length.
    expect(packed.corners).toHaveLength(MARK_CAUSTIC_MAX_POINTS);
    const last = packed.corners[2]!;
    expect(last).toEqual({ x: 0, y: 0 });
    for (let index = 3; index < MARK_CAUSTIC_MAX_POINTS; index += 1) {
      expect(packed.corners[index]).toEqual(last);
    }
    expect(packed.intensity).toBeCloseTo(0.4);

    // Nothing published, nothing packed: the caller parks its own slots.
    expect(packMarkCaustic(null, bounds, 800, 400)).toBeNull();
  });
});
