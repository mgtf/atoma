import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { translate } from '../client/i18n.js';
import {
  emptyRenderMetrics,
  type GpuRenderMetrics,
} from './renderer/metrics.js';
import { AtomaCursor } from './AtomaCursor.js';
import { AuthControls, useAuthController } from './AuthControls.js';
import { DomBridge } from './DomBridge.js';
import { EntryVeilLayer, useEntryFade } from './entry-fade.js';
import { GpuSurface } from './GpuSurface.js';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { api } from '../client/data-api.js';
import {
  activeViewQueryFilter,
  useAdminOrganisations,
  useBurnin,
  useGithubInstallations,
  useProfiles,
  useProjectRuns,
  useProjects,
  useRefreshBridge,
  useRegistries,
  useRegistry,
  useRunTrace,
  useRunsIndex,
  useSkillDetail,
  useSkillLists,
  useSkillNamespaces,
} from './queries.js';
import { nextRunFilters, useGpuStore, visibleViews } from './store.js';
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
  const { snapshot: authSnapshot, activate: activateAuth } = useAuthController();
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const metrics = useRef<GpuRenderMetrics>(emptyRenderMetrics());
  const { phase: entryPhase, begin: beginEnter } = useEntryFade();
  useRefreshBridge();

  // Operator surfaces are admin-only behind the gate: the server 403s them
  // for ordinary members, and a 403'd query would poison the global data
  // error exactly the way the ungated /api/projects 404 once did. Ungated
  // (auth null) keeps the classic developer path.
  const operatorSurfaces = authSnapshot === null || authSnapshot.viewer.platformAdmin;
  const isPlatformAdmin = authSnapshot?.viewer.platformAdmin === true;
  const runsQuery = useRunsIndex(state.view === 'runs');
  const runQuery = useRunTrace(state.selectedRunId, state.view === 'runs');
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
  const profilesQuery = useProfiles(state.view === 'launch');
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

  const adminOrganisationsQuery = useAdminOrganisations(
    state.view === 'admin' && isPlatformAdmin
  );
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
  // admin revoked, stale state) lands back on runs instead of a dead tab.
  useEffect(() => {
    if (!visibleViews(authSnapshot).includes(state.view)) state.setView('runs');
  }, [authSnapshot, state]);

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

  useEffect(() => {
    const projects = projectsQuery.data ?? [];
    if (state.view !== 'projects') return;
    if (!state.selectedProjectId && projects[0]) state.selectProject(projects[0].projectId);
    else if (
      state.selectedProjectId &&
      projects.length &&
      !projects.some((project) => project.projectId === state.selectedProjectId) &&
      projects[0]
    ) {
      state.selectProject(projects[0].projectId);
    }
  }, [projectsQuery.data, state]);

  useEffect(() => {
    const installations = githubInstallationsQuery.data ?? [];
    const active = installations.filter((installation) => installation.status === 'active');
    if (state.view !== 'projects') return;
    if (!state.selectedGithubInstallationId && active[0]) {
      state.selectGithubInstallation(active[0].installationId);
    }
  }, [githubInstallationsQuery.data, state]);

  const copyCommand = useCallback(() => {
    const profile = profilesQuery.data?.profiles[0];
    const goal = useGpuStore.getState().search.launch.trim();
    if (!profile || !goal) return;
    const command = `npm run ${profile.npmScript} -- "${goal.replace(/"/g, '\\"')}"`;
    void navigator.clipboard.writeText(command);
  }, [profilesQuery.data]);

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
    if (id === 'refresh') {
      store.refresh();
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
      store.selectProject(id.slice('project.select.'.length));
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
    if (id.startsWith('launch.example.')) {
      const index = Number(id.slice('launch.example.'.length));
      const example = profilesQuery.data?.profiles[0]?.examples[index];
      if (example) store.setSearch('launch', example);
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
    if (id === 'launch.copy') copyCommand();
  }, [activateAuth, beginEnter, copyCommand, mintInvitation, profilesQuery.data]);

  const loading =
    (state.view === 'projects' && (projectsQuery.isLoading || githubInstallationsQuery.isLoading)) ||
    (state.view === 'runs' && (runsQuery.isLoading || runQuery.isLoading)) ||
    (state.view === 'registry' && (registriesQuery.isLoading || registryQuery.isLoading)) ||
    (state.view === 'skills' && namespacesQuery.isLoading) ||
    (state.view === 'burnin' && burninQuery.isLoading) ||
    (state.view === 'launch' && profilesQuery.isLoading) ||
    (state.view === 'admin' && adminOrganisationsQuery.isLoading);
  // Requests in flight for the ACTIVE view only — the same predicate the
  // refresh button invalidates with, so the spinner reports on exactly the
  // requests the button causes. Unlike `loading` this covers refetches of
  // data already on screen, which is the entire point: on registry, skills,
  // burn-in and launch nothing polls, so a refetch is invisible without it.
  const inFlight = useIsFetching(activeViewQueryFilter(state.view)) > 0;
  // ...but ONLY the button arms it. `fetching` sits in the snapshot the GPU
  // scene is rebuilt from, and on a live run the background polls (trace
  // every 1s, index every 2s) each flip an unfiltered in-flight count on and
  // off — two full scene rebuilds per poll, ~2.5 per second, for a spinner
  // nobody asked to spin. Measured as the source of the frame drops on live
  // runs: 30 rebuilds in 12s of an otherwise idle view. Polls now leave the
  // snapshot alone unless their DATA actually changed.
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (state.refreshNonce > 0) setRefreshing(true);
  }, [state.refreshNonce]);
  useEffect(() => {
    // Disarm only once the button's requests have settled. This effect also
    // runs while the arm above is still pending its re-render, in which case
    // `refreshing` is still false and there is nothing to disarm.
    if (refreshing && !inFlight) setRefreshing(false);
  }, [refreshing, inFlight]);
  const fetching = refreshing;
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
    adminInvitation,
    adminError,
    loading,
    fetching,
    error,
  }), [
    adminError,
    adminInvitation,
    adminOrganisationsQuery.data,
    authSnapshot,
    fetching,
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
      <DomBridge
        runs={runsQuery.data ?? []}
        releaseVersion={RELEASE_VERSION}
        views={visibleViews(authSnapshot)}
        t={t}
        onSelectRun={state.selectRun}
        onCopy={copyCommand}
        onEnter={beginEnter}
        githubInstallations={githubInstallationsQuery.data ?? []}
        onCreateProject={() => { void createProject(); }}
        onStartRun={() => { void startProjectRun(); }}
        projectBusy={projectBusy}
        projectError={projectError}
        selectedProjectName={selectedProject?.name ?? null}
      />
      <AtomaCursor />
      <EntryVeilLayer phase={entryPhase} />
    </main>
  );
}
