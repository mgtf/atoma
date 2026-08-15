import { Container } from 'pixi.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { truncate } from '../copy.js';

/**
 * Launch view: describes the task families and shows the command to run —
 * it intentionally does not start runs. Extracted from gpu-renderer.ts
 * (2026-08-15 decomposition).
 *
 * Layout is ONE measured pass (2026-08-15 review residual): each block is
 * placed from the measured bottom of the paragraph above it — `ctx.text`
 * returns real wrapped heights in the renderer — with floors that reproduce
 * the historical fixed positions when paragraphs are short. The backdrop
 * panel depends on that final cursor but must render behind the text, so a
 * layer reserves its z-slot up front and the panel is drawn into it last.
 * The panel height, the drawn positions and the scroll max all derive from
 * the same cursor instead of a duplicated analytic estimate.
 */
export function drawLaunch(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const top = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
  // Layout runs in unscrolled coordinates; every draw subtracts the wheel
  // offset (scroll honesty — 2026-08-14 review).
  const scroll = snapshot.state.scrollY.launch;
  const panelWidth = Math.min(920, width - GPU_LAYOUT.gap * 2);
  const x = (width - panelWidth) / 2;
  const profile = snapshot.data.profiles[0];
  const panelLayer = new Container();
  ctx.root.addChild(panelLayer);
  ctx.text(ctx.root, snapshot.t('nav.launch'), x + 22, top + 18 - scroll, { size: 18, weight: '700' });
  const help = ctx.text(ctx.root, snapshot.t('launch.help'), x + 22, top + 52 - scroll, {
    size: 11,
    color: GPU_COLORS.muted,
    width: panelWidth - 44,
  });
  let contentBottom = top + 52 + help.height;
  if (profile) {
    const labelY = Math.max(top + 92, contentBottom + 24);
    ctx.text(ctx.root, profile.label, x + 22, labelY - scroll, {
      size: 13,
      weight: '700',
      color: GPU_COLORS.primary,
    });
    const profileHelp = ctx.text(ctx.root, profile.help, x + 22, labelY + 30 - scroll, {
      size: 11,
      color: GPU_COLORS.muted,
      width: panelWidth - 44,
    });
    const examplesTop = Math.max(labelY + 148, labelY + 30 + profileHelp.height + 24);
    let exampleY = examplesTop;
    const exampleWidth = (panelWidth - 66) / 2;
    profile.examples.forEach((example, index) => {
      ctx.button(
        ctx.root,
        `launch.example.${index}`,
        'button',
        truncate(example, 90),
        x + 22,
        exampleY - scroll,
        exampleWidth,
        36,
        false,
        snapshot.onActivate
      );
      exampleY += 43;
    });
    const command = snapshot.state.search.launch.trim()
      ? `npm run ${profile.npmScript} -- "${snapshot.state.search.launch.trim().replace(/"/g, '\\"')}"`
      : snapshot.t('launch.empty');
    // The command block follows the examples. Its historical floor (top+430)
    // is examplesTop+190, so it moves with measured paragraphs; the old
    // `min(height - 118, …)` viewport pin is gone — with honest scrolling it
    // only dragged the block up over the examples in short windows.
    const commandY = Math.max(examplesTop + 190, exampleY + 18);
    ctx.panel(ctx.root, x + 22, commandY - scroll, panelWidth - 150, 68, 0x0b111e);
    ctx.text(ctx.root, command, x + 34, commandY + 12 - scroll, {
      size: 10,
      mono: true,
      width: panelWidth - 180,
    });
    ctx.button(ctx.root, 'launch.copy', 'button', snapshot.t('launch.copy'), x + panelWidth - 114, commandY - scroll, 92, 68, false, snapshot.onActivate);
    contentBottom = commandY + 68;
  }
  ctx.panel(
    panelLayer,
    x,
    top - scroll,
    panelWidth,
    Math.max(height - top - GPU_LAYOUT.gap, contentBottom + 16 - top),
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );
  ctx.scrollMax.launch = Math.max(0, contentBottom + 12 - height);
}
