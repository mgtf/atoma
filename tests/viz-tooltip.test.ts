import { Container } from 'pixi.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { TooltipLayer } from '../src/viz/client-gl/renderer/tooltip.js';

/**
 * The bubble is drawn, not native, so its open delay, its edge flipping and
 * its per-render region lifetime are OUR behaviour and have to be pinned.
 *
 * Measurement is injected: Pixi cannot measure a Text without a canvas 2D
 * context, and none of the geometry under test is about font metrics. A fixed
 * size also makes the edge-flip assertions exact instead of approximate.
 */

/** One character ≈ 6px, the mono face's rough advance at 11px. */
const MEASURE = (text: string) => ({ width: text.length * 6, height: 13 });
/** What `measure` reports plus the module's padding, for exact geometry. */
const bubbleWidth = (text: string) => MEASURE(text).width + 18;

const VIEWPORT = { width: 1280, height: 800 };
/** Comfortably past the module's open delay. */
const AFTER_DELAY = 10_000;

function hover(layer: TooltipLayer, x: number, y: number, now: number) {
  layer.update({ x, y, active: true }, now, VIEWPORT);
}

describe('the shared hover bubble', () => {
  let root: Container;
  let layer: TooltipLayer;
  const bubble = () => root.children[0]!;

  beforeEach(() => {
    root = new Container();
    layer = new TooltipLayer(root, MEASURE);
  });

  it('waits for the pointer to settle before opening', () => {
    layer.beginRender();
    layer.register({ x: 100, y: 100, width: 60, height: 14, text: '23 August 2026' });
    hover(layer, 120, 105, 1000);
    expect(bubble().visible).toBe(false);
    hover(layer, 120, 105, 1000 + 100);
    expect(bubble().visible).toBe(false);
    hover(layer, 120, 105, 1000 + AFTER_DELAY);
    expect(bubble().visible).toBe(true);
  });

  it('restarts the delay only when the TEXT changes, not on every move', () => {
    layer.beginRender();
    layer.register({ x: 0, y: 0, width: 100, height: 20, text: 'row one' });
    layer.register({ x: 0, y: 40, width: 100, height: 20, text: 'row two' });
    hover(layer, 10, 10, 0);
    // Moving within the same region keeps the timer, so the bubble opens.
    hover(layer, 90, 15, AFTER_DELAY);
    expect(bubble().visible).toBe(true);
    // Sweeping onto a DIFFERENT row restarts it, so a list does not flash.
    hover(layer, 10, 45, AFTER_DELAY + 1);
    expect(bubble().visible).toBe(false);
  });

  it('closes when the pointer leaves the region, or leaves the window', () => {
    layer.beginRender();
    layer.register({ x: 0, y: 0, width: 100, height: 20, text: 'stamp' });
    hover(layer, 10, 10, 0);
    hover(layer, 10, 10, AFTER_DELAY);
    expect(bubble().visible).toBe(true);
    hover(layer, 500, 500, AFTER_DELAY + 1);
    expect(bubble().visible).toBe(false);
    hover(layer, 10, 10, AFTER_DELAY + 2);
    hover(layer, 10, 10, AFTER_DELAY * 2);
    expect(bubble().visible).toBe(true);
    // Pointer gone from the canvas entirely.
    layer.update({ x: 10, y: 10, active: false }, AFTER_DELAY * 2 + 1, VIEWPORT);
    expect(bubble().visible).toBe(false);
  });

  it('drops last render regions, so a view that stops declaring stops hovering', () => {
    layer.beginRender();
    layer.register({ x: 0, y: 0, width: 100, height: 20, text: 'stamp' });
    hover(layer, 10, 10, 0);
    hover(layer, 10, 10, AFTER_DELAY);
    expect(bubble().visible).toBe(true);
    // The next render scrolled that row away and declared nothing there.
    layer.beginRender();
    hover(layer, 10, 10, AFTER_DELAY + 1);
    expect(bubble().visible).toBe(false);
  });

  it('flips rather than clamps at the right and bottom edges', () => {
    layer.beginRender();
    layer.register({
      x: 0,
      y: 0,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      text: 'Sunday 23 August 2026 at 14:35:07',
    });
    // Near the origin the bubble sits BELOW-RIGHT of the pointer.
    hover(layer, 40, 40, 0);
    hover(layer, 40, 40, AFTER_DELAY);
    expect(bubble().position.x).toBeGreaterThan(40);
    expect(bubble().position.y).toBeGreaterThan(40);
    const width = bubbleWidth('Sunday 23 August 2026 at 14:35:07');
    const height = MEASURE('').height + 12;
    // At the far corner it flips to above-left. The property that separates a
    // FLIP from a clamp is that the pointer ends up OUTSIDE the bubble: a
    // clamp would park the bubble's right edge at the viewport edge, which
    // leaves the cursor sitting on top of the text it is trying to read.
    // Not AT the edge: a pointer 5px from the corner is degenerate, because a
    // clamp happens to land just clear of it. One bubble-width in, a clamp
    // would put the bubble squarely under the cursor and a flip would not.
    const px = VIEWPORT.width - Math.round(width / 2);
    const py = VIEWPORT.height - Math.round(height / 2);
    hover(layer, px, py, AFTER_DELAY);
    const { x, y } = bubble().position;
    // EACH AXIS separately: an `x && y` containment test passes as soon as one
    // of the two flips works, which hid a broken horizontal flip behind a
    // working vertical one.
    expect(px >= x && px <= x + width).toBe(false);
    expect(py >= y && py <= y + height).toBe(false);
    // And it stays fully inside the viewport on both axes.
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + width).toBeLessThanOrEqual(VIEWPORT.width);
    expect(y + height).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('is never hit-tested, so it cannot eat a click meant for the row under it', () => {
    expect(bubble().eventMode).toBe('none');
  });

  it('prefers the LAST region declared, so an overlay beats the row under it', () => {
    layer.beginRender();
    layer.register({ x: 0, y: 0, width: 100, height: 20, text: 'under' });
    layer.register({ x: 0, y: 0, width: 100, height: 20, text: 'over' });
    hover(layer, 10, 10, 0);
    hover(layer, 10, 10, AFTER_DELAY);
    const label = bubble().children.find((child) => 'text' in child) as { text: string };
    expect(label.text).toBe('over');
  });

  it('ignores an empty string or a collapsed rectangle', () => {
    layer.beginRender();
    layer.register({ x: 0, y: 0, width: 100, height: 20, text: '' });
    layer.register({ x: 0, y: 40, width: 0, height: 20, text: 'zero width' });
    hover(layer, 10, 10, 0);
    hover(layer, 10, 10, AFTER_DELAY);
    expect(bubble().visible).toBe(false);
    hover(layer, 0, 45, AFTER_DELAY);
    hover(layer, 0, 45, AFTER_DELAY * 2);
    expect(bubble().visible).toBe(false);
  });
});
