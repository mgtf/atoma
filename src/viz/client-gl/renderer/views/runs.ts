import { Container, Graphics, Rectangle } from 'pixi.js';
import {
  buildAtomMap,
  coerceEventFilters,
  fmtCost,
  fmtMs,
  isRunLive,
  tryParseJson,
  visibleEventKindFilters,
} from '../../../client/run-utils.js';
import {
  buildTimelineLayout,
  timelineBranchHeading,
} from '../../../client/timeline-layout.js';
import {
  buildSkillEventDetail,
  buildStructuredDetail,
  eventRoleLabel,
  filePathFromArgs,
  skillEventSubtitle,
  skillEventTitle,
  type StructuredDetailNode,
} from '../../../client/structured-detail.js';
import type { VizEvent, VizRun } from '../../../client/types.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import {
  FILTER_BLOCK_GAP,
  layoutAtomLaneBlocks,
  layoutFilterChipBlock,
  layoutRunFilterBlocks,
} from '../chip-layout.js';
import {
  detailToneColor,
  eventAccent,
  gpuEventCardCopy,
  nowDescription,
  scalar,
  timelineBranchColor,
  timelineBranchLabel,
  truncate,
} from '../copy.js';
import { drawAtomDetail } from './atom-detail.js';
import { gpuCardShaderMode } from '../shaders.js';

/**
 * Runs view: causal branch timeline on the left, summary + event/atom detail
 * on the right. Extracted from GpuRenderer; the timeline keeps its bespoke
 * viewport math (windowed rows over `scrollMax.runs`) and its own list mask —
 * it is deliberately NOT a scroll pane.
 */
export function drawRuns(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const run = snapshot.data.run;
  if (!run) {
    ctx.text(ctx.root, snapshot.t('runs.none'), 18, 76, { size: 14 });
    return;
  }
  const top = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
  const twoPane = width >= 1050;
  const rightWidth = twoPane ? Math.min(GPU_LAYOUT.rightWidth, width * 0.4) : 0;
  const leftWidth = width - rightWidth - GPU_LAYOUT.gap * (twoPane ? 3 : 2);
  const leftX = GPU_LAYOUT.gap;
  const rightX = leftX + leftWidth + GPU_LAYOUT.gap;

  ctx.panel(
    ctx.root,
    leftX,
    top,
    leftWidth,
    height - top - GPU_LAYOUT.gap,
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );
  ctx.text(ctx.root, truncate(run.label, 95), leftX + 14, top + 12, {
    size: 14,
    weight: '700',
    width: leftWidth - 28,
  });
  ctx.text(ctx.root, truncate(run.task?.description ?? '', 180), leftX + 14, top + 34, {
    size: 11,
    color: GPU_COLORS.muted,
    width: leftWidth - 28,
  });
  if (isRunLive(run)) {
    ctx.text(ctx.root, snapshot.t('runs.flag.live'), leftX + leftWidth - 72, top + 12, {
      size: 11,
      color: GPU_COLORS.success,
      weight: '700',
    });
  }

  const statsY = top + 76;
  const stats = [
    [snapshot.t('summary.duration'), fmtMs(run.durationMs)],
    [snapshot.t('summary.llmCalls'), scalar(run.totals?.calls, '0')],
    [snapshot.t('summary.tokens'), `${run.totals?.inputTokens ?? 0}/${run.totals?.outputTokens ?? 0}`],
    [snapshot.t('summary.cost'), fmtCost(run.totals?.costUsd)],
  ];
  const statAccents = [
    GPU_COLORS.cyan,
    GPU_COLORS.tiers[3],
    GPU_COLORS.primary,
    GPU_COLORS.success,
  ];
  const statWidth = (leftWidth - 28 - GPU_LAYOUT.gap * 3) / 4;
  stats.forEach(([label, value], index) => {
    const x = leftX + 14 + index * (statWidth + GPU_LAYOUT.gap);
    ctx.statCard(
      ctx.root,
      `runs.stat.${index}`,
      label!,
      value!,
      x,
      statsY,
      statWidth,
      55,
      statAccents[index] ?? GPU_COLORS.primary
    );
  });

  const atoms = buildAtomMap(run);
  const atomLayout = layoutAtomLaneBlocks({
    originX: leftX + 14,
    originY: statsY + 55 + FILTER_BLOCK_GAP,
    maxWidth: leftWidth - 28,
    lanes: ([3, 2, 1] as const).flatMap((tier) => {
      const entries = [...atoms.values()].filter((value) => value.snapshot.tier === tier);
      if (!entries.length) return [];
      return [{
        tier,
        label: snapshot.t(`lanes.l${tier}`),
        names: entries.map((entry) => entry.snapshot.name),
      }];
    }),
  });
  for (const lane of atomLayout.lanes) {
    ctx.filterBlockFrame(ctx.root, lane);
    ctx.text(ctx.root, lane.label, lane.labelX, lane.labelY, {
      size: 10,
      color: GPU_COLORS.tiers[lane.tier],
      weight: '700',
    });
    for (const chip of lane.chips) {
      ctx.atomButton(
        ctx.root,
        chip.id,
        chip.label,
        lane.tier,
        chip.x,
        chip.y,
        chip.width,
        chip.height,
        snapshot.state.selectedAtomName === chip.label,
        snapshot.onActivate
      );
    }
  }

  const filterY = atomLayout.bottom + FILTER_BLOCK_GAP;
  const runFilters = coerceEventFilters(run.events, snapshot.state.runFilters);
  const kinds = visibleEventKindFilters(run.events);
  const rolesVisible =
    runFilters.kind === 'all' ||
    runFilters.kind === 'llm';
  const roleNames = rolesVisible
    ? [...new Set(run.events.flatMap((event) => event.role ? [event.role] : []))]
    : [];
  const filterLayout = layoutRunFilterBlocks({
    originX: leftX + 14,
    originY: filterY,
    maxWidth: leftWidth - 28,
    kinds: kinds.map((kind) => ({
      id: `run.filter.kind.${kind}`,
      label: kind === 'tool' ? snapshot.t('filters.tools').toUpperCase() : kind.toUpperCase(),
    })),
    roles: roleNames.length
      ? ['all', ...roleNames].map((role) => ({
          id: `run.filter.role.${role}`,
          label: role === 'all' ? snapshot.t('filters.allRoles').toUpperCase() : role.toUpperCase(),
        }))
      : null,
  });
  ctx.filterBlockFrame(ctx.root, filterLayout.kinds);
  for (const chip of filterLayout.kinds.chips) {
    ctx.filterButton(
      ctx.root,
      chip.id,
      chip.label,
      chip.x,
      chip.y,
      chip.width,
      chip.height,
      runFilters.kind === chip.id.slice('run.filter.kind.'.length),
      snapshot.onActivate
    );
  }
  if (filterLayout.roles) {
    ctx.filterBlockFrame(ctx.root, filterLayout.roles);
    for (const chip of filterLayout.roles.chips) {
      ctx.filterButton(
        ctx.root,
        chip.id,
        chip.label,
        chip.x,
        chip.y,
        chip.width,
        chip.height,
        runFilters.role === chip.id.slice('run.filter.role.'.length),
        snapshot.onActivate
      );
    }
  }

  const controlsBottomWithoutRoles = filterLayout.kinds.y + filterLayout.kinds.height + FILTER_BLOCK_GAP;
  let controlsBottom = filterLayout.bottom + FILTER_BLOCK_GAP;
  const roleWasVisible = [...ctx.previousFilterBounds.keys()].some((id) =>
    id.startsWith('run.filter.role.')
  );
  const exitingRoleFilters = !rolesVisible
    ? [...ctx.previousFilterBounds.values()].filter((target) =>
        target.id.startsWith('run.filter.role.')
      )
    : [];
  const enterDistance = Math.max(0, controlsBottom - controlsBottomWithoutRoles);
  if (rolesVisible) {
    if (ctx.roleRowTransition?.phase === 'exit') ctx.roleRowTransition = null;
    if (enterDistance > 0 && !roleWasVisible && ctx.roleRowTransition?.phase !== 'enter') {
      ctx.roleRowTransition = {
        phase: 'enter',
        targets: [],
        distance: enterDistance,
        startedAt: performance.now(),
      };
    }
  } else if (exitingRoleFilters.length && ctx.roleRowTransition?.phase !== 'exit') {
    const previousRoleBottom = Math.max(
      ...exitingRoleFilters.map((target) => target.y + target.height + 4)
    );
    ctx.roleRowTransition = {
      phase: 'exit',
      targets: exitingRoleFilters,
      distance: Math.max(0, previousRoleBottom - controlsBottom),
      startedAt: performance.now(),
    };
  } else if (ctx.roleRowTransition?.phase === 'enter') {
    ctx.roleRowTransition = null;
  }
  const lowerControlsLayer = new Container();
  ctx.root.addChild(lowerControlsLayer);
  const roleRowTransition = ctx.roleRowTransition;
  if (roleRowTransition?.phase === 'exit') {
    ctx.drawExitingFilterButtons(
      roleRowTransition.targets,
      lowerControlsLayer,
      roleRowTransition.distance,
      roleRowTransition.startedAt
    );
  } else if (roleRowTransition?.phase === 'enter') {
    ctx.animateEnteringFilterSpace(
      lowerControlsLayer,
      roleRowTransition.distance,
      roleRowTransition.startedAt
    );
  }
  const branchOverview = buildTimelineLayout(run.events, {
    ...runFilters,
    branchId: 'all',
  });
  const overviewById = new Map(
    branchOverview.branches.map((branch) => [branch.id, branch])
  );
  const branchIds = branchOverview.branches.map((branch) => branch.id);
  const shownBranchIds = branchIds.slice(0, 6);
  if (
    runFilters.branchId !== 'all' &&
    !shownBranchIds.includes(runFilters.branchId)
  ) {
    shownBranchIds.push(runFilters.branchId);
  }
  if (branchIds.length > 1) {
    const branchBlock = layoutFilterChipBlock(
      leftX + 14,
      controlsBottom,
      leftWidth - 28,
      ['all', ...shownBranchIds].map((branchId) => {
        const branch = overviewById.get(branchId);
        return {
          id: `run.filter.branch.${branchId}`,
          label:
            branchId === 'all'
              ? snapshot.t('timeline.allBranches').toUpperCase()
              : branch
                ? timelineBranchLabel(branch, snapshot.t).toUpperCase()
                : `⑂ ${branchId.slice(0, 6)}`,
        };
      })
    );
    ctx.filterBlockFrame(lowerControlsLayer, branchBlock);
    for (const chip of branchBlock.chips) {
      ctx.filterButton(
        lowerControlsLayer,
        chip.id,
        chip.label,
        chip.x,
        chip.y,
        chip.width,
        chip.height,
        runFilters.branchId === chip.id.slice('run.filter.branch.'.length),
        snapshot.onActivate
      );
    }
    controlsBottom = branchBlock.y + branchBlock.height + FILTER_BLOCK_GAP;
  }

  const completed = new Set(run.events.filter((event) => event.kind === 'llm').map((event) => event.id));
  const inFlight = run.events.filter(
    (event) =>
      event.kind === 'llm-start' &&
      typeof event.llmEventId === 'string' &&
      !completed.has(event.llmEventId)
  );
  if (isRunLive(run) && inFlight.length) {
    const liveY = controlsBottom + 5;
    ctx.panel(lowerControlsLayer, leftX + 14, liveY, leftWidth - 28, 52, 0x10263b, GPU_COLORS.cyan);
    const current = inFlight.at(-1)!;
    const tools = run.events.filter(
      (event) => event.kind === 'tool' && event.llmEventId === current.llmEventId
    );
    ctx.text(
      lowerControlsLayer,
      `${snapshot.t('now.title')} · ${(current.role ?? 'LLM').toUpperCase()} · ${current.actor?.name ?? '?'} · ${snapshot.t('now.elementCount', { count: tools.length })}`,
      leftX + 24,
      liveY + 11,
      { size: 10, color: GPU_COLORS.cyan, weight: '700' }
    );
    ctx.text(
      lowerControlsLayer,
      truncate(nowDescription(snapshot.t, current), 130),
      leftX + 24,
      liveY + 29,
      { size: 9, color: GPU_COLORS.muted, width: leftWidth - 48 }
    );
    controlsBottom = liveY + 57;
  }

  if (runFilters.branchId !== 'all') {
    const selectedBranch = overviewById.get(runFilters.branchId);
    const heading = selectedBranch
      ? timelineBranchHeading(selectedBranch, snapshot.t)
      : {
          eyebrow: snapshot.t('filters.branch', { id: runFilters.branchId.slice(0, 8) }),
          title: snapshot.t('filters.branch', { id: runFilters.branchId.slice(0, 8) }),
          lines: [] as const,
        };
    const expanded = snapshot.state.branchHeadingExpanded;
    const visibleLines = expanded ? heading.lines : [];
    const accent = selectedBranch ? timelineBranchColor(selectedBranch) : GPU_COLORS.primary;
    const blockX = leftX + 14;
    const blockWidth = leftWidth - 28;
    const padX = 14;
    const padY = 10;
    const innerWidth = blockWidth - padX * 2 - 36;
    const block = new Container();
    let cursor = padY;
    const eyebrow = ctx.text(block, heading.eyebrow.toUpperCase(), padX, cursor, {
      size: 10,
      weight: '700',
      color: accent,
    });
    ctx.collapseCaret(block, blockWidth - padX, cursor + 1, expanded, accent);
    cursor += eyebrow.height + 5;
    const title = ctx.text(block, heading.title, padX, cursor, {
      size: 14,
      weight: '700',
      color: GPU_COLORS.text,
      width: innerWidth,
    });
    cursor += title.height;
    if (visibleLines.length) cursor += 8;
    for (const line of visibleLines) {
      const row = ctx.text(block, `·  ${line}`, padX, cursor, {
        size: 11,
        color: GPU_COLORS.muted,
        width: innerWidth,
      });
      cursor += row.height + 3;
    }
    cursor += padY - 2;
    ctx.panel(
      lowerControlsLayer,
      blockX,
      controlsBottom,
      blockWidth,
      cursor,
      GPU_COLORS.panelRaised,
      accent
    );
    block.eventMode = 'static';
    block.cursor = 'pointer';
    block.hitArea = new Rectangle(0, 0, blockWidth, cursor);
    block.on('pointertap', () => snapshot.onActivate('branch.heading.toggle'));
    block.position.set(blockX, controlsBottom);
    lowerControlsLayer.addChild(block);
    ctx.metrics.hitTargets.push({
      id: 'branch.heading.toggle',
      role: 'button',
      label: snapshot.t(expanded ? 'timeline.collapse' : 'timeline.expand'),
      x: blockX,
      y: controlsBottom,
      width: blockWidth,
      height: cursor,
    });
    controlsBottom += cursor + FILTER_BLOCK_GAP;
  }

  const listY = controlsBottom + 7;
  const listHeight = height - listY - GPU_LAYOUT.gap;
  const listMask = new Graphics();
  // Card filters have 12px shader padding and hover-scale around center.
  // Keep vertical clipping strict (no overlap with filters) but use the full
  // pane width so right-side glow/scale is not guillotined.
  listMask.rect(leftX + 1, listY, leftWidth - 2, listHeight).fill(0xffffff);
  listMask.eventMode = 'none';
  lowerControlsLayer.addChild(listMask);
  const listLayer = new Container();
  listLayer.eventMode = 'static';
  listLayer.interactiveChildren = true;
  listLayer.hitArea = new Rectangle(leftX + 1, listY, leftWidth - 2, listHeight);
  listLayer.mask = listMask;
  lowerControlsLayer.addChild(listLayer);
  const timeline = buildTimelineLayout(run.events, runFilters);
  const rowHeight = timeline.rowHeight;
  const contentTopPadding = 18;
  const contentBottomPadding = 20;
  const cardRightPadding = 24;
  ctx.scrollMax.runs = Math.max(
    0,
    timeline.totalHeight +
      contentTopPadding +
      contentBottomPadding -
      listHeight
  );
  const scrollY = Math.min(
    snapshot.state.scrollY.runs,
    ctx.scrollMax.runs
  );
  const start = Math.max(
    0,
    Math.floor(Math.max(0, scrollY - contentTopPadding) / rowHeight)
  );
  const count = Math.ceil(listHeight / rowHeight) + 2;
  const laneSpacing =
    timeline.maxLane > 0
      ? Math.min(22, 96 / timeline.maxLane)
      : 22;
  const railInset = 28;
  const labelGutter = 46;
  const branchCardOffset = 10;
  const railX = (lane: number) => leftX + railInset + lane * laneSpacing;
  const cardBaseX = railX(timeline.maxLane) + labelGutter;
  const cardBaseWidth = Math.min(
    520,
    leftX + leftWidth - cardRightPadding - cardBaseX
  );
  const rowCenterY = (row: number) =>
    listY +
    contentTopPadding +
    row * rowHeight -
    scrollY +
    (rowHeight - 10) / 2;
  ctx.metrics.timelineViewport = {
    left: leftX,
    top: listY,
    width: leftWidth,
    height: listHeight,
    railBaseX: railX(0),
    laneSpacing,
    cardBaseX,
    cardBaseWidth,
    branchCardOffset,
    contentTopPadding,
    contentBottomPadding,
    rowHeight,
    totalHeight:
      timeline.totalHeight + contentTopPadding + contentBottomPadding,
    scrollY,
  };
  if (timeline.items.length === 0) {
    ctx.text(listLayer, snapshot.t('filters.noMatch'), leftX + 24, listY + 22, {
      size: 11,
      color: GPU_COLORS.muted,
      width: leftWidth - 48,
    });
  }
  const graph = new Graphics();
  if (timeline.items.length > 0) {
    graph
      .moveTo(railX(0), rowCenterY(0))
      .lineTo(railX(0), rowCenterY(timeline.items.length - 1));
    graph.stroke({ color: GPU_COLORS.primary, width: 2.2, alpha: 0.42 });
  }
  for (const branch of timeline.branches) {
    const color = timelineBranchColor(branch);
    graph
      .moveTo(railX(branch.lane), rowCenterY(branch.firstRow))
      .lineTo(railX(branch.lane), rowCenterY(branch.lastRow));
    graph.stroke({ color, width: 2.4, alpha: 0.72 });
  }
  for (const connector of timeline.connectors) {
    const branch = timeline.branches.find(
      (candidate) => candidate.id === connector.branchId
    );
    const color = branch ? timelineBranchColor(branch) : GPU_COLORS.primary;
    const fromX = railX(connector.fromLane);
    const toX = railX(connector.toLane);
    const connectorY = rowCenterY(connector.row);
    const bend = Math.max(5, Math.abs(toX - fromX) * 0.45);
    graph.moveTo(fromX, connectorY);
    graph.bezierCurveTo(
      fromX + Math.sign(toX - fromX) * bend,
      connectorY,
      toX - Math.sign(toX - fromX) * bend,
      connectorY,
      toX,
      connectorY
    );
    graph.stroke({
      color,
      width: connector.kind === 'fork' ? 1.8 : 1.2,
      alpha: connector.kind === 'fork' ? 0.78 : 0.48,
    });
  }
  for (const item of timeline.items.slice(start, start + count)) {
    const branch = item.branchId
      ? timeline.branches.find((candidate) => candidate.id === item.branchId)
      : undefined;
    graph
      .circle(railX(item.lane), rowCenterY(item.row), item.branchStart ? 4 : 2.4);
    graph.fill({
      color: branch ? timelineBranchColor(branch) : GPU_COLORS.primary,
      alpha: item.branchStart || item.branchEnd ? 0.95 : 0.62,
    });
  }
  listLayer.addChild(graph);

  if (timeline.items.length > 0) {
    const startY = rowCenterY(0);
    const endY = rowCenterY(timeline.items.length - 1);
    if (startY >= listY - 20 && startY <= listY + listHeight + 20) {
      ctx.text(listLayer, snapshot.t('timeline.start').toUpperCase(), railX(0) + 7, startY - 7, {
        size: 8,
        color: GPU_COLORS.primary,
        weight: '700',
      });
    }
    if (endY >= listY - 20 && endY <= listY + listHeight + 20) {
      ctx.text(listLayer, snapshot.t('timeline.end').toUpperCase(), railX(0) + 7, endY - 7, {
        size: 8,
        color: GPU_COLORS.primary,
        weight: '700',
      });
    }
  }

  timeline.items.slice(start, start + count).forEach((item) => {
    const event = item.event;
    const y =
      listY +
      contentTopPadding +
      item.row * rowHeight -
      scrollY;
    if (y > listY + listHeight || y + rowHeight < listY) return;
    const selected = snapshot.state.selectedEventId === event.id;
    const branch = item.branchId
      ? timeline.branches.find((candidate) => candidate.id === item.branchId)
      : undefined;
    const branchOffset = item.lane * branchCardOffset;
    const cardX = cardBaseX + branchOffset;
    const cardWidth = cardBaseWidth - branchOffset;
    const cardHeight = rowHeight - 10;
    const tierDepth = item.tier === 3 ? 0.9 : item.tier === 2 ? 0.58 : item.tier === 1 ? 0.3 : 0.12;
    const zDepth = Math.min(1, tierDepth + item.lane * 0.08);
    const cardContent = ctx.eventCard(
      listLayer,
      event.id,
      cardX,
      y,
      cardWidth,
      cardHeight,
      eventAccent(event),
      gpuCardShaderMode(event),
      selected,
      snapshot.onActivate,
      zDepth
    );
    const copy = gpuEventCardCopy(event, snapshot.t);
    ctx.text(cardContent, truncate(copy.title, 28), 11, 6, {
      size: 11,
      weight: '700',
      color: eventAccent(event),
    });
    const rawMeta = copy.meta.replace(/(?: · )?⑂ [^ ·]+/g, '').trim();
    const actor = rawMeta.split(' · ')[0] ?? '';
    if (actor) {
      ctx.text(cardContent, truncate(actor, 28), 118, 7, {
        size: 9,
        color: GPU_COLORS.muted,
        width: Math.max(80, cardWidth - 250),
      });
    }
    if (copy.decision) {
      ctx.text(cardContent, copy.decision, cardWidth - 118, 6, {
        size: 10,
        color: copy.decision.startsWith('✕') || copy.decision.startsWith('↑')
          ? GPU_COLORS.warning
          : GPU_COLORS.success,
        weight: '700',
      });
    }
    const detail = [copy.body, copy.footer].filter(Boolean).join(' · ');
    ctx.text(cardContent, truncate(detail, 160), 11, 28, {
      size: 9,
      color: event.error ? GPU_COLORS.error : GPU_COLORS.muted,
      width: cardWidth - 22,
    });
    if (item.branchStart && branch) {
      ctx.text(
        listLayer,
        branch.parallel
          ? `B${branch.path.join('.')}`
          : `P${branch.path.join('.')}`,
        railX(branch.lane) + 6,
        y + 4,
        {
          size: 8,
          color: timelineBranchColor(branch),
          weight: '700',
        }
      );
    }
  });

  if (twoPane) {
    ctx.panel(
      ctx.root,
      rightX,
      top,
      rightWidth,
      height - top - GPU_LAYOUT.gap,
      GPU_COLORS.panel,
      GPU_COLORS.border,
      GPU_LAYOUT.radius,
      2
    );
    const summaryHeight = drawRunSummaryCard(
      ctx,
      snapshot,
      run,
      rightX,
      top,
      rightWidth
    );
    const detailTop = top + summaryHeight;
    const event = run.events.find((value) => value.id === snapshot.state.selectedEventId);
    const atom = snapshot.state.selectedAtomName
      ? atoms.get(snapshot.state.selectedAtomName)
      : undefined;
    if (event) {
      drawEventDetail(
        ctx,
        snapshot,
        event,
        rightX,
        detailTop,
        rightWidth,
        height - detailTop
      );
    } else if (atom) {
      drawAtomDetail(
        ctx,
        snapshot,
        atom.snapshot,
        rightX,
        detailTop,
        rightWidth,
        height - detailTop
      );
    } else if (!snapshot.state.runSummaryExpanded) {
      ctx.text(ctx.root, snapshot.t('pane.selectEvent'), rightX + 18, detailTop + 12, {
        size: 12,
        color: GPU_COLORS.muted,
        width: rightWidth - 36,
      });
    }
  }
}

function drawRunSummaryCard(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  run: VizRun,
  x: number,
  y: number,
  width: number
): number {
  const expanded = snapshot.state.runSummaryExpanded;
  const padX = 16;
  const cardWidth = width - 20;
  const innerWidth = cardWidth - padX * 2;
  const block = new Container();
  let cursor = 12;
  ctx.text(block, snapshot.t('run.summary').toUpperCase(), padX, cursor, {
    size: 10,
    weight: '700',
    color: GPU_COLORS.cyan,
  });
  ctx.collapseCaret(block, cardWidth - padX, cursor + 1, expanded, GPU_COLORS.cyan);
  cursor += 18;
  const title = ctx.text(block, truncate(run.label, 90), padX, cursor, {
    size: 13,
    weight: '700',
    color: GPU_COLORS.text,
    width: innerWidth - 8,
  });
  cursor += title.height + 6;
  const facts = [
    fmtMs(run.durationMs),
    snapshot.t('runs.calls', { count: run.totals?.calls ?? 0 }),
    fmtCost(run.totals?.costUsd),
  ].filter(Boolean).join('  ·  ');
  ctx.text(block, facts, padX, cursor, {
    size: 10,
    color: GPU_COLORS.muted,
  });
  cursor += 18;
  const goal = run.task?.description ?? '';
  if (goal) {
    ctx.text(block, snapshot.t('run.goal').toUpperCase(), padX, cursor, {
      size: 9,
      weight: '700',
      color: GPU_COLORS.muted,
    });
    cursor += 16;
    const goalText = ctx.text(
      block,
      expanded ? goal : truncate(goal, 140),
      padX,
      cursor,
      {
        size: 11,
        color: GPU_COLORS.text,
        width: innerWidth,
      }
    );
    cursor += goalText.height + 10;
  } else {
    cursor += 8;
  }
  ctx.panel(
    ctx.root,
    x + 10,
    y + 10,
    width - 20,
    cursor,
    GPU_COLORS.panelRaised,
    GPU_COLORS.cyan
  );
  block.eventMode = 'static';
  block.cursor = 'pointer';
  block.hitArea = new Rectangle(0, 0, width - 20, cursor);
  block.on('pointertap', () => snapshot.onActivate('run.summary.toggle'));
  block.position.set(x + 10, y + 10);
  ctx.root.addChild(block);
  ctx.metrics.hitTargets.push({
    id: 'run.summary.toggle',
    role: 'button',
    label: snapshot.t(expanded ? 'run.collapse' : 'run.expand'),
    x: x + 10,
    y: y + 10,
    width: width - 20,
    height: cursor,
  });
  return cursor + 18;
}

function drawEventDetail(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  event: VizEvent,
  x: number,
  y: number,
  width: number,
  height: number
) {
  if (event.kind === 'skill') {
    const title = ctx.text(ctx.root, skillEventTitle(event, snapshot.t), x + 18, y + 16, {
      size: 15,
      weight: '700',
      color: eventAccent(event),
      width: width - 36,
    });
    const subtitle = ctx.text(ctx.root, skillEventSubtitle(event), x + 18, y + 22 + title.height, {
      size: 10,
      color: GPU_COLORS.muted,
      width: width - 36,
    });
    const skill =
      snapshot.data.skillDetail?.id === event.skillId ? snapshot.data.skillDetail : null;
    const structured = buildSkillEventDetail(event, skill, snapshot.t);
    const detailTop = y + 36 + title.height + subtitle.height;
    const detailBottom = y + height - 62;
    const detailHeight = Math.max(40, detailBottom - detailTop);
    ctx.detailBounds = new Rectangle(x + 12, detailTop - 6, width - 24, detailHeight + 6);
    const detailLayer = new Container();
    detailLayer.position.y = -ctx.detailScrollY;
    ctx.root.addChild(detailLayer);
    const mask = ctx.detailMask(x + 12, detailTop - 6, width - 24, detailHeight + 6);
    detailLayer.mask = mask;
    const contentBottom = drawStructuredDetailNodes(
      ctx,
      detailLayer,
      structured,
      x + 18,
      detailTop,
      width - 42
    );
    ctx.detailScrollMax = Math.max(0, contentBottom - detailBottom + 8);
    ctx.detailScrollY = Math.min(ctx.detailScrollY, ctx.detailScrollMax);
    detailLayer.position.y = -ctx.detailScrollY;
    if (ctx.detailScrollMax > 0) {
      const trackHeight = detailHeight;
      const thumbHeight = Math.max(
        28,
        trackHeight * Math.min(1, detailHeight / (detailHeight + ctx.detailScrollMax))
      );
      const thumbY =
        detailTop +
        (trackHeight - thumbHeight) * (ctx.detailScrollY / ctx.detailScrollMax);
      const scrollbar = new Graphics();
      scrollbar.roundRect(x + width - 8, detailTop, 3, trackHeight, 2);
      scrollbar.fill({ color: GPU_COLORS.border, alpha: 0.55 });
      scrollbar.roundRect(x + width - 8, thumbY, 3, thumbHeight, 2);
      scrollbar.fill({ color: GPU_COLORS.primary, alpha: 0.9 });
      ctx.root.addChild(scrollbar);
    }
    if (event.l1Name && event.skillId) {
      ctx.button(
        ctx.root,
        `skill.open.${event.l1Name}::${event.skillId}`,
        'button',
        snapshot.t('registry.openSkill'),
        x + 18,
        y + height - 55,
        width - 36,
        34,
        false,
        snapshot.onActivate
      );
    }
    return;
  }
  ctx.text(
    ctx.root,
    event.kind === 'llm' ? eventRoleLabel(event.role, snapshot.t) : event.kind,
    x + 18,
    y + 16,
    {
    size: 15,
    weight: '700',
    color: eventAccent(event),
    }
  );
  ctx.text(ctx.root, `${event.actor?.name ?? ''} ${event.model ?? ''}`, x + 18, y + 42, {
    size: 10,
    color: GPU_COLORS.muted,
    width: width - 36,
  });
  if (event.kind === 'cache') {
    ctx.text(ctx.root, snapshot.t('detail.cache.title'), x + 18, y + 72, {
      size: 13,
      color: GPU_COLORS.cyan,
      weight: '700',
      width: width - 36,
    });
    ctx.text(ctx.root, scalar(event.outcome), x + 18, y + 108, {
      size: 12,
      weight: '700',
      width: width - 36,
    });
    ctx.text(ctx.root, event.reasoning ?? '', x + 18, y + 142, {
      size: 10,
      color: GPU_COLORS.muted,
      width: width - 36,
    });
    ctx.text(ctx.root, snapshot.t('detail.cache.explain'), x + 18, y + 220, {
      size: 10,
      color: GPU_COLORS.muted,
      width: width - 36,
    });
    return;
  }
  const raw =
    event.kind === 'llm'
      ? event.response ?? event.error ?? ''
      : event.error ?? event.reasoning ?? '';
  const structured =
    event.kind === 'llm'
      ? tryParseJson(raw)
      : event.kind === 'tool' && !event.error
        ? { args: event.args ?? {}, result: event.result }
        : !event.error
          ? event
          : undefined;
  const detailTop = y + 68;
  const detailBottom = y + height - 14;
  const detailHeight = Math.max(40, detailBottom - detailTop);
  ctx.detailBounds = new Rectangle(x + 12, detailTop - 6, width - 24, detailHeight + 6);
  const detailLayer = new Container();
  detailLayer.position.y = -ctx.detailScrollY;
  ctx.root.addChild(detailLayer);
  const mask = ctx.detailMask(x + 12, detailTop - 6, width - 24, detailHeight + 6);
  detailLayer.mask = mask;
  const contentBottom =
    structured === undefined
      ? detailTop +
        ctx.text(detailLayer, truncate(raw, 8000), x + 18, detailTop, {
          size: 10,
          mono: true,
          color: 0xcbd5e1,
          width: width - 42,
        }).height
      : drawStructuredDetailNodes(
          ctx,
          detailLayer,
          buildStructuredDetail(structured, snapshot.t, {
            markdownPath: event.kind === 'tool' ? filePathFromArgs(event.args) : undefined,
          }),
          x + 18,
          detailTop,
          width - 42
        );
  ctx.detailScrollMax = Math.max(0, contentBottom - detailBottom + 8);
  ctx.detailScrollY = Math.min(ctx.detailScrollY, ctx.detailScrollMax);
  detailLayer.position.y = -ctx.detailScrollY;
  if (ctx.detailScrollMax > 0) {
    const trackHeight = detailHeight;
    const thumbHeight = Math.max(
      28,
      trackHeight * Math.min(1, detailHeight / (detailHeight + ctx.detailScrollMax))
    );
    const thumbY =
      detailTop +
      (trackHeight - thumbHeight) * (ctx.detailScrollY / ctx.detailScrollMax);
    const scrollbar = new Graphics();
    scrollbar.roundRect(x + width - 8, detailTop, 3, trackHeight, 2);
    scrollbar.fill({ color: GPU_COLORS.border, alpha: 0.55 });
    scrollbar.roundRect(x + width - 8, thumbY, 3, thumbHeight, 2);
    scrollbar.fill({ color: GPU_COLORS.primary, alpha: 0.9 });
    ctx.root.addChild(scrollbar);
  }
}

function drawStructuredDetailNodes(
  ctx: RendererCtx,
  parent: Container,
  nodes: readonly StructuredDetailNode[],
  x: number,
  startY: number,
  width: number,
  depth = 0
): number {
  let cursor = startY;
  for (const node of nodes) {
    const inset = depth * 12;
    const nodeX = x + inset;
    const nodeWidth = Math.max(120, width - inset);
    if (node.kind === 'field') {
      const background = new Graphics();
      parent.addChild(background);
      ctx.text(parent, node.label, nodeX + 10, cursor + 7, {
        size: 9,
        color: GPU_COLORS.muted,
        weight: '600',
        width: nodeWidth - 20,
      });
      if (node.presentation === 'badge') {
        const accent = detailToneColor(node.tone);
        const badgeWidth = Math.min(
          nodeWidth - 20,
          Math.max(72, node.value.length * 6.4 + 22)
        );
        const badge = new Graphics();
        badge.roundRect(nodeX + 10, cursor + 25, badgeWidth, 24, 6);
        badge.fill({ color: accent, alpha: node.tone === 'neutral' ? 0.08 : 0.18 });
        badge.stroke({ color: accent, width: 1, alpha: 0.75 });
        parent.addChild(badge);
        ctx.text(parent, node.value, nodeX + 20, cursor + 30, {
          size: 10,
          color: node.tone === 'neutral' ? GPU_COLORS.text : accent,
          weight: '700',
          width: badgeWidth - 18,
        });
        background.roundRect(nodeX, cursor, nodeWidth, 59, 7);
        background.fill({ color: GPU_COLORS.panelRaised, alpha: 0.55 });
        background.stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.65 });
        cursor += 67;
        continue;
      }

      const valueText = ctx.text(
        parent,
        truncate(node.value, 4000),
        nodeX + 10,
        cursor + 25,
        {
          size: 10,
          mono: node.presentation === 'code',
          color: node.tone === 'info' ? GPU_COLORS.cyan : 0xcbd5e1,
          width: nodeWidth - 20,
        }
      );
      const fieldHeight = Math.max(58, valueText.height + 36);
      background.roundRect(nodeX, cursor, nodeWidth, fieldHeight, 7);
      background.fill({ color: GPU_COLORS.panelRaised, alpha: 0.55 });
      background.stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.65 });
      cursor += fieldHeight + 8;
      continue;
    }

    const rail = new Graphics();
    parent.addChild(rail);
    const title = node.count === undefined ? node.label : `${node.label} · ${node.count}`;
    ctx.text(parent, title, nodeX + 10, cursor + 3, {
      size: depth === 0 ? 12 : 10,
      color: depth === 0 ? GPU_COLORS.primary : GPU_COLORS.text,
      weight: '700',
      width: nodeWidth - 20,
    });
    const railTop = cursor + 25;
    cursor += 29;
    cursor = drawStructuredDetailNodes(
      ctx,
      parent,
      node.children,
      x,
      cursor,
      width,
      depth + 1
    );
    rail.moveTo(nodeX + 2, railTop).lineTo(nodeX + 2, Math.max(railTop, cursor - 7));
    rail.stroke({
      color: depth === 0 ? GPU_COLORS.primary : GPU_COLORS.border,
      width: depth === 0 ? 2 : 1,
      alpha: 0.65,
    });
    cursor += 5;
  }
  return cursor;
}

