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
}

export interface VizEvent {
  id: string;
  ts: number;
  kind: string;
  role?: string;
  name?: string;
  model?: string;
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
  skillId?: string;
  snapshot?: RegistryType;
  modifications?: unknown;
  llmEventId?: string;
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
  ordinal: number;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
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
  l1Name: string;
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
