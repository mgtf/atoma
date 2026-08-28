import {
  useInfiniteQuery,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useRef } from 'react';
import { api } from '../client/data-api.js';
import { isRunLive, projectRunUpdate } from '../client/run-utils.js';
import type { SkillSummary, VizRun } from '../client/types.js';

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
      return projectRunUpdate(current, incoming);
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

export function useProjects(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'projects'],
    queryFn: api.projects,
    enabled: active,
    refetchInterval: active ? 5_000 : false,
    staleTime: 2_000,
  });
}

export function useProjectRuns(projectId: string | null, active: boolean) {
  return useQuery({
    queryKey: ['viz', 'project', projectId, 'runs'],
    enabled: active && !!projectId,
    queryFn: () => {
      if (!projectId) throw new Error('project id is required');
      return api.projectRuns(projectId);
    },
    refetchInterval: (query) => {
      const runs = query.state.data;
      const live = runs?.some((run) => run.status === 'queued' || run.status === 'running');
      return live ? 2_000 : false;
    },
    staleTime: 1_000,
  });
}

export function useGithubInstallations(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'github', 'installations'],
    queryFn: api.githubInstallations,
    enabled: active,
    staleTime: 30_000,
  });
}

export function useAdminOrganisations(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'admin', 'organisations'],
    queryFn: api.adminOrganisations,
    enabled: active,
    staleTime: 5_000,
  });
}

/**
 * THE AUDIT JOURNAL, paged. One page per scroll to the bottom, newest first,
 * with the server's `nextBefore` as the cursor — so a page boundary can
 * neither repeat nor skip a row the way an offset over a growing table would.
 *
 * Filters live in the QUERY KEY, not in a client-side filter over loaded
 * pages: filtering after paging would thin each page instead of finding more
 * matching rows, and a viewer would see three matches where the journal holds
 * three hundred.
 *
 * Polling stops once the viewer has paged. React Query refetches EVERY loaded
 * page on an interval, so tailing a ten-page history would re-fetch ten pages
 * every ten seconds to learn about one new row. Page one tails; deeper
 * history is history.
 */
export function useAdminEventsPages(
  active: boolean,
  filters: { severity: string; family: string }
) {
  return useInfiniteQuery({
    queryKey: ['viz', 'admin', 'events', filters.severity, filters.family],
    queryFn: ({ pageParam }) =>
      api.adminEvents({
        limit: 60,
        before: pageParam,
        severity: filters.severity,
        family: filters.family,
      }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: active,
    staleTime: 10_000,
    refetchInterval: (query) =>
      active && (query.state.data?.pages.length ?? 1) === 1 ? 10_000 : false,
  });
}

/**
 * The viewer's notification tray, paged like the journal. Fetched only while
 * the menu is open; the first page re-polls on the journal's cadence so a tray
 * left open tails new arrivals. The locale rides the query key because the
 * server renders the copy — switching language is a different query, not a
 * client-side re-render.
 */
export function useNotificationsPages(active: boolean, locale: string) {
  return useInfiniteQuery({
    queryKey: ['viz', 'notifications', locale],
    queryFn: ({ pageParam }) =>
      api.notifications({ limit: 30, before: pageParam, locale }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: active,
    staleTime: 10_000,
    refetchInterval: (query) =>
      active && (query.state.data?.pages.length ?? 1) === 1 ? 10_000 : false,
  });
}

/**
 * The sentinel's own screen: rule table, live coverage, findings. Polled at
 * the runs cadence rather than the journal's, because half of it IS live
 * state — which runs are in flight right now.
 */
export function useAdminSentinel(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'admin', 'sentinel'],
    queryFn: api.adminSentinel,
    enabled: active,
    staleTime: 2_000,
    refetchInterval: active ? 5_000 : false,
  });
}

/** The product ledger's tail. Static enough to fetch once per visit. */
export function useAdminLedger(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'admin', 'ledger'],
    queryFn: () => api.adminLedger(),
    enabled: active,
    staleTime: 30_000,
  });
}

/** The viewer's own organisation. Gated deployments only — 404 otherwise. */
export function useOrganisation(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'org'],
    queryFn: api.organisation,
    enabled: active,
    staleTime: 15_000,
  });
}

export function useAccountModels(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'account', 'models'],
    queryFn: api.accountModels,
    enabled: active,
    staleTime: 30_000,
  });
}

export function useOrgModels(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'org', 'models'],
    queryFn: api.orgModels,
    enabled: active,
    staleTime: 30_000,
  });
}
