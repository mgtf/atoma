import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { truncate } from '../copy.js';

/**
 * Launch view: describes the task families and shows the command to run —
 * it intentionally does not start runs. Extracted from gpu-renderer.ts
 * (2026-08-15 decomposition).
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
  // Analytic content bottom, computed up front so the panel can grow past a
  // short viewport and the wheel max reflects examples the window does not
  // fit, instead of failing closed with an unreachable tail.
  let contentBottom = top + 92;
  if (profile) {
    const examplesEnd = top + 240 + profile.examples.length * 43;
    const commandTop = Math.min(height - 118, Math.max(top + 430, examplesEnd + 18));
    contentBottom = Math.max(examplesEnd - 7, commandTop + 68);
  }
  ctx.panel(
    ctx.root,
    x,
    top - scroll,
    panelWidth,
    Math.max(height - top - GPU_LAYOUT.gap, contentBottom + 16 - top),
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );
  ctx.text(ctx.root, snapshot.t('nav.launch'), x + 22, top + 18 - scroll, { size: 18, weight: '700' });
  ctx.text(ctx.root, snapshot.t('launch.help'), x + 22, top + 52 - scroll, {
    size: 11,
    color: GPU_COLORS.muted,
    width: panelWidth - 44,
  });
  if (profile) {
    ctx.text(ctx.root, profile.label, x + 22, top + 92 - scroll, {
      size: 13,
      weight: '700',
      color: GPU_COLORS.primary,
    });
    ctx.text(ctx.root, profile.help, x + 22, top + 122 - scroll, {
      size: 11,
      color: GPU_COLORS.muted,
      width: panelWidth - 44,
    });
    let exampleY = top + 240;
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
    const commandY = Math.min(height - 118, Math.max(top + 430, exampleY + 18));
    ctx.panel(ctx.root, x + 22, commandY - scroll, panelWidth - 150, 68, 0x0b111e);
    ctx.text(ctx.root, command, x + 34, commandY + 12 - scroll, {
      size: 10,
      mono: true,
      width: panelWidth - 180,
    });
    ctx.button(ctx.root, 'launch.copy', 'button', snapshot.t('launch.copy'), x + panelWidth - 114, commandY - scroll, 92, 68, false, snapshot.onActivate);
  }
  ctx.scrollMax.launch = Math.max(0, contentBottom + 12 - height);
}
