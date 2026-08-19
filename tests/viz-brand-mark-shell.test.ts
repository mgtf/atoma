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

  it('keeps backticks out of the shader sources', () => {
    // These are template literals. A backtick inside one — easy to type when
    // quoting an identifier in a comment — terminates the string and the file
    // stops parsing, which has happened three times while editing these
    // shaders. Cheaper to assert than to rediscover from a TS1005.
    for (const [name, source] of Object.entries({
      MARK_SHELL_WGSL,
      MARK_SHELL_GLSL_VERTEX,
      MARK_SHELL_GLSL,
    })) {
      expect(source, `${name} must not contain a backtick`).not.toContain('`');
    }
  });

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

  it('can switch refraction off so the backdrop cannot feed itself', () => {
    // The defect this pins, and it cost four wrong diagnoses. The back and
    // front shells share ONE shader, and the back facets are outer facets too —
    // so while the interior was being rendered into the backdrop texture, those
    // facets ran the refraction sampler against the previous frame's copy of
    // that same texture, and their output went straight back into it. A closed
    // loop: the artefact compounded every frame into a saturated pixel grid.
    //
    // It survived a displacement clamp, a grazing fade, removing bulk from the
    // bend, and 2x supersampling, because none of those break a feedback path.
    // The uniform must exist and must gate the bend, in both programs.
    expect(MARK_SHELL_UNIFORMS.map(({ name }) => name)).toContain('uRefractOn');
    expect(MARK_SHELL_WGSL).toContain('markUniforms.uRefractOn');
    expect(MARK_SHELL_GLSL).toContain('* uRefractOn');
  });

  it('covers the undistorted interior so refraction cannot ghost', () => {
    // Drawing the transmitted image at the bent UV only works if the facet
    // REPLACES what is behind it. Using 1 - attenuation * transmit as outer
    // alpha punched a hole in diamond (transmit 1.32, so the expression went
    // negative) and let the undistorted bead show through next to the
    // refracted one. Coverage is 1 on the hull; Beer-Lambert lives in RGB.
    for (const source of [MARK_SHELL_WGSL, MARK_SHELL_GLSL]) {
      expect(source, 'attenuation must not punch a hole in outer alpha')
        .not.toMatch(/1\.0 - attenuation \* transmit/);
      expect(source).toMatch(/mix\(\s*vSurface\.x \* opacity,\s*1\.0,\s*outer\)/);
    }
  });

  it('lets a highlight become a spot by varying the view across a facet', () => {
    // Eight flat facets plus a constant view made N·H constant, so the key
    // glazed a whole face at once and the crystal read as painted triangles.
    // Both programs must build a perspective view from vScreen and use it for
    // the half vector — not (0,0,1).
    for (const source of [MARK_SHELL_WGSL, MARK_SHELL_GLSL]) {
      expect(source).toContain('viewDir');
      expect(source).toContain('nDotV');
      expect(source, 'orthographic view must not drive the half vector')
        .not.toMatch(/\+\s*vec3(<f32>)?\(0\.0,\s*0\.0,\s*1\.0\)/);
    }
  });

  it('gates the key highlight on geometry and concentrates fire in tight lobes', () => {
    // Specular on a face the key does not see is a glaze on the dark side, and
    // four glasses that share one peak only differ in width — diamond fire has
    // to be brighter because the energy is packed into a smaller spot.
    for (const source of [MARK_SHELL_WGSL, MARK_SHELL_GLSL]) {
      expect(source).toContain('sun * nDotV / max(sun + nDotV - sun * nDotV, 1e-4)');
      expect(source).toContain('(specularPower + 2.0) / 51.0');
      expect(source).toMatch(/specF \* geo \* specNorm/);
    }
  });

  it('conserves energy between reflection and transmission', () => {
    // A dielectric reflects F and lets 1-F into the body. Without bounce the
    // body, the highlight and the transmitted interior were three independent
    // adds, so grazing edges stacked a painted face AND a full interior.
    for (const source of [MARK_SHELL_WGSL, MARK_SHELL_GLSL]) {
      expect(source).toContain('bounce = 1.0 - fresnel');
      expect(source).toContain('transmit * bounce');
      expect(source).toMatch(/mix\(1\.0, 0\.58, bulk\) \* bounce/);
    }
  });

  it('throws traveling glints off the cavity walls, with TIR on high-index glass', () => {
    // The bead is the only point light, so a specular term against it is a
    // spot that moves as the bead bounces. Outer facets see that light as
    // transmission; the cavity reflects it, and past the critical angle the
    // reflection is total — diamond sparkles, glass does not, from the IOR.
    for (const source of [MARK_SHELL_WGSL, MARK_SHELL_GLSL]) {
      expect(source).toContain('coreHalf');
      expect(source).toContain('coreHighlight');
      expect(source).toContain('cosCrit');
      expect(source).toContain('(1.0 - outer)');
    }
  });

  it('counts the interior once, not twice', () => {
    // CORE (the bead solved analytically against this facet) and TRANSMITTED
    // (that same bead read out of the backdrop texture) are the same light. The
    // lit sum added both when transmission landed, so the interior came out at
    // double brightness and washed the rank tints out from underneath.
    //
    // They must be SELECTED between by hull, never summed: outer facets take
    // the sampled version, which is the one carrying the refracted
    // displacement; cavity facets have no backdrop and keep the analytic one.
    for (const source of [MARK_SHELL_WGSL, MARK_SHELL_GLSL]) {
      expect(source).toMatch(/mix\(\s*\n?\s*(markUniforms\.)?uCoreTint \* core/);
      expect(source, 'the two interior terms must not both be added')
        .not.toMatch(/uCoreTint \* core \+[\s\S]{0,200}transmitted \*/);
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
