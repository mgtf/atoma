import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ATOMA_MARK_TURN_MS } from '../src/viz/client-gl/brand-mark.js';
import { FRAME_COUNT, STEP_MS, TURN_MS, ALIVE_PEAK_MEAN_MIN, crystalClip, VIEW_HEIGHT, VIEW_WIDTH } from '../scripts/viz-mark-turn.mjs';
import { welcomeLayout } from '../src/viz/client-gl/renderer/views/welcome.js';

const script = readFileSync(
  resolve(import.meta.dirname, '../scripts/viz-mark-turn.mjs'),
  'utf8'
);
const gitignore = readFileSync(resolve(import.meta.dirname, '../.gitignore'), 'utf8');
const gpuRenderer = readFileSync(
  resolve(import.meta.dirname, '../src/viz/client-gl/gpu-renderer.ts'),
  'utf8'
);
const welcome = readFileSync(
  resolve(import.meta.dirname, '../src/viz/client-gl/renderer/views/welcome.ts'),
  'utf8'
);

describe('viz mark-turn capture', () => {
  it('steps a full turn at 250 ms, matching the mark\'s authored period', () => {
    expect(STEP_MS).toBe(250);
    expect(TURN_MS).toBe(ATOMA_MARK_TURN_MS);
    expect(FRAME_COUNT).toBe(Math.floor(ATOMA_MARK_TURN_MS / 250) + 1);
    expect(FRAME_COUNT).toBe(61);
  });

  it('pins the diag clock rather than sleeping 15 seconds on the wall', () => {
    expect(script).toContain('pinMarkElapsedMs');
    expect(script).toContain('?atomaDiag=1');
    expect(gpuRenderer).toContain('pinMarkElapsedMs');
    expect(script).not.toMatch(/waitUntil:\s*'networkidle0'/);
    expect(script).toMatch(/waitUntil:\s*'load'/);
  });

  it('freezes the welcome float so the film is a rotation, not a bob', () => {
    expect(welcome).toContain('markClockIsPinned');
    expect(welcome).not.toMatch(/Math\.sin\(performance\.now\(\)/);
  });

  it('crops to the crystal, above the inspect row', () => {
    const clip = crystalClip(VIEW_WIDTH, VIEW_HEIGHT);
    const layout = welcomeLayout(VIEW_WIDTH, VIEW_HEIGHT);
    expect(clip.y + clip.height).toBeLessThan(layout.sliderY);
    expect(clip.y + clip.height).toBeLessThan(layout.buttonY);
    expect(clip.x + clip.width).toBeLessThanOrEqual(VIEW_WIDTH);
  });

  it('keeps the film crop and welcome layout in lockstep', () => {
    expect(script).toMatch(/MARK_TO_SLIDER = 22/);
    expect(welcome).toMatch(/MARK_TO_SLIDER = 22/);
    expect(script).toMatch(/SLIDER_HEIGHT = 28/);
    expect(welcome).toMatch(/SLIDER_HEIGHT = 28/);
    expect(script).toMatch(/SLIDER_TO_BUTTON = 18/);
    expect(welcome).toMatch(/SLIDER_TO_BUTTON = 18/);
  });

  it('can capture a single degree instead of the 250 ms film', () => {
    expect(script).toContain('--degree');
    expect(script).toContain('degree-');
    expect(gpuRenderer).toContain('pinMarkTurnDegrees');
  });

  it('writes into a gitignored capture directory', () => {
    expect(script).toContain('.atoma-mark-turn');
    expect(gitignore).toContain('.atoma-mark-turn/');
  });

  it('fails closed if the film is only the aura', () => {
    // A WGSL let-reassignment refused the pipeline and every frame peaked at
    // 22: the cyan halo, no crystal. Capture must notice.
    expect(ALIVE_PEAK_MEAN_MIN).toBe(40);
    expect(script).toContain('assertFilmAlive');
    expect(script).toContain('peak_mean');
  });
});
