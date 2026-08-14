import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient } from '../core/types.js';
import { AnthropicLlmClient } from '../core/llm.js';
import { OllamaLlmClient } from '../core/llmOllama.js';
import { ClaudeCliLlmClient } from '../core/llmClaudeCli.js';
import { CodexCliLlmClient } from '../core/llmCodexCli.js';
import { splitProviderModel } from '../core/llmRouting.js';
import { makeAnthropicClient } from './auth.js';

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
 * ONE construction switch for the process-wide base provider. The runner
 * and the curriculum CLI both used to hand-roll this ternary, re-reading
 * OLLAMA_BASE_URL/OLLAMA_MODEL independently — the drift class this repo
 * has been bitten by twice (research-brief.ts lost every safety guarantee
 * the build path gained; curriculum's copy of the provider switch missed
 * the bare `claude` alias). Review 2026-08-14 §3.9.
 *
 * `anthropic` REQUIRES a constructed SDK client rather than building one:
 * `makeAnthropicClient()` exits the process when no credential resolves,
 * and only the caller knows whether an Anthropic credential should even be
 * demanded (an ollama/claude-cli session must never die on a missing key).
 */
export function makeBaseClient(
  kind: BaseProviderKind,
  opts?: { anthropic?: Anthropic; env?: NodeJS.ProcessEnv }
): LlmClient {
  const env = opts?.env ?? process.env;
  switch (kind) {
    case 'ollama':
      return new OllamaLlmClient({
        baseUrl: env['OLLAMA_BASE_URL'],
        defaultModel: env['OLLAMA_MODEL'],
      });
    case 'claude-cli':
      return new ClaudeCliLlmClient();
    case 'anthropic':
      if (!opts?.anthropic) {
        throw new Error(
          'makeBaseClient("anthropic") needs a constructed Anthropic SDK client — ' +
            'call makeAnthropicClient() and pass it as opts.anthropic'
        );
      }
      return new AnthropicLlmClient(opts.anthropic);
  }
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
  // The three base kinds route through the ONE construction switch above —
  // a tier-pinned `anthropic:`/`ollama:`/`claude-cli:` client must be built
  // exactly like the ATOMA_LLM base client, or the two paths drift.
  anthropic: () => makeBaseClient('anthropic', { anthropic: makeAnthropicClient() }),
  ollama: () => makeBaseClient('ollama'),
  'claude-cli': () => makeBaseClient('claude-cli'),
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
 * Provider prefixes explicitly referenced by the three tier-model env vars.
 * Parsing DELEGATES to `splitProviderModel` — this function used to
 * re-implement the same first-colon/known-prefix walk byte-for-byte, which
 * is exactly the two-copies-of-one-rule drift that broke `storeDbPath` and
 * `usedOrdinals` (review 2026-08-14 §3.9). A known-provider pin with an
 * empty model (`zai:`) therefore throws HERE, at construction scan time,
 * with the env-var shape in the message — instead of the first LLM call.
 */
export function referencedProviderNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const referenced = new Set<string>();
  for (const tier of [1, 2, 3] as const) {
    // Default tier models are unprefixed Anthropic ids. Only an explicit env
    // value can add a cross-provider route.
    const value = env[`ATOMA_MODEL_L${tier}`]?.trim();
    if (!value) continue;
    const { provider } = splitProviderModel(value, KNOWN_PROVIDER_PREFIXES);
    if (provider !== null) referenced.add(provider);
  }
  return [...referenced];
}

/**
 * Scan the three tier pins for `provider:` prefixes and build ONLY the
 * referenced clients. Returns the map to hand to RoutingLlmClient (empty
 * when no tier crosses providers — the router then costs nothing).
 */
export function buildReferencedProviders(): Record<string, LlmClient> {
  const out: Record<string, LlmClient> = {};
  for (const name of referencedProviderNames()) out[name] = PROVIDER_FACTORIES[name]!();
  return out;
}
