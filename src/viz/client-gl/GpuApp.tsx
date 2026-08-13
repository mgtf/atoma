import { lazy, Suspense, useCallback, useEffect, useMemo, useRef } from 'react';
import { translate } from '../client/i18n.js';
import type { GpuRenderMetrics } from './gpu-renderer.js';
import { DomBridge } from './DomBridge.js';
import { GpuSurface } from './GpuSurface.js';
import {
  useBurnin,
  useProfiles,
  useRefreshBridge,
  useRegistries,
  useRegistry,
  useRunTrace,
  useRunsIndex,
  useSkillDetail,
  useSkillLists,
  useSkillNamespaces,
} from './queries.js';
import { nextRunFilters, useGpuStore } from './store.js';

const ThreeBackdrop = lazy(() =>
  import('./ThreeBackdrop.js').then((module) => ({ default: module.ThreeBackdrop }))
);

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
  const state = useGpuStore();
  const metrics = useRef<GpuRenderMetrics>({
    backend: 'unknown',
    objectCount: 0,
    runCollapseOffset: 0,
    visibleLabels: [],
    hitTargets: [],
  });
  const t = useCallback(
    (key: string, vars?: Record<string, unknown>) => translate(state.locale, key, vars),
    [state.locale]
  );
  useRefreshBridge();

  const runsQuery = useRunsIndex(state.view === 'runs');
  const runQuery = useRunTrace(state.selectedRunId, state.view === 'runs');
  const registriesQuery = useRegistries(state.view === 'registry');
  const registryQuery = useRegistry(state.selectedRegistryId, state.view === 'registry');
  const namespacesQuery = useSkillNamespaces(state.view === 'skills');
  const namespaceNames = useMemo(
    () => (namespacesQuery.data ?? []).map((item) => item.l1Name),
    [namespacesQuery.data]
  );
  const skillLists = useSkillLists(namespaceNames, state.view === 'skills');
  const skillDetailQuery = useSkillDetail(state.selectedSkill, state.view === 'skills');
  const burninQuery = useBurnin(state.view === 'burnin');
  const profilesQuery = useProfiles(state.view === 'launch');

  useEffect(() => {
    const runs = runsQuery.data ?? [];
    if (!state.selectedRunId && runs[0]) state.selectRun(runs[0].id);
    else if (state.selectedRunId && runs.length && !runs.some((run) => run.id === state.selectedRunId)) {
      state.selectRun(runs[0]!.id);
    }
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

  const copyCommand = useCallback(() => {
    const profile = profilesQuery.data?.profiles[0];
    const goal = useGpuStore.getState().search.launch.trim();
    if (!profile || !goal) return;
    const command = `npm run ${profile.npmScript} -- "${goal.replace(/"/g, '\\"')}"`;
    void navigator.clipboard.writeText(command);
  }, [profilesQuery.data]);

  const activate = useCallback((id: string) => {
    const store = useGpuStore.getState();
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
      store.setScrollY('runs', 0);
      return;
    }
    if (id.startsWith('run.filter.role.')) {
      store.setRunFilters(
        nextRunFilters(store.runFilters, 'role', id.slice('run.filter.role.'.length))
      );
      store.setScrollY('runs', 0);
      return;
    }
    if (id.startsWith('run.filter.branch.')) {
      store.setRunFilters(
        nextRunFilters(store.runFilters, 'branchId', id.slice('run.filter.branch.'.length))
      );
      store.setScrollY('runs', 0);
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
    if (id === 'launch.copy') copyCommand();
  }, [copyCommand, profilesQuery.data]);

  const loading =
    (state.view === 'runs' && (runsQuery.isLoading || runQuery.isLoading)) ||
    (state.view === 'registry' && (registriesQuery.isLoading || registryQuery.isLoading)) ||
    (state.view === 'skills' && namespacesQuery.isLoading) ||
    (state.view === 'burnin' && burninQuery.isLoading) ||
    (state.view === 'launch' && profilesQuery.isLoading);
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
  ]);
  const data = useMemo(() => ({
    runs: runsQuery.data ?? [],
    run: runQuery.data ?? null,
    registries: registriesQuery.data ?? [],
    registry: registryQuery.data ?? null,
    skillNamespaces: namespacesQuery.data ?? [],
    skillsByNamespace: skillLists.byNamespace,
    skillDetail: skillDetailQuery.data ?? null,
    burnin: burninQuery.data ?? null,
    profiles: profilesQuery.data?.profiles ?? [],
    loading,
    error,
  }), [
    burninQuery.data,
    error,
    loading,
    namespacesQuery.data,
    profilesQuery.data,
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
      <Suspense fallback={null}>
        <ThreeBackdrop run={runQuery.data ?? null} />
      </Suspense>
      <GpuSurface data={data} t={t} onActivate={activate} onMetrics={updateMetrics} />
      <DomBridge
        runs={runsQuery.data ?? []}
        t={t}
        onSelectRun={state.selectRun}
        onCopy={copyCommand}
      />
    </main>
  );
}
