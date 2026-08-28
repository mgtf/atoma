import type {
  BurninRow,
  LaunchProfile,
  VizAccountModels,
  VizOrgModels,
  VizOrgProviderKeyStatus,
  VizOrganisation,
  RegistrySummary,
  RegistryType,
  RunIndexEntry,
  SkillNamespace,
  SkillSummary,
  VizAdminInvitation,
  VizAnnouncementTexts,
  VizAdminOrganisation,
  VizLedgerEvent,
  VizNotificationPage,
  VizPlatformEventPage,
  VizSentinelSnapshot,
  VizGitHubInstallation,
  VizProject,
  VizProjectRun,
  VizRun,
} from './types.js';
import { redirectIfAuthenticationRequired } from './session-guard.js';

export async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  redirectIfAuthenticationRequired(response.status);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  return (await response.json()) as T;
}

export const api = {
  runs: () => fetchJson<RunIndexEntry[]>('/api/runs'),
  run: async (id: string, after?: number) =>
    fetchJson<VizRun>(
      `/api/runs/${encodeURIComponent(id)}${after === undefined ? '' : `?after=${after}`}`
    ),
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
  // The viewer's own tray, paged like the journal: `before` is the exclusive
  // `seq` cursor from the previous page. The copy comes back rendered in
  // `locale`, so a language switch is a new query, not a client re-render.
  notifications: (query: { before?: number | null; limit?: number; locale: string }) => {
    const params = new URLSearchParams({
      limit: String(query.limit ?? 30),
      locale: query.locale,
    });
    if (query.before) params.set('before', String(query.before));
    return fetchJson<VizNotificationPage>(`/api/notifications?${params.toString()}`);
  },
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
  // The journal reads as PAGES, newest first: `before` is the exclusive `seq`
  // cursor the previous page handed back, so a boundary can neither repeat
  // nor skip a row. Filters are server-side for the same reason — filtering
  // an already-paged list client-side would silently thin the pages.
  adminEvents: (
    query: {
      limit?: number;
      before?: number | null;
      severity?: string;
      family?: string;
    } = {}
  ) => {
    const params = new URLSearchParams({ limit: String(query.limit ?? 60) });
    if (query.before) params.set('before', String(query.before));
    if (query.severity && query.severity !== 'all') params.set('severity', query.severity);
    if (query.family && query.family !== 'all') params.set('family', query.family);
    return fetchJson<VizPlatformEventPage>(`/api/admin/events?${params.toString()}`);
  },
  adminSentinel: () => fetchJson<VizSentinelSnapshot>('/api/admin/sentinel'),
  // A SEPARATE read of the product ledger, never a merge with the journal
  // above: the two answer different questions and only share a tab.
  adminLedger: (limit = 20) =>
    fetchJson<{ events: VizLedgerEvent[] }>(
      `/api/admin/ledger?limit=${encodeURIComponent(limit)}`
    ),
  createAdminInvitation: (body: { orgId: string; role: string; ttlHours?: number }) =>
    mutateJson<VizAdminInvitation>('/api/admin/invitations', body),
  // The two announcement steps, deliberately two calls: the draft sends
  // nothing, and only text the admin has read reaches `announce`.
  draftAnnouncement: (body: { source: string; title: string; body: string }) =>
    mutateJson<{
      translated: boolean;
      /** Why there is no draft: nothing configured, or the provider refused. */
      reason: 'unavailable' | 'failed' | null;
      texts: VizAnnouncementTexts | null;
    }>('/api/admin/announce/draft', body),
  sendAnnouncement: (body: { segment: string; texts: VizAnnouncementTexts }) =>
    mutateJson<{ segment: string; orgCount: number | null }>('/api/admin/announce', body),
  organisation: () => fetchJson<VizOrganisation>('/api/org'),
  accountModels: () => fetchJson<VizAccountModels>('/api/account/models'),
  orgModels: () => fetchJson<VizOrgModels>('/api/org/models'),
  // PUT/PATCH rather than POST: these replace one account/org-scoped resource.
  saveAccountModels: (pins: VizAccountModels['pins']) =>
    mutateJson<VizAccountModels>('/api/account/models', { pins }, 'PUT'),
  saveOrgModels: (models: VizOrgModels['models']) =>
    mutateJson<{ models: VizOrgModels['models'] }>('/api/org/models', { models }, 'PUT'),
  saveOrgProviderKey: (provider: string, key: string) =>
    mutateJson<{ keys: VizOrgProviderKeyStatus[] }>(
      `/api/org/provider-keys/${encodeURIComponent(provider)}`,
      { key },
      'PUT'
    ),
  removeOrgProviderKey: async (provider: string): Promise<{ keys: VizOrgProviderKeyStatus[] }> => {
    const response = await fetch(
      `/api/org/provider-keys/${encodeURIComponent(provider)}`,
      {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status} for provider-keys`);
    return (await response.json()) as { keys: VizOrgProviderKeyStatus[] };
  },
  renameAccount: (displayName: string) =>
    mutateJson<{ displayName: string; displayNameSource: string }>(
      '/api/account',
      { displayName },
      'PATCH'
    ),
};

async function mutateJson<T>(
  path: string,
  body: unknown,
  method: 'POST' | 'PUT' | 'PATCH' = 'POST'
): Promise<T> {
  const response = await fetch(path, {
    method,
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
