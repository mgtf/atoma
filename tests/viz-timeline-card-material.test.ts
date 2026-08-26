import { describe, expect, it } from 'vitest';
import {
  TIMELINE_CARD_MATERIAL_ATTRIBUTES,
  TIMELINE_CARD_MATERIAL_GLSL,
  TIMELINE_CARD_MATERIAL_GLSL_VERTEX,
  TIMELINE_CARD_MATERIAL_UNIFORMS,
  TIMELINE_CARD_MATERIAL_WGSL,
} from '../src/viz/client-gl/renderer/timeline-card-material.js';

describe('timeline card material shader contract', () => {
  const wgslVertexInput = TIMELINE_CARD_MATERIAL_WGSL
    .split('struct VertexInput')[1]
    ?.split('}')[0] ?? '';

  it('declares every interleaved geometry attribute on both backends', () => {
    expect(TIMELINE_CARD_MATERIAL_ATTRIBUTES).toHaveLength(3);
    for (const { name, format } of TIMELINE_CARD_MATERIAL_ATTRIBUTES) {
      expect(wgslVertexInput, `WGSL VertexInput missing ${name}`).toContain(`${name}:`);
      const components = Number(format.slice(-1));
      const glslType = components === 1 ? 'float' : `vec${components}`;
      expect(TIMELINE_CARD_MATERIAL_GLSL_VERTEX, `GLSL vertex missing ${name}`)
        .toContain(`in ${glslType} ${name};`);
    }
  });

  it('lays out the shared uniform block identically in JS and WGSL', () => {
    const struct = TIMELINE_CARD_MATERIAL_WGSL
      .split('struct TimelineCardUniforms')[1]
      ?.split('}')[0] ?? '';
    const order = struct.trim().split('\n')
      .filter((line) => line.includes(':'))
      .map((line) => {
        const [name, type] = line.trim().replace(/,$/, '').split(':');
        return { name: name!.trim(), type: type!.trim() };
      });
    expect(order).toEqual(
      TIMELINE_CARD_MATERIAL_UNIFORMS.map(({ name, type }) => ({ name, type }))
    );
  });

  it('samples the diffuse and normal bitmaps once each in uniform flow', () => {
    expect(TIMELINE_CARD_MATERIAL_WGSL.match(/textureSample\(/g)).toHaveLength(2);
    expect(TIMELINE_CARD_MATERIAL_GLSL.match(/\btexture\(/g)).toHaveLength(2);
    for (const source of [TIMELINE_CARD_MATERIAL_WGSL, TIMELINE_CARD_MATERIAL_GLSL]) {
      expect(source).toContain('uSandDiffuse');
      expect(source).toContain('uSandNormal');
      expect(source).toContain('surfaceNormal');
      expect(source).toContain('specular');
      expect(source).not.toContain('uSandSpecular');
      expect(source).not.toContain('uTexture');
      expect(source).not.toMatch(/\bdiscard\b/);
    }
  });

  it('keeps the direct-lighting equations paired across WebGPU and WebGL', () => {
    for (const source of [TIMELINE_CARD_MATERIAL_WGSL, TIMELINE_CARD_MATERIAL_GLSL]) {
      expect(source).toContain('vMaterialPx / 173.0');
      expect(source).toContain('mapped.xy * 0.44');
      expect(source).toContain('pointerMix');
      expect(source).toContain('grainGain');
      expect(source).toContain('glossExponent');
      expect(source).toContain('lit * alpha');
    }
  });

  it('ships plain shader strings with no accidental template terminator', () => {
    for (const [name, source] of Object.entries({
      TIMELINE_CARD_MATERIAL_WGSL,
      TIMELINE_CARD_MATERIAL_GLSL_VERTEX,
      TIMELINE_CARD_MATERIAL_GLSL,
    })) {
      expect(source, `${name} must not contain a backtick`).not.toContain('`');
    }
  });
});
