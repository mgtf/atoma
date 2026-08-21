import type {
  BurninRow,
  LaunchProfile,
  RegistrySummary,
  RegistryType,
  RunIndexEntry,
  SkillNamespace,
  SkillSummary,
  VizAdminInvitation,
  VizAdminOrganisation,
  VizGitHubInstallation,
  VizProject,
  VizProjectRun,
  VizRun,
} from './types.js';
import { projectRunTaxonomy } from './run-utils.js';
import { redirectIfAuthenticationRequired } from './auth-session.js';

export async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  redirectIfAuthenticationRequired(response.status);
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
  projects: () => fetchJson<VizProject[]>('/api/projects'),
  projectRuns: (projectId: string) =>
    fetchJson<VizProjectRun[]>(`/api/projects/${encodeURIComponent(projectId)}/runs`),
  githubInstallations: () =>
    fetchJson<VizGitHubInstallation[]>('/api/github/installations'),
  createProject: (body: {
    name: string;
    slug: string;
    initialPrompt?: string;
    repositoryTarget: VizProject['repositoryTarget'];
  }) =>
    mutateJson<VizProject>('/api/projects', body),
  startProjectRun: (projectId: string, body: { goal: string; idempotencyKey: string }) =>
    mutateJson<VizProjectRun>(
      `/api/projects/${encodeURIComponent(projectId)}/runs`,
      body
    ),
  pushConfig: () => fetchJson<{ enabled: boolean; publicKey?: string }>('/api/push/config'),
  subscribePush: (body: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    /** Captured now: a push is generated later with no request to read. */
    locale: string;
  }) => mutateJson<{ subscribed: boolean }>('/api/push/subscribe', body),
  unsubscribePush: (body: { endpoint: string }) =>
    mutateJson<{ removed: boolean }>('/api/push/unsubscribe', body),
  adminOrganisations: () => fetchJson<VizAdminOrganisation[]>('/api/admin/organisations'),
  createAdminInvitation: (body: { orgId: string; role: string; ttlHours?: number }) =>
    mutateJson<VizAdminInvitation>('/api/admin/invitations', body),
};

async function mutateJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  redirectIfAuthenticationRequired(response.status);
  if (!response.ok) {
    let detail = `HTTP ${response.status} for ${path}`;
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload.error === 'string' && payload.error.trim()) detail = payload.error.trim();
    } catch {
      // Keep the status line when the body is not JSON.
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}
