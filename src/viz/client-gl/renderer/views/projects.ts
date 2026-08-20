import { fmtCost } from '../../../client/run-utils.js';
import type { VizProjectRun } from '../../../client/types.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { truncate } from '../copy.js';
import { createScrollPane } from '../scroll-pane.js';

/**
 * Projects view: the organisation's projects, their GitHub repository state
 * and their runs with publication receipts. Follows the 2026-08-15 view
 * decomposition: a free function over the exported RendererCtx, one measured
 * layout pass, scroll through the shared masked pane, honest `scrollMax`.
 *
 * The create/connect form is a DOM overlay (`.gpu-project-form`). GPU copy
 * and the project list start below that band so labels never sit under inputs.
 */

const ROW_HEIGHT = 54;
const RUN_ROW_HEIGHT = 34;
const RUN_ERROR_EXTRA = 14;
const HEADER_Y = 78;
const STATUS_COL = 108;
/** Must match `.gpu-project-form { top }` in styles.css. */
export const PROJECTS_DOM_FORM_TOP = 128;
export const PROJECTS_DOM_FORM_HEIGHT = 212;

export function projectsGpuContentTop(): number {
  return PROJECTS_DOM_FORM_TOP + PROJECTS_DOM_FORM_HEIGHT + 16;
}

function runRowHeight(run: VizProjectRun): number {
  return run.error ? RUN_ROW_HEIGHT + RUN_ERROR_EXTRA : RUN_ROW_HEIGHT;
}

const STATUS_COLORS: Record<string, number> = {
  active: GPU_COLORS.success,
  pending: GPU_COLORS.muted,
  creating: GPU_COLORS.warning,
  ready: GPU_COLORS.success,
  failed: GPU_COLORS.error,
  queued: GPU_COLORS.muted,
  running: GPU_COLORS.warning,
  delivered: GPU_COLORS.success,
  cancelled: GPU_COLORS.muted,
  published: GPU_COLORS.success,
  publishing: GPU_COLORS.warning,
  suspended: GPU_COLORS.warning,
  deleted: GPU_COLORS.error,
};

function statusColor(status: string): number {
  return STATUS_COLORS[status] ?? GPU_COLORS.text;
}

function statusLabel(
  t: GpuRenderSnapshot['t'],
  status: string,
  prefix: string
): string {
  return t(`${prefix}.${status}`);
}

export function projectLayout(
  viewportWidth: number,
  projectCount: number,
  selectedIndex: number,
  selectedRuns: readonly VizProjectRun[]
) {
  const panelWidth = Math.min(980, viewportWidth - GPU_LAYOUT.gap * 2);
  const x = (viewportWidth - panelWidth) / 2;
  const listTop = 12;
  let cursor = listTop;
  for (let index = 0; index < projectCount; index++) {
    cursor += ROW_HEIGHT;
    if (index !== selectedIndex) continue;
    if (selectedRuns.length === 0) {
      cursor += 24;
      continue;
    }
    cursor += 26;
    for (const run of selectedRuns) cursor += runRowHeight(run);
  }
  const contentBottom = cursor + 16;
  return { x, panelWidth, listTop, contentBottom };
}

/** Draw the projects list. Selected project expands to show its runs. */
export function drawProjects(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const projects = snapshot.data.projects ?? [];
  const installations = snapshot.data.githubInstallations ?? [];
  const runsByProject = snapshot.data.projectRuns ?? {};
  const scroll = snapshot.state.scrollY.projects;

  ctx.text(ctx.root, snapshot.t('nav.projects'), 20, HEADER_Y, { size: 18, weight: '700' });
  const selectedProject = projects.find((p) => p.projectId === snapshot.state.selectedProjectId);
  const summary = selectedProject
    ? snapshot.t('projects.summarySelected', {
        count: projects.length,
        name: selectedProject.name,
      })
    : snapshot.t('projects.summary', { count: projects.length });
  ctx.text(ctx.root, summary, 20 + 200, HEADER_Y + 6, {
    size: 11,
    color: GPU_COLORS.muted,
  });

  const contentTop = projectsGpuContentTop();
  if (projects.length === 0) {
    const connectHint = installations.length === 0
      ? snapshot.t('projects.emptyNoInstallation')
      : snapshot.t('projects.empty');
    ctx.text(ctx.root, connectHint, 20, contentTop, {
      size: 13,
      color: GPU_COLORS.muted,
      width: width - 60,
    });
    ctx.scrollMax.projects = 0;
    return;
  }

  const pane = createScrollPane(ctx.root, {
    x: 0,
    y: contentTop,
    width,
    height: Math.max(0, height - contentTop),
    scrollY: scroll,
    bottomPadding: 24,
  });

  const expandedRunList: (readonly VizProjectRun[])[] = projects.map(
    (p) => runsByProject[p.projectId] ?? []
  );
  const selectedIndex = selectedProject
    ? projects.findIndex((project) => project.projectId === selectedProject.projectId)
    : -1;
  const selectedRuns = selectedIndex >= 0 ? expandedRunList[selectedIndex] ?? [] : [];
  const layout = projectLayout(width, projects.length, selectedIndex, selectedRuns);

  // Hug the list. Stretching to the remaining viewport left a hollow slab
  // under a handful of rows.
  ctx.panel(
    pane.content,
    layout.x,
    0,
    layout.panelWidth,
    layout.contentBottom,
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );

  const columnX = layout.x + 18;
  const innerWidth = layout.panelWidth - 36;
  const runColumnX = layout.x + 34;
  const statusX = Math.min(
    layout.x + layout.panelWidth - 18 - STATUS_COL,
    columnX + 560
  );
  let cursor = layout.listTop;
  projects.forEach((project, index) => {
    const y = cursor;
    const selected = project.projectId === snapshot.state.selectedProjectId;
    const rowLabel = truncate(project.name, 64);
    ctx.button(
      pane.content,
      `project.select.${project.projectId}`,
      'button',
      rowLabel,
      columnX,
      y,
      innerWidth,
      ROW_HEIGHT - 8,
      selected,
      snapshot.onActivate
    );
    ctx.text(
      pane.content,
      `${project.slug} · ${project.repositoryTarget.owner}/${project.repositoryTarget.name}`,
      columnX + 12,
      y + 26,
      { size: 9, color: GPU_COLORS.muted, width: innerWidth - STATUS_COL - 24 }
    );
    ctx.text(
      pane.content,
      statusLabel(snapshot.t, project.repositoryStatus, 'projects.repoStatus'),
      statusX,
      y + 8,
      { size: 10, color: statusColor(project.repositoryStatus), mono: true, width: STATUS_COL }
    );
    if (project.repositoryFullName) {
      ctx.text(
        pane.content,
        project.repositoryUrl ?? project.repositoryFullName,
        statusX,
        y + 24,
        { size: 8, color: GPU_COLORS.muted, width: STATUS_COL }
      );
    }
    cursor += ROW_HEIGHT;

    const runs = expandedRunList[index] ?? [];
    if (selected && runs.length > 0) {
      ctx.text(
        pane.content,
        snapshot.t('projects.runsHeading', { count: runs.length }),
        runColumnX,
        cursor,
        { size: 10, color: GPU_COLORS.muted, weight: '600' }
      );
      cursor += 26;
      for (const run of runs) {
        const statusText = statusLabel(snapshot.t, run.status, 'projects.runStatus');
        const cost = run.costUsd === null ? '' : ` · ${fmtCost(run.costUsd)}`;
        const rowHeight = runRowHeight(run);
        const goalWidth = Math.max(160, statusX - runColumnX - 12);
        ctx.button(
          pane.content,
          `project.run.${run.traceId ?? run.projectRunId}`,
          'button',
          truncate(run.goal, 70),
          runColumnX,
          cursor,
          goalWidth,
          rowHeight - 4,
          false,
          snapshot.onActivate
        );
        ctx.text(
          pane.content,
          `${statusText}${cost}`,
          statusX,
          cursor + 4,
          { size: 10, color: statusColor(run.status), mono: true, width: STATUS_COL }
        );
        if (run.publication && run.publication.status === 'published' && run.publication.commitSha) {
          ctx.text(
            pane.content,
            truncate(run.publication.commitSha, 12),
            statusX,
            cursor + 18,
            { size: 9, color: GPU_COLORS.success, mono: true, width: STATUS_COL }
          );
        } else if (run.error) {
          ctx.text(
            pane.content,
            truncate(run.error, 72),
            runColumnX,
            cursor + 22,
            { size: 8, color: GPU_COLORS.error, width: goalWidth }
          );
        }
        cursor += rowHeight;
      }
    } else if (selected && runs.length === 0) {
      ctx.text(
        pane.content,
        snapshot.t('projects.noRuns'),
        runColumnX,
        cursor,
        { size: 10, color: GPU_COLORS.muted }
      );
      cursor += 24;
    }
  });

  pane.extend(layout.contentBottom);
  ctx.scrollMax.projects = pane.finish();
}
