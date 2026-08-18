import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient } from '../core/types.js';
import { AnthropicLlmClient } from '../core/llm.js';
import { OllamaLlmClient } from '../core/llmOllama.js';
import { ClaudeCliLlmClient } from '../core/llmClaudeCli.js';
import { CodexCliLlmClient } from '../core/llmCodexCli.js';
import { splitProviderModel } from '../core/llmRouting.js';
import { RunnerConfigError } from '../core/errors.js';
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
 * only the caller knows whether an Anthropic credential should be demanded
 * at all, and the client carries a credential SNAPSHOT (`makeAnthropicClient(env)`)
 * that this switch has no business choosing on the caller's behalf. An
 * ollama/claude-cli session must never acquire an Anthropic credential it
 * will not use.
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
const PROVIDER_FACTORIES: Record<string, (env: NodeJS.ProcessEnv) => LlmClient> = {
  zai: (env) => {
    const apiKey = env['ZAI_API_KEY'];
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
        baseURL: env['ZAI_BASE_URL']?.trim() || ZAI_DEFAULT_BASE_URL,
      })
    );
  },
  // The three base kinds route through the ONE construction switch above —
  // a tier-pinned `anthropic:`/`ollama:`/`claude-cli:` client must be built
  // exactly like the ATOMA_LLM base client, or the two paths drift.
  anthropic: (env) => makeBaseClient('anthropic', { anthropic: makeAnthropicClient(env), env }),
  ollama: (env) => makeBaseClient('ollama', { env }),
  // Takes no env: it binds to a machine-local `claude /login`, which is
  // exactly why `assertTransportHonoursCredentials` refuses it whenever the
  // caller supplied a credential snapshot.
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
export function buildReferencedProviders(
  env: NodeJS.ProcessEnv = process.env
): Record<string, LlmClient> {
  const out: Record<string, LlmClient> = {};
  for (const name of referencedProviderNames(env)) out[name] = PROVIDER_FACTORIES[name]!(env);
  return out;
}

/**
 * A supplied credential must be a USED credential.
 *
 * `claude-cli` drives the machine's `claude /login` session: it takes no key,
 * no bearer token and no base URL, so a caller-supplied credential snapshot
 * is silently ignored and the work bills the host machine's subscription
 * instead. For a single developer that is the point of the transport. For
 * anything hosting a second credential it is a correctness failure that is
 * invisible until the bill arrives — and, per docs/saas-architecture.md §1,
 * serving another party's run through a consumer subscription is also
 * prohibited by the vendor.
 *
 * So the refusal is mechanical and at LAUNCH, matching how a codex L1 pin
 * already fails before any spend. It triggers on the caller having supplied
 * a snapshot at all — not on a notion of "tenant" — which keeps it correct
 * under every tenancy model the SaaS design might land on, and leaves the
 * developer path (no snapshot, inherit the process) untouched.
 */
export function assertTransportHonoursCredentials(
  kind: BaseProviderKind,
  env: NodeJS.ProcessEnv = {}
): void {
  if (kind === 'claude-cli') {
    throw new RunnerConfigError(
      'ATOMA_LLM=claude-cli cannot honour a supplied credential snapshot: it binds to the ' +
        "machine's `claude /login` session, so the run would bill that subscription and ignore " +
        'the credential passed to startTask. Use ATOMA_LLM=anthropic with ANTHROPIC_API_KEY ' +
        '(or ANTHROPIC_AUTH_TOKEN) in the snapshot, or omit the snapshot to inherit the process.'
    );
  }
  // Tier pins can name the same machine-bound transports. The base-kind
  // check above used to be the whole gate, so
  // `{ ATOMA_LLM: 'anthropic', ATOMA_MODEL_L2: 'claude-cli:sonnet' }`
  // constructed a CLI client that ignored the snapshot (review 2026-08-18 §1.6).
  const pinned = referencedProviderNames(env).filter(
    (name) => name === 'claude-cli' || name === 'codex'
  );
  if (pinned.length === 0) return;
  throw new RunnerConfigError(
    `tier pin ${pinned.map((name) => `"${name}:"`).join(', ')} cannot honour a supplied credential snapshot: ` +
      'those transports bind to a machine-local login and ignore the credential passed to startTask. ' +
      'Pin L2/L3 to a key-bearing provider (anthropic / zai / ollama) or omit the snapshot to inherit the process.'
  );
}
