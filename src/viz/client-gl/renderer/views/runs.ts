import { Container, Graphics, Rectangle } from 'pixi.js';
import {
  buildAtomMap,
  coerceEventFilters,
  fmtCost,
  fmtMs,
  fmtTime,
  inFlightLlmEvents,
  isRunLive,
  runElapsedMs,
  runHeading,
  runStatus,
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
import type { RunStatus } from '../../../client/run-utils.js';
import type { VizEvent, VizRun } from '../../../client/types.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { tuningPanelVisible } from '../../tuning.js';
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
import { LLM_FAMILY_COLOR, eventKindColor, llmRoleColor } from '../event-palette.js';
import { drawScrollbarThumb } from '../scroll-pane.js';
import { timelineConnectorGeometry } from '../timeline-rails.js';
import { drawAtomDetail } from './atom-detail.js';
import { drawTuningPanel, tuningPanelHeight } from './tuning-panel.js';
import { gpuCardShaderMode } from '../shaders.js';

const RUN_STATUS_COLOR: Record<RunStatus, number> = {
  live: GPU_COLORS.success,
  delivered: GPU_COLORS.success,
  cancelled: GPU_COLORS.warning,
  failed: GPU_COLORS.error,
  abandoned: GPU_COLORS.warning,
};

/**
 * Rows the view inserts ABOVE the first event row for its "run ended"
 * bookend. Published on the viewport so the R3F rails project onto the same
 * grid — they read rows, not indices.
 */
const TIMELINE_ROW_OFFSET = 1;

/**
 * Event-card column geometry. These were three magic numbers spread across the
 * card body — a title truncated by CHARACTER COUNT, an actor pinned to a fixed
 * x, and a decision column inset from the right — and nothing related them, so
 * a long title simply drew over the actor. Named and related here so the three
 * columns are laid out from one set of facts.
 */
const EVENT_TITLE_X = 11;
const EVENT_DECISION_INSET = 118;
const EVENT_COLUMN_GAP = 10;
const EVENT_ACTOR_MIN_WIDTH = 64;
/** Mean advance of 11px bold in the UI face; only bounds the truncation. */
const EVENT_TITLE_CHAR_PX = 6.4;
/** Characters the card's second line can show at 9px across the pane. */
const EVENT_DETAIL_CHARS = 160;

/**
 * Roughly two lines of the 13px summary title at the right pane's width.
 * Collapsing is about giving the event detail room, not about hiding the run.
 */
const COLLAPSED_TITLE_CHARS = 110;

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
  // The goal names the run, once. The line under it used to repeat that same
  // sentence verbatim — `label` is only ever a cut copy of the goal plus the
  // family — so it now carries what the title cannot: who ran it, and when.
  const heading = runHeading(run);
  ctx.text(ctx.root, truncate(heading.title, 95), leftX + 14, top + 12, {
    size: 14,
    weight: '700',
    width: leftWidth - 28,
  });
  ctx.text(
    ctx.root,
    [heading.family, fmtTime(run.startedAt)].filter(Boolean).join('  ·  '),
    leftX + 14,
    top + 34,
    {
      size: 11,
      color: GPU_COLORS.muted,
      width: leftWidth - 28,
    }
  );
  // What happened to this run, always visible: the header used to flag only
  // LIVE, so a cancelled or failed run looked exactly like a delivered one
  // (2026-08-15 review of a real cancelled run).
  const status = runStatus(run);
  const statusColor = RUN_STATUS_COLOR[status];
  const statusLabel = snapshot.t(`runs.flag.${status}`);
  const statusWidth = Math.max(64, statusLabel.length * 6.4 + 16);
  const statusChip = new Graphics();
  statusChip.roundRect(leftX + leftWidth - statusWidth - 14, top + 8, statusWidth, 20, 6);
  statusChip.fill({ color: statusColor, alpha: 0.16 });
  statusChip.stroke({ color: statusColor, width: 1, alpha: 0.8 });
  statusChip.eventMode = 'none';
  ctx.root.addChild(statusChip);
  ctx.text(ctx.root, statusLabel, leftX + leftWidth - statusWidth - 6, top + 12, {
    size: 10,
    color: statusColor,
    weight: '700',
  });

  // A tool-bearing L1 execute is one provider call that only reports its
  // usage when it returns, so a live run's totals sit at zero for minutes
  // while work streams past. The header says so: the duration ticks, and the
  // call count carries the started-but-unfinished ones as `13 (+1)`.
  const inFlight = inFlightLlmEvents(run);
  const statsY = top + 76;
  const completedCalls = run.totals?.calls ?? 0;
  const stats = [
    [snapshot.t('summary.duration'), fmtMs(runElapsedMs(run))],
    [
      snapshot.t('summary.llmCalls'),
      inFlight.length ? `${completedCalls} (+${inFlight.length})` : scalar(run.totals?.calls, '0'),
    ],
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
      snapshot.onActivate,
      // The chip wears the colour of the cards it selects — the control and
      // its result were previously unrelated, every chip falling back to blue.
      eventKindColor(chip.id.slice('run.filter.kind.'.length))
    );
  }
  if (filterLayout.roles) {
    ctx.filterBlockFrame(ctx.root, filterLayout.roles);
    for (const chip of filterLayout.roles.chips) {
      const role = chip.id.slice('run.filter.role.'.length);
      ctx.filterButton(
        ctx.root,
        chip.id,
        chip.label,
        chip.x,
        chip.y,
        chip.width,
        chip.height,
        runFilters.role === chip.id.slice('run.filter.role.'.length),
        snapshot.onActivate,
        // Role chips ride the same yellow→orange ramp their LLM cards do.
        role === 'all' ? LLM_FAMILY_COLOR : llmRoleColor(role)
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
  // Newest first: what happened last is what you opened the run to read.
  const timeline = buildTimelineLayout(run.events, runFilters, { newestFirst: true });
  const rowHeight = timeline.rowHeight;
  const contentTopPadding = 18;
  const contentBottomPadding = 20;
  const cardRightPadding = 24;
  // Two bookend rows frame the events: "run ended" on top (newest), "run
  // started" at the bottom. They are rows like any other, so they scroll,
  // cull and project with the rest.
  const rowOffset = TIMELINE_ROW_OFFSET;
  const totalRows = timeline.items.length + rowOffset + 1;
  const displayRow = (row: number) => row + rowOffset;
  ctx.scrollMax.runs = Math.max(
    0,
    totalRows * rowHeight +
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
  // The window is expressed in DISPLAY rows; event indices sit one row lower.
  const itemStart = Math.max(0, start - rowOffset);
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
    totalHeight: totalRows * rowHeight + contentTopPadding + contentBottomPadding,
    scrollY,
    rowOffset,
  };
  if (timeline.items.length === 0) {
    ctx.text(listLayer, snapshot.t('filters.noMatch'), leftX + 24, listY + 22, {
      size: 11,
      color: GPU_COLORS.muted,
      width: leftWidth - 48,
    });
  }
  const graph = new Graphics();
  // Labelled so a recording test can read back the rail/connector geometry.
  graph.label = 'timeline-rails';
  // The trunk runs the WHOLE row space, bookends included, so both ends of
  // the run hang off the same spine.
  graph
    .moveTo(railX(0), rowCenterY(0))
    .lineTo(railX(0), rowCenterY(totalRows - 1));
  graph.stroke({ color: GPU_COLORS.primary, width: 2.2, alpha: 0.42 });
  for (const branch of timeline.branches) {
    const color = timelineBranchColor(branch);
    // A parent is still alive while its children run: draw the subtree span
    // faintly first so a child's fork always meets a live rail, then the
    // branch's own events at full strength.
    if (
      branch.subtreeFirstRow < branch.firstRow ||
      branch.subtreeLastRow > branch.lastRow
    ) {
      graph
        .moveTo(railX(branch.lane), rowCenterY(displayRow(branch.subtreeFirstRow)))
        .lineTo(railX(branch.lane), rowCenterY(displayRow(branch.subtreeLastRow)));
      graph.stroke({ color, width: 1.4, alpha: 0.3 });
    }
    graph
      .moveTo(railX(branch.lane), rowCenterY(displayRow(branch.firstRow)))
      .lineTo(railX(branch.lane), rowCenterY(displayRow(branch.lastRow)));
    graph.stroke({ color, width: 2.4, alpha: 0.72 });
  }
  for (const connector of timeline.connectors) {
    const branch = timeline.branches.find(
      (candidate) => candidate.id === connector.branchId
    );
    const color = branch ? timelineBranchColor(branch) : GPU_COLORS.primary;
    // Anchor on the PARENT rail just outside the branch's own span, then
    // elbow into the child rail at its causal end. Both ends land on a drawn
    // rail: the parent's own span is clamping the anchor, and the branch end
    // is the connector's row by construction.
    const parent = branch?.parentId
      ? timeline.branches.find((candidate) => candidate.id === branch.parentId)
      : undefined;
    const geometry = timelineConnectorGeometry({
      kind: connector.kind,
      fromLane: connector.fromLane,
      toLane: connector.toLane,
      connectorY: rowCenterY(displayRow(connector.row)),
      rowHeight,
      chronological: timeline.chronological,
      // The trunk is the whole row space, bookends included.
      parentTopY: parent
        ? rowCenterY(displayRow(parent.subtreeFirstRow))
        : rowCenterY(0),
      parentBottomY: parent
        ? rowCenterY(displayRow(parent.subtreeLastRow))
        : rowCenterY(totalRows - 1),
    });
    const parentX = railX(geometry.parentLane);
    const branchX = railX(geometry.branchLane);
    graph.moveTo(parentX, geometry.parentY);
    graph.bezierCurveTo(
      parentX,
      geometry.branchY,
      branchX,
      geometry.parentY,
      branchX,
      geometry.branchY
    );
    graph.stroke({
      color,
      width: connector.kind === 'fork' ? 1.8 : 1.2,
      alpha: connector.kind === 'fork' ? 0.78 : 0.48,
    });
  }
  for (const item of timeline.items.slice(itemStart, itemStart + count)) {
    const branch = item.branchId
      ? timeline.branches.find((candidate) => candidate.id === item.branchId)
      : undefined;
    graph
      .circle(railX(item.lane), rowCenterY(displayRow(item.row)), item.branchStart ? 4 : 2.4);
    graph.fill({
      color: branch ? timelineBranchColor(branch) : GPU_COLORS.primary,
      alpha: item.branchStart || item.branchEnd ? 0.95 : 0.62,
    });
  }
  listLayer.addChild(graph);

  // The two bookends: the run's own start and end are steps of the story,
  // not decorations. They replace the tiny rail ticks that said "START" and
  // "END" without ever saying WHAT ended (2026-08-15 review).
  const clockTime = (ms: number): string =>
    Number.isFinite(ms)
      ? new Date(ms).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : '';
  const bookend = (
    row: number,
    accent: number,
    title: string,
    facts: string
  ): void => {
    const y =
      listY + contentTopPadding + row * rowHeight - scrollY;
    if (y > listY + listHeight || y + rowHeight < listY) return;
    const cardHeight = rowHeight - 10;
    const panel = new Graphics();
    panel.roundRect(cardBaseX, y, cardBaseWidth, cardHeight, 7);
    panel.fill({ color: accent, alpha: 0.1 });
    panel.stroke({ color: accent, width: 1.2, alpha: 0.75 });
    panel.eventMode = 'none';
    listLayer.addChild(panel);
    ctx.text(listLayer, title, cardBaseX + 11, y + 8, {
      size: 11,
      weight: '700',
      color: accent,
    });
    if (facts) {
      ctx.text(listLayer, truncate(facts, 150), cardBaseX + 11, y + 28, {
        size: 9,
        color: GPU_COLORS.muted,
        width: cardBaseWidth - 22,
      });
    }
    const marker = new Graphics();
    marker.circle(railX(0), y + cardHeight / 2, 5);
    marker.fill({ color: accent, alpha: 0.95 });
    marker.eventMode = 'none';
    listLayer.addChild(marker);
  };

  const endedMs = run.endedAt ? Date.parse(run.endedAt) : NaN;
  const runOver = status !== 'live' && status !== 'abandoned';
  bookend(
    0,
    statusColor,
    `${runOver ? snapshot.t('timeline.runEnded') : snapshot.t('timeline.runUnfinished')} · ${statusLabel}`,
    [
      run.error,
      fmtMs(run.durationMs),
      snapshot.t('runs.calls', { count: run.totals?.calls ?? 0 }),
      fmtCost(run.totals?.costUsd),
      clockTime(endedMs),
    ]
      .filter(Boolean)
      .join(' · ')
  );
  bookend(
    totalRows - 1,
    GPU_COLORS.primary,
    snapshot.t('timeline.runStarted'),
    [clockTime(Date.parse(run.startedAt)), run.task?.description ?? '']
      .filter(Boolean)
      .join(' · ')
  );

  timeline.items.slice(itemStart, itemStart + count).forEach((item) => {
    const event = item.event;
    const y =
      listY +
      contentTopPadding +
      displayRow(item.row) * rowHeight -
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
    // The title was capped at 28 CHARACTERS while the actor sat at a fixed
    // x=118. Twenty-eight characters of 11px bold is ~180px, so any long title
    // — `registry · recordSuccess` is the one that shows it — ran straight
    // through the molecule name. Both ends are now driven by the geometry:
    // the title gets the space that is actually free before the actor column,
    // and the actor column starts after whatever the title really measured.
    const decisionX = cardWidth - EVENT_DECISION_INSET;
    const titleBudget = Math.max(70, decisionX - EVENT_TITLE_X - EVENT_ACTOR_MIN_WIDTH - EVENT_COLUMN_GAP);
    const titleLabel = ctx.text(
      cardContent,
      truncate(copy.title, Math.max(8, Math.min(28, Math.floor(titleBudget / EVENT_TITLE_CHAR_PX)))),
      EVENT_TITLE_X,
      6,
      { size: 11, weight: '700', color: eventAccent(event) }
    );
    const rawMeta = copy.meta.replace(/(?: · )?⑂ [^ ·]+/g, '').trim();
    const actor = rawMeta.split(' · ')[0] ?? '';
    // Measured, not estimated: the estimate above only bounds the truncation.
    const actorX = Math.max(118, EVENT_TITLE_X + titleLabel.width + EVENT_COLUMN_GAP);
    const actorWidth = decisionX - actorX - EVENT_COLUMN_GAP;
    if (actor && actorWidth >= EVENT_ACTOR_MIN_WIDTH) {
      ctx.text(cardContent, truncate(actor, 28), actorX, 7, {
        size: 9,
        color: GPU_COLORS.muted,
        width: actorWidth,
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
    // The FOOTER is never the part that gets cut. It carries the facts the
    // card exists to report — served model, tokens, cache read, cost — while
    // the body is prose that survives truncation gracefully. Truncating the
    // pair as one string dropped the numbers first whenever an event had
    // reasoning attached, which is exactly when they were worth reading.
    const bodyBudget = Math.max(24, EVENT_DETAIL_CHARS - copy.footer.length - 3);
    const detail = [truncate(copy.body, bodyBudget), copy.footer]
      .filter(Boolean)
      .join(' · ');
    ctx.text(cardContent, detail, 11, 28, {
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
    // Reserved BEFORE the detail is laid out, so the panel never draws over
    // the detail pane or steals its wheel. The first version was appended on
    // top of whatever was already there and swallowed ~188px of it.
    const tuningHeight = tuningPanelVisible() ? tuningPanelHeight() + GPU_LAYOUT.gap : 0;
    const detailHeight = height - detailTop - tuningHeight;
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
        detailHeight
      );
    } else if (atom) {
      drawAtomDetail(
        ctx,
        snapshot,
        atom.snapshot,
        rightX,
        detailTop,
        rightWidth,
        detailHeight
      );
    } else if (!snapshot.state.runSummaryExpanded) {
      ctx.text(ctx.root, snapshot.t('pane.selectEvent'), rightX + 18, detailTop + 12, {
        size: 12,
        color: GPU_COLORS.muted,
        width: rightWidth - 36,
      });
    }

    if (tuningHeight > 0) {
      drawTuningPanel(
        ctx,
        ctx.root,
        rightX + GPU_LAYOUT.gap,
        height - GPU_LAYOUT.gap - tuningPanelHeight(),
        rightWidth - GPU_LAYOUT.gap * 2
      );
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
  // The goal is the TITLE, and it appears exactly once: a run's stored label
  // is a cut copy of that same sentence plus the family, so the old separate
  // GOAL block said the very same thing twice. The family, the one piece the
  // goal cannot carry, rides the eyebrow.
  const heading = runHeading(run);
  ctx.text(
    block,
    [snapshot.t('run.summary'), heading.family].filter(Boolean).join(' · ').toUpperCase(),
    padX,
    cursor,
    { size: 10, weight: '700', color: GPU_COLORS.cyan }
  );
  ctx.collapseCaret(block, cardWidth - padX, cursor + 1, expanded, GPU_COLORS.cyan);
  cursor += 18;
  // Expanded, this card hides NOTHING. Collapsed, it keeps the goal to about
  // two lines and the verdict alone — so the caret always changes something,
  // which it did not when the goal happened to be short.
  const title = ctx.text(
    block,
    expanded ? heading.title : truncate(heading.title, COLLAPSED_TITLE_CHARS),
    padX,
    cursor,
    {
      size: 13,
      weight: '700',
      color: GPU_COLORS.text,
      width: innerWidth - 8,
    }
  );
  cursor += title.height + 6;
  // The verdict leads the facts: this pane is where the eye lands, and it
  // used to read identically for a delivered and a cancelled run.
  const summaryStatus = runStatus(run);
  const summaryStatusColor = RUN_STATUS_COLOR[summaryStatus];
  const statusText = ctx.text(
    block,
    snapshot.t(`runs.flag.${summaryStatus}`),
    padX,
    cursor,
    { size: 10, weight: '700', color: summaryStatusColor }
  );
  cursor += 18;
  if (expanded) {
    const facts = [
      fmtMs(run.durationMs),
      snapshot.t('runs.calls', { count: run.totals?.calls ?? 0 }),
      fmtCost(run.totals?.costUsd),
    ].filter(Boolean).join('  ·  ');
    ctx.text(block, facts, padX + statusText.width + 12, cursor - 18, {
      size: 10,
      color: GPU_COLORS.muted,
    });
    if (run.error) {
      const reason = ctx.text(block, run.error, padX, cursor, {
        size: 9,
        color: summaryStatusColor,
        width: innerWidth,
      });
      cursor += reason.height + 6;
    }
  }
  cursor += 8;
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
    drawScrollbarThumb(ctx.root, {
      x,
      y: detailTop,
      width,
      height: detailHeight,
      scrollY: ctx.detailScrollY,
      maxScroll: ctx.detailScrollMax,
    });
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
  drawScrollbarThumb(ctx.root, {
    x,
    y: detailTop,
    width,
    height: detailHeight,
    scrollY: ctx.detailScrollY,
    maxScroll: ctx.detailScrollMax,
  });
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

