import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient } from '../core/types.js';
import { AnthropicLlmClient } from '../core/llm.js';
import { OllamaLlmClient } from '../core/llmOllama.js';
import { OpenAiLlmClient } from '../core/llmOpenAi.js';
import { ClaudeCliLlmClient } from '../core/llmClaudeCli.js';
import { CodexCliLlmClient } from '../core/llmCodexCli.js';
import { RunnerConfigError } from '../core/errors.js';
import {
  formatModelSelector,
  readTierSelectors,
  referencedTransports,
  selectorSpendsSubscription,
  tierPinVariable,
  TIERS,
  transportOf,
  type ModelSelector,
  type ModelTransport,
  type TierNumber,
} from '../contracts/modelSelector.js';
import { makeAnthropicClient } from './auth.js';

/**
 * Default base URL of Z.ai's ANTHROPIC-COMPATIBLE endpoint — the same one
 * Claude Code users point ANTHROPIC_BASE_URL at to run GLM models. Because
 * it speaks the Messages API, the existing AnthropicLlmClient (tool loop,
 * cache_control, truncation) serves it unchanged; Z.ai simply ignores the
 * knobs it doesn't support.
 */
export const ZAI_DEFAULT_BASE_URL = 'https://api.z.ai/api/anthropic';

/**
 * ONE construction switch per TRANSPORT (`contracts/modelSelector.ts`
 * `transportOf`). The runner, the curriculum CLI and the viz server's
 * announcement translator all build their clients here; nothing else may
 * hand-roll an anthropic/openai/zai/ollama/claude-cli/codex switch — the
 * drift class this repo has been bitten by twice (research-brief.ts lost every
 * safety guarantee the build path gained; curriculum's copy of the provider
 * switch missed an alias). Review 2026-08-14 §3.9.
 *
 * `anthropic-api` takes the constructed SDK client when the caller has one,
 * because the client carries a credential SNAPSHOT (`makeAnthropicClient(env)`)
 * and only the caller knows which environment that snapshot must come from.
 */
export function makeTransportClient(
  transport: ModelTransport,
  opts: { readonly env?: NodeJS.ProcessEnv; readonly anthropic?: Anthropic } = {}
): LlmClient {
  const env = opts.env ?? process.env;
  switch (transport) {
    case 'anthropic-api':
      return new AnthropicLlmClient(opts.anthropic ?? makeAnthropicClient(env));
    case 'openai-api':
      return new OpenAiLlmClient({ apiKey: env['OPENAI_API_KEY'], baseUrl: env['OPENAI_BASE_URL'] });
    case 'zai-api':
      return makeZaiClient(env);
    case 'ollama':
      return new OllamaLlmClient({
        baseUrl: env['OLLAMA_BASE_URL'],
        defaultModel: env['OLLAMA_MODEL'],
      });
    // Takes no env: it binds to a machine-local `claude /login`, which is
    // exactly why `assertTransportHonoursCredentials` refuses it whenever the
    // parent did not authorise the tier.
    case 'claude-cli':
      return new ClaudeCliLlmClient();
    // Local Codex CLI on a ChatGPT login — TIERS 2/3 ONLY, enforced at parse
    // time (`selectorAdmitsTools`) and again by the client, which throws when
    // handed tools rather than degrading silently. The client captures THIS
    // run's environment snapshot: CODEX_HOME selects the authorised principal
    // profile, while its subprocess allowlist strips every API/provider key.
    case 'codex-cli':
      return new CodexCliLlmClient({ env });
  }
}

/** Build the Anthropic-compatible Z.ai transport from one environment snapshot. */
function makeZaiClient(env: NodeJS.ProcessEnv): LlmClient {
  const apiKey = env['ZAI_API_KEY'];
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      'api:zai requires ZAI_API_KEY — get a key at https://z.ai and export ZAI_API_KEY ' +
        `(optional: ZAI_BASE_URL, default ${ZAI_DEFAULT_BASE_URL})`
    );
  }
  return new AnthropicLlmClient(
    new Anthropic({
      apiKey: apiKey.trim(),
      baseURL: env['ZAI_BASE_URL']?.trim() || ZAI_DEFAULT_BASE_URL,
    })
  );
}

/** The three selectors of an environment, parsed; a missing or malformed pin throws. */
export function tierSelectors(
  env: NodeJS.ProcessEnv = process.env,
  opts: { readonly allowOwn?: boolean } = {}
): Record<TierNumber, ModelSelector> {
  return readTierSelectors(env, opts);
}

/**
 * Build ONLY the transports the three tier selectors reach, each once, keyed
 * for `RoutingLlmClient`. A transport is constructed lazily from the SNAPSHOT
 * it is asked about, so a missing ZAI_API_KEY only matters if a tier asks for
 * Z.ai, and a tenant run's clients read the tenant's environment.
 */
export function buildTierClients(
  env: NodeJS.ProcessEnv = process.env,
  opts: { readonly allowOwn?: boolean; readonly anthropic?: Anthropic } = {}
): Partial<Record<ModelTransport, LlmClient>> {
  const selectors = tierSelectors(env, { allowOwn: opts.allowOwn ?? false });
  const out: Partial<Record<ModelTransport, LlmClient>> = {};
  for (const transport of referencedTransports(selectors)) {
    out[transport] = makeTransportClient(transport, {
      env,
      ...(opts.anthropic ? { anthropic: opts.anthropic } : {}),
    });
  }
  return out;
}

/** `L1=… L2=… L3=…`, for the run banner and the burn-in label. */
export function describeTierSelectors(selectors: Readonly<Record<TierNumber, ModelSelector>>): string {
  return TIERS.map((tier) => `L${tier}=${formatModelSelector(selectors[tier])}`).join('  ');
}

/**
 * A supplied credential must be a USED credential.
 *
 * `sub:` and `own:` selectors drive a machine-local login session (Claude
 * Code or Codex): they take no key, no bearer token and no base URL, so a
 * caller-supplied credential snapshot is silently ignored and the work bills
 * that login instead. For a single developer that is the point of the
 * transport. For anything hosting a second credential it is a correctness
 * failure that is invisible until the bill arrives — and, per
 * docs/saas-architecture.md §1, serving another party's run through a
 * consumer subscription is also prohibited by the vendor.
 *
 * So the refusal is mechanical and at LAUNCH, matching how a Codex L1 pin
 * already fails before any spend. It triggers on the caller having supplied a
 * snapshot at all — not on a notion of "tenant" — which keeps it correct under
 * every tenancy model the SaaS design might land on, and leaves the developer
 * path (no snapshot, inherit the process) untouched.
 *
 * WHAT THE PARENT AUTHORISED, named tier by tier. A project run may be MIXED:
 * the coordinator admits a platform admin's per-tier `sub:` pin or a member's
 * own `own:` pin after re-asking the authority, and records the result in
 * `ATOMA_SUBSCRIPTION_TIERS` (`l1,l2,l3` subset). A machine-bound selector
 * on a tier NOT in that list reached the child another way and is refused
 * here, before spend (design 2026-08-28, Q8). The list is a CAPABILITY, not a
 * claim: it only ever narrows what this assertion permits, and a child that
 * forges it cannot grant itself a credential — the subscription subprocess
 * authenticates from the host's own login session, which a tenant's run has
 * no way to obtain.
 */
export function assertTransportHonoursCredentials(env: NodeJS.ProcessEnv): void {
  const authorised = new Set(
    (env['ATOMA_SUBSCRIPTION_TIERS'] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
  const selectors = readTierSelectors(env, { allowOwn: true });
  const unauthorised = TIERS.filter(
    (tier) => selectorSpendsSubscription(selectors[tier]) && !authorised.has(`l${tier}`)
  );
  if (unauthorised.length === 0) return;
  throw new RunnerConfigError(
    `${unauthorised
      .map((tier) => `${tierPinVariable(tier)}=${formatModelSelector(selectors[tier])}`)
      .join(', ')} cannot honour a supplied credential snapshot: a ${unauthorised
      .map((tier) => transportOf(selectors[tier]))
      .filter((value, index, all) => all.indexOf(value) === index)
      .join('/')} selector binds to a machine-local login and ignores the credential passed to ` +
      'startTask. Pin the tier to an api: selector, or omit the snapshot to inherit the process.'
  );
}
