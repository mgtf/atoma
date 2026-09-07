import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { GPU_COLORS, gpuTextRasterOptions } from '../theme.js';

/**
 * ONE hover bubble for the whole GPU client.
 *
 * The canvas is a single DOM surface, so a Pixi label cannot carry a native
 * `title=`: there is no element under the pointer to hang one on. A tooltip
 * here is therefore drawn, and drawing it once is the only way the burn-in
 * chart's hand-rolled bubble stops being the pattern every later hover copies.
 *
 * The bubble is NOT part of the scene views rebuild. Views declare a RECTANGLE
 * and a string per render (`register`), and the bubble itself lives on its own
 * layer, moved by a ticker reading the same mutable pointer sample the pointer
 * light reads. That is the project rule for pointer motion: no scene rebuild,
 * no React state, one sample read per frame. A view that stops declaring a
 * region simply stops being hoverable on the next render.
 *
 * Regions are in RENDERER pixels, already projected through
 * `recordHitTarget`'s transform, because a view's container may be translated
 * (the content viewport is offset by the nav rail) and the pointer sample is
 * in renderer space.
 */

/** Delay before an idle hover opens the bubble, as a native title would. */
const OPEN_DELAY_MS = 350;
const PADDING_X = 9;
const PADDING_Y = 6;
const FONT_SIZE = 11;
/**
 * Gap between the pointer and the bubble. Asymmetric ON PURPOSE, measured
 * against a real hover: the client draws its own arrow cursor, which extends
 * about 20px DOWN from the hotspot, so a symmetric 14px gap put the bubble
 * under the arrow and on top of the very stamp the reader hovered. Sideways
 * the arrow is narrow, so the horizontal gap stays small.
 */
const POINTER_GAP_X = 14;
const POINTER_GAP_Y = 24;
/** Keep the bubble this far inside the viewport when it would overflow. */
const EDGE_MARGIN = 6;

export interface TooltipRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
}

/**
 * How the bubble learns its own size. In the browser this is the Pixi label's
 * measured bounds; a headless test passes its own, because Pixi cannot measure
 * text without a canvas 2D context and the geometry under test — the open
 * delay, the edge flip — is not about font metrics.
 */
export type TooltipMeasure = (text: string) => { width: number; height: number };

export interface TooltipDiagnostics {
  readonly visible: boolean;
  readonly text: string | null;
  readonly regionCount: number;
}

export class TooltipLayer {
  private readonly bubble = new Container();
  private readonly background = new Graphics();
  private readonly label: Text;
  /** Rebuilt every render. The pointer reads it; nothing else mutates it. */
  private regions: TooltipRegion[] = [];
  private shownText: string | null = null;
  /** When the current hover began, or null while the pointer is over nothing. */
  private hoverStartedAt: number | null = null;
  private hoveredText: string | null = null;

  private readonly measure: TooltipMeasure;
  /** Size of the bubble currently shown, so it is measured once per string. */
  private shownSize = { width: 0, height: 0 };

  constructor(parent: Container, measure?: TooltipMeasure) {
    this.label = new Text({
      text: '',
      ...gpuTextRasterOptions(),
      style: new TextStyle({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: FONT_SIZE,
        fill: GPU_COLORS.text,
      }),
    });
    this.label.position.set(PADDING_X, PADDING_Y);
    this.bubble.addChild(this.background, this.label);
    // The bubble must never eat a click meant for the row under it, and it
    // must never be hit-tested itself.
    this.bubble.eventMode = 'none';
    this.bubble.visible = false;
    parent.addChild(this.bubble);
    this.measure =
      measure ??
      ((text: string) => {
        this.label.text = text;
        return { width: this.label.width, height: this.label.height };
      });
  }

  /** Drop last render's regions. Called once, before the views redraw. */
  beginRender(): void {
    this.regions = [];
  }

  /** Declare one hoverable rectangle, in renderer pixels. */
  register(region: TooltipRegion): void {
    if (region.width <= 0 || region.height <= 0 || !region.text) return;
    this.regions.push(region);
  }

  /**
   * Per-frame update from the pointer sample. Topmost declaration wins, so a
   * region declared by an overlay beats one under it.
   */
  update(
    pointer: { readonly x: number; readonly y: number; readonly active: boolean },
    now: number,
    viewport: { readonly width: number; readonly height: number }
  ): void {
    const hit = pointer.active ? this.regionAt(pointer.x, pointer.y) : null;
    if (!hit) {
      this.hoverStartedAt = null;
      this.hoveredText = null;
      this.hide();
      return;
    }
    // A move WITHIN one region keeps its timer; moving to a different string
    // restarts it, so sweeping a list does not flash a bubble per row.
    if (hit.text !== this.hoveredText) {
      this.hoveredText = hit.text;
      this.hoverStartedAt = now;
    }
    if (this.hoverStartedAt === null || now - this.hoverStartedAt < OPEN_DELAY_MS) {
      this.hide();
      return;
    }
    this.show(hit.text, pointer.x, pointer.y, viewport);
  }

  /** Topmost match: later declarations draw over earlier ones. */
  private regionAt(x: number, y: number): TooltipRegion | null {
    for (let index = this.regions.length - 1; index >= 0; index -= 1) {
      const region = this.regions[index]!;
      if (
        x >= region.x &&
        x <= region.x + region.width &&
        y >= region.y &&
        y <= region.y + region.height
      ) {
        return region;
      }
    }
    return null;
  }

  private show(
    text: string,
    pointerX: number,
    pointerY: number,
    viewport: { readonly width: number; readonly height: number }
  ): void {
    if (text !== this.shownText) {
      const measured = this.measure(text);
      this.label.text = text;
      this.shownSize = {
        width: measured.width + PADDING_X * 2,
        height: measured.height + PADDING_Y * 2,
      };
      this.background.clear();
      this.background.roundRect(0, 0, this.shownSize.width, this.shownSize.height, 6);
      this.background.fill({ color: 0x080e19, alpha: 0.97 });
      this.background.stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.9 });
      this.shownText = text;
    }
    const { width, height } = this.shownSize;
    // Below-right of the pointer by default, flipped rather than clamped when
    // that would leave the viewport: a clamped bubble sits UNDER the cursor.
    let x = pointerX + POINTER_GAP_X;
    if (x + width > viewport.width - EDGE_MARGIN) x = pointerX - POINTER_GAP_X - width;
    let y = pointerY + POINTER_GAP_Y;
    if (y + height > viewport.height - EDGE_MARGIN) y = pointerY - POINTER_GAP_Y - height;
    this.bubble.position.set(
      Math.max(EDGE_MARGIN, Math.min(x, viewport.width - EDGE_MARGIN - width)),
      Math.max(EDGE_MARGIN, Math.min(y, viewport.height - EDGE_MARGIN - height))
    );
    this.bubble.visible = true;
  }

  private hide(): void {
    this.bubble.visible = false;
  }

  /** Read-only capture surface, exposed only through the opt-in viz diagnostic. */
  diagnostics(): TooltipDiagnostics {
    return {
      visible: this.bubble.visible,
      text: this.bubble.visible ? this.shownText : null,
      regionCount: this.regions.length,
    };
  }

  destroy(): void {
    this.bubble.destroy({ children: true, context: true });
  }
}
