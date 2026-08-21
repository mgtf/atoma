export interface RunIndexEntry {
  id: string;
  label: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  hasError?: boolean;
  degraded?: boolean;
  inFlight?: boolean;
  lastEventAt?: number;
  cancelled?: boolean;
  costUsd?: number;
  calls?: number;
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
}

export interface VizEvent {
  id: string;
  ts: number;
  kind: string;
  role?: string;
  name?: string;
  model?: string;
  /**
   * What the transport ACTUALLY served. claude-cli, codex and ollama rewrite
   * the tier pin, and cost is priced from this rather than from `model` — so a
   * surface that shows one and prices the other is lying about the bill.
   */
  servedModel?: string;
  /** `end_turn` is a finished answer; `max_tokens` is a truncated one. */
  stopReason?: string;
  subject?: string;
  reasoning?: string;
  branchId?: string;
  error?: string;
  durationMs?: number;
  costUsd?: number;
  actor?: { name?: string; tier?: number };
  child?: { name?: string; tier?: number };
  usage?: Record<string, number>;
  args?: Record<string, unknown>;
  result?: unknown;
  response?: string;
  systemPrompt?: string;
  userContent?: string;
  op?: string;
  l1Name?: string;
  /** Stored skill-namespace key (atom id). Address `/api/skills` with this, not `l1Name`. */
  l1AtomId?: string;
  skillId?: string;
  snapshot?: RegistryType;
  modifications?: unknown;
  llmEventId?: string;
  toolNames?: string[];
  context?: Array<{
    id: string;
    source: string;
    chars: number;
    preview: string;
    skillId?: string;
  }>;
  source?: string;
  chars?: number;
  preview?: string;
  [key: string]: unknown;
}

export interface VizRun {
  id: string;
  label: string;
  task?: { description?: string };
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  events: VizEvent[];
  eventsFrom?: number;
  eventsTotal?: number;
  degraded?: boolean;
  cancelled?: boolean;
  error?: string;
  initialTypes?: RegistryType[];
  result?: {
    summary?: string;
    output?: unknown;
    producedBy?: { tier?: number; name?: string; viaFallback?: boolean };
  };
  totals?: {
    calls?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    costUsd?: number;
    perModel?: Array<{
      model: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    }>;
  };
}

export interface RegistryHistory {
  version: number;
  systemPrompt: string;
  tools: string[];
  params: Record<string, unknown>;
  modifiedBy: string;
  modifiedAt: string;
  reason?: string | null;
}

export interface RegistryType {
  tier: number;
  rank?: 'molecule' | 'cell' | 'tissue';
  ordinal: number;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  elements?: Array<{
    tool: string;
    number: number;
    name: string;
    symbol: string;
  }>;
  params: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  version: number;
  successes: number;
  failures: number;
  history?: RegistryHistory[];
}

export interface RegistrySummary {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  counts: { 1: number; 2: number; 3: number; total: number };
}

export interface SkillSummary {
  id: string;
  description: string;
  whenToUse: string;
  kind: 'llm' | 'script';
  language?: string;
  successes: number;
  failures: number;
  updatedAt: string;
  body?: string;
  shareability?: {
    verdict: 'blocked' | 'review-required' | 'not-shareable';
    blockers: Array<{ code: string; detail: string }>;
    warnings: Array<{ code: string; detail: string }>;
    humanMustCheck?: string;
  };
}

export interface SkillNamespace {
  /** Stored namespace key (an atom id) — what /api/skills/:l1Name expects. */
  l1Name: string;
  /** Display label for that key — what the molecule is called. */
  l1Label: string;
  count: number;
}

export interface BurninRow {
  ts: string;
  taskId: string;
  family: string;
  outcome: string;
  costUsd: number | null;
  durationS: number | null;
  llmCalls: number | null;
  opusCalls: number;
  sonnetCalls: number;
  haikuCalls: number;
  otherCalls: number;
  deterministicPhases: number;
  escalations: number;
  learnedSkills: number;
  learnedEventSkills: number;
  promotions: number;
  refusals: number;
  compileErrors: number;
  demotions: number;
  dispatchFallbacks: number;
  trace: string;
  provider: string;
}

export interface LaunchProfile {
  id: string;
  npmScript: string;
  label: string;
  help: string;
  examples: string[];
}

/**
 * Projects view projections. Server-owned slice of the contracts in
 * `src/contracts/projects.ts`: host paths never cross this boundary.
 */
export interface VizProject {
  projectId: string;
  name: string;
  slug: string;
  status: 'active' | 'archived';
  family: string;
  repositoryTarget: {
    installationId: string;
    owner: string;
    name: string;
    visibility: 'private' | 'public';
  };
  repositoryStatus: 'pending' | 'creating' | 'ready' | 'failed';
  repositoryFullName: string | null;
  repositoryUrl: string | null;
  repositoryError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VizProjectRun {
  projectRunId: string;
  projectId: string;
  goal: string;
  status: 'queued' | 'running' | 'delivered' | 'failed' | 'cancelled';
  traceId: string | null;
  costUsd: number | null;
  durationS: number | null;
  error: string | null;
  createdAt: string;
  endedAt: string | null;
  publication: {
    status: 'pending' | 'publishing' | 'published' | 'failed';
    repositoryUrl: string | null;
    commitSha: string | null;
  } | null;
}

export interface VizGitHubInstallation {
  installationId: string;
  accountLogin: string;
  targetType: 'User' | 'Organization';
  status: 'active' | 'suspended' | 'deleted';
  repositorySelection: 'all' | 'selected';
}

/** Admin plane (platform admin only): one organisation with its members. */
export interface VizAdminOrganisation {
  orgId: string;
  name: string;
  createdAt: string;
  members: VizOrganisationMember[];
}

export interface VizOrganisationMember {
  principalId: string;
  displayName: string;
  role: string;
  joinedAt?: string;
  platformAdmin?: boolean;
  /** Same-origin avatar URL, versioned by content hash; null when there is none. */
  avatarUrl?: string | null;
}

/**
 * The VIEWER'S OWN organisation (`GET /api/org`) — org-scoped, unlike the
 * admin inventory above. No emails by design: provider emails are display
 * attributes and GitHub's is not a verified-email assertion.
 */
export interface VizOrganisation {
  id: string;
  name: string;
  createdAt: string;
  viewerRole: string;
  members: VizOrganisationMember[];
  projectCount: number;
  /** Null unless the viewer is an owner or admin — only they can mint them. */
  pendingInvitations: number | null;
}

/** Per-tier model pins plus the labels the account page needs to show. */
export interface VizAccountModels {
  pins: { l1: string | null; l2: string | null; l3: string | null };
  /** What "operator default" resolves to today, per tier. */
  defaults: { l1: string; l2: string; l3: string };
  choices: string[];
}

/**
 * One row of the platform audit journal.
 *
 * `kind` and `severity` are DELIBERATELY plain strings, not the server's
 * unions: a viewer may be running an older bundle than the server, and the
 * journal must render an unfamiliar label rather than hide the rows around
 * it. Same tolerance the server reader applies.
 */
export interface VizPlatformEvent {
  seq: number;
  at: string;
  kind: string;
  severity: string;
  actorType: string;
  actorId: string | null;
  orgId: string | null;
  projectId: string | null;
  runId: string | null;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface VizPlatformEventPage {
  events: VizPlatformEvent[];
  /** Exclusive `seq` cursor for the next (older) page, or null at the end. */
  nextBefore: number | null;
}

/** The product ledger's tail — a separate journal, never merged with the above. */
export interface VizLedgerEvent {
  at: string;
  kind: string;
  entity: string;
  detail?: Record<string, unknown>;
}

/** Admin plane: a freshly minted one-use invitation. Shown once, never stored. */
export interface VizAdminInvitation {
  token: string;
  url: string;
  orgId: string;
  orgName: string;
  role: string;
  expiresAt: string;
}
