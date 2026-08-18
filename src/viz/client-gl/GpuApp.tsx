import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { translate } from '../client/i18n.js';
import { emptyRenderMetrics } from './gpu-renderer.js';
import type {
  GpuRenderMetrics,
  GpuTimelineViewport,
} from './gpu-renderer.js';
import { AtomaCursor } from './AtomaCursor.js';
import { DomBridge } from './DomBridge.js';
import { GpuSurface } from './GpuSurface.js';
import { useIsFetching } from '@tanstack/react-query';
import {
  activeViewQueryFilter,
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

function sameTimelineViewport(
  left: GpuTimelineViewport | null,
  right: GpuTimelineViewport | null
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return Object.keys(left).every(
    (key) =>
      left[key as keyof GpuTimelineViewport] ===
      right[key as keyof GpuTimelineViewport]
  );
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
  const [timelineViewport, setTimelineViewport] =
    useState<GpuTimelineViewport | null>(null);
  const metrics = useRef<GpuRenderMetrics>(emptyRenderMetrics());
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
  const skillDetailQuery = useSkillDetail(skillSelection, Boolean(skillSelection));
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
    fetching,
    error,
  }), [
    fetching,
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
    const nextTimeline = next.timelineViewport
      ? { ...next.timelineViewport }
      : null;
    setTimelineViewport((current) =>
      sameTimelineViewport(current, nextTimeline) ? current : nextTimeline
    );
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
        <ThreeBackdrop
          run={runQuery.data ?? null}
          view={state.view}
          runFilters={state.runFilters}
          timelineViewport={timelineViewport}
        />
      </Suspense>
      <GpuSurface data={data} t={t} onActivate={activate} onMetrics={updateMetrics} />
      <DomBridge
        runs={runsQuery.data ?? []}
        t={t}
        onSelectRun={state.selectRun}
        onCopy={copyCommand}
      />
      <AtomaCursor />
    </main>
  );
}
