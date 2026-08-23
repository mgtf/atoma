import { Container } from 'pixi.js';
import { fmtCost } from '../../../client/run-utils.js';
import type { LaunchProfile, VizProjectRun } from '../../../client/types.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { truncate } from '../copy.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_CONTENT_TOP, VIEW_FRAME_PAD } from '../view-frame.js';

/**
 * Projects view: the organisation's projects, their GitHub repository state
 * and their runs with publication receipts. Follows the 2026-08-15 view
 * decomposition: a free function over the exported RendererCtx, one measured
 * layout pass, scroll through the shared masked pane, honest `scrollMax`.
 *
 * The create/connect form is a DOM overlay (`.gpu-project-form`). GPU copy
 * and the project list start below that band so labels never sit under inputs.
 *
 * It also carries the run prompt's GUIDANCE — how to phrase a goal for the
 * family, and example goals that fill the prompt. That used to be a separate
 * Launch tab which could only describe and never start, so one job lived in
 * two places; the guidance now sits beside the input it describes.
 */

const ROW_HEIGHT = 54;
const COMPACT_ROW_HEIGHT = 86;
const COMPACT_PROJECT_PANEL_WIDTH = 400;
const RUN_ROW_HEIGHT = 34;
const RUN_ERROR_EXTRA = 14;
const STATUS_COL = 108;
/**
 * The repository link under the status needs more room than the status word:
 * at 108 it wrapped mid-URL. Reserved by the name/slug column on every row, so
 * a row that has a link and one that does not keep the same left column.
 */
const REPO_URL_COL = 220;
/** Breathing room between the status column and the row's right border. */
export const PROJECTS_ROW_PAD = 14;
/**
 * Must match `.gpu-project-form { top }` in styles.css. The form is the first
 * thing inside the column frame, so this is the frame's own content top.
 */
export const PROJECTS_DOM_FORM_TOP =
  GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap + VIEW_FRAME_CONTENT_TOP;
/**
 * The form has two shapes, so it has two heights. With no project selected it
 * is the create fields; with one it is the run prompt. Measuring one height
 * for both left a band of dead space under whichever form was shorter.
 */
export const PROJECTS_DOM_FORM_HEIGHT = { create: 140, run: 184 } as const;
/** Below this content width the DOM form stacks fields instead of squeezing them. */
export const PROJECTS_NARROW_CONTENT_WIDTH = 480;
/** Must match the narrow media query in styles.css. */
export const PROJECTS_DOM_FORM_NARROW_HEIGHT = { create: 272, run: 248 } as const;

export type ProjectsFormMode = keyof typeof PROJECTS_DOM_FORM_HEIGHT;

export function projectsGpuContentTop(
  mode: ProjectsFormMode,
  contentWidth = Number.POSITIVE_INFINITY
): number {
  const heights = contentWidth < PROJECTS_NARROW_CONTENT_WIDTH
    ? PROJECTS_DOM_FORM_NARROW_HEIGHT
    : PROJECTS_DOM_FORM_HEIGHT;
  return PROJECTS_DOM_FORM_TOP + heights[mode] + 16;
}

function runRowHeight(run: VizProjectRun, compact = false): number {
  if (!compact) return run.error ? RUN_ROW_HEIGHT + RUN_ERROR_EXTRA : RUN_ROW_HEIGHT;
  const hasSecondLine = Boolean(
    run.error ||
    (run.publication?.status === 'published' && run.publication.commitSha)
  );
  return hasSecondLine ? 68 : 54;
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

const GUIDANCE_PAD = 18;
const GUIDANCE_GAP = 16;
const EXAMPLE_HEIGHT = 34;
const EXAMPLE_GAP = 8;
const EXAMPLE_COLUMNS = 2;

/**
 * A catalog key beats the profile's own English when the deployment has one:
 * `t()` echoes an unknown key back, which is how a miss is detected — the
 * same resolution the MUI fallback applies, so a new family stays describable
 * without touching either client.
 */
function familyHelp(t: GpuRenderSnapshot['t'], profile: LaunchProfile): string {
  const key = `launch.help.${profile.id}`;
  const translated = t(key);
  return translated === key ? profile.help : translated;
}

/**
 * Draw the prompt guidance at the top of the scrolled content and return the
 * height the project list must shift by. Measured, not estimated: the body is
 * a wrapped paragraph, so every block below it is placed from its real
 * bottom. The backdrop panel depends on the final cursor but must render
 * behind the text, so a layer reserves its z-slot up front (same shape the
 * former Launch view used).
 */
function drawPromptGuidance(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  parent: Container,
  x: number,
  panelWidth: number,
  profile: LaunchProfile
): number {
  const panelLayer = new Container();
  parent.addChild(panelLayer);
  const innerX = x + GUIDANCE_PAD;
  const innerWidth = panelWidth - GUIDANCE_PAD * 2;

  ctx.text(parent, snapshot.t('launch.help'), innerX, GUIDANCE_PAD, {
    size: 13,
    weight: '700',
    color: GPU_COLORS.primary,
  });
  const body = ctx.text(parent, familyHelp(snapshot.t, profile), innerX, GUIDANCE_PAD + 26, {
    size: 11,
    color: GPU_COLORS.muted,
    width: innerWidth,
  });

  let cursor = GUIDANCE_PAD + 26 + body.height + 18;
  if (profile.examples.length > 0) {
    ctx.text(parent, snapshot.t('launch.examples'), innerX, cursor, {
      size: 10,
      weight: '600',
    });
    cursor += 22;
    const exampleWidth = (innerWidth - EXAMPLE_GAP * (EXAMPLE_COLUMNS - 1)) / EXAMPLE_COLUMNS;
    profile.examples.forEach((example, index) => {
      const column = index % EXAMPLE_COLUMNS;
      const row = Math.floor(index / EXAMPLE_COLUMNS);
      ctx.button(
        parent,
        `projects.example.${index}`,
        'button',
        truncate(example, 54),
        innerX + column * (exampleWidth + EXAMPLE_GAP),
        cursor + row * (EXAMPLE_HEIGHT + EXAMPLE_GAP),
        exampleWidth,
        EXAMPLE_HEIGHT,
        false,
        snapshot.onActivate
      );
    });
    const rows = Math.ceil(profile.examples.length / EXAMPLE_COLUMNS);
    cursor += rows * (EXAMPLE_HEIGHT + EXAMPLE_GAP) - EXAMPLE_GAP;
  }

  const height = cursor + GUIDANCE_PAD;
  ctx.panel(
    panelLayer,
    x,
    0,
    panelWidth,
    height,
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );
  return height + GUIDANCE_GAP;
}

/** Horizontal inset the column leaves inside the content viewport, in total. */
export const PROJECTS_COLUMN_INSET = GPU_LAYOUT.gap * 2;

/**
 * ONE content column for this view, full-bleed like the other tabs. The DOM
 * form and the GL panels below it are two cards in a single stack, and they
 * only read as one while they agree on both edges — the form used to sit
 * flush left at 20 while the list centred itself, so the two cards stepped
 * sideways from each other. `.gpu-project-form` computes exactly this in
 * CSS; a test holds the two constants together.
 */
export function projectsColumn(viewportWidth: number): { x: number; width: number } {
  const frame = viewFrame(viewportWidth, 0);
  return { x: frame.innerX, width: frame.innerWidth };
}

export function projectLayout(
  viewportWidth: number,
  projectCount: number,
  selectedIndex: number,
  selectedRuns: readonly VizProjectRun[]
) {
  const { x, width: panelWidth } = projectsColumn(viewportWidth);
  const compactRunRows = panelWidth < COMPACT_PROJECT_PANEL_WIDTH;

  const listTop = 12;
  let cursor = listTop;
  for (let index = 0; index < projectCount; index++) {
    cursor += compactRunRows ? COMPACT_ROW_HEIGHT : ROW_HEIGHT;
    if (index !== selectedIndex) continue;
    if (selectedRuns.length === 0) {
      cursor += 24;
      continue;
    }
    cursor += 26;
    for (const run of selectedRuns) cursor += runRowHeight(run, compactRunRows);
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

  const selectedProject = projects.find((p) => p.projectId === snapshot.state.selectedProjectId);
  const summary = selectedProject
    ? snapshot.t('projects.summarySelected', {
        count: projects.length,
        name: selectedProject.name,
      })
    : snapshot.t('projects.summary', { count: projects.length });
  const frame = viewFrame(width, height);
  drawViewFrame(ctx, frame, snapshot.t('nav.projects'), summary);

  // The DOM form is gated on a session (`projectActionsEnabled` in DomBridge),
  // so an UNGATED instance renders none — and reserving the band it would have
  // occupied left a ~260px hole between the title and the copy explaining why
  // there is nothing here. Reserve the band only when the form is really there.
  const contentTop = snapshot.data.auth === null
    ? frame.contentTop
    : projectsGpuContentTop(selectedProject ? 'run' : 'create', width);
  if (projects.length === 0) {
    // Ungated deployments have no organisations, so projects cannot exist and
    // their API routes are absent — say that, instead of coaching the viewer
    // toward a GitHub connect flow the server will 404.
    const connectHint = snapshot.data.auth === null
      ? snapshot.t('projects.gateOff')
      : installations.length === 0
        ? snapshot.t('projects.emptyNoInstallation')
        : snapshot.t('projects.empty');
    ctx.text(ctx.root, connectHint, frame.innerX, contentTop, {
      size: 13,
      color: GPU_COLORS.muted,
      width: frame.innerWidth,
    });
    ctx.scrollMax.projects = 0;
    return;
  }

  // Clipped to the FRAME, not the viewport: rows that scrolled past the
  // column's bottom edge would otherwise draw over the page beneath it.
  const pane = createScrollPane(ctx.root, {
    x: frame.x,
    y: contentTop,
    width: frame.width,
    height: Math.max(0, frame.bottom - VIEW_FRAME_PAD - contentTop),
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
  const viewportLayout = projectLayout(width, projects.length, selectedIndex, selectedRuns);
  // `projectLayout` stays viewport-absolute because the DOM form consumes its
  // edges too. The scroll pane is positioned at `frame.x`, so drawing inside
  // `pane.content` uses the same layout relative to that pane.
  const layout = { ...viewportLayout, x: viewportLayout.x - frame.x };

  // The guidance describes the run PROMPT, and the DOM form only shows that
  // textarea once a project is selected — so it appears on exactly the same
  // condition, and never coaches a viewer who has nothing to run yet. The
  // list below shifts by its MEASURED height; nothing here estimates it.
  const guidanceProfile = snapshot.data.profiles[0];
  const listOffset =
    selectedProject && guidanceProfile
      ? drawPromptGuidance(
          ctx,
          snapshot,
          pane.content,
          layout.x,
          layout.panelWidth,
          guidanceProfile
        )
      : 0;

  // Hug the list. Stretching to the remaining viewport left a hollow slab
  // under a handful of rows.
  ctx.panel(
    pane.content,
    layout.x,
    listOffset,
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
  const repoUrlWidth = Math.min(REPO_URL_COL, Math.max(80, innerWidth * 0.45));
  const compactRunRows = layout.panelWidth < COMPACT_PROJECT_PANEL_WIDTH;
  // The status column hugs the card's INNER RIGHT EDGE and its labels are
  // anchored to that edge. Capping it at `columnX + 560` left a wide gap
  // between the verdict and the card border on any panel past ~700px, so the
  // column a reader scans down floated in the middle of the row. `statusX` is
  // still the column's LEFT edge — the copy beside it measures against that.
  // Inset from the ROW's own right edge, not flush with it: the row button
  // spans `innerWidth`, so a status anchored to the panel edge sat exactly on
  // that button's border with nothing between text and stroke.
  const statusRight = layout.x + layout.panelWidth - 18 - PROJECTS_ROW_PAD;
  const statusX = statusRight - STATUS_COL;
  let cursor = listOffset + layout.listTop;
  projects.forEach((project, index) => {
    const y = cursor;
    const projectRowHeight = compactRunRows ? COMPACT_ROW_HEIGHT : ROW_HEIGHT;
    const selected = project.projectId === snapshot.state.selectedProjectId;
    const rowLabel = truncate(project.name, 64);
    // Wide rows reserve the right-hand status column from the LABEL surface;
    // the surrounding panel still carries the row. A full-width centred label
    // crossed directly through the anchored status at intermediate widths.
    const projectButtonWidth = compactRunRows
      ? innerWidth
      : Math.max(0, statusX - columnX - 12);
    ctx.button(
      pane.content,
      `project.select.${project.projectId}`,
      'button',
      rowLabel,
      columnX,
      y,
      projectButtonWidth,
      compactRunRows ? 30 : ROW_HEIGHT - 8,
      selected,
      snapshot.onActivate
    );
    const metadataWidth = compactRunRows
      ? Math.max(0, innerWidth - 24)
      : Math.max(40, innerWidth - repoUrlWidth - 24);
    // VISIBILITY LEADS the metadata line. It cannot ride at the end: this line
    // is truncated from the TAIL, so an appended badge is the first thing to
    // disappear on a narrow panel — and it is the one word on the row that
    // says who can read what these runs publish. Public is upshifted because a
    // single text node carries a single colour, and this line's colour belongs
    // to the slug, not to the audience.
    const visibility = project.repositoryTarget.visibility;
    const badge = snapshot.t(`projects.visibilityBadge.${visibility}`);
    const metadata = `${visibility === 'public' ? badge.toUpperCase() : badge} · ${project.slug} · ${project.repositoryTarget.owner}/${project.repositoryTarget.name}`;
    ctx.text(
      pane.content,
      truncate(metadata.replace(/\s+/g, ' '), Math.max(8, Math.floor(metadataWidth / 6))),
      columnX + 12,
      y + (compactRunRows ? 34 : 26),
      {
        size: 9,
        color: GPU_COLORS.muted,
        width: metadataWidth,
        singleLine: true,
      }
    );
    const repositoryStatus = ctx.text(
      pane.content,
      statusLabel(snapshot.t, project.repositoryStatus, 'projects.repoStatus'),
      compactRunRows ? columnX + 12 : statusRight,
      y + (compactRunRows ? 49 : 8),
      {
        size: 10,
        color: statusColor(project.repositoryStatus),
        mono: true,
        width: compactRunRows ? Math.max(0, innerWidth - 24) : STATUS_COL,
        singleLine: true,
      }
    );
    if (!compactRunRows) repositoryStatus.anchor.x = 1;
    if (project.repositoryFullName) {
      const repositoryWidth = compactRunRows
        ? Math.max(0, innerWidth - 24)
        : repoUrlWidth;
      const repositoryText = project.repositoryUrl ?? project.repositoryFullName;
      const repository = ctx.text(
        pane.content,
        truncate(repositoryText, Math.max(8, Math.floor(repositoryWidth / 6))),
        compactRunRows ? columnX + 12 : statusRight,
        y + (compactRunRows ? 64 : 24),
        {
          size: 8,
          color: GPU_COLORS.muted,
          width: repositoryWidth,
          singleLine: true,
        }
      );
      if (!compactRunRows) repository.anchor.x = 1;
    }
    cursor += projectRowHeight;

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
        const rowHeight = runRowHeight(run, compactRunRows);
        const goalWidth = compactRunRows
          ? Math.max(0, layout.panelWidth - 52)
          : Math.max(0, statusX - runColumnX - 12);
        ctx.button(
          pane.content,
          `project.run.${run.traceId ?? run.projectRunId}`,
          'button',
          truncate(run.goal, 70),
          runColumnX,
          cursor,
          goalWidth,
          compactRunRows ? 30 : rowHeight - 4,
          false,
          snapshot.onActivate
        );
        const status = ctx.text(
          pane.content,
          truncate(
            `${statusText}${cost}`,
            Math.max(8, Math.floor((compactRunRows ? goalWidth : STATUS_COL) / 7))
          ),
          compactRunRows ? runColumnX : statusRight,
          cursor + (compactRunRows ? 34 : 4),
          {
            size: 10,
            color: statusColor(run.status),
            mono: true,
            width: compactRunRows ? goalWidth : STATUS_COL,
            singleLine: true,
          }
        );
        if (!compactRunRows) status.anchor.x = 1;
        if (run.publication && run.publication.status === 'published' && run.publication.commitSha) {
          const commit = ctx.text(
            pane.content,
            truncate(run.publication.commitSha, 12),
            compactRunRows ? runColumnX : statusRight,
            cursor + (compactRunRows ? 48 : 18),
            {
              size: 9,
              color: GPU_COLORS.success,
              mono: true,
              width: compactRunRows ? goalWidth : STATUS_COL,
              singleLine: true,
            }
          );
          if (!compactRunRows) commit.anchor.x = 1;
        } else if (run.error) {
          const boundedError = run.error.replace(/\s+/g, ' ');
          ctx.text(
            pane.content,
            truncate(boundedError, Math.max(8, Math.floor(goalWidth / 6))),
            runColumnX,
            cursor + (compactRunRows ? 48 : 22),
            { size: 8, color: GPU_COLORS.error, width: goalWidth, singleLine: true }
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

  pane.extend(listOffset + layout.contentBottom);
  ctx.scrollMax.projects = pane.finish();
}
