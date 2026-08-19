import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ATOMA_MARK_TURN_MS } from '../src/viz/client-gl/brand-mark.js';
import { FRAME_COUNT, STEP_MS, TURN_MS, crystalClip, VIEW_HEIGHT, VIEW_WIDTH } from '../scripts/viz-mark-turn.mjs';
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

  it('crops to the crystal, above the Continue control', () => {
    const clip = crystalClip(VIEW_WIDTH, VIEW_HEIGHT);
    const layout = welcomeLayout(VIEW_WIDTH, VIEW_HEIGHT);
    expect(clip.y + clip.height).toBeLessThan(layout.buttonY);
    expect(clip.x + clip.width).toBeLessThanOrEqual(VIEW_WIDTH);
  });

  it('writes into a gitignored capture directory', () => {
    expect(script).toContain('.atoma-mark-turn');
    expect(gitignore).toContain('.atoma-mark-turn/');
  });

  it('ships a pixel analyser for the film', () => {
    expect(script).toContain('viz:mark-turn:analyze');
  });
});
