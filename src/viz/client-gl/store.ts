import { create } from 'zustand';
import {
  DEFAULT_REPOSITORY_VISIBILITY,
  type RepositoryVisibility,
} from '../../contracts/projects.js';
import { isLocale, type Locale } from '../../contracts/locales.js';
import { applyDocumentLocale } from '../client/i18n-catalog.js';
import type { EventFilters } from '../client/run-utils.js';
import type { SceneCameraMode } from './scene-camera.js';

export type ViewName =
  | 'projects'
  | 'runs'
  | 'registry'
  | 'skills'
  | 'burnin'
  | 'docs'
  | 'admin'
  | 'journal'
  | 'ledger'
  | 'sentinel'
  | 'announce'
  | 'settings';

/**
 * The admin plane, one view per JOB rather than one tab holding four.
 *
 * `admin` keeps its key (organisations and invitations) because it is the
 * stored scroll key, the doc theme and the route every existing link uses;
 * its LABEL is what changed. The journal, the catalogue ledger and the
 * sentinel each answer a different question and each needs its own scroll
 * position and its own filters — which one stacked view could not give them.
 *
 * `announce` is the plane's only WRITE surface, and it is last for that
 * reason: the other four report what happened, this one reaches every
 * subscriber's pocket. It rode at the foot of the organisation list, which
 * put a broadcast composer under a screen nobody opens to broadcast, and cost
 * that list 260px of height on every visit.
 */
export const ADMIN_VIEWS: readonly ViewName[] = [
  'admin',
  'journal',
  'ledger',
  'sentinel',
  'announce',
];

/**
 * ONE definition of which nav tabs a viewer gets — the DOM tablist and the
 * GL rail both read it, or they drift.
 *
 * - Gate off (`auth` null): the classic operator developer path — every
 *   instance surface, no admin plane (there are no organisations to manage).
 * - Gated platform admin: everything, plus the admin plane.
 * - Gated member: org-scoped surfaces only. Registry, skills and burn-in are
 *   instance-global operator state; the server 403s them for non-admins, so
 *   offering the tabs would poison the global data error the way the
 *   ungated /api/projects 404 once did.
 *
 * There is no `launch` tab: a tab that could only DESCRIBE how to phrase a
 * goal, beside a Projects tab that actually starts runs, split one job over
 * two places. The family guidance now renders inside the project run form
 * (`views/projects.ts`), and the shell path for an instance with no
 * organisations is documented under the `launch` docs theme.
 */
export function visibleViews(auth: { viewer: { platformAdmin: boolean } } | null): ViewName[] {
  if (!auth) return ['projects', 'runs', 'registry', 'skills', 'burnin', 'docs'];
  if (auth.viewer.platformAdmin) {
    return ['projects', 'runs', 'registry', 'skills', 'burnin', 'docs', ...ADMIN_VIEWS];
  }
  return ['projects', 'runs', 'docs'];
}

/**
 * Doc themes are pure prose about what a feature does, never a fetch of its
 * data — so unlike `visibleViews`, every theme is offered to every viewer
 * regardless of gating. `mcp` has no nav tab of its own; it documents the
 * stdio control plane a host application connects with.
 */
export type DocsThemeKey =
  | 'projects'
  | 'runs'
  | 'registry'
  | 'skills'
  | 'burnin'
  | 'launch'
  | 'admin'
  | 'mcp';

export const DOC_THEMES: readonly { key: DocsThemeKey; ref: string }[] = [
  { key: 'projects', ref: 'src/projects/AGENTS.md' },
  { key: 'runs', ref: 'src/run/AGENTS.md' },
  { key: 'registry', ref: 'src/registry/AGENTS.md' },
  { key: 'skills', ref: 'src/skills/AGENTS.md' },
  { key: 'burnin', ref: 'src/cli/AGENTS.md' },
  { key: 'launch', ref: 'src/run/AGENTS.md' },
  { key: 'admin', ref: 'src/auth/AGENTS.md' },
  { key: 'mcp', ref: 'src/mcp/AGENTS.md' },
];

/**
 * Which views may be ACTIVE, which is not the same question as which get a nav
 * tab. Settings is reached from the account menu and deliberately has no tab —
 * without this distinction the "viewer landed on a view they cannot see" guard
 * in GpuApp would bounce it back to Projects on the very next render.
 *
 * Settings exists only where an account does: the ungated developer path has
 * no principal to configure.
 */
export function isRoutableView(
  view: ViewName,
  auth: { viewer: { platformAdmin: boolean } } | null
): boolean {
  if (view === 'settings') return auth !== null;
  return visibleViews(auth).includes(view);
}

export type InputKind =
  | 'run'
  | 'registry'
  | 'skills'
  | 'projectName'
  | 'projectPrompt'
  | 'projectRepository'
  | 'displayName'
  | null;

export function nextRunFilters(
  current: EventFilters,
  dimension: 'kind' | 'role' | 'branchId',
  value: string
): EventFilters {
  if (dimension === 'kind') return { ...current, kind: value, role: 'all' };
  if (dimension === 'role') return { ...current, kind: 'llm', role: value };
  return { ...current, branchId: value };
}

/** Re-clicking the active project is the route back to the create form. */
export function projectSelectionAfterActivate(
  currentProjectId: string | null,
  activatedProjectId: string
): string | null {
  return currentProjectId === activatedProjectId ? null : activatedProjectId;
}

/** Is the first-goal guidance open? With no preference, expose it by default. */
export function projectGuidanceOpen(preference: boolean | null): boolean {
  return preference ?? true;
}

/**
 * Repair a stale selection without turning the first project into an implicit
 * selection. An empty list may be a loading transition, so it preserves the
 * current id until a non-empty response can prove that the project is gone.
 */
export function projectSelectionAfterProjects(
  currentProjectId: string | null,
  projectIds: readonly string[]
): string | null {
  if (currentProjectId === null || projectIds.length === 0) return currentProjectId;
  return projectIds.includes(currentProjectId) ? currentProjectId : projectIds[0]!;
}

export interface GpuUiState {
  view: ViewName;
  /** Pulled-back whole scene, or the navigation focus on the content column. */
  sceneCameraMode: SceneCameraMode;
  locale: Locale;
  selectedRunId: string | null;
  selectedEventId: string | null;
  selectedAtomName: string | null;
  selectedRegistryId: string | null;
  selectedRegistryAtom: string | null;
  selectedSkill: { l1Name: string; id: string } | null;
  selectedProjectId: string | null;
  selectedGithubInstallationId: string | null;
  /**
   * The new project's repository visibility. A top-level field, like the
   * installation it sits beside in the form: `search` is one key per focusable
   * TEXT input, and a two-option select carries no focus state anyone reads.
   */
  projectVisibility: RepositoryVisibility;
  runFilters: EventFilters;
  branchHeadingExpanded: boolean;
  runSummaryExpanded: boolean;
  /**
   * The first-goal guidance disclosure. It is eligible only while the selected
   * project has no runs; the view owns that absolute rule. Within that state,
   * `null` defaults open and a toggle pins the viewer's choice for the session.
   */
  projectGuidanceExpanded: boolean | null;
  search: Record<Exclude<InputKind, null>, string>;
  focusedInput: InputKind;
  runPickerScrollY: number;
  runPickerActiveIndex: number;
  burninFamily: string;
  burninOutcome: string;
  burninPreset: string;
  burninPage: number;
  /** Journal filters. Server-side: filtering paged rows would thin the pages. */
  journalSeverity: string;
  journalFamily: string;
  selectedDocsTheme: DocsThemeKey;
  scrollY: Record<ViewName, number>;
  /**
   * Arrival gate. False until Continue (later: login). Not a nav view — the
   * chrome and data views stay behind it so SaaS auth can replace `enter()`.
   */
  entered: boolean;
  /**
   * The account menu behind the header orb. Not a view: it is an overlay drawn
   * above every view, and it closes on navigation so it can never outlive the
   * screen it was opened from.
   */
  accountMenuOpen: boolean;
  /** Endonym picker opened from the compact locale code control. */
  localeMenuOpen: boolean;
  /** Floating scene controls, opened from the foot of the admin rail. */
  tuningPanelOpen: boolean;
  /** Monotonic signal consumed by a sent announcement receipt only. */
  announcementResetSignal: number;
  enter: () => void;
  /** Reopen the arrival scene without forgetting that Continue was completed. */
  showWelcome: () => void;
  /** Crystal route: focused content restores overview; overview opens Welcome. */
  activateCrystal: () => void;
  toggleAccountMenu: () => void;
  closeAccountMenu: () => void;
  toggleLocaleMenu: () => void;
  closeLocaleMenu: () => void;
  toggleTuningPanel: () => void;
  /** User activation of a rail/tab destination; re-activation toggles framing. */
  activateView: (view: ViewName) => void;
  /** Programmatic/cross-view navigation always lands on focused content. */
  setView: (view: ViewName) => void;
  setLocale: (locale: Locale) => void;
  selectRun: (id: string | null) => void;
  selectEvent: (id: string | null) => void;
  selectAtom: (name: string | null) => void;
  selectRegistry: (id: string | null) => void;
  selectRegistryAtom: (name: string | null) => void;
  selectSkill: (selection: { l1Name: string; id: string } | null) => void;
  selectProject: (id: string | null) => void;
  selectGithubInstallation: (id: string | null) => void;
  setProjectVisibility: (visibility: RepositoryVisibility) => void;
  setRunFilters: (filters: EventFilters) => void;
  toggleBranchHeading: () => void;
  toggleRunSummary: () => void;
  /**
   * `currentlyOpen` is what the viewer SEES, which is not necessarily the
   * stored preference: with no preference the view resolved it from the run
   * count, and a toggle that flipped `null` would have to guess which way. The
   * caller knows what it drew, so it says so, and the click always does the
   * opposite of what is on screen.
   */
  toggleProjectGuidance: (currentlyOpen: boolean) => void;
  setSearch: (kind: Exclude<InputKind, null>, value: string) => void;
  setFocusedInput: (kind: InputKind) => void;
  setRunPickerScrollY: (value: number) => void;
  setRunPickerActiveIndex: (value: number) => void;
  setBurninFilter: (kind: 'family' | 'outcome' | 'preset', value: string) => void;
  setBurninPage: (page: number) => void;
  setJournalFilter: (kind: 'severity' | 'family', value: string) => void;
  selectDocsTheme: (theme: DocsThemeKey) => void;
  setScrollY: (view: ViewName, value: number) => void;
}

function initialLocale(): Locale {
  if (typeof location === 'undefined') return 'en';
  const query = new URLSearchParams(location.search).get('lang');
  if (isLocale(query)) return query;
  try {
    if (typeof localStorage === 'undefined') return 'en';
    const saved = localStorage.getItem('atoma.viz.lang');
    return isLocale(saved) ? saved : 'en';
  } catch {
    return 'en';
  }
}

// A visitor who already hit Continue once should not see the arrival gate
// again on the same browser. The gated login screen is unaffected: it
// re-blocks itself the moment whoami resolves to unauthenticated (see the
// gateBlocked effect in GpuApp.tsx), so this flag never bypasses a real login.
function initialEntered(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem('atoma.viz.entered') === '1';
  } catch {
    return false;
  }
}

/** Explicit opt-in kept for diagnostics and the real-browser tuning smoke. */
function initialTuningPanelOpen(): boolean {
  if (typeof location === 'undefined') return false;
  const value = new URLSearchParams(location.search).get('atomaTune');
  return value === '1' || value?.trim().toLowerCase() === 'true';
}

function viewChange(
  state: GpuUiState,
  view: ViewName,
  sceneCameraMode: SceneCameraMode
): Pick<
  GpuUiState,
  | 'view'
  | 'sceneCameraMode'
  | 'focusedInput'
  | 'accountMenuOpen'
  | 'localeMenuOpen'
  | 'announcementResetSignal'
> {
  return {
    view,
    sceneCameraMode,
    focusedInput: null,
    accountMenuOpen: false,
    localeMenuOpen: false,
    announcementResetSignal:
      state.view === 'announce' && view === 'announce'
        ? state.announcementResetSignal + 1
        : state.announcementResetSignal,
  };
}

export const useGpuStore = create<GpuUiState>()((set) => ({
  // The app opens on PROJECTS: it is the authenticated launch surface. Runs
  // is where you go to watch what you started, a second step rather than the
  // arrival. Ungated developer mode gets its no-project-routes empty state.
  view: 'projects',
  sceneCameraMode: 'overview',
  locale: initialLocale(),
  selectedRunId: null,
  selectedEventId: null,
  selectedAtomName: null,
  selectedRegistryId: null,
  selectedRegistryAtom: null,
  selectedSkill: null,
  selectedProjectId: null,
  selectedGithubInstallationId: null,
  projectVisibility: DEFAULT_REPOSITORY_VISIBILITY,
  runFilters: { kind: 'all', role: 'all', branchId: 'all' },
  branchHeadingExpanded: true,
  runSummaryExpanded: true,
  projectGuidanceExpanded: null,
  search: {
    run: '',
    registry: '',
    skills: '',
    projectName: '',
    projectPrompt: '',
    projectRepository: '',
    displayName: '',
  },
  focusedInput: null,
  runPickerScrollY: 0,
  runPickerActiveIndex: 0,
  burninFamily: 'all',
  burninOutcome: 'all',
  burninPreset: 'all',
  burninPage: 1,
  journalSeverity: 'all',
  journalFamily: 'all',
  selectedDocsTheme: 'runs',
  scrollY: {
    projects: 0,
    runs: 0,
    registry: 0,
    skills: 0,
    burnin: 0,
    docs: 0,
    admin: 0,
    journal: 0,
    ledger: 0,
    sentinel: 0,
    announce: 0,
    settings: 0,
  },
  entered: initialEntered(),
  accountMenuOpen: false,
  localeMenuOpen: false,
  tuningPanelOpen: initialTuningPanelOpen(),
  announcementResetSignal: 0,
  enter: () => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('atoma.viz.entered', '1');
      }
    } catch {
      // Local storage is optional.
    }
    set({ entered: true });
  },
  // This is an explicit in-app route, not a first-visit reset. Keep the
  // persisted admission bit at `1`, so a later reload still opens the product
  // directly instead of trapping a returning viewer on Welcome again.
  showWelcome: () => set({ entered: false, accountMenuOpen: false, localeMenuOpen: false }),
  activateCrystal: () => set((state) => state.sceneCameraMode === 'focus'
    ? viewChange(state, state.view, 'overview')
    : { entered: false, accountMenuOpen: false, localeMenuOpen: false }),
  toggleAccountMenu: () => set((state) => ({
    accountMenuOpen: !state.accountMenuOpen,
    localeMenuOpen: false,
  })),
  closeAccountMenu: () => set({ accountMenuOpen: false }),
  toggleLocaleMenu: () => set((state) => ({
    localeMenuOpen: !state.localeMenuOpen,
    accountMenuOpen: false,
  })),
  closeLocaleMenu: () => set({ localeMenuOpen: false }),
  toggleTuningPanel: () => set((state) => ({ tuningPanelOpen: !state.tuningPanelOpen })),
  // Navigation closes the menu: an overlay anchored to the account control must not
  // survive the screen it was opened from. Re-activating Announcements also
  // acknowledges its sent receipt; the form decides whether it is currently
  // safe to consume that signal, so an in-progress draft remains untouched.
  activateView: (view) =>
    set((state) => viewChange(
      state,
      view,
      // Arrival is the establishing overview. Any destination advances the
      // camera to its content column; re-activating that same destination is
      // the reversible route back to the whole-scene composition.
      state.view === view && state.sceneCameraMode === 'focus'
        ? 'overview'
        : 'focus'
    )),
  setView: (view) =>
    set((state) => viewChange(
      state,
      view,
      // Cross-links and account routes are navigation, not menu toggles.
      // Even an idempotent route setter keeps its destination in focus.
      'focus'
    )),
  setLocale: (locale) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('atoma.viz.lang', locale);
      }
    } catch {
      // Local storage is optional.
    }
    // ONE writer for lang, dir and the tab title — it guards `document` itself,
    // because this store is imported where there is none.
    applyDocumentLocale(locale);
    set({ locale, localeMenuOpen: false });
  },
  selectRun: (selectedRunId) =>
    set({
      selectedRunId,
      selectedEventId: null,
      selectedAtomName: null,
      runPickerScrollY: 0,
      runPickerActiveIndex: 0,
      runSummaryExpanded: true,
    }),
  selectEvent: (selectedEventId) =>
    set({
      selectedEventId,
      selectedAtomName: null,
      runSummaryExpanded: selectedEventId === null,
    }),
  selectAtom: (selectedAtomName) =>
    set({
      selectedAtomName,
      selectedEventId: null,
      runSummaryExpanded: selectedAtomName === null,
    }),
  selectRegistry: (selectedRegistryId) =>
    set({ selectedRegistryId, selectedRegistryAtom: null }),
  selectRegistryAtom: (selectedRegistryAtom) => set({ selectedRegistryAtom }),
  selectSkill: (selectedSkill) => set({ selectedSkill }),
  selectProject: (selectedProjectId) => set((state) => ({
    selectedProjectId,
    // A selected project can expand with guidance and run history. Changing
    // mode while retaining that scroll can place the shorter create list
    // entirely above its pane until another wheel event clamps it.
    scrollY: { ...state.scrollY, projects: 0 },
  })),
  selectGithubInstallation: (selectedGithubInstallationId) =>
    set({ selectedGithubInstallationId }),
  // Deliberately NOT persisted. A visibility carried over from the last
  // project would be a decision made by a previous session about a repository
  // that did not exist yet; every create starts from the stated default.
  setProjectVisibility: (projectVisibility) => set({ projectVisibility }),
  setRunFilters: (runFilters) =>
    set((state) => ({
      runFilters,
      branchHeadingExpanded:
        runFilters.branchId !== state.runFilters.branchId
          ? true
          : state.branchHeadingExpanded,
      // One notification: Pixi pointertap is not a React event, so a follow-up
      // setScrollY would remount the GPU scene and kill the role-row dissolve.
      scrollY: state.scrollY.runs === 0 ? state.scrollY : { ...state.scrollY, runs: 0 },
    })),
  toggleBranchHeading: () =>
    set((state) => ({ branchHeadingExpanded: !state.branchHeadingExpanded })),
  toggleRunSummary: () =>
    set((state) => ({ runSummaryExpanded: !state.runSummaryExpanded })),
  toggleProjectGuidance: (currentlyOpen) =>
    set({ projectGuidanceExpanded: !currentlyOpen }),
  setSearch: (kind, value) =>
    set((state) => ({ search: { ...state.search, [kind]: value } })),
  setFocusedInput: (focusedInput) => set({ focusedInput }),
  setRunPickerScrollY: (runPickerScrollY) =>
    set({ runPickerScrollY: Math.max(0, runPickerScrollY) }),
  setRunPickerActiveIndex: (runPickerActiveIndex) =>
    set({ runPickerActiveIndex: Math.max(0, runPickerActiveIndex) }),
  setBurninFilter: (kind, value) =>
    set({
      [kind === 'family'
        ? 'burninFamily'
        : kind === 'outcome'
          ? 'burninOutcome'
          : 'burninPreset']: value,
      burninPage: 1,
    } as Partial<GpuUiState>),
  setBurninPage: (burninPage) => set({ burninPage }),
  // A changed filter is a different query, so the old scroll position points
  // into rows that are no longer there: back to the top with it.
  setJournalFilter: (kind, value) =>
    set((state) => ({
      ...(kind === 'severity' ? { journalSeverity: value } : { journalFamily: value }),
      scrollY: { ...state.scrollY, journal: 0 },
    })),
  selectDocsTheme: (selectedDocsTheme) => set({ selectedDocsTheme }),
  setScrollY: (view, value) =>
    set((state) => {
      const next = Math.max(0, value);
      if (state.scrollY[view] === next) return state;
      return { scrollY: { ...state.scrollY, [view]: next } };
    }),
}));
