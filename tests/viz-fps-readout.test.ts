import { describe, expect, it } from 'vitest';
import { FPS_REFRESH_MS, formatFps, fpsColor } from '../src/viz/client-gl/renderer/fps-readout.js';
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
  it('is slow enough that the counter is not the most expensive object drawn', () => {
    // Every change re-rasterises the label and uploads a texture. Per-frame
    // updates would make the FPS counter a measurable cost of its own.
    expect(FPS_REFRESH_MS).toBeGreaterThanOrEqual(200);
    expect(FPS_REFRESH_MS).toBeLessThanOrEqual(1000);
  });
});
