import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_PAD } from '../view-frame.js';

/**
 * ANNOUNCEMENTS — the admin plane's only write surface, and the one push a
 * human writes.
 *
 * This view draws a FRAME AND NOTHING ELSE. The composer is real DOM
 * (`AnnouncementForm`), because text entry, a per-language review and a
 * select belong to the browser, and it fills the frame's whole content box —
 * so unlike every other DOM overlay in this client there is no GL content
 * underneath for it to collide with. The frame still comes from
 * `view-frame.ts` rather than from CSS: the title, the elevation and the
 * column geometry are the same product surface as the four views beside it,
 * and a form floating on the far field would read as a different app.
 *
 * The height contract is therefore INVERTED compared to the project form:
 * the DOM does not claim a slice the renderer must give up, it claims the
 * whole box, and the test pins its inset to the frame's own padding.
 */

/** Where the composer's box ends, measured up from the viewport's foot. */
export function announceFormBottom(viewportHeight: number, frameBottom: number): number {
  return Math.max(0, viewportHeight - frameBottom + VIEW_FRAME_PAD);
}

export function drawAnnounce(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const frame = viewFrame(width, height);
  drawViewFrame(ctx, frame, snapshot.t('nav.announce'), snapshot.t('announce.summary'));
}
