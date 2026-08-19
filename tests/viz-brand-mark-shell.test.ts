import { describe, expect, it } from 'vitest';
import {
  MARK_SHELL_ATTRIBUTES,
  MARK_SHELL_UNIFORMS,
} from '../src/viz/client-gl/renderer/mark-shell.js';
import {
  MARK_SHELL_GLSL,
  MARK_SHELL_GLSL_VERTEX,
  MARK_SHELL_WGSL,
} from '../src/viz/client-gl/renderer/shaders.js';

/**
 * The shell's two programs are one contract seen twice, and NOTHING else in
 * `tests/` can look at them: `createMarkShell` needs a document to compile a
 * shader, so the headless view tests never build one. The failure mode this
 * file exists for is asymmetric and expensive — an attribute the geometry
 * supplies and a shader forgot is a warning plus a wrong picture on WebGL, and
 * a REFUSED PIPELINE on WebGPU, which is the mark not drawing at all. It was
 * caught by `viz:smoke` on a real adapter, which is the slowest place to find
 * anything. Held here at zero cost.
 */
describe('mark shell shader contract', () => {
  const wgslVertexInput = MARK_SHELL_WGSL.split('struct VertexInput')[1]
    ?.split('}')[0] ?? '';

  it('declares every geometry attribute in both programs', () => {
    expect(MARK_SHELL_ATTRIBUTES.length).toBeGreaterThan(0);
    for (const { name, format } of MARK_SHELL_ATTRIBUTES) {
      // WGSL: the vertex INPUT struct specifically. A name that appears only in
      // the body — as it did when aMaterial was added to the outputs and not
      // the inputs — compiles nowhere and is exactly the defect to catch.
      expect(wgslVertexInput, `wgsl VertexInput missing ${name}`).toContain(`${name}:`);
      const components = Number(format.slice(-1));
      const glslType = components === 1 ? 'float' : `vec${components}`;
      expect(MARK_SHELL_GLSL_VERTEX, `glsl vertex missing ${name}`)
        .toContain(`in ${glslType} ${name};`);
    }
  });

  it('lays the uniform block out identically in JS and in WGSL', () => {
    // THE defect this file was extended for. Pixi builds the WebGPU uniform
    // buffer from the JS declaration order alone and never parses the shader's
    // hand-written struct, so a disagreement silently feeds every member past
    // the first difference its neighbour's bytes — and WebGL, which binds by
    // name, keeps rendering perfectly. uPulse was last in JS and seventh in the
    // struct; uOpacityRef, an opacity DENOMINATOR guarded by max(x, 1e-4), was
    // served a sine that crosses zero. Order, not just membership, is the test.
    const struct = MARK_SHELL_WGSL.split('struct MarkUniforms')[1]?.split('}')[0] ?? '';
    const wgslOrder = struct.trim().split('\n')
      .filter((line) => line.includes(':'))
      .map((line) => {
        const [name, type] = line.trim().replace(/,$/, '').split(':');
        return { name: name!.trim(), type: type!.trim() };
      });
    expect(wgslOrder).toEqual(MARK_SHELL_UNIFORMS.map(({ name, type }) => ({ name, type })));
  });

  it('declares every uniform in GLSL too, in the same order', () => {
    // GLSL cannot suffer the offset bug, but a uniform the JS block sends and
    // the fragment program never declares is a feature that silently does
    // nothing on the WebGL fallback — the other half of the same asymmetry.
    const glslTypes: Record<string, string> = {
      'vec3<f32>': 'vec3',
      'vec2<f32>': 'vec2',
      f32: 'float',
    };
    // Samplers are NOT uniform-block members. They bind separately on both
    // backends — a WGSL texture_2d/sampler pair in the bind group, a texture
    // unit in GL — so they must not be counted into the ordered layout the
    // WebGPU buffer is built from.
    const declared = [...MARK_SHELL_GLSL.matchAll(/^\s*uniform\s+(\w+)\s+(\w+);/gm)]
      .map((match) => ({ type: match[1]!, name: match[2]! }))
      .filter((entry) => !entry.type.startsWith('sampler'));
    expect(declared).toEqual(MARK_SHELL_UNIFORMS.map(({ name, type }) => ({
      name,
      type: glslTypes[type]!,
    })));
  });

  it('builds chromatic split as a per-channel displacement difference', () => {
    // The defect this pins: the split was first written as
    // `sample - vec3(sample.g)`, which zeroes green by construction and leaves
    // red and blue carrying ABSOLUTE brightness rather than a difference. Every
    // lit part of the interior then gained flat magenta whether or not anything
    // had been displaced, and the four rank hues did not survive it.
    //
    // The property that must hold: each channel is compared against the
    // UNDISPLACED sample of the same channel, so a zero offset — a flat facet,
    // or obsidian, which has dispersion 0 — yields exactly zero.
    for (const source of [MARK_SHELL_WGSL, MARK_SHELL_GLSL]) {
      expect(source).toContain('shiftR - straight.r');
      expect(source).toContain('shiftB - straight.b');
      expect(source, 'green must not be cross-subtracted').not.toContain('vec3(shiftG)');
      expect(source, 'green must not be cross-subtracted')
        .not.toContain('vec3<f32>(shiftG)');
    }
  });

  it('keeps the refraction sample inside the mark box', () => {
    // vScreen must come from the LOCAL 28x28 position, not from clip space.
    // Clip space spans the whole viewport while the backdrop texture holds only
    // the mark's own box, so a clip-derived coord had every facet sampling an
    // unrelated part of the screen — large flat washes of colour with no
    // relation to the geometry.
    expect(MARK_SHELL_WGSL).toContain('input.aPosition / markUniforms.uLocalSize');
    expect(MARK_SHELL_GLSL_VERTEX).toContain('aPosition / uLocalSize');
    for (const source of [MARK_SHELL_WGSL, MARK_SHELL_GLSL_VERTEX]) {
      expect(source, 'clip space must not drive the backdrop sample')
        .not.toMatch(/vScreen\s*=\s*(gl_Position|clip)/);
    }
  });

  it('gives every WGSL vertex input its own location', () => {
    const locations = [...wgslVertexInput.matchAll(/@location\((\d+)\)/g)]
      .map((match) => Number(match[1]));
    expect(locations).toHaveLength(MARK_SHELL_ATTRIBUTES.length);
    expect(new Set(locations).size).toBe(locations.length);
  });

  it('passes every fragment varying through both vertex stages', () => {
    // Same asymmetry one stage later: a varying the fragment stage reads and
    // the vertex stage never writes.
    const wgslOutput = MARK_SHELL_WGSL.split('struct VertexOutput')[1]
      ?.split('}')[0] ?? '';
    const varyings = [...wgslOutput.matchAll(/@location\(\d+\)\s+(v\w+):/g)]
      .map((match) => match[1]!);
    expect(varyings.length).toBeGreaterThan(0);
    for (const varying of varyings) {
      expect(MARK_SHELL_WGSL, `wgsl vertex never writes ${varying}`)
        .toContain(`out.${varying} =`);
      expect(MARK_SHELL_GLSL_VERTEX, `glsl vertex never writes ${varying}`)
        .toContain(`${varying} =`);
      expect(MARK_SHELL_GLSL, `glsl fragment never declares ${varying}`)
        .toContain(` ${varying};`);
    }
  });

  it('keeps the two fragment programs on the same uniforms', () => {
    const block = MARK_SHELL_WGSL.split('struct MarkUniforms')[1]?.split('}')[0] ?? '';
    const uniforms = [...block.matchAll(/(u\w+):\s*([\w<>]+)/g)]
      .map(([, name, type]) => ({ name: name!, type: type! }));
    expect(uniforms.length).toBeGreaterThan(5);
    for (const { name, type } of uniforms) {
      const glslType = type === 'f32' ? 'float' : type.replace(/<f32>/, '');
      expect(MARK_SHELL_GLSL, `glsl missing uniform ${name}`)
        .toContain(`uniform ${glslType} ${name};`);
    }
  });
});
