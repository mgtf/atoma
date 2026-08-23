import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { translate } from '../client/i18n.js';
import { loginBounceParams, providerLoginHref } from '../client/auth-session.js';
import { isIndexEntryLive } from '../client/run-utils.js';
import {
  dismissPushPrompt,
  enableWebPush,
  pushPromptStorage,
  shouldEnsureAdminSubscription,
  shouldOfferPushPrompt,
} from '../client/push.js';
import {
  emptyRenderMetrics,
  type GpuRenderMetrics,
} from './renderer/metrics.js';
import { AtomaCursor } from './AtomaCursor.js';
import { AuthControls, useAuthController } from './AuthControls.js';
import { GpuDomBridge } from './DomBridge.js';
import { EntryVeilLayer, useEntryFade } from './entry-fade.js';
import { GpuSurface } from './GpuSurface.js';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../client/data-api.js';
import {
  useAccountModels,
  useAdminEventsPages,
  useAdminLedger,
  useAdminSentinel,
  useAdminOrganisations,
  useBurnin,
  useOrganisation,
  useGithubInstallations,
  useProfiles,
  useProjectRuns,
  useProjects,
  useRegistries,
  useRegistry,
  useRunTrace,
  useRunsIndex,
  useSkillDetail,
  useSkillLists,
  useSkillNamespaces,
} from './queries.js';
import {
  isRoutableView,
  nextRunFilters,
  projectSelectionAfterActivate,
  projectSelectionAfterProjects,
  useGpuStore,
  visibleViews,
  type DocsThemeKey,
} from './store.js';
import { parseSettingsModelId } from './renderer/views/settings.js';
import type { VizAdminInvitation } from '../client/types.js';

const RELEASE_VERSION = __ATOMA_RELEASE_VERSION__;

declare global {
  interface Window {
    __ATOMA_VIZ_TEST__?: {
      view: string;
      renderer: GpuRenderMetrics;
      selectedRunId: string | null;
      dispatch: (id: string) => void;
    };
  }
}

function errorMessage(errors: unknown[]) {
  const found = errors.find(Boolean);
  if (found instanceof Error) return found.message;
  if (typeof found === 'string') return found;
  if (typeof found === 'number' || typeof found === 'boolean') return String(found);
  return found ? 'Unknown visualizer query error' : null;
}

export function GpuApp() {
  const locale = useGpuStore((snapshot) => snapshot.locale);
  const entered = useGpuStore((snapshot) => snapshot.entered);
  const t = useCallback(
    (key: string, vars?: Record<string, unknown>) => translate(locale, key, vars),
    [locale]
  );
  return (
    <AuthControls active={entered} t={t}>
      <GpuAppContent t={t} />
    </AuthControls>
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function GpuAppContent({
  t,
}: {
  t: (key: string, vars?: Record<string, unknown>) => string;
}) {
  const state = useGpuStore();
  const queryClient = useQueryClient();
  const {
    snapshot: authSnapshot,
    gate: authGate,
    providers: authProviders,
    activate: activateAuth,
  } = useAuthController();
  // The arrival gate doubles as the login when the server says the gate is
  // on and this browser holds no session. Every data query stays dark until
  // the gate is KNOWN ('off' or 'authenticated'): firing /api/* while whoami
  // is still in flight earned a 401 whose handler reloads '/', which re-ran
  // the race — an infinite reload loop the first gated screenshot caught.
  const gateBlocked = authGate === 'unauthenticated';
  const apiReady = authGate === 'off' || authGate === 'authenticated';
  // Bounce parameters from the server's auth flow, read once per page load:
  // ?authNotice=<code> names a login failure to display, ?invite=<token>
  // must ride every provider link so the invitation admits the account the
  // visitor signs in with. Parsing and href building are the unit-tested
  // helpers in auth-session.ts.
  const loginParams = useMemo(() => loginBounceParams(window.location.search), []);
  const loginHref = useCallback(
    (providerId: string) => providerLoginHref(providerId, loginParams.invite),
    [loginParams.invite]
  );
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const metrics = useRef<GpuRenderMetrics>(emptyRenderMetrics());
  const { phase: entryPhase, begin: beginEnter } = useEntryFade();

  // Operator surfaces are admin-only behind the gate: the server 403s them
  // for ordinary members, and a 403'd query would poison the global data
  // error exactly the way the ungated /api/projects 404 once did. Ungated
  // (auth null) keeps the classic developer path.
  const operatorSurfaces =
    apiReady && (authSnapshot === null || authSnapshot.viewer.platformAdmin);
  const isPlatformAdmin = authSnapshot?.viewer.platformAdmin === true;
  const runsQuery = useRunsIndex(state.view === 'runs' && apiReady);
  const runQuery = useRunTrace(state.selectedRunId, state.view === 'runs' && apiReady);
  const registriesQuery = useRegistries(state.view === 'registry' && operatorSurfaces);
  const registryQuery = useRegistry(
    state.selectedRegistryId,
    state.view === 'registry' && operatorSurfaces
  );
  const namespacesQuery = useSkillNamespaces(state.view === 'skills' && operatorSurfaces);
  const namespaceNames = useMemo(
    () => (namespacesQuery.data ?? []).map((item) => item.l1Name),
    [namespacesQuery.data]
  );
  const skillLists = useSkillLists(namespaceNames, state.view === 'skills' && operatorSurfaces);
  const selectedRunEvent = useMemo(
    () => runQuery.data?.events.find((event) => event.id === state.selectedEventId) ?? null,
    [runQuery.data, state.selectedEventId]
  );
  const runSkillNs = selectedRunEvent?.l1AtomId ?? selectedRunEvent?.l1Name;
  const runSkillSelection =
    state.view === 'runs' &&
    selectedRunEvent?.kind === 'skill' &&
    runSkillNs &&
    selectedRunEvent.skillId
      ? { l1Name: runSkillNs, id: selectedRunEvent.skillId }
      : null;
  const skillSelection = state.view === 'skills' ? state.selectedSkill : runSkillSelection;
  const skillDetailQuery = useSkillDetail(skillSelection, Boolean(skillSelection) && operatorSurfaces);
  const burninQuery = useBurnin(state.view === 'burnin' && operatorSurfaces);
  // The family guidance renders inside the project run form, so it is fetched
  // with the Projects view. It is supplementary copy, never gating: it is
  // deliberately absent from `loading` below, so a slow /api/profiles cannot
  // hide the project list behind a spinner.
  const profilesQuery = useProfiles(state.view === 'projects' && apiReady);
  // Project routes exist only behind the auth gate; an ungated server 404s
  // them. Left enabled, those 404s poisoned the GLOBAL `data.error` below and
  // the runs view then rendered an error banner instead of its list — the
  // wheel handler fails closed on scrollMax, so scrolling died with it.
  const authed = authSnapshot !== null;
  const projectsQuery = useProjects(state.view === 'projects' && authed);
  const githubInstallationsQuery = useGithubInstallations(state.view === 'projects' && authed);
  const selectedProject = state.view === 'projects'
    ? projectsQuery.data?.find((project) => project.projectId === state.selectedProjectId) ?? null
    : null;
  const projectRunsQuery = useProjectRuns(
    selectedProject?.projectId ?? null,
    state.view === 'projects' && !!selectedProject
  );
  const projectRuns = useMemo<Record<string, import('../client/types.js').VizProjectRun[]>>(
    () =>
      selectedProject && projectRunsQuery.data
        ? { [selectedProject.projectId]: projectRunsQuery.data }
        : {},
    [projectRunsQuery.data, selectedProject]
  );

  const login = useMemo(
    () => (gateBlocked ? { providers: authProviders, notice: loginParams.notice } : null),
    [authProviders, gateBlocked, loginParams.notice]
  );

  // For MEMBERS the permission ask lives in the FIRST RUN, not at login: the
  // moment a viewer's run is actually alive is when "hear about it even
  // offline" has visible value, and it is one-shot per browser. PLATFORM
  // ADMINS must end up subscribed — push routes target them for a curated set
  // of instance-wide platform events with or without a run — so they are
  // asked at login, and their "not now" only holds for the session
  // (`pushPromptStorage` picks the store).
  // Enabling or denying ends the offer for everyone: `shouldOfferPushPrompt`
  // re-checks the browser permission and the stored dismissal every time.
  const [pushPrompt, setPushPrompt] = useState<'hidden' | 'offer' | 'busy' | 'error'>('hidden');
  const hasLiveRun = useMemo(() => {
    const projectRunLive = Object.values(projectRuns).some((runs) =>
      runs.some((run) => run.status === 'queued' || run.status === 'running')
    );
    return projectRunLive || (runsQuery.data ?? []).some((entry) => isIndexEntryLive(entry));
  }, [projectRuns, runsQuery.data]);
  useEffect(() => {
    if (pushPrompt !== 'hidden') return;
    if (
      shouldOfferPushPrompt({
        authenticated: authed,
        hasLiveRun,
        platformAdmin: isPlatformAdmin,
      })
    ) {
      setPushPrompt('offer');
    }
  }, [authed, hasLiveRun, isPlatformAdmin, pushPrompt]);
  const enablePush = useCallback(async () => {
    setPushPrompt('busy');
    const outcome = await enableWebPush();
    if (outcome === 'error') {
      setPushPrompt('error');
      return;
    }
    // enabled, denied and unsupported all end the conversation for good.
    dismissPushPrompt(pushPromptStorage(isPlatformAdmin));
    setPushPrompt('hidden');
  }, [isPlatformAdmin]);
  const dismissPush = useCallback(() => {
    dismissPushPrompt(pushPromptStorage(isPlatformAdmin));
    setPushPrompt('hidden');
  }, [isPlatformAdmin]);
  // A permission already granted shows NO prompt (`permission !== 'default'`
  // ends the offer), so an admin who said yes once is silently re-subscribed
  // instead: enableWebPush reuses the browser subscription and re-saves it,
  // repairing a pruned server row without any UI or gesture. Once per mount —
  // the outcome cannot change within a page load.
  const ensuredAdminPush = useRef(false);
  useEffect(() => {
    if (ensuredAdminPush.current) return;
    if (!shouldEnsureAdminSubscription({ authenticated: authed, platformAdmin: isPlatformAdmin })) {
      return;
    }
    ensuredAdminPush.current = true;
    void enableWebPush();
  }, [authed, isPlatformAdmin]);

  // Settings is account-scoped: it exists exactly where a principal does.
  const organisationQuery = useOrganisation(state.view === 'settings' && authed);
  const accountModelsQuery = useAccountModels(state.view === 'settings' && authed);
  const [accountError, setAccountError] = useState<string | null>(null);
  const saveTierModel = useCallback(
    async (tier: 1 | 2 | 3, model: string | null) => {
      const current = accountModelsQuery.data?.pins ?? { l1: null, l2: null, l3: null };
      setAccountError(null);
      try {
        const next = await api.saveAccountModels({ ...current, [`l${tier}`]: model });
        // Seed the cache with the server's answer instead of refetching: it
        // returns the stored pins, so a round trip would tell us nothing new.
        queryClient.setQueryData(['viz', 'account', 'models'], next);
      } catch (error) {
        setAccountError(error instanceof Error ? error.message : t('settings.actionFailed'));
      }
    },
    [accountModelsQuery.data, queryClient, t]
  );
  const renameAccount = useCallback(
    async (displayName: string) => {
      setAccountError(null);
      try {
        await api.renameAccount(displayName);
        // whoami owns the display name and the source flag, and AuthControls
        // reads it once per page load — a reload is the honest refresh here.
        window.location.reload();
      } catch (error) {
        setAccountError(error instanceof Error ? error.message : t('settings.actionFailed'));
      }
    },
    [t]
  );

  // Seed the rename field with the name it is about to replace, once: an empty
  // box beside "Save" reads as "your name is blank".
  useEffect(() => {
    if (state.view !== 'settings' || !authSnapshot) return;
    if (state.search.displayName.length > 0) return;
    state.setSearch('displayName', authSnapshot.viewer.displayName);
  }, [authSnapshot, state]);

  const adminOrganisationsQuery = useAdminOrganisations(
    state.view === 'admin' && isPlatformAdmin
  );
  // The journal, the ledger tail and the sentinel read ride the same
  // admin-only gate as the organisation list: the server 403s them for anyone
  // else, and a poisoned query would take the whole view's error banner with
  // it. Each is enabled on ITS OWN view now — the three used to load together
  // because they shared one tab, which meant opening Admin fetched three
  // things to show one.
  const adminEventsQuery = useAdminEventsPages(state.view === 'journal' && isPlatformAdmin, {
    severity: state.journalSeverity,
    family: state.journalFamily,
  });
  const adminLedgerQuery = useAdminLedger(state.view === 'ledger' && isPlatformAdmin);
  const adminSentinelQuery = useAdminSentinel(state.view === 'sentinel' && isPlatformAdmin);
  // ONE way to ask for the next page, so the wheel gesture and the button
  // cannot diverge. React Query makes a second call while one is in flight a
  // no-op, and `hasNextPage` false makes it a no-op too — which is what lets
  // the wheel announce the bottom on every tick without consequence.
  const loadOlderEvents = useCallback(() => {
    if (!adminEventsQuery.hasNextPage || adminEventsQuery.isFetchingNextPage) return;
    void adminEventsQuery.fetchNextPage();
  }, [adminEventsQuery]);
  const [adminInvitation, setAdminInvitation] = useState<VizAdminInvitation | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const mintInvitation = useCallback(async (orgId: string, role: string) => {
    setAdminError(null);
    try {
      const invitation = await api.createAdminInvitation({ orgId, role });
      setAdminInvitation(invitation);
      try {
        // Best effort: the URL also stays visible in the admin view for
        // manual transcription when the clipboard is unavailable.
        await navigator.clipboard.writeText(invitation.url);
      } catch {
        // Display fallback covers it.
      }
      await queryClient.invalidateQueries({ queryKey: ['viz', 'admin', 'organisations'] });
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : t('admin.actionFailed'));
    }
  }, [queryClient, t]);

  // A viewer whose nav does not include the current view (role changed,
  // admin revoked, stale state) lands back on projects instead of a dead tab.
  // ROUTABLE, not visible: Settings has no tab by design and would otherwise
  // be bounced away on the render right after it opened.
  useEffect(() => {
    if (!isRoutableView(state.view, authSnapshot)) state.setView('projects');
  }, [authSnapshot, state]);

  // A very fast Continue click while whoami was still in flight could enter
  // the app before the gate resolved to 'unauthenticated'. Send that visitor
  // back to the arrival gate — it is the login.
  useEffect(() => {
    if (gateBlocked && state.entered) useGpuStore.setState({ entered: false });
  }, [gateBlocked, state.entered]);

  useEffect(() => {
    const runs = runsQuery.data ?? [];
    if (!state.selectedRunId && runs[0]) state.selectRun(runs[0].id);
  }, [runsQuery.data, state]);

  useEffect(() => {
    const registries = registriesQuery.data ?? [];
    if (!state.selectedRegistryId && registries[0]) {
      state.selectRegistry(registries.find((item) => item.exists)?.id ?? registries[0].id);
    }
  }, [registriesQuery.data, state]);

  useEffect(() => {
    const types = registryQuery.data?.types ?? [];
    if (!state.selectedRegistryAtom && types[0]) state.selectRegistryAtom(types[0].name);
  }, [registryQuery.data, state]);

  useEffect(() => {
    if (state.selectedSkill) return;
    const firstNamespace = namespaceNames[0];
    const firstSkill = firstNamespace ? skillLists.byNamespace[firstNamespace]?.[0] : undefined;
    if (firstNamespace && firstSkill) {
      state.selectSkill({ l1Name: firstNamespace, id: firstSkill.id });
    }
  }, [namespaceNames, skillLists.byNamespace, state]);

  // NO auto-select of the first project. The form the Projects view carries is
  // the create form until a project is selected, so auto-selecting one made
  // creating a project unreachable for anyone who already had one — and it
  // would have re-selected on the render right after a deselect, so the toggle
  // in `activate` could never land either. Only the REPAIR remains: a
  // selection whose project is gone falls back to the first that exists.
  useEffect(() => {
    const projects = projectsQuery.data ?? [];
    if (state.view !== 'projects') return;
    const nextSelection = projectSelectionAfterProjects(
      state.selectedProjectId,
      projects.map((project) => project.projectId)
    );
    if (nextSelection !== state.selectedProjectId) state.selectProject(nextSelection);
  }, [projectsQuery.data, state]);

  useEffect(() => {
    const installations = githubInstallationsQuery.data ?? [];
    const active = installations.filter((installation) => installation.status === 'active');
    if (state.view !== 'projects') return;
    if (!state.selectedGithubInstallationId && active[0]) {
      state.selectGithubInstallation(active[0].installationId);
    }
  }, [githubInstallationsQuery.data, state]);

  const createProject = useCallback(async (): Promise<void> => {
    if (projectBusy) return;
    const name = useGpuStore.getState().search.projectName.trim();
    const repository = useGpuStore.getState().search.projectRepository.trim();
    const installationId = useGpuStore.getState().selectedGithubInstallationId;
    const installation = githubInstallationsQuery.data?.find(
      (candidate) => candidate.installationId === installationId
    );
    const slug = slugify(name);
    if (!name || !slug || !installation) {
      setProjectError(t('projects.actionFailed'));
      return;
    }
    setProjectBusy(true);
    setProjectError(null);
    try {
      const created = await api.createProject({
        name,
        slug,
        repositoryTarget: {
          installationId: installation.installationId,
          owner: installation.accountLogin,
          name: repository || slug,
          visibility: 'private',
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['viz', 'projects'] });
      useGpuStore.getState().selectProject(created.projectId);
    } catch {
      setProjectError(t('projects.actionFailed'));
    } finally {
      setProjectBusy(false);
    }
  }, [githubInstallationsQuery.data, projectBusy, queryClient, t]);

  const startProjectRun = useCallback(async (): Promise<void> => {
    if (projectBusy) return;
    const projectId = useGpuStore.getState().selectedProjectId;
    const goal = useGpuStore.getState().search.projectPrompt.trim();
    if (!projectId) {
      setProjectError(t('projects.actionFailed'));
      return;
    }
    if (!goal) {
      setProjectError(t('projects.promptRequired'));
      return;
    }
    setProjectBusy(true);
    setProjectError(null);
    try {
      await api.startProjectRun(projectId, {
        idempotencyKey: crypto.randomUUID(),
        goal,
      });
      await queryClient.invalidateQueries({ queryKey: ['viz', 'project', projectId, 'runs'] });
      await queryClient.invalidateQueries({ queryKey: ['viz', 'projects'] });
      await queryClient.invalidateQueries({ queryKey: ['viz', 'runs'] });
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : t('projects.actionFailed'));
    } finally {
      setProjectBusy(false);
    }
  }, [projectBusy, queryClient, t]);

  const activate = useCallback((id: string) => {
    const store = useGpuStore.getState();
    // The menu's own open/closed state is UI, not identity, so it is handled
    // here rather than delegated to the auth controller.
    if (id === 'account.menu.toggle') {
      store.toggleAccountMenu();
      return;
    }
    if (id === 'account.menu.close') {
      store.closeAccountMenu();
      return;
    }
    if (id === 'account.settings') {
      store.setView('settings');
      return;
    }
    const modelChoice = parseSettingsModelId(id);
    if (modelChoice) {
      void saveTierModel(modelChoice.tier, modelChoice.model);
      return;
    }
    if (id.startsWith('auth.')) {
      activateAuth(id);
      return;
    }
    if (id === 'welcome.continue') {
      beginEnter();
      return;
    }
    if (id.startsWith('nav.')) {
      store.setView(id.slice(4) as typeof store.view);
      return;
    }
    if (id === 'locale.toggle') {
      store.setLocale(store.locale === 'en' ? 'fr' : 'en');
      return;
    }
    if (id.startsWith('run.select.')) {
      store.selectRun(id.slice('run.select.'.length));
      store.setFocusedInput(null);
      return;
    }
    if (id.startsWith('event.')) {
      store.selectEvent(id.slice('event.'.length));
      return;
    }
    if (id.startsWith('atom.')) {
      store.selectAtom(id.slice('atom.'.length));
      return;
    }
    if (id.startsWith('run.filter.kind.')) {
      store.setRunFilters(
        nextRunFilters(store.runFilters, 'kind', id.slice('run.filter.kind.'.length))
      );
      return;
    }
    if (id.startsWith('run.filter.role.')) {
      store.setRunFilters(
        nextRunFilters(store.runFilters, 'role', id.slice('run.filter.role.'.length))
      );
      return;
    }
    if (id.startsWith('run.filter.branch.')) {
      store.setRunFilters(
        nextRunFilters(store.runFilters, 'branchId', id.slice('run.filter.branch.'.length))
      );
      return;
    }
    if (id === 'branch.heading.toggle') {
      store.toggleBranchHeading();
      return;
    }
    if (id === 'run.summary.toggle') {
      store.toggleRunSummary();
      return;
    }
    if (id.startsWith('project.select.')) {
      // Toggle: re-clicking the selected project deselects it, which is how a
      // viewer who already has projects gets the create form back. No extra
      // control for it — the row is the control.
      const projectId = id.slice('project.select.'.length);
      store.selectProject(projectSelectionAfterActivate(store.selectedProjectId, projectId));
      return;
    }
    if (id.startsWith('project.run.')) {
      store.selectRun(id.slice('project.run.'.length));
      store.setView('runs');
      return;
    }
    if (id.startsWith('registry.select.')) {
      store.selectRegistry(id.slice('registry.select.'.length));
      return;
    }
    if (id.startsWith('registry.atom.')) {
      store.selectRegistryAtom(id.slice('registry.atom.'.length));
      return;
    }
    if (id.startsWith('skill.open.') || id.startsWith('skill.select.')) {
      const marker = id.startsWith('skill.open.') ? 'skill.open.' : 'skill.select.';
      const [l1Name, skillId] = id.slice(marker.length).split('::');
      if (l1Name && skillId) {
        store.selectSkill({ l1Name, id: skillId });
        store.setView('skills');
      }
      return;
    }
    if (id.startsWith('burnin.family.')) {
      store.setBurninFilter('family', id.slice('burnin.family.'.length));
      return;
    }
    if (id.startsWith('burnin.outcome.')) {
      store.setBurninFilter('outcome', id.slice('burnin.outcome.'.length));
      return;
    }
    if (id.startsWith('burnin.preset.')) {
      store.setBurninFilter('preset', id.slice('burnin.preset.'.length));
      return;
    }
    if (id === 'burnin.page.prev') {
      store.setBurninPage(Math.max(1, store.burninPage - 1));
      return;
    }
    if (id === 'burnin.page.next') {
      store.setBurninPage(store.burninPage + 1);
      return;
    }
    if (id.startsWith('burnin.trace.')) {
      store.selectRun(id.slice('burnin.trace.'.length));
      store.setView('runs');
      return;
    }
    if (id.startsWith('docs.theme.')) {
      store.selectDocsTheme(id.slice('docs.theme.'.length) as DocsThemeKey);
      return;
    }
    if (id.startsWith('projects.example.')) {
      const index = Number(id.slice('projects.example.'.length));
      const example = profilesQuery.data?.profiles[0]?.examples[index];
      if (example) store.setSearch('projectPrompt', example);
      return;
    }
    if (id.startsWith('login.provider.')) {
      window.location.assign(loginHref(id.slice('login.provider.'.length)));
      return;
    }
    if (id.startsWith('journal.severity.')) {
      store.setJournalFilter('severity', id.slice('journal.severity.'.length));
      return;
    }
    if (id.startsWith('journal.family.')) {
      store.setJournalFilter('family', id.slice('journal.family.'.length));
      return;
    }
    // The gesture and the button, one handler. `scroll.end.<view>` is the
    // renderer saying a downward wheel had nowhere left to go.
    if (id === 'journal.more' || id === 'scroll.end.journal') {
      loadOlderEvents();
      return;
    }
    if (id.startsWith('scroll.end.')) return;
    if (id.startsWith('sentinel.run.')) {
      store.selectRun(id.slice('sentinel.run.'.length));
      store.setView('runs');
      return;
    }
    if (id.startsWith('admin.invite.')) {
      const rest = id.slice('admin.invite.'.length);
      const separator = rest.indexOf('.');
      const role = rest.slice(0, separator);
      const orgId = rest.slice(separator + 1);
      if (role && orgId) void mintInvitation(orgId, role);
      return;
    }
  }, [
    activateAuth,
    beginEnter,
    loadOlderEvents,
    loginHref,
    mintInvitation,
    profilesQuery.data,
    saveTierModel,
  ]);

  const loading =
    (state.view === 'projects' && (projectsQuery.isLoading || githubInstallationsQuery.isLoading)) ||
    (state.view === 'runs' && (runsQuery.isLoading || runQuery.isLoading)) ||
    (state.view === 'registry' && (registriesQuery.isLoading || registryQuery.isLoading)) ||
    (state.view === 'skills' && namespacesQuery.isLoading) ||
    (state.view === 'burnin' && burninQuery.isLoading) ||
    (state.view === 'admin' && adminOrganisationsQuery.isLoading) ||
    // The FIRST page only. A later page loads under a foot-of-list notice
    // inside the view; swapping the whole screen for "loading" while the
    // viewer reads row 300 would throw their place away.
    (state.view === 'journal' && adminEventsQuery.isLoading) ||
    (state.view === 'ledger' && adminLedgerQuery.isLoading) ||
    (state.view === 'sentinel' && adminSentinelQuery.isLoading) ||
    (state.view === 'settings' && (organisationQuery.isLoading || accountModelsQuery.isLoading));
  const error = errorMessage([
    runsQuery.error,
    runQuery.error,
    registriesQuery.error,
    registryQuery.error,
    namespacesQuery.error,
    ...skillLists.results.map((result) => result.error),
    skillDetailQuery.error,
    burninQuery.error,
    profilesQuery.error,
    projectsQuery.error,
    githubInstallationsQuery.error,
    projectRunsQuery.error,
    adminOrganisationsQuery.error,
    organisationQuery.error,
    accountModelsQuery.error,
    adminEventsQuery.error,
    adminLedgerQuery.error,
    adminSentinelQuery.error,
  ]);
  const data = useMemo(() => ({
    auth: authSnapshot,
    runs: runsQuery.data ?? [],
    run: runQuery.data ?? null,
    registries: registriesQuery.data ?? [],
    registry: registryQuery.data ?? null,
    skillNamespaces: namespacesQuery.data ?? [],
    skillsByNamespace: skillLists.byNamespace,
    skillDetail: skillDetailQuery.data ?? null,
    burnin: burninQuery.data ?? null,
    profiles: profilesQuery.data?.profiles ?? [],
    projects: projectsQuery.data ?? [],
    projectRuns,
    githubInstallations: githubInstallationsQuery.data ?? [],
    adminOrganisations: adminOrganisationsQuery.data ?? [],
    adminEvents: adminEventsQuery.data?.pages.flatMap((page) => page.events) ?? [],
    adminEventsHasMore: adminEventsQuery.hasNextPage === true,
    adminEventsLoading: adminEventsQuery.isFetchingNextPage === true,
    adminLedger: adminLedgerQuery.data?.events ?? [],
    adminSentinel: adminSentinelQuery.data ?? null,
    adminInvitation,
    adminError,
    organisation: organisationQuery.data ?? null,
    accountModels: accountModelsQuery.data ?? null,
    accountError,
    login,
    loading,
    error,
  }), [
    accountError,
    accountModelsQuery.data,
    adminError,
    adminInvitation,
    adminOrganisationsQuery.data,
    adminEventsQuery.data,
    adminEventsQuery.hasNextPage,
    adminEventsQuery.isFetchingNextPage,
    adminLedgerQuery.data,
    adminSentinelQuery.data,
    authSnapshot,
    organisationQuery.data,
    login,
    burninQuery.data,
    error,
    githubInstallationsQuery.data,
    loading,
    namespacesQuery.data,
    profilesQuery.data,
    projectRuns,
    projectsQuery.data,
    registriesQuery.data,
    registryQuery.data,
    runQuery.data,
    runsQuery.data,
    skillDetailQuery.data,
    skillLists.byNamespace,
  ]);

  const updateMetrics = useCallback((next: GpuRenderMetrics) => {
    metrics.current = next;
    if (import.meta.env.DEV && window.__ATOMA_VIZ_TEST__) {
      window.__ATOMA_VIZ_TEST__.renderer = next;
    }
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__ATOMA_VIZ_TEST__ = {
      view: state.view,
      renderer: metrics.current,
      selectedRunId: state.selectedRunId,
      dispatch: activate,
    };
    return () => {
      delete window.__ATOMA_VIZ_TEST__;
    };
  }, [activate, state.selectedRunId, state.view]);

  return (
    <main className="gpu-app">
      <GpuSurface
        data={data}
        releaseVersion={RELEASE_VERSION}
        t={t}
        onActivate={activate}
        onMetrics={updateMetrics}
      />
      <GpuDomBridge
        authSnapshot={authSnapshot}
        runs={runsQuery.data ?? []}
        releaseVersion={RELEASE_VERSION}
        views={visibleViews(authSnapshot)}
        loginLinks={
          login
            ? login.providers.map((provider) => ({
                id: provider.id,
                label: provider.label,
                href: loginHref(provider.id),
              }))
            : null
        }
        t={t}
        onSelectRun={state.selectRun}
        onEnter={beginEnter}
        githubInstallations={githubInstallationsQuery.data ?? []}
        projects={projectsQuery.data ?? []}
        onCreateProject={() => { void createProject(); }}
        onStartRun={() => { void startProjectRun(); }}
        projectBusy={projectBusy}
        projectError={projectError}
        pushPrompt={pushPrompt}
        onEnablePush={() => { void enablePush(); }}
        onDismissPush={dismissPush}
        onRenameAccount={(displayName) => { void renameAccount(displayName); }}
        accountError={accountError}
      />
      <AtomaCursor />
      <EntryVeilLayer phase={entryPhase} />
    </main>
  );
}
