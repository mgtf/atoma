import type {
  BurninRow,
  LaunchProfile,
  RegistrySummary,
  RegistryType,
  RunIndexEntry,
  SkillNamespace,
  SkillSummary,
  VizRun,
} from './types.js';
import { projectRunTaxonomy } from './run-utils.js';

export async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  return (await response.json()) as T;
}

export const api = {
  runs: () => fetchJson<RunIndexEntry[]>('/api/runs'),
  run: async (id: string, after?: number) =>
    projectRunTaxonomy(await fetchJson<VizRun>(
      `/api/runs/${encodeURIComponent(id)}${after === undefined ? '' : `?after=${after}`}`
    )),
  registries: () => fetchJson<RegistrySummary[]>('/api/registries'),
  registry: (id: string) =>
    fetchJson<{ registry: RegistrySummary; types: RegistryType[] }>(
      `/api/registry/${encodeURIComponent(id)}`
    ),
  skillNamespaces: () => fetchJson<SkillNamespace[]>('/api/skills'),
  skills: (l1Name: string) =>
    fetchJson<SkillSummary[]>(`/api/skills/${encodeURIComponent(l1Name)}`),
  skill: (l1Name: string, id: string) =>
    fetchJson<SkillSummary>(
      `/api/skills/${encodeURIComponent(l1Name)}/${encodeURIComponent(id)}`
    ),
  burnin: () => fetchJson<{ rows: BurninRow[]; csvPath: string }>('/api/burnin'),
  profiles: () =>
    fetchJson<{ launchEnabled: false; profiles: LaunchProfile[] }>('/api/profiles'),
};
