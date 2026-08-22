import { create } from 'zustand';
import type { EventFilters } from '../client/run-utils.js';

export type ViewName =
  | 'projects'
  | 'runs'
  | 'registry'
  | 'skills'
  | 'burnin'
  | 'docs'
  | 'admin'
  | 'settings';

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
    return ['projects', 'runs', 'registry', 'skills', 'burnin', 'docs', 'admin'];
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
  locale: 'en' | 'fr';
  selectedRunId: string | null;
  selectedEventId: string | null;
  selectedAtomName: string | null;
  selectedRegistryId: string | null;
  selectedRegistryAtom: string | null;
  selectedSkill: { l1Name: string; id: string } | null;
  selectedProjectId: string | null;
  selectedGithubInstallationId: string | null;
  runFilters: EventFilters;
  branchHeadingExpanded: boolean;
  runSummaryExpanded: boolean;
  search: Record<Exclude<InputKind, null>, string>;
  focusedInput: InputKind;
  runPickerScrollY: number;
  runPickerActiveIndex: number;
  burninFamily: string;
  burninOutcome: string;
  burninPreset: string;
  burninPage: number;
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
  enter: () => void;
  toggleAccountMenu: () => void;
  closeAccountMenu: () => void;
  setView: (view: ViewName) => void;
  setLocale: (locale: 'en' | 'fr') => void;
  selectRun: (id: string | null) => void;
  selectEvent: (id: string | null) => void;
  selectAtom: (name: string | null) => void;
  selectRegistry: (id: string | null) => void;
  selectRegistryAtom: (name: string | null) => void;
  selectSkill: (selection: { l1Name: string; id: string } | null) => void;
  selectProject: (id: string | null) => void;
  selectGithubInstallation: (id: string | null) => void;
  setRunFilters: (filters: EventFilters) => void;
  toggleBranchHeading: () => void;
  toggleRunSummary: () => void;
  setSearch: (kind: Exclude<InputKind, null>, value: string) => void;
  setFocusedInput: (kind: InputKind) => void;
  setRunPickerScrollY: (value: number) => void;
  setRunPickerActiveIndex: (value: number) => void;
  setBurninFilter: (kind: 'family' | 'outcome' | 'preset', value: string) => void;
  setBurninPage: (page: number) => void;
  selectDocsTheme: (theme: DocsThemeKey) => void;
  setScrollY: (view: ViewName, value: number) => void;
}

function initialLocale(): 'en' | 'fr' {
  if (typeof location === 'undefined') return 'en';
  const query = new URLSearchParams(location.search).get('lang');
  if (query === 'fr') return 'fr';
  try {
    if (typeof localStorage === 'undefined') return 'en';
    return localStorage.getItem('atoma.viz.lang') === 'fr' ? 'fr' : 'en';
  } catch {
    return 'en';
  }
}

export const useGpuStore = create<GpuUiState>()((set) => ({
  // The app opens on PROJECTS: it is the authenticated launch surface. Runs
  // is where you go to watch what you started, a second step rather than the
  // arrival. Ungated developer mode gets its no-project-routes empty state.
  view: 'projects',
  locale: initialLocale(),
  selectedRunId: null,
  selectedEventId: null,
  selectedAtomName: null,
  selectedRegistryId: null,
  selectedRegistryAtom: null,
  selectedSkill: null,
  selectedProjectId: null,
  selectedGithubInstallationId: null,
  runFilters: { kind: 'all', role: 'all', branchId: 'all' },
  branchHeadingExpanded: true,
  runSummaryExpanded: true,
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
  selectedDocsTheme: 'runs',
  scrollY: {
    projects: 0,
    runs: 0,
    registry: 0,
    skills: 0,
    burnin: 0,
    docs: 0,
    admin: 0,
    settings: 0,
  },
  entered: false,
  accountMenuOpen: false,
  enter: () => set({ entered: true }),
  toggleAccountMenu: () => set((state) => ({ accountMenuOpen: !state.accountMenuOpen })),
  closeAccountMenu: () => set({ accountMenuOpen: false }),
  // Navigation closes the menu: an overlay anchored to the header must not
  // survive the screen it was opened from.
  setView: (view) => set({ view, focusedInput: null, accountMenuOpen: false }),
  setLocale: (locale) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('atoma.viz.lang', locale);
      }
    } catch {
      // Local storage is optional.
    }
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
    set({ locale });
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
  selectDocsTheme: (selectedDocsTheme) => set({ selectedDocsTheme }),
  setScrollY: (view, value) =>
    set((state) => {
      const next = Math.max(0, value);
      if (state.scrollY[view] === next) return state;
      return { scrollY: { ...state.scrollY, [view]: next } };
    }),
}));
