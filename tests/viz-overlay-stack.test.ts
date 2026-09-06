import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE OVERLAY STACK CONTRACT — the rule that ends the recurring z-order bug.
 *
 * The GL client renders four layers, in one fixed order, with one filter:
 *
 *   ambientRoot  <  stage  <  markRoot  <  tooltipRoot
 *                     ^ pointer-light filter applies HERE
 *
 * Every product surface (chrome, views, panels, overlay menus) draws into
 * `stage`: that is what makes it receive the pointer light and sit UNDER the
 * one hover bubble. A surface mounted above `stage` escapes the light; one
 * mounted above `tooltipRoot` buries the bubble a reader opened. A DOM
 * overlay that PAINTS its own frame has both defects at any z-index — the
 * canvas is one element — which is why frames are drawn by the view with
 * `panel()` and DOM wrappers stay transparent (the Projects-form pattern).
 *
 * This kept regressing one new frame at a time, each fixed by hand
 * (2026-08-28). These assertions are SOURCE-STRUCTURAL on purpose: the stack
 * is invisible to mocked tests (no GPU device) and `viz:smoke` proves the
 * behaviour on a real one — this file is the cheap clean-checkout guard for
 * the architectural shape, the same split as viz-client-bundle-boundary.
 * The prose contract lives in src/viz/AGENTS.md ("THE OVERLAY STACK").
 */

const GL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'viz', 'client-gl');
const renderer = readFileSync(join(GL_ROOT, 'gpu-renderer.ts'), 'utf8');

/**
 * CSS-framed DOM overlays, GRANDFATHERED. Each is a known debt: out of the
 * pointer light and over the hover bubble. Migrate one by giving it the
 * Projects treatment (transparent wrapper, `panel()` frame drawn by the
 * view), then REMOVE it here. Never extend this list — a new overlay draws
 * its frame in GL.
 */
const GRANDFATHERED_SKIN_TOKENS = new Set([
  'gpu-panel-skin',
  'gpu-overlays-veiled',
  // The reference pattern: the skin is NEUTRALISED for this one (transparent
  // background, no border) and the view draws the real frame with panel().
  'gpu-project-form',
  'gpu-project-form--run',
  // The debts. (`gpu-settings-form`, the fixed rename form, was retired when
  // Settings became one tabbed body — the display name is in-flow now.)
  'gpu-org-models-form',
  'gpu-announce-form',
  // A floating dragged window by explicit contract (src/viz/AGENTS.md).
  'gpu-scene-tuning',
]);

describe('the GL overlay stack', () => {
  it('mounts exactly four layers, in the light-then-bubble order', () => {
    const mounts = renderer.match(/this\.app\.stage\.addChild\([^)]*\)/g) ?? [];
    // ONE mount call, naming all four layers in order: ambient scenery under
    // everything, product surfaces next (the lit ones), the retained crystal
    // and orbs above them, and the hover bubble on top of it all. A second
    // mount call would be a fifth layer nothing in the contract places.
    expect(mounts).toEqual([
      'this.app.stage.addChild(this.ambientRoot, this.stage, this.markRoot, this.tooltipRoot)',
    ]);
  });

  it('applies the pointer light to stage, and to stage alone', () => {
    const assignments = renderer.match(/this\.\w+(?:\.\w+)*\.filters\s*=\s*[^;]+/g) ?? [];
    // Install and teardown, both on `stage`. A filter on markRoot would smear
    // the crystal; one on tooltipRoot would smear the text a reader opened
    // the bubble to read; a filter missing from stage un-lights the product.
    expect(assignments).toEqual(['this.stage.filters = [filter]', 'this.stage.filters = null']);
  });

  it('keeps views off the layers above the light', () => {
    const viewsDir = join(GL_ROOT, 'renderer', 'views');
    for (const file of readdirSync(viewsDir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(join(viewsDir, file), 'utf8');
      // Views reach markRoot only through the renderer's retain* methods,
      // which resolve coordinates and account for retention; tooltips go
      // through ctx.tooltip. Direct mounting on either layer puts content
      // above the pointer light or above the bubble.
      expect(source.includes('markRoot'), `${file} touches markRoot directly`).toBe(false);
      expect(source.includes('tooltipRoot'), `${file} touches tooltipRoot directly`).toBe(false);
    }
  });

  it('holds the CSS-framed overlay list closed', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(GL_ROOT)) {
      if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;
      const source = readFileSync(join(GL_ROOT, file), 'utf8');
      for (const literal of source.match(/["'`][^"'`\n]*gpu-panel-skin[^"'`\n]*["'`]/g) ?? []) {
        for (const token of literal.match(/gpu-[a-z-]+/g) ?? []) {
          if (!GRANDFATHERED_SKIN_TOKENS.has(token)) {
            offenders.push(`${file}: ${token}`);
          }
        }
      }
    }
    // A new `.gpu-panel-skin` surface is a frame the pointer light cannot
    // reach and the hover bubble cannot cross. Draw the frame in GL instead
    // (transparent DOM wrapper + panel(), the Projects-form pattern) — see
    // "THE OVERLAY STACK" in src/viz/AGENTS.md.
    expect(offenders).toEqual([]);
  });

  it('lets the preview plane paint its own frame, because it REPLACES the canvas', () => {
    const plane = readFileSync(join(GL_ROOT, 'PreviewPlane.tsx'), 'utf8');
    const app = readFileSync(join(GL_ROOT, 'GpuApp.tsx'), 'utf8');
    const styles = readFileSync(join(GL_ROOT, 'styles.css'), 'utf8');

    // It is not an overlay OVER the canvas, so the grandfathered-skin rule
    // does not reach it — but it must not smuggle the skin in either.
    expect(plane.includes('gpu-panel-skin')).toBe(false);
    // What earns that exemption: the product tree goes INERT behind it, so
    // there is nothing underneath competing for the pointer light or buried
    // under a frame. Take this away and the plane becomes exactly the
    // CSS-framed overlay the list above closes.
    expect(app).toMatch(/inert=\{previewOpen\}/);
    // And it covers the viewport rather than floating in it.
    const rule = styles.match(/\.gpu-preview-plane\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).toContain('position: fixed');
    expect(rule![0]).toContain('inset: 0');
  });

  it('keeps the reference pattern honest: the project form skin stays neutralised', () => {
    const styles = readFileSync(join(GL_ROOT, 'styles.css'), 'utf8');
    const neutraliser = styles.match(/\.gpu-project-form\.gpu-panel-skin\s*\{[^}]*\}/);
    expect(neutraliser).not.toBeNull();
    expect(neutraliser![0]).toContain('background: transparent');
    expect(neutraliser![0]).toContain('box-shadow: none');
  });
});
