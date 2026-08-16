import {
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
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
  const byNamespace: Record<string, SkillSummary[]> = {};
  names.forEach((name, index) => {
    byNamespace[name] = results[index]?.data ?? [];
  });
  return { results, byNamespace };
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
