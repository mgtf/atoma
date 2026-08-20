import { describe, expect, it } from 'vitest';
import {
  FAR_FIELD_ATTRIBUTES,
  FAR_FIELD_GLSL,
  FAR_FIELD_GLSL_VERTEX,
  FAR_FIELD_UNIFORMS,
  FAR_FIELD_WGSL,
} from '../src/viz/client-gl/renderer/far-field.js';

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
});
