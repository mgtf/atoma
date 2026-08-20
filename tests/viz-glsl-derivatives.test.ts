import { describe, expect, it } from 'vitest';
import {
  FAR_FIELD_GLSL,
  FAR_FIELD_GLSL_VERTEX,
} from '../src/viz/client-gl/renderer/far-field.js';
import {
  MARK_SHELL_GLSL,
  MARK_SHELL_GLSL_VERTEX,
} from '../src/viz/client-gl/renderer/shaders.js';

/**
 * Derivative intrinsics (`fwidth`, `dFdx`, `dFdy`) are CORE in GLSL ES 3.00 and
 * in WGSL, but in GLSL ES 1.00 they exist only behind `GL_OES_standard_derivatives`.
 * Pixi compiles a GLSL program as ES 1.00 unless the FRAGMENT source contains
 * `#version 300 es` (GlProgram decides the dialect from the fragment alone and
 * applies it to both stages), and the fallback environments do not expose the
 * ES 1.00 extension at all. The 2026-08-20 WebGL-fallback break was two programs
 * that used derivatives without declaring the dialect: they compiled on WebGPU
 * and failed to link on the fallback.
 *
 * `tests/` runs without a GPU and cannot compile a shader, so this is held as a
 * source contract. The pin must also be the FIRST characters of the template
 * literal: a `#version` directive anywhere else is rejected by the compiler.
 */
const GLSL_PROGRAMS = {
  'far-field': { vertex: FAR_FIELD_GLSL_VERTEX, fragment: FAR_FIELD_GLSL },
  'mark-shell': { vertex: MARK_SHELL_GLSL_VERTEX, fragment: MARK_SHELL_GLSL },
} as const;

const VERSION = '#version 300 es';

const usesDerivatives = (source: string) => /\b(fwidth|dFdx|dFdy)\s*\(/.test(source);

describe('GLSL derivative intrinsics declare their dialect', () => {
  it('pins #version 300 es, first, on every stage of every ES 3.00 program', () => {
    for (const [program, stages] of Object.entries(GLSL_PROGRAMS)) {
      for (const [stage, source] of Object.entries(stages)) {
        expect(
          source.startsWith(VERSION),
          `${program} ${stage} must start with ${VERSION}`
        ).toBe(true);
      }
    }
  });

  it('still has derivative work to guard (the contract is live)', () => {
    const fragments = Object.values(GLSL_PROGRAMS).map(({ fragment }) => fragment);
    expect(fragments.some(usesDerivatives)).toBe(true);
  });
});
