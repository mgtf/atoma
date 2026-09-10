import { Container, Rectangle } from 'pixi.js';
import type { LaunchProfile, VizProjectRun } from '../../../client/types.js';
import { BUTTON_LABEL_INSET } from '../../gpu-renderer.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { projectGuidanceOpen } from '../../store.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { truncate } from '../copy.js';
import { relativeTime } from '../relative-time.js';
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

const ROW_HEIGHT = 58;
/**
 * Wide rows keep the name button a single-line control and stack the
 * metadata BELOW it, like the run rows stack their second line. The metadata
 * used to render INSIDE the 46px button frame, 11px under a vertically
 * centred label — the two lines nearly touched, and the frame read as
 * cramped at any width (2026-08-24 review of the live Projects screen).
 */
const PROJECT_BUTTON_HEIGHT = 46;
const COMPACT_ROW_HEIGHT = ROW_HEIGHT;
/** A selected project owns the page title, so its detail row omits the name button. */
const SELECTED_PROJECT_DETAIL_HEIGHT = ROW_HEIGHT;
const SELECTED_PROJECT_COMPACT_DETAIL_HEIGHT = ROW_HEIGHT;
const COMPACT_PROJECT_PANEL_WIDTH = 400;
const RUN_ROW_HEIGHT = 46;
/**
 * Extra vertical room for a second line — commit hash or error — stacked
 * BELOW the run button in wide (non-compact) rows. The button itself keeps
 * `RUN_BUTTON_HEIGHT`'s single-line height; this is purely appended row
 * height, so the second line's text never falls inside the button's label.
 */
const RUN_SECOND_LINE_EXTRA = 20;
/** Height of the run goal button itself; the row height above adds the air. */
const RUN_BUTTON_HEIGHT = 32;
/** Non-compact: where the second line starts, measured from the row's top. */
const RUN_SECOND_LINE_Y = RUN_BUTTON_HEIGHT + 4;
/**
 * The status column was a FIXED 108px reservation: every row surrendered the
 * same width whether the verdict read `delivered · $12.34` or just `queued`,
 * so the label a reader came for — the project name, the run goal — was
 * truncated to pay for space nothing drew in, AND `delivered · $1.02` still
 * did not fit in it, losing its own cost to an ellipsis. Both halves of that
 * are the same mistake: guessing a width instead of measuring one.
 */
/** Floor: below this the column is too narrow to read a verdict in. */
const STATUS_COL_MIN = 44;
/**
 * Ceiling, as a SHARE of the card rather than a constant. A verdict is
 * secondary to the goal beside it, so it may never take more than this of the
 * row however long a locale makes it; on a wide card that is generous enough
 * that nothing truncates, and on a narrow one the goal still wins.
 */
const STATUS_COL_MAX_SHARE = 0.3;
/** Font size the status/verdict labels are drawn at, and measured at. */
const STATUS_FONT_SIZE = 10;
/** The linked mesh carries inset detail, so its full box must be visibly larger than the copy. */
export const REPOSITORY_ICON_SIZE = 42;
/** The mesh has transparent padding inside its box; overlap it to keep the visible mark near the URL. */
export const REPOSITORY_ICON_GAP = -6;
/** Pull the padded texture toward the separator without moving the link's logical start. */
const REPOSITORY_ICON_OFFSET_X = -8;
export const PRIVATE_REPOSITORY_ICON_SIZE = 13;
export const PRIVATE_REPOSITORY_ICON_GAP = 6;
const PROJECT_INFO_GAP = 10;
const PROJECT_INFO_SEPARATOR = '·';
const PROJECT_INFO_SEPARATOR_BEFORE_GAP = 6;
/** Compensates for the repository mesh's transparent left inset. */
const PROJECT_INFO_SEPARATOR_AFTER_GAP = 0;
const PROJECT_INFO_TEXT_Y = 15;
const PROJECT_NAME_Y = 7;
const PROJECT_METADATA_Y = 28;

function projectCreatedDate(createdAt: string, locale: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return date.toLocaleDateString(locale, { dateStyle: 'medium' });
}

/**
 * The status column, MEASURED against the real glyphs of the statuses on
 * screen. Pixi is the only honest source here — a character count cannot tell
 * `delivered · $12.34` from `queued` in pixels — and `CanvasTextMetrics`
 * caches per font, so this costs a map lookup rather than a rasterisation.
 */
function statusColumnWidth(
  ctx: RendererCtx,
  labels: readonly string[],
  panelWidth: number
): number {
  let widest = 0;
  for (const label of labels) {
    widest = Math.max(widest, ctx.measureText(label, { size: STATUS_FONT_SIZE, mono: true }));
  }
  // +2 so a sub-pixel measurement cannot clip the final glyph.
  const ceiling = Math.max(STATUS_COL_MIN, panelWidth * STATUS_COL_MAX_SHARE);
  return Math.min(ceiling, Math.max(STATUS_COL_MIN, Math.ceil(widest) + 2));
}
/**
 * The repository link under the status needs more room than the status word:
 * at 108 it wrapped mid-URL. Reserved by the name/slug column on every row, so
 * a row that has a link and one that does not keep the same left column.
 */
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
export const PROJECTS_DOM_FORM_HEIGHT = { create: 186, run: 184 } as const;
/** Below this content width the DOM form stacks fields instead of squeezing them. */
export const PROJECTS_NARROW_CONTENT_WIDTH = 480;
/** Must match the narrow media query in styles.css. */
export const PROJECTS_DOM_FORM_NARROW_HEIGHT = { create: 364, run: 248 } as const;

export type ProjectsFormMode = keyof typeof PROJECTS_DOM_FORM_HEIGHT;

export function projectsFormHeight(
  mode: ProjectsFormMode,
  contentWidth = Number.POSITIVE_INFINITY
): number {
  const heights = contentWidth < PROJECTS_NARROW_CONTENT_WIDTH
    ? PROJECTS_DOM_FORM_NARROW_HEIGHT
    : PROJECTS_DOM_FORM_HEIGHT;
  return heights[mode];
}

export function projectsGpuContentTop(
  mode: ProjectsFormMode,
  contentWidth = Number.POSITIVE_INFINITY
): number {
  return PROJECTS_DOM_FORM_TOP + projectsFormHeight(mode, contentWidth) + 16;
}

/**
 * Room the runs heading takes, shared by the measuring and drawing passes —
 * two copies of this number would desynchronise `scrollMax` from the rows.
 */
const RUNS_HEADING_HEIGHT = 30;

function runRowHeight(run: VizProjectRun, compact = false): number {
  const hasSecondLine = Boolean(
    run.error ||
    (run.publication?.status === 'published' && run.publication.commitSha)
  );
  if (!compact) return hasSecondLine ? RUN_ROW_HEIGHT + RUN_SECOND_LINE_EXTRA : RUN_ROW_HEIGHT;
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

/**
 * A run's total cost, in MONEY — two decimals, and a leading `<` under a cent
 * rather than a rounded `$0.00` that reads as free.
 *
 * NOT `fmtCost`, which is fixed at four decimals on purpose: it prices a
 * SINGLE LLM call, where a tenth of a cent is the signal. A whole run's total
 * is read as an amount spent, and `$1.0200` reads as a defect. The wide
 * precision was invisible here only while the column truncated it away.
 */
function runCost(costUsd: number): string {
  if (costUsd > 0 && costUsd < 0.01) return '<$0.01';
  return `$${costUsd.toFixed(2)}`;
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

/** Height of the always-visible header row a viewer clicks to expand/collapse. */
const GUIDANCE_HEADER_HEIGHT = 18;

/**
 * Draw the prompt guidance at the top of the scrolled content and return the
 * height the project list must shift by. Measured, not estimated: the body is
 * a wrapped paragraph, so every block below it is placed from its real
 * bottom. The backdrop panel depends on the final cursor but must render
 * behind the text, so a layer reserves its z-slot up front (same shape the
 * former Launch view used).
 *
 * Eligibility belongs to the caller: this disclosure exists only for a
 * selected project with no runs. Within that first-goal state it defaults
 * open, and the viewer may collapse or reopen it without losing the examples.
 */
function drawPromptGuidance(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  parent: Container,
  x: number,
  panelWidth: number,
  profile: LaunchProfile,
  expanded: boolean
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
  ctx.collapseCaret(
    parent,
    x + panelWidth - GUIDANCE_PAD,
    GUIDANCE_PAD + 1,
    expanded,
    GPU_COLORS.primary
  );

  let cursor = GUIDANCE_PAD + GUIDANCE_HEADER_HEIGHT;
  if (expanded) {
    const body = ctx.text(parent, familyHelp(snapshot.t, profile), innerX, cursor + 8, {
      size: 11,
      color: GPU_COLORS.muted,
      width: innerWidth,
    });
    cursor += 8 + body.height + 18;
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
          // `button` fits this to `exampleWidth` against the real glyphs.
          example.replace(/\s+/g, ' '),
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

  // The whole header row toggles, not just the caret glyph: a wider target is
  // easier to hit and matches the branch-heading disclosure pattern.
  const headerHitHeight = GUIDANCE_PAD + GUIDANCE_HEADER_HEIGHT;
  // The id states what is ON SCREEN: with no stored preference the open state
  // came from the project's run count, so the handler cannot re-derive it.
  const toggleId = `projects.guidance.toggle.${expanded ? 'open' : 'closed'}`;
  const header = new Container();
  header.eventMode = 'static';
  header.cursor = 'pointer';
  header.hitArea = new Rectangle(0, 0, panelWidth, headerHitHeight);
  header.position.set(x, 0);
  header.on('pointertap', () => snapshot.onActivate(toggleId));
  parent.addChild(header);
  ctx.recordHitTarget(parent, {
    id: toggleId,
    role: 'button',
    label: snapshot.t(expanded ? 'launch.help.collapse' : 'launch.help.expand'),
    x,
    y: 0,
    width: panelWidth,
    height: headerHitHeight,
  });

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

/**
 * A SELECTION IS A FILTER, not just a highlight: with one project selected the
 * list shows THAT project and nothing else, so the run form at the top of the
 * column sits directly against the card it acts on. Every other project is a
 * distraction from the run being launched. Its name moves to the page title
 * rather than repeating as an active row; re-clicking Projects in the rail
 * returns to the full list and create form.
 *
 * ONE definition, consulted by both the measuring pass (`projectLayout`) and
 * the drawing pass. Two copies of this rule would desynchronise `scrollMax`
 * from the content the moment one of them changed.
 */
function projectHidden(index: number, selectedIndex: number): boolean {
  return selectedIndex >= 0 && index !== selectedIndex;
}

function projectRowHeight(compact: boolean, selected: boolean): number {
  if (selected) {
    return compact ? SELECTED_PROJECT_COMPACT_DETAIL_HEIGHT : SELECTED_PROJECT_DETAIL_HEIGHT;
  }
  return compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT;
}

export function projectLayout(
  viewportWidth: number,
  projectCount: number,
  selectedIndex: number,
  selectedRuns: readonly VizProjectRun[]
) {
  const { x, width: panelWidth } = projectsColumn(viewportWidth);
  const compactRunRows = panelWidth < COMPACT_PROJECT_PANEL_WIDTH;

  const listTop = 16;
  let cursor = listTop;
  for (let index = 0; index < projectCount; index++) {
    if (projectHidden(index, selectedIndex)) continue;
    cursor += projectRowHeight(compactRunRows, index === selectedIndex);
    if (index !== selectedIndex) continue;
    if (selectedRuns.length === 0) {
      cursor += 24;
      continue;
    }
    cursor += RUNS_HEADING_HEIGHT;
    for (const run of selectedRuns) cursor += runRowHeight(run, compactRunRows);
  }
  const contentBottom = cursor + 20;
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
  const frame = viewFrame(width, height);
  // Selection changes the SUBJECT of the screen. Once one project is open,
  // its name is the title; the collection count and “viewing …” subtitle no
  // longer describe the job in front of the viewer.
  drawViewFrame(
    ctx,
    frame,
    selectedProject
      ? snapshot.t('projects.selectedTitle', { name: selectedProject.name })
      : snapshot.t('nav.projects'),
    selectedProject ? undefined : snapshot.t('projects.summary', { count: projects.length })
  );

  // The form's fields are DOM, but its CARD is the same GPU panel as the list
  // below. A CSS imitation could share dimensions and still disagree on the
  // pointer-driven shadow, which is exactly what made the two adjacent cards
  // read at different depths. The DOM wrapper is transparent and supplies
  // interaction only; this panel owns material, border, radius and elevation.
  const formMode: ProjectsFormMode = selectedProject ? 'run' : 'create';
  if (snapshot.data.auth !== null) {
    ctx.panel(
      ctx.root,
      frame.innerX,
      PROJECTS_DOM_FORM_TOP,
      frame.innerWidth,
      projectsFormHeight(formMode, width),
      GPU_COLORS.panel,
      GPU_COLORS.border,
      GPU_LAYOUT.radius,
      2
    );
  }

  // The DOM form is gated on a session (`projectActionsEnabled` in DomBridge),
  // so an UNGATED instance renders none — and reserving the band it would have
  // occupied left a ~260px hole between the title and the copy explaining why
  // there is nothing here. Reserve the band only when the form is really there.
  const contentTop = snapshot.data.auth === null
    ? frame.contentTop
    : projectsGpuContentTop(formMode, width);
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

  // The guidance describes the run PROMPT, but only its FIRST use: it appears
  // once a project is selected and only until that project has a run. It opens
  // for the FIRST goal on a project and steps aside afterwards
  // (`projectGuidanceOpen`), because a viewer with run history has phrased one
  // before and this panel is tall enough to bury that history. It disappears
  // WHOLE once any run exists — not merely collapsed to a lingering heading.
  // The list below shifts by its MEASURED height; nothing here estimates it.
  const guidanceProfile = snapshot.data.profiles[0];
  const listOffset =
    selectedProject && selectedRuns.length === 0 && guidanceProfile
      ? drawPromptGuidance(
          ctx,
          snapshot,
          pane.content,
          layout.x,
          layout.panelWidth,
          guidanceProfile,
          projectGuidanceOpen(snapshot.state.projectGuidanceExpanded)
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
  // The column is only as wide as the verdicts it must hold. Gather the copy
  // the VISIBLE rows will draw — a hidden project's longer status must not
  // reserve width nothing renders — and measure that.
  const statusCopy: string[] = [];
  projects.forEach((project, index) => {
    if (projectHidden(index, selectedIndex)) return;
    statusCopy.push(statusLabel(snapshot.t, project.repositoryStatus, 'projects.repoStatus'));
    if (index !== selectedIndex) return;
    for (const run of expandedRunList[index] ?? []) {
      const cost = run.costUsd === null ? '' : ` · ${runCost(run.costUsd)}`;
      statusCopy.push(`${statusLabel(snapshot.t, run.status, 'projects.runStatus')}${cost}`);
    }
  });
  const statusCol = statusColumnWidth(ctx, statusCopy, layout.panelWidth);
  const statusX = statusRight - statusCol;
  let cursor = listOffset + layout.listTop;
  projects.forEach((project, index) => {
    // A selection filters the list to its own card. Same rule the measuring
    // pass applied, so `scrollMax` describes what is really drawn.
    if (projectHidden(index, selectedIndex)) return;
    const y = cursor;
    const selected = project.projectId === snapshot.state.selectedProjectId;
    const rowLabel = project.name.replace(/\s+/g, ' ');
    const repositoryStatusCopy = statusLabel(
      snapshot.t,
      project.repositoryStatus,
      'projects.repoStatus'
    );
    const privateIconSpace = project.repositoryTarget.visibility === 'private'
      ? PRIVATE_REPOSITORY_ICON_SIZE + PRIVATE_REPOSITORY_ICON_GAP
      : 0;
    const statusWidth = ctx.measureText(repositoryStatusCopy, {
      size: STATUS_FONT_SIZE,
      mono: true,
    });
    const separatorWidth = ctx.measureText(PROJECT_INFO_SEPARATOR, {
      size: STATUS_FONT_SIZE,
      mono: true,
    });
    const destinationPath =
      `${project.repositoryTarget.owner}/${project.repositoryTarget.name}`;
    const destinationText = project.repositoryUrl ?? destinationPath;
    const destinationTextSize = project.repositoryUrl ? 9 : 10;
    const destinationTextNaturalWidth = ctx.measureText(destinationText, {
      size: destinationTextSize,
    });
    const destinationChromeWidth = project.repositoryUrl
      ? REPOSITORY_ICON_OFFSET_X + REPOSITORY_ICON_SIZE + REPOSITORY_ICON_GAP
      : 0;
    const fixedInfoWidth =
      privateIconSpace +
      statusWidth +
      PROJECT_INFO_SEPARATOR_BEFORE_GAP +
      separatorWidth +
      PROJECT_INFO_SEPARATOR_AFTER_GAP +
      destinationChromeWidth;
    // On a list row the project name keeps a useful left-hand column. In
    // detail its name is already the page title, so the repository sequence
    // may use the complete framed row.
    const nameReserve = selected
      ? 0
      : Math.min(280, Math.max(140, innerWidth * 0.22));
    const infoMaxWidth = Math.max(
      0,
      innerWidth - BUTTON_LABEL_INSET * 2 - nameReserve
    );
    const destinationTextWidth = Math.max(
      0,
      Math.min(destinationTextNaturalWidth, infoMaxWidth - fixedInfoWidth)
    );
    const infoWidth = fixedInfoWidth + destinationTextWidth;
    const infoX = selected
      ? columnX + BUTTON_LABEL_INSET
      : columnX + innerWidth - PROJECTS_ROW_PAD - infoWidth;
    const nameLabelWidth = Math.max(
      0,
      infoX - columnX - BUTTON_LABEL_INSET * 2 - PROJECT_INFO_GAP
    );

    if (!selected) {
      ctx.button(
        pane.content,
        `project.select.${project.projectId}`,
        'button',
        rowLabel,
        columnX,
        y,
        innerWidth,
        PROJECT_BUTTON_HEIGHT,
        false,
        snapshot.onActivate,
        GPU_COLORS.primary,
        false,
        false,
        nameLabelWidth,
        PROJECT_NAME_Y
      );
      const runCount = project.runCount ?? runsByProject[project.projectId]?.length;
      const lastRunAt = project.lastRunAt ?? runsByProject[project.projectId]?.[0]?.createdAt;
      const lastRunAgo = lastRunAt
        ? relativeTime(lastRunAt, snapshot.t, snapshot.state.locale)
        : '';
      const metadata = [
        snapshot.t('projects.cardCreated', {
          date: projectCreatedDate(project.createdAt, snapshot.state.locale),
        }),
        runCount === undefined
          ? null
          : lastRunAgo
            ? snapshot.t('projects.cardRunsWithLast', {
                count: runCount,
                ago: lastRunAgo,
              })
            : snapshot.t('projects.cardRuns', { count: runCount }),
      ].filter((value): value is string => value !== null).join(' · ');
      ctx.text(
        pane.content,
        metadata,
        columnX + BUTTON_LABEL_INSET,
        y + PROJECT_METADATA_Y,
        {
          size: 9,
          color: GPU_COLORS.muted,
          width: nameLabelWidth,
          singleLine: true,
        }
      );
    } else {
      ctx.panel(
        pane.content,
        columnX,
        y,
        innerWidth,
        PROJECT_BUTTON_HEIGHT,
        GPU_COLORS.panelRaised,
        GPU_COLORS.border,
        7,
        1
      );
    }
    let infoCursor = infoX;
    if (project.repositoryTarget.visibility === 'private') {
      ctx.privateRepositoryIcon(
        pane.content,
        infoCursor,
        y + 16,
        PRIVATE_REPOSITORY_ICON_SIZE
      );
      infoCursor += privateIconSpace;
    }
    ctx.text(
      pane.content,
      repositoryStatusCopy,
      infoCursor,
      y + PROJECT_INFO_TEXT_Y,
      {
        size: 10,
        color: statusColor(project.repositoryStatus),
        mono: true,
        width: statusWidth,
        singleLine: true,
      }
    );
    infoCursor += statusWidth + PROJECT_INFO_SEPARATOR_BEFORE_GAP;
    ctx.text(
      pane.content,
      PROJECT_INFO_SEPARATOR,
      infoCursor,
      y + PROJECT_INFO_TEXT_Y,
      {
        size: STATUS_FONT_SIZE,
        color: GPU_COLORS.muted,
        mono: true,
        width: separatorWidth,
        singleLine: true,
      }
    );
    infoCursor += separatorWidth + PROJECT_INFO_SEPARATOR_AFTER_GAP;
    if (project.repositoryUrl) {
      const repositoryGroupWidth =
        REPOSITORY_ICON_OFFSET_X +
        REPOSITORY_ICON_SIZE +
        REPOSITORY_ICON_GAP +
        destinationTextWidth;
      const repositoryLink = ctx.linkRegion(
        pane.content,
        `project.repository.${project.projectId}`,
        destinationText,
        infoCursor,
        y + 2,
        repositoryGroupWidth,
        REPOSITORY_ICON_SIZE,
        snapshot.onActivate
      );
      ctx.repositoryIcon(
        repositoryLink,
        REPOSITORY_ICON_OFFSET_X,
        0,
        REPOSITORY_ICON_SIZE
      );
      ctx.text(
        repositoryLink,
        destinationText,
        REPOSITORY_ICON_OFFSET_X + REPOSITORY_ICON_SIZE + REPOSITORY_ICON_GAP,
        14,
        {
          size: 9,
          color: GPU_COLORS.primary,
          width: destinationTextWidth,
          singleLine: true,
        }
      );
    } else {
      ctx.text(
        pane.content,
        destinationText,
        infoCursor,
        y + PROJECT_INFO_TEXT_Y,
        {
          size: 10,
          color: GPU_COLORS.muted,
          width: destinationTextWidth,
          singleLine: true,
        }
      );
    }
    cursor += projectRowHeight(compactRunRows, selected);

    const runs = expandedRunList[index] ?? [];
    if (selected && runs.length > 0) {
      ctx.text(
        pane.content,
        snapshot.t('projects.runsHeading', { count: runs.length }),
        runColumnX,
        cursor,
        { size: 10, color: GPU_COLORS.muted, weight: '600' }
      );
      cursor += RUNS_HEADING_HEIGHT;
      for (const run of runs) {
        const statusText = statusLabel(snapshot.t, run.status, 'projects.runStatus');
        const cost = run.costUsd === null ? '' : ` · ${runCost(run.costUsd)}`;
        const rowHeight = runRowHeight(run, compactRunRows);
        const goalWidth = compactRunRows
          ? Math.max(0, layout.panelWidth - 52)
          : Math.max(0, statusX - runColumnX - 12);
        ctx.button(
          pane.content,
          `project.run.${run.traceId ?? run.projectRunId}`,
          'button',
          // NO character-count bound here: `button` fits the label against the
          // real glyphs and its own width. A 70-char pre-truncation on top of
          // that only ever cut a goal the button had room for.
          run.goal.replace(/\s+/g, ' '),
          runColumnX,
          cursor,
          goalWidth,
          // A FIXED single-line height, independent of `rowHeight`: the extra
          // height a second line needs is appended AFTER the button, never
          // folded into it, or the button grows tall enough that its own
          // vertically-centred label lands under the second line's text.
          RUN_BUTTON_HEIGHT,
          false,
          snapshot.onActivate
        );
        // NO character-count pre-truncation: the column was MEASURED to hold
        // exactly this copy, and a `/7` estimate on top of it was what cut
        // `delivered · $1.02` down to `delivered · $1…` — dropping the cost,
        // which is the half of the verdict a reader is scanning for.
        // `singleLine` still fits it against the real glyphs as a backstop.
        const status = ctx.text(
          pane.content,
          `${statusText}${cost}`,
          compactRunRows ? runColumnX : statusRight,
          cursor + (compactRunRows ? 34 : 9),
          {
            size: 10,
            color: statusColor(run.status),
            mono: true,
            width: compactRunRows ? goalWidth : statusCol,
            singleLine: true,
          }
        );
        if (!compactRunRows) status.anchor.x = 1;
        if (run.publication && run.publication.status === 'published' && run.publication.commitSha) {
          const commit = ctx.text(
            pane.content,
            run.publication.pullRequestUrl ? snapshot.t('projects.pullRequest') : truncate(run.publication.commitSha, 12),
            compactRunRows ? runColumnX : statusRight,
            cursor + (compactRunRows ? 48 : RUN_SECOND_LINE_Y),
            {
              size: 9,
              color: GPU_COLORS.success,
              mono: true,
              width: compactRunRows ? goalWidth : statusCol,
              singleLine: true,
            }
          );
          if (!compactRunRows) commit.anchor.x = 1;
          if (run.publication.pullRequestUrl) {
            ctx.linkRegion(pane.content, `project.pullRequest.${run.projectRunId}`,
              snapshot.t('projects.pullRequest'), compactRunRows ? runColumnX : statusRight - statusCol,
              cursor + (compactRunRows ? 34 : RUN_SECOND_LINE_Y - 14),
              compactRunRows ? goalWidth : statusCol, 22, snapshot.onActivate);
          }
        } else if (run.error) {
          const boundedError = run.error.replace(/\s+/g, ' ');
          // Starts on the LABEL's vertical, not the button's border: this line
          // belongs to the goal above it, and at `runColumnX` it hung 10px out
          // to the left of the text it explains.
          const errorX = runColumnX + BUTTON_LABEL_INSET;
          ctx.text(
            pane.content,
            ctx.fitText(boundedError, goalWidth - BUTTON_LABEL_INSET, { size: 9 }),
            errorX,
            cursor + (compactRunRows ? 48 : RUN_SECOND_LINE_Y),
            {
              size: 9,
              color: GPU_COLORS.error,
              width: goalWidth - BUTTON_LABEL_INSET,
              singleLine: true,
            }
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
