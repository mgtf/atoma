import { Container, Graphics, Rectangle } from 'pixi.js';
import type { Ticker } from 'pixi.js';
import { fmtCost } from '../../../client/run-utils.js';
import type { BurninRow } from '../../../client/types.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { gpuFilterButtonWidth } from '../chip-layout.js';
import { quantile, truncate } from '../copy.js';
import { prefersReducedMotion } from '../motion.js';

/**
 * Burn-in view: filters, stat cards, cost scatter chart and the paginated
 * run table. Extracted from gpu-renderer.ts (2026-08-15 decomposition).
 */

const PAGE_SIZE = 50;

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
  ctx.metrics.hitTargets.push({
    id: 'burnin.chart',
    role: 'figure',
    label: snapshot.t('burnin.chartLabel'),
    x,
    y,
    width,
    height,
  });
  for (const point of points) {
    ctx.metrics.hitTargets.push({
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
  if (!payload?.rows.length) {
    ctx.text(ctx.root, snapshot.t('burnin.empty', { path: payload?.csvPath ?? '' }), 20, 78, {
      size: 13,
    });
    return;
  }
  const top = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
  // Layout runs in unscrolled coordinates; every draw subtracts the wheel
  // offset so short windows can actually reach the chart and table
  // (scroll honesty — 2026-08-14 review).
  const scroll = snapshot.state.scrollY.burnin;
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
  let x = GPU_LAYOUT.gap;
  let familyY = top;
  const addFamilyFilter = (id: string, label: string, active: boolean) => {
    const buttonWidth = gpuFilterButtonWidth(label);
    if (x + buttonWidth > width - GPU_LAYOUT.gap && x > GPU_LAYOUT.gap) {
      x = GPU_LAYOUT.gap;
      familyY += 34;
    }
    ctx.filterButton(
      ctx.root,
      id,
      label,
      x,
      familyY - scroll,
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
  let optionX = GPU_LAYOUT.gap;
  let optionY = familyY + 36;
  const addOptionFilter = (id: string, label: string, active: boolean) => {
    const buttonWidth = gpuFilterButtonWidth(label);
    if (optionX + buttonWidth > width - GPU_LAYOUT.gap && optionX > GPU_LAYOUT.gap) {
      optionX = GPU_LAYOUT.gap;
      optionY += 32;
    }
    ctx.filterButton(
      ctx.root,
      id,
      label,
      optionX,
      optionY - scroll,
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
  const statWidth = (width - GPU_LAYOUT.gap * 5) / 4;
  stats.forEach(([label, value], index) => {
    const statX = GPU_LAYOUT.gap + index * (statWidth + GPU_LAYOUT.gap);
    ctx.statCard(
      ctx.root,
      `burnin.stat.${index}`,
      label!,
      value!,
      statX,
      statsY - scroll,
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
    ctx.root,
    GPU_LAYOUT.gap,
    chartY - scroll,
    width - GPU_LAYOUT.gap * 2,
    chartHeight,
    rows
  );

  const tableY = chartY + chartHeight + 10;
  const availableRows = Math.min(PAGE_SIZE, Math.max(1, Math.floor((height - tableY - 40) / 25)));
  const pageCount = Math.max(1, Math.ceil(rows.length / availableRows));
  const page = Math.min(snapshot.state.burninPage, pageCount);
  const pageRows = rows.slice().reverse().slice((page - 1) * availableRows, page * availableRows);
  pageRows.forEach((row, index) => {
    const rowY = tableY + index * 25 - scroll;
    if (index % 2 === 0) {
      ctx.panel(
        ctx.root,
        GPU_LAYOUT.gap,
        rowY,
        width - GPU_LAYOUT.gap * 2,
        24,
        0x0f1725,
        0x0f1725,
        0,
        0
      );
    }
    ctx.text(ctx.root, row.outcome === 'delivered' ? '✓' : '✗', 18, rowY + 4, {
      size: 11,
      color: row.outcome === 'delivered' ? GPU_COLORS.success : GPU_COLORS.error,
    });
    ctx.text(ctx.root, truncate(row.taskId, 60), 40, rowY + 4, { size: 10, width: width * 0.5 });
    ctx.text(ctx.root, `${fmtCost(row.costUsd)} · ${row.durationS ?? '?'}s`, width * 0.58, rowY + 4, {
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
    ctx.text(ctx.root, lifecycle, width * 0.79, rowY + 4, {
      size: 10,
      color: row.compileErrors ? GPU_COLORS.error : GPU_COLORS.muted,
    });
    if (row.trace) {
      ctx.button(ctx.root, `burnin.trace.${row.trace.replace(/\.json$/, '')}`, 'button', '', GPU_LAYOUT.gap, rowY, width - GPU_LAYOUT.gap * 2, 24, false, snapshot.onActivate).alpha = 0.001;
    }
  });
  // Scroll honesty (2026-08-14 review): the wheel handler fails closed to
  // this max, so it must reflect the true content bottom — filters, stats,
  // chart and the current table page — not just what a tall window fits.
  const contentBottom = tableY + pageRows.length * 25;
  ctx.scrollMax.burnin = Math.max(0, contentBottom + 12 - height);
  ctx.text(ctx.root, `${page}/${pageCount}`, width - 110, height - 26, {
    size: 10,
    color: GPU_COLORS.muted,
  });
  if (page > 1) ctx.button(ctx.root, 'burnin.page.prev', 'button', '‹', width - 172, height - 34, 34, 25, false, snapshot.onActivate);
  if (page < pageCount) ctx.button(ctx.root, 'burnin.page.next', 'button', '›', width - 66, height - 34, 34, 25, false, snapshot.onActivate);
}
