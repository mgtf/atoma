import type { AccountSubscriptionsResponse } from '../../contracts/accountSubscriptions.js';

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
  projectRunId?: string;
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
  /** Registry type version credited, blamed or produced by this event. */
  version?: number;
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
  runCount?: number;
  lastRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the browser learns about a run's preview — the server's
 * `previewSummarySchema`, restated here as a wire shape like every other type
 * in this file. It carries no host path, container id, image digest, runtime
 * or token: the server's projection is an ALLOWLIST for exactly that reason,
 * and mirroring more here would invite a future field to cross by accident.
 */
export interface VizPreviewSummary {
  availability: 'available' | 'unavailable';
  kind: 'static' | 'node' | null;
  reason: string | null;
  state: 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';
  generation: number;
  /** `delivered` describes a finished run; `in-flight` a snapshot of one building. */
  source: 'delivered' | 'in-flight';
  /** When that snapshot was taken. Null for a delivered preview. */
  snapshotAt: string | null;
  readyAt: string | null;
  expiresAt: string | null;
  errorCode: string | null;
  requestedHosts: string[];
  allowedHosts: string[];
  blockedHosts: string[];
}

/** What an open returns: the summary, and a claim URL only when one is ready. */
export interface VizPreviewOpen {
  summary: VizPreviewSummary;
  /** Carries a one-time claim in its fragment. Never store or log it. */
  url?: string;
  retryAfterSeconds?: number;
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

/** Picker capabilities only; detailed connection state comes from its own endpoint. */
export interface VizPersonalSubscriptionCapabilities {
  claude: boolean;
  codex: boolean;
}

/** Per-tier model pins plus the labels the account page needs to show. */
export interface VizAccountModels {
  pins: { l1: string | null; l2: string | null; l3: string | null };
  /** What "operator default" resolves to today, per tier. */
  defaults: { l1: string; l2: string; l3: string };
  catalog: VizLlmCatalogEntry[];
  /**
   * Legacy singular offer for the operator's Claude login. ABSENT MEANS NOT
   * OFFERED — the inverse of `ollamaAvailable`'s tolerant default, and
   * deliberately so: an unknown endpoint is a dormant choice, an unknown
   * PAYER is somebody's money. `reason` present means offered-but-unusable,
   * so the picker can say why instead of hiding the family and leaving an
   * armed pin invisible in the select that must be used to clear it.
   */
  hostSubscription?: {
    family: VizLlmCatalogEntry;
    reason?: 'undeclared' | 'other-organisation';
  };
  /** All Claude/ChatGPT machine-bound subscriptions offered to this requester. */
  hostSubscriptions?: Array<{
    family: VizLlmCatalogEntry;
    reason?: 'undeclared' | 'other-organisation';
  }>;
  /**
   * Personal provider logins currently usable by this account. Detailed
   * connection/device-code state lives on `/api/account/subscriptions`; this
   * compact capability only decides whether a personal family may be picked.
   * Optional so an older server remains a safe "not connected".
   */
  personalSubscriptions?: VizPersonalSubscriptionCapabilities;
  /**
   * Whether the deployment declared an Ollama endpoint (OLLAMA_BASE_URL).
   * Ollama runs on the OPERATOR's infrastructure — orgs pick its models,
   * never its destination — so absent declaration the picker greys the
   * family. Optional so an older server payload reads as "unknown", which
   * renders as available rather than falsely refusing.
   */
  ollamaAvailable?: boolean;
}

/** The secret-free self-care projection from `/api/account/subscriptions`. */
export type VizAccountSubscriptions = AccountSubscriptionsResponse;

/** One provider family the server offers for tier/model selection. */
export interface VizLlmCatalogEntry {
  id: string;
  label: string;
  /** Null when self-hosted; otherwise the env var whose absence degrades the provider. */
  credentialEnvVar: string | null;
  /** True when the model list reflects an inventory we cannot enumerate statically. */
  suggestive: boolean;
  models: Array<{ id: string; label: string; tiers?: Array<1 | 2 | 3> }>;
}

/** One configured org provider key: presence and timestamp, never material. */
export interface VizOrgProviderKeyStatus {
  provider: string;
  configuredAt: string;
}

/** The organisation-level tier defaults and BYO-key state. */
export interface VizOrgModels {
  models: { l1: string | null; l2: string | null; l3: string | null };
  keys: VizOrgProviderKeyStatus[];
  /** False when the deployment lacks ATOMA_SECRET_ENCRYPTION_KEY: key management is refused server-side. */
  encryptionReady: boolean;
  catalog: VizLlmCatalogEntry[];
  operatorDefaults: { l1: string; l2: string; l3: string };
  /** See VizAccountModels.ollamaAvailable. */
  ollamaAvailable?: boolean;
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

/**
 * One row of the viewer's notification tray: a journal event the push routing
 * table addresses to them, with its copy already rendered server-side in the
 * language the request asked for. `kind` and `severity` stay plain strings for
 * the same newer-server tolerance as the journal rows above.
 */
export interface VizNotification {
  seq: number;
  at: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  /**
   * The event's own scope ids, so a row can LINK to its subject when the app
   * has a surface for it. `traceId` is resolved server-side from the project
   * run the event names (`runId` is a project-run id, which the Runs view
   * cannot address); all four are null when the event carried no such scope.
   */
  orgId: string | null;
  projectId: string | null;
  runId: string | null;
  traceId: string | null;
}

export interface VizNotificationPage {
  notifications: VizNotification[];
  /** Exclusive `seq` cursor for the next (older) page, or null at the end. */
  nextBefore: number | null;
}

/**
 * One watch's own account of itself. Facts about a TIMER IN A PROCESS — which
 * is the only reason they may be reported: the viz server hosts the tick, so
 * it knows its own. Never an aggregate over every watch that might exist.
 */
export interface VizSentinelWatchHealth {
  armed: boolean;
  /** `armed` | `disabled` | `lease-held` | `lease-lost` | `failing` | … */
  reason: string;
  source: string;
  intervalMs: number;
  startedAt: string;
  armedSince: string | null;
  lastTickAt: string | null;
  lastTickMs: number | null;
  ticks: number;
  runsScreenedLastTick: number;
  skippedLastTick: number;
  emittedSinceBoot: number;
  consecutiveFailures: number;
  lastError: string | null;
  /** The watch holding this store when this server is not it. */
  incumbent: {
    source: string;
    ownerPid: number;
    label: string | null;
    intervalMs: number;
    startedAt: string;
    heartbeatAt: string;
  } | null;
}

/**
 * WHAT THE SENTINEL SEES. This server's own watch, the rule table, the runs it
 * would screen right now across both corpora, the candidates it had to skip,
 * and the findings in the journal.
 *
 * `watch` is scoped to THIS PROCESS and says so on screen. It became reportable
 * when the server started hosting the tick; before that the honest answer was
 * silence, because a watch in another process is not something a server can
 * see — and that is still true of any watch but its own.
 */
export interface VizSentinelSnapshot {
  watch: VizSentinelWatchHealth | null;
  rules: { id: string; kind: string }[];
  live: {
    runId: string;
    corpus: 'operator' | 'project';
    orgId: string | null;
    projectId: string | null;
    label: string | null;
  }[];
  skipped: { runId: string | null; reason: string }[];
  findings: VizPlatformEvent[];
}

/** The product ledger's tail — a separate journal, never merged with the above. */
export interface VizLedgerEvent {
  at: string;
  kind: string;
  entity: string;
  detail?: Record<string, unknown>;
}

/** Admin plane: a freshly minted one-use invitation. Shown once, never stored. */
/**
 * An announcement's approved text, one entry per supported language. Keyed by
 * a plain string rather than the Locale union so a client built against an
 * older language list still renders a payload from a newer server.
 */
export type VizAnnouncementTexts = Record<string, { title: string; body: string }>;

export interface VizAdminInvitation {
  token: string;
  url: string;
  orgId: string;
  orgName: string;
  role: string;
  expiresAt: string;
}
