import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient } from '../core/types.js';
import { AnthropicLlmClient } from '../core/llm.js';
import { OllamaLlmClient } from '../core/llmOllama.js';
import { ClaudeCliLlmClient } from '../core/llmClaudeCli.js';
import { CodexCliLlmClient } from '../core/llmCodexCli.js';
import { makeAnthropicClient } from './auth.js';
import { modelForTier } from '../core/models.js';

/**
 * Default base URL of Z.ai's ANTHROPIC-COMPATIBLE endpoint — the same one
 * Claude Code users point ANTHROPIC_BASE_URL at to run GLM models. Because
 * it speaks the Messages API, the existing AnthropicLlmClient (tool loop,
 * cache_control, truncation) serves it unchanged; Z.ai simply ignores the
 * knobs it doesn't support.
 */
export const ZAI_DEFAULT_BASE_URL = 'https://api.z.ai/api/anthropic';

export type BaseProviderKind = 'anthropic' | 'ollama' | 'claude-cli';

/**
 * One definition for the process-wide provider selector used by the runner
 * and curriculum CLI. Cross-vendor `provider:model` tier pins are separate.
 */
export function resolveBaseProviderKind(raw?: string): BaseProviderKind {
  const provider = (raw ?? 'anthropic').trim().toLowerCase();
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'ollama') return 'ollama';
  if (provider === 'claude-cli' || provider === 'claude') return 'claude-cli';
  if (provider === 'codex') {
    throw new Error(
      'ATOMA_LLM=codex is not supported because Codex is structurally refused at L1; ' +
        'pin supervisor tiers instead (for example ATOMA_MODEL_L3=codex:gpt-5.6-sol)'
    );
  }
  throw new Error(
    `unknown ATOMA_LLM provider "${raw}" (expected anthropic, ollama, claude-cli, or claude)`
  );
}

/**
 * Providers that a `provider:model` tier pin can reference
 * (e.g. ATOMA_MODEL_L1=zai:glm-4.5-air). Each entry builds its client
 * lazily — only providers actually referenced by a tier var are
 * constructed, so a missing ZAI_API_KEY only matters if a tier asks
 * for Z.ai.
 */
const PROVIDER_FACTORIES: Record<string, () => LlmClient> = {
  zai: () => {
    const apiKey = process.env['ZAI_API_KEY'];
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        'a tier model is pinned to "zai:…" but ZAI_API_KEY is not set — ' +
          'get a key at https://z.ai and export ZAI_API_KEY (optional: ZAI_BASE_URL, ' +
          `default ${ZAI_DEFAULT_BASE_URL})`
      );
    }
    return new AnthropicLlmClient(
      new Anthropic({
        apiKey: apiKey.trim(),
        baseURL: process.env['ZAI_BASE_URL']?.trim() || ZAI_DEFAULT_BASE_URL,
      })
    );
  },
  anthropic: () => new AnthropicLlmClient(makeAnthropicClient()),
  ollama: () =>
    new OllamaLlmClient({
      baseUrl: process.env['OLLAMA_BASE_URL'],
      defaultModel: process.env['OLLAMA_MODEL'],
    }),
  'claude-cli': () => new ClaudeCliLlmClient(),
  // Local Codex CLI on a ChatGPT subscription (`codex login`) — TIERS 2/3
  // ONLY. It cannot host a tool loop (openai/codex#6049: Codex's own
  // built-in tools cannot be disabled, so calls would bypass ToolSandbox
  // and the #8a scope gate), and CodexCliLlmClient.complete throws when
  // handed tools rather than degrading silently. Needs no key: an ABSENT
  // OPENAI_API_KEY is what makes it reuse the subscription login.
  codex: () => new CodexCliLlmClient(),
};

/** Provider names a tier pin may reference via the `provider:` prefix. */
export const KNOWN_PROVIDER_PREFIXES = Object.keys(PROVIDER_FACTORIES);

/**
 * Scan the three tier pins for `provider:` prefixes and build ONLY the
 * referenced clients. Returns the map to hand to RoutingLlmClient (empty
 * when no tier crosses providers — the router then costs nothing).
 */
export function buildReferencedProviders(): Record<string, LlmClient> {
  const referenced = new Set<string>();
  for (const tier of [1, 2, 3] as const) {
    const value = modelForTier(tier);
    const i = value.indexOf(':');
    if (i > 0) {
      const prefix = value.slice(0, i).toLowerCase();
      if (KNOWN_PROVIDER_PREFIXES.includes(prefix)) referenced.add(prefix);
    }
  }
  const out: Record<string, LlmClient> = {};
  for (const name of referenced) out[name] = PROVIDER_FACTORIES[name]!();
  return out;
}
