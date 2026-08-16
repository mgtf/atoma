import {
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '../client/data-api.js';
import { isRunLive, mergeRunDelta } from '../client/run-utils.js';
import type { SkillSummary, VizRun } from '../client/types.js';
import { useGpuStore, type ViewName } from './store.js';

export function useRunsIndex(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'runs'],
    queryFn: api.runs,
    enabled: active,
    refetchInterval: active ? 2000 : false,
    staleTime: 750,
  });
}

export function useRunTrace(runId: string | null, active: boolean) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['viz', 'run', runId],
    enabled: active && !!runId,
    queryFn: async () => {
      if (!runId) throw new Error('run id is required');
      const current = queryClient.getQueryData<VizRun>(['viz', 'run', runId]);
      const incoming = await api.run(runId, current?.events.length);
      return current && incoming.eventsFrom !== undefined
        ? mergeRunDelta(current, incoming)
        : incoming;
    },
    refetchInterval: (query) => {
      const run = query.state.data;
      return run && isRunLive(run) ? 1000 : false;
    },
    staleTime: 750,
  });
}

export function useRegistries(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'registries'],
    queryFn: api.registries,
    enabled: active,
  });
}

export function useRegistry(registryId: string | null, active: boolean) {
  return useQuery({
    queryKey: ['viz', 'registry', registryId],
    queryFn: () => {
      if (!registryId) throw new Error('registry id is required');
      return api.registry(registryId);
    },
    enabled: active && !!registryId,
  });
}

export function useSkillNamespaces(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'skills', 'namespaces'],
    queryFn: api.skillNamespaces,
    enabled: active,
  });
}

export function useSkillLists(names: string[], active: boolean) {
  const results = useQueries({
    queries: names.map((l1Name) => ({
      queryKey: ['viz', 'skills', l1Name],
      queryFn: () => api.skills(l1Name),
      enabled: active,
    })),
  });
  // Reference-stable across renders whose inputs did not change. This object
  // sits in the deps of the `data` memo the GPU snapshot is built from, and a
  // fresh `{}` per render meant every React render — every poll notification
  // included — produced a "new" snapshot and rebuilt the entire GPU scene.
  // A ref-compare cache instead of useMemo because the dependency list
  // (one data ref per namespace) has variable length.
  const cache = useRef<{
    names: readonly string[];
    datas: readonly (SkillSummary[] | undefined)[];
    value: Record<string, SkillSummary[]>;
  } | null>(null);
  const datas = results.map((result) => result.data);
  const cached = cache.current;
  if (
    !cached ||
    cached.names.length !== names.length ||
    names.some((name, index) => name !== cached.names[index]) ||
    datas.some((data, index) => data !== cached.datas[index])
  ) {
    const value: Record<string, SkillSummary[]> = {};
    names.forEach((name, index) => {
      value[name] = datas[index] ?? [];
    });
    cache.current = { names: [...names], datas, value };
  }
  return { results, byNamespace: cache.current!.value };
}

export function useSkillDetail(
  selection: { l1Name: string; id: string } | null,
  active: boolean
) {
  return useQuery({
    queryKey: ['viz', 'skill', selection?.l1Name, selection?.id],
    queryFn: () => {
      if (!selection) throw new Error('skill selection is required');
      return api.skill(selection.l1Name, selection.id);
    },
    enabled: active && !!selection,
  });
}

export function useBurnin(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'burnin'],
    queryFn: api.burnin,
    enabled: active,
  });
}

export function useProfiles(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'profiles'],
    queryFn: api.profiles,
    enabled: active,
    staleTime: Infinity,
  });
}

const VIEW_QUERY_ROOTS: Record<ViewName, readonly string[]> = {
  runs: ['runs', 'run'],
  registry: ['registries', 'registry'],
  skills: ['skills', 'skill'],
  burnin: ['burnin'],
  launch: ['profiles'],
};

/**
 * The queries the ACTIVE view is built from — one definition, used both to
 * invalidate them on refresh and to know when they are in flight. Two copies
 * of this predicate would drift, and the refresh button's spinner would then
 * report on a different set of requests than the button actually triggers.
 */
export function activeViewQueryFilter(view: ViewName) {
  return {
    predicate: (query: { queryKey: readonly unknown[] }) => {
      const root = query.queryKey[1];
      return query.queryKey[0] === 'viz' &&
        typeof root === 'string' &&
        VIEW_QUERY_ROOTS[view].includes(root);
    },
  };
}

export function invalidateActiveView(queryClient: QueryClient, view: ViewName) {
  return queryClient.invalidateQueries(activeViewQueryFilter(view));
}

export function useRefreshBridge() {
  const queryClient = useQueryClient();
  const refreshNonce = useGpuStore((state) => state.refreshNonce);
  const view = useGpuStore((state) => state.view);
  useEffect(() => {
    if (refreshNonce === 0) return;
    void invalidateActiveView(queryClient, view);
  }, [queryClient, refreshNonce, view]);
}
