import { Container, Graphics, Rectangle } from 'pixi.js';
import type { Ticker } from 'pixi.js';
import { fmtCost } from '../../../client/run-utils.js';
import type { BurninRow } from '../../../client/types.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { gpuFilterButtonWidth } from '../chip-layout.js';
import { quantile, truncate } from '../copy.js';
import { prefersReducedMotion } from '../motion.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_PAD } from '../view-frame.js';

/**
 * Burn-in view: filters, stat cards, cost scatter chart and the paginated
 * run table. Extracted from gpu-renderer.ts (2026-08-15 decomposition).
 */

const PAGE_SIZE = 50;

/**
 * Viewport pixels reserved below the scroll pane for the pager. The SAME
 * constant bounds `availableRows`, so an unscrolled full page always fits
 * above the pager — pagination math stays scroll-free by construction.
 */
const PAGER_RESERVE = 40;

function drawBurninChart(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  parent: Container,
  x: number,
  y: number,
  width: number,
  height: number,
  rows: BurninRow[]
) {
  const firstAppearance = !prefersReducedMotion() && !ctx.seenAnimatedControls.has('burnin.chart');
  ctx.seenAnimatedControls.add('burnin.chart');
  const chart = new Container();
  chart.position.set(x, y);
  chart.eventMode = 'static';
  chart.cursor = 'crosshair';
  chart.hitArea = new Rectangle(0, 0, width, height);

  const frame = new Graphics();
  frame.roundRect(0, 0, width, height, 8);
  frame.fill({ color: 0x0d1626, alpha: 0.9 });
  frame.stroke({ color: 0x263a5a, width: 1.1, alpha: 0.9 });
  chart.addChild(frame);

  const grid = new Graphics();
  for (let index = 1; index < 6; index++) {
    const gx = 28 + index / 6 * (width - 48);
    grid.moveTo(gx, 14).lineTo(gx, height - 24);
  }
  for (let index = 1; index < 5; index++) {
    const gy = 12 + index / 5 * (height - 38);
    grid.moveTo(28, gy).lineTo(width - 14, gy);
  }
  grid.stroke({ color: 0x4e6d9f, width: 0.6, alpha: 0.16 });
  chart.addChild(grid);

  const timestamps = rows
    .map((row) => Date.parse(row.ts))
    .filter(Number.isFinite);
  const minTime = Math.min(...timestamps);
  const maxTime = Math.max(...timestamps);
  const maxCost = Math.max(0.01, ...rows.map((row) => row.costUsd ?? 0));
  const familyColors: Record<string, number> = {
    app: 0x6ea8ff,
    cli: 0x2dd4bf,
    'cli-trio': 0x22d3ee,
    files: 0xc084fc,
    http: 0xfbbf24,
    web: 0xe879f9,
  };
  const plotWidth = width - 48;
  const plotHeight = height - 42;
  const points = rows.flatMap((row, index) => {
    if (row.costUsd === null) return [];
    const timestamp = Date.parse(row.ts);
    const px =
      28 +
      (Number.isFinite(timestamp) && maxTime > minTime
        ? (timestamp - minTime) / (maxTime - minTime)
        : index / Math.max(1, rows.length - 1)) *
        plotWidth;
    const py = 12 + plotHeight - row.costUsd / maxCost * plotHeight;
    return [{
      row,
      x: px,
      y: py,
      color:
        row.outcome === 'delivered'
          ? familyColors[row.family] ?? GPU_COLORS.success
          : GPU_COLORS.error,
    }];
  });
  ctx.recordHitTarget(parent, {
    id: 'burnin.chart',
    role: 'figure',
    label: snapshot.t('burnin.chartLabel'),
    x,
    y,
    width,
    height,
  });
  for (const point of points) {
    ctx.recordHitTarget(parent, {
      id: `burnin.point.${point.row.taskId}`,
      role: 'graphics-symbol',
      label: point.row.taskId,
      x: x + point.x - 8,
      y: y + point.y - 8,
      width: 16,
      height: 16,
    });
  }

  const pointGraphics = new Graphics();
  for (const point of points) {
    pointGraphics
      .circle(point.x, point.y, point.row.outcome === 'delivered' ? 2.8 : 4.5)
      .fill({ color: point.color, alpha: 0.88 });
  }
  chart.addChild(pointGraphics);

  const sweepTrail = Array.from({ length: 5 }, (_, index) => {
    const line = new Graphics();
    line.rect(0, 12, 1.2 + index * 0.35, plotHeight).fill({
      color: index % 2 ? GPU_COLORS.primary : GPU_COLORS.cyan,
      alpha: 0.14,
    });
    line.alpha = 0.02 + index * 0.015;
    chart.addChild(line);
    return line;
  });

  const highlight = new Graphics();
  highlight.circle(0, 0, 8).stroke({ color: 0xffffff, width: 1.4, alpha: 0.9 });
  highlight.circle(0, 0, 4).fill(0xffffff);
  highlight.alpha = 0;
  chart.addChild(highlight);

  const tooltip = new Container();
  const tooltipBg = new Graphics();
  tooltipBg.roundRect(0, 0, 210, 54, 7);
  tooltipBg.fill({ color: 0x080e19, alpha: 0.96 });
  tooltipBg.stroke({ color: GPU_COLORS.primary, width: 1.1, alpha: 0.9 });
  tooltip.addChild(tooltipBg);
  const tooltipTitle = ctx.text(tooltip, '', 10, 7, {
    size: 10,
    color: GPU_COLORS.text,
    weight: '700',
  });
  const tooltipMeta = ctx.text(tooltip, '', 10, 28, {
    size: 9,
    color: GPU_COLORS.muted,
  });
  tooltip.alpha = 0;
  chart.addChild(tooltip);

  ctx.text(chart, `$${maxCost.toFixed(2)}`, 5, 8, {
    size: 8,
    color: GPU_COLORS.muted,
  });
  ctx.text(chart, '$0', 10, height - 25, {
    size: 8,
    color: GPU_COLORS.muted,
  });
  if (Number.isFinite(minTime) && Number.isFinite(maxTime)) {
    ctx.text(chart, new Date(minTime).toLocaleDateString(), 28, height - 18, {
      size: 8,
      color: GPU_COLORS.muted,
    });
    const endLabel = ctx.text(
      chart,
      new Date(maxTime).toLocaleDateString(),
      width - 14,
      height - 18,
      { size: 8, color: GPU_COLORS.muted }
    );
    endLabel.anchor.x = 1;
  }

  let hoveredPoint: typeof points[number] | null = null;
  chart.on('pointermove', (event) => {
    const local = event.getLocalPosition(chart);
    let nearest: typeof points[number] | null = null;
    let nearestDistance = 15 * 15;
    for (const point of points) {
      const dx = point.x - local.x;
      const dy = point.y - local.y;
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance) {
        nearest = point;
        nearestDistance = distance;
      }
    }
    hoveredPoint = nearest;
    if (!nearest) {
      tooltip.alpha = 0;
      highlight.alpha = 0;
      return;
    }
    highlight.position.set(nearest.x, nearest.y);
    highlight.tint = nearest.color;
    highlight.alpha = 1;
    tooltipTitle.text = truncate(nearest.row.taskId, 32);
    tooltipMeta.text =
      `${nearest.row.family} · ${fmtCost(nearest.row.costUsd)} · ` +
      `${nearest.row.durationS ?? '?'}s · ${nearest.row.outcome}`;
    tooltip.position.set(
      Math.max(8, Math.min(width - 218, nearest.x + 12)),
      Math.max(8, Math.min(height - 62, nearest.y - 62))
    );
    tooltip.alpha = 1;
  });
  chart.on('pointerout', () => {
    hoveredPoint = null;
    tooltip.alpha = 0;
    highlight.alpha = 0;
  });

  let elapsed = firstAppearance ? 0 : performance.now();
  chart.alpha = firstAppearance ? 0 : 1;
  const animate = (ticker: Ticker) => {
    if (!prefersReducedMotion()) elapsed += ticker.deltaMS;
    const entrance = Math.min(1, elapsed / 420);
    chart.alpha = 1 - (1 - entrance) ** 3;
    const sweep = 28 + (elapsed * 0.055) % Math.max(32, plotWidth);
    sweepTrail.forEach((line, index) => {
      line.x = sweep - index * 7;
      line.alpha = (0.025 + index * 0.016) * (0.55 + Math.sin(elapsed / 230) * 0.25);
    });
    if (hoveredPoint) {
      const pulse = 0.5 + Math.sin(elapsed / 110) * 0.5;
      highlight.scale.set(0.9 + pulse * 0.28);
      highlight.alpha = 0.62 + pulse * 0.38;
    }
  };
  ctx.addTicker(animate);
  parent.addChild(chart);
  return chart;
}

export function drawBurnin(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const payload = snapshot.data.burnin;
  const frame = viewFrame(width, height);
  drawViewFrame(ctx, frame, snapshot.t('nav.burnin'));
  if (!payload?.rows.length) {
    ctx.text(ctx.root, snapshot.t('burnin.empty', { path: payload?.csvPath ?? '' }), frame.innerX, frame.contentTop, {
      size: 13,
      width: frame.innerWidth,
    });
    ctx.scrollMax.burnin = 0;
    return;
  }
  // Everything lays out INSIDE the column frame: `left` is where content
  // starts and `inner` is how wide it may be, replacing the page-edge gap
  // this view used to measure against.
  const top = frame.contentTop;
  const left = VIEW_FRAME_PAD;
  const inner = frame.innerWidth;
  const scroll = snapshot.state.scrollY.burnin;
  // Everything except the pager scrolls inside ONE masked pane: table rows
  // used to slide unmasked under the viewport-anchored pager and over the
  // header (2026-08-15 review residual). Layout keeps its unscrolled screen
  // coordinates; draws go pane-local (screenY - top) and the pane applies the
  // wheel offset, so short windows can still reach the chart and table
  // (scroll honesty — 2026-08-14 review).
  const pane = createScrollPane(ctx.root, {
    x: frame.x,
    y: top,
    width: frame.width,
    height: Math.max(0, frame.bottom - PAGER_RESERVE - top),
    scrollY: scroll,
    bottomPadding: 0,
  });
  const latestTimestamp = Math.max(
    ...payload.rows.map((row) => Date.parse(row.ts)).filter(Number.isFinite)
  );
  const presetDays =
    snapshot.state.burninPreset === 'all' ? null : Number(snapshot.state.burninPreset);
  const rows = payload.rows.filter((row) => {
    if (snapshot.state.burninFamily !== 'all' && row.family !== snapshot.state.burninFamily) return false;
    if (
      snapshot.state.burninOutcome !== 'all' &&
      (snapshot.state.burninOutcome === 'delivered'
        ? row.outcome !== 'delivered'
        : row.outcome === 'delivered')
    ) return false;
    if (
      presetDays !== null &&
      Number.isFinite(latestTimestamp) &&
      Date.parse(row.ts) < latestTimestamp - presetDays * 86_400_000
    ) return false;
    return true;
  });
  const families = [...new Set(payload.rows.map((row) => row.family))].sort();
  let x = left;
  let familyY = top;
  const addFamilyFilter = (id: string, label: string, active: boolean) => {
    const buttonWidth = gpuFilterButtonWidth(label);
    if (x + buttonWidth > left + inner && x > left) {
      x = left;
      familyY += 34;
    }
    ctx.filterButton(
      pane.content,
      id,
      label,
      x,
      familyY - top,
      buttonWidth,
      30,
      active,
      snapshot.onActivate
    );
    x += buttonWidth + 6;
  };
  addFamilyFilter('burnin.family.all', snapshot.t('burnin.all'), snapshot.state.burninFamily === 'all');
  for (const family of families.slice(0, 7)) {
    addFamilyFilter(`burnin.family.${family}`, family, snapshot.state.burninFamily === family);
  }
  let optionX = left;
  let optionY = familyY + 36;
  const addOptionFilter = (id: string, label: string, active: boolean) => {
    const buttonWidth = gpuFilterButtonWidth(label);
    if (optionX + buttonWidth > left + inner && optionX > left) {
      optionX = left;
      optionY += 32;
    }
    ctx.filterButton(
      pane.content,
      id,
      label,
      optionX,
      optionY - top,
      buttonWidth,
      28,
      active,
      snapshot.onActivate
    );
    optionX += buttonWidth + 6;
  };
  for (const outcome of ['all', 'delivered', 'failed']) {
    const label =
      outcome === 'all'
        ? snapshot.t('burnin.all')
        : outcome === 'delivered'
          ? snapshot.t('burnin.deliveredOnly')
          : snapshot.t('burnin.failedOnly');
    addOptionFilter(
      `burnin.outcome.${outcome}`,
      label,
      snapshot.state.burninOutcome === outcome
    );
  }
  optionX += 10;
  for (const preset of ['all', '1', '7', '30']) {
    const label =
      preset === 'all'
        ? snapshot.t('burnin.allTime')
        : preset === '1'
          ? snapshot.t('burnin.last24h')
          : preset === '7'
            ? snapshot.t('burnin.last7d')
            : snapshot.t('burnin.last30d');
    addOptionFilter(
      `burnin.preset.${preset}`,
      label,
      snapshot.state.burninPreset === preset
    );
  }
  const delivered = rows.filter((row) => row.outcome === 'delivered').length;
  const costs = rows.flatMap((row) => row.costUsd === null ? [] : [row.costUsd]);
  const durations = rows.flatMap((row) => row.durationS === null ? [] : [row.durationS]);
  const stats = [
    [snapshot.t('burnin.runsSelected'), String(rows.length)],
    [snapshot.t('burnin.deliveryRate'), `${Math.round(delivered / Math.max(1, rows.length) * 100)}%`],
    [snapshot.t('burnin.medianCost'), fmtCost(quantile(costs, 0.5))],
    [snapshot.t('burnin.p90Duration'), `${quantile(durations, 0.9) ?? '—'}s`],
  ];
  const burninStatAccents = [
    GPU_COLORS.primary,
    GPU_COLORS.success,
    GPU_COLORS.cyan,
    GPU_COLORS.warning,
  ];
  const statsY = optionY + 38;
  const statWidth = (inner - GPU_LAYOUT.gap * 3) / 4;
  stats.forEach(([label, value], index) => {
    const statX = left + index * (statWidth + GPU_LAYOUT.gap);
    ctx.statCard(
      pane.content,
      `burnin.stat.${index}`,
      label!,
      value!,
      statX,
      statsY - top,
      statWidth,
      58,
      burninStatAccents[index] ?? GPU_COLORS.primary
    );
  });
  const chartY = statsY + 68;
  const chartHeight = Math.min(280, height * 0.34);
  drawBurninChart(
    ctx,
    snapshot,
    pane.content,
    left,
    chartY - top,
    inner,
    chartHeight,
    rows
  );

  const tableY = chartY + chartHeight + 10;
  const availableRows = Math.min(
    PAGE_SIZE,
    Math.max(1, Math.floor((frame.bottom - tableY - PAGER_RESERVE) / 25))
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / availableRows));
  const page = Math.min(snapshot.state.burninPage, pageCount);
  const pageRows = rows.slice().reverse().slice((page - 1) * availableRows, page * availableRows);
  pageRows.forEach((row, index) => {
    const rowY = tableY + index * 25 - top;
    if (index % 2 === 0) {
      ctx.panel(
        pane.content,
        left,
        rowY,
        inner,
        24,
        0x0f1725,
        0x0f1725,
        0,
        0
      );
    }
    ctx.text(pane.content, row.outcome === 'delivered' ? '✓' : '✗', left + 8, rowY + 4, {
      size: 11,
      color: row.outcome === 'delivered' ? GPU_COLORS.success : GPU_COLORS.error,
    });
    ctx.text(pane.content, truncate(row.taskId, 60), left + 30, rowY + 4, { size: 10, width: inner * 0.5 });
    ctx.text(pane.content, `${fmtCost(row.costUsd)} · ${row.durationS ?? '?'}s`, left + inner * 0.58, rowY + 4, {
      size: 10,
      color: GPU_COLORS.muted,
    });
    const lifecycle = [
      row.deterministicPhases ? `⚡${row.deterministicPhases}` : '',
      row.refusals ? `⛔${row.refusals}` : '',
      row.compileErrors ? `⚠${row.compileErrors}` : '',
      row.demotions ? `🛡${row.demotions}` : '',
      row.dispatchFallbacks ? `↩${row.dispatchFallbacks}` : '',
    ].filter(Boolean).join(' ');
    ctx.text(pane.content, lifecycle, left + inner * 0.79, rowY + 4, {
      size: 10,
      color: row.compileErrors ? GPU_COLORS.error : GPU_COLORS.muted,
    });
    if (row.trace) {
      ctx.button(pane.content, `burnin.trace.${row.trace.replace(/\.json$/, '')}`, 'button', '', left, rowY, inner, 24, false, snapshot.onActivate).alpha = 0.001;
    }
  });
  // Scroll honesty (2026-08-14 review): the wheel handler fails closed to
  // this max, so it must reflect the true content bottom — filters, stats,
  // chart and the current table page — not just what the pane viewport fits.
  pane.extend(tableY + pageRows.length * 25 - top);
  ctx.scrollMax.burnin = pane.finish();
  // The pager stays outside the pane, anchored to viewport coordinates in the
  // PAGER_RESERVE strip the mask never covers.
  ctx.text(ctx.root, `${page}/${pageCount}`, width - 110, height - 26, {
    size: 10,
    color: GPU_COLORS.muted,
  });
  if (page > 1) ctx.button(ctx.root, 'burnin.page.prev', 'button', '‹', width - 172, height - 34, 34, 25, false, snapshot.onActivate);
  if (page < pageCount) ctx.button(ctx.root, 'burnin.page.next', 'button', '›', width - 66, height - 34, 34, 25, false, snapshot.onActivate);
}
