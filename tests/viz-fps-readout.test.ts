import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FPS_REFRESH_MS,
  createFpsSampleWindow,
  formatFps,
  fpsColor,
  sampleFpsWindow,
} from '../src/viz/client-gl/renderer/fps-readout.js';
import { GPU_COLORS } from '../src/viz/client-gl/theme.js';

describe('formatFps', () => {
  it('rounds, because a jittering decimal reads as instability', () => {
    expect(formatFps(59.6)).toBe('60 FPS');
    expect(formatFps(30.4)).toBe('30 FPS');
  });

  it('shows a placeholder rather than a lie before the first sample', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatFps(value)).toBe('— FPS');
    }
  });
});

describe('fpsColor', () => {
  it('stays muted while healthy, so the readout is furniture not an alarm', () => {
    expect(fpsColor(60)).toBe(GPU_COLORS.muted);
    expect(fpsColor(50)).toBe(GPU_COLORS.muted);
  });

  it('warns below 50, where motion stops being smooth on a 60Hz panel', () => {
    expect(fpsColor(49.9)).toBe(GPU_COLORS.warning);
    expect(fpsColor(30)).toBe(GPU_COLORS.warning);
  });

  it('errors below 30, where the UI is failing rather than struggling', () => {
    expect(fpsColor(29.9)).toBe(GPU_COLORS.error);
    expect(fpsColor(1)).toBe(GPU_COLORS.error);
  });

  it('is muted rather than alarming for a missing sample', () => {
    expect(fpsColor(0)).toBe(GPU_COLORS.muted);
    expect(fpsColor(Number.NaN)).toBe(GPU_COLORS.muted);
  });
});

describe('refresh cadence', () => {
  it('uses a legible window rather than publishing every frame', () => {
    expect(FPS_REFRESH_MS).toBeGreaterThanOrEqual(200);
    expect(FPS_REFRESH_MS).toBeLessThanOrEqual(1000);
  });

  it('averages the complete window instead of reporting one missed 120Hz frame as 60 FPS', () => {
    const sample = createFpsSampleWindow();
    let published: number | null = null;
    for (let frame = 0; frame < 30; frame += 1) {
      const next = sampleFpsWindow(sample, frame === 29 ? 1000 / 60 : 1000 / 120);
      if (next !== null) published = next;
    }
    expect(published).toBeCloseTo(116.13, 1);
    expect(formatFps(published ?? 0)).toBe('116 FPS');
  });

  it('publishes nothing before the window is armed', () => {
    const sample = createFpsSampleWindow();
    for (let frame = 0; frame < 29; frame += 1) {
      expect(sampleFpsWindow(sample, 1000 / 120)).toBeNull();
    }
  });

  it('ignores invalid intervals without poisoning the next window', () => {
    const sample = createFpsSampleWindow();
    for (const interval of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(sampleFpsWindow(sample, interval)).toBeNull();
    }
    expect(sample).toEqual({ elapsedMs: 0, frames: 0 });
  });

  it('keeps the window outside the scene-owned callback so rebuilds cannot reset it', () => {
    // The pure tests above prove the arithmetic. This source assertion owns
    // the otherwise GPU-only wiring: renderScene replaces ticker callbacks on
    // every wheel rebuild, while the sample and last value must live on the
    // renderer instance.
    const source = readFileSync('src/viz/client-gl/gpu-renderer.ts', 'utf8');
    expect(source).toMatch(/private readonly fpsSample = createFpsSampleWindow\(\)/);
    expect(source).toMatch(/private lastFps = 0/);
    const draw = source.slice(source.indexOf('private drawFpsReadout('));
    const body = draw.slice(0, draw.indexOf('\n  private ', 1));
    expect(body).toMatch(/sampleFpsWindow\(this\.fpsSample, ticker\.elapsedMS\)/);
    expect(body).not.toMatch(/const sample = createFpsSampleWindow\(\)/);
    expect(body).toMatch(/formatFps\(this\.lastFps\)/);
  });
});
