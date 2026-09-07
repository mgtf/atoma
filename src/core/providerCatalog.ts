import {
  formatModelSelector,
  tryParseModelSelector,
  type ModelSelector,
  type ModelSelectorVendor,
  type TierNumber,
} from '../contracts/modelSelector.js';
import {
  CHATGPT_SUBSCRIPTION_MODELS,
  HOST_SUBSCRIPTION_ALIASES,
} from '../contracts/runPayers.js';

/**
 * THE VENDOR/MODEL CATALOGUE FOR TENANT SELECTION.
 * =================================================
 *
 * One static description of every vendor a deployment may route a run to by
 * API, and the models each offers, read by three consumers that must not
 * drift: the settings-write validators (`contracts/tierModels.ts`), the run
 * environment builder (`projects/coordinator.ts`), and the GL client's
 * Settings selectors.
 *
 * Every offered choice is a full selector (`contracts/modelSelector.ts`):
 * a catalogue entry offers `api:<vendor>:<model>`, and the subscription
 * FAMILIES below offer `sub:` and `own:` spellings of the two vendors whose
 * CLI atoma can drive. The picker renders `${selectorPrefix}:${model.id}` and
 * nothing else builds a selector by hand.
 *
 * The lists are EXTENDED BY DESIGN (owner decision 2026-08-27): every
 * generation a vendor still serves, so an organisation can standardise on an
 * older cheaper model if it wants. A new entry is a one-line edit here — there
 * is no second copy of any list.
 *
 * The Ollama entries are SUGGESTIONS, not an inventory: that vendor is
 * self-hosted, so what actually resolves depends on the deployment pulling
 * the tags. The listed tags keep it selectable without free text, and stay
 * honest about their role through `suggestive: true`.
 *
 * THE SUBSCRIPTIONS ARE NEIGHBOURS, NOT MEMBERS (design 2026-08-28, D4).
 * `HOST_SUBSCRIPTION_FAMILIES` are offered by the account picker beside this
 * catalogue and are deliberately not entries, because three mechanisms read
 * `LLM_PROVIDER_CATALOG` as "things that may hold a key": `orgProviderIsReady`
 * returns TRUE for any entry whose `credentialEnvVar` is null, so a
 * subscription row would read as always-ready to every viewer — the exact
 * inverse of a per-requester offer; `resolveOrgProviderKeys` passes
 * `provider.id` into a `ProviderKeyProvider` parameter, mirrored by the
 * `CHECK (provider IN (…))` constraint on `auth_org_provider_keys`; and
 * `injectOrgProviderKeys` iterates the same array.
 */

export interface ProviderModelEntry {
  /** The vendor's model id — the third selector segment. */
  readonly id: string;
  /** Human label rendered by the Settings pickers. */
  readonly label: string;
  /** Tiers this model may serve; absent means every tier. */
  readonly tiers?: readonly TierNumber[];
}

export interface LlmProviderEntry {
  readonly id: ModelSelectorVendor;
  readonly label: string;
  /** What the picker prepends to a model id to form the stored selector. */
  readonly selectorPrefix: `api:${ModelSelectorVendor}`;
  /**
   * The credential the run child needs, when one exists. `null` means the
   * vendor needs no secret (self-hosted Ollama); such a vendor is always
   * considered configured for an organisation.
   */
  readonly credentialEnvVar: string | null;
  /** Additional tuning variables a deployment may set alongside the key. */
  readonly configurableEnvVars: readonly string[];
  /** True when the model list reflects a live remote inventory we cannot enumerate statically. */
  readonly suggestive: boolean;
  readonly models: readonly ProviderModelEntry[];
}

const ANTHROPIC_MODELS: readonly ProviderModelEntry[] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (20251001)' },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
  { id: 'claude-sonnet-4-0', label: 'Claude Sonnet 4' },
];

/**
 * The OpenAI API serves the same slugs a ChatGPT subscription does, with
 * tools — so by API every tier is admissible, L1 included. Only the CLI
 * transport is supervisor-only (see `selectorAdmitsTools`).
 */
const OPENAI_MODELS: readonly ProviderModelEntry[] = CHATGPT_SUBSCRIPTION_MODELS.map((model) => ({
  id: model,
  label: modelLabel(model),
}));

const ZAI_MODELS: readonly ProviderModelEntry[] = [
  { id: 'glm-4.5', label: 'GLM-4.5' },
  { id: 'glm-4.5-air', label: 'GLM-4.5 Air' },
  { id: 'glm-4.5-flash', label: 'GLM-4.5 Flash' },
  { id: 'glm-4-32b-0414-128k', label: 'GLM-4 32B' },
];

const OLLAMA_MODELS: readonly ProviderModelEntry[] = [
  { id: 'qwen3:8b', label: 'Qwen3 8B' },
  { id: 'qwen3:30b-a3b', label: 'Qwen3 30B A3B' },
  { id: 'llama3.3:70b', label: 'Llama 3.3 70B' },
  { id: 'mistral-small3.1:latest', label: 'Mistral Small 3.1' },
  { id: 'gemma3:27b', label: 'Gemma 3 27B' },
  { id: 'deepseek-r1:14b', label: 'DeepSeek R1 14B' },
];

export const LLM_PROVIDER_CATALOG: readonly LlmProviderEntry[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    selectorPrefix: 'api:anthropic',
    credentialEnvVar: 'ANTHROPIC_API_KEY',
    // ANTHROPIC_AUTH_TOKEN is deliberately absent: the bearer slot has no
    // place to be supplied from in this product, and project runs refuse it
    // (see src/projects/AGENTS.md). Local operator runs still honour it
    // through the SDK's own chain in src/run/auth.ts.
    configurableEnvVars: ['ANTHROPIC_BASE_URL'],
    suggestive: false,
    models: ANTHROPIC_MODELS,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    selectorPrefix: 'api:openai',
    credentialEnvVar: 'OPENAI_API_KEY',
    configurableEnvVars: ['OPENAI_BASE_URL'],
    suggestive: false,
    models: OPENAI_MODELS,
  },
  {
    id: 'zai',
    label: 'Z.ai',
    selectorPrefix: 'api:zai',
    credentialEnvVar: 'ZAI_API_KEY',
    configurableEnvVars: ['ZAI_BASE_URL'],
    suggestive: false,
    models: ZAI_MODELS,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    selectorPrefix: 'api:ollama',
    credentialEnvVar: null,
    configurableEnvVars: ['OLLAMA_BASE_URL', 'OLLAMA_MODEL'],
    suggestive: true,
    models: OLLAMA_MODELS,
  },
] as const;

export interface SubscriptionFamily {
  /** The selector prefix the picker prepends: `sub:<vendor>` or `own:<vendor>`. */
  readonly id: `sub:${ModelSelectorVendor}` | `own:${ModelSelectorVendor}`;
  readonly selectorPrefix: `sub:${ModelSelectorVendor}` | `own:${ModelSelectorVendor}`;
  readonly label: string;
  readonly credentialEnvVar: null;
  readonly suggestive: false;
  readonly models: readonly ProviderModelEntry[];
}

/**
 * The host's own Claude Code login, offered per tier to a platform admin on a
 * deployment that declares it. Shaped like a catalogue entry so one picker can
 * render both, and typed separately so nothing that iterates the catalogue can
 * reach it. Its "models" are the ALIASES the transport serves — a subscription
 * resolves whatever generation Claude Code gives it that day, so a dated id
 * here would be a promise the transport cannot keep (design 2026-08-28, Q2).
 */
export const HOST_SUBSCRIPTION_FAMILY: SubscriptionFamily = {
  id: 'sub:anthropic',
  selectorPrefix: 'sub:anthropic',
  label: 'Claude (host subscription)',
  credentialEnvVar: null,
  suggestive: false,
  models: HOST_SUBSCRIPTION_ALIASES.map((alias) => ({ id: alias, label: aliasLabel(alias) })),
};

/** The operator's ChatGPT subscription, routed through the local Codex CLI. */
export const CHATGPT_SUBSCRIPTION_FAMILY: SubscriptionFamily = {
  id: 'sub:openai',
  selectorPrefix: 'sub:openai',
  label: 'ChatGPT (host subscription)',
  credentialEnvVar: null,
  suggestive: false,
  models: CHATGPT_SUBSCRIPTION_MODELS.map((model) => ({
    id: model,
    label: modelLabel(model),
    tiers: [2, 3],
  })),
};

/** The signed-in requester's own ChatGPT subscription. Account-only. */
export const PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY: SubscriptionFamily = {
  id: 'own:openai',
  selectorPrefix: 'own:openai',
  label: 'ChatGPT (your subscription)',
  credentialEnvVar: null,
  suggestive: false,
  models: CHATGPT_SUBSCRIPTION_MODELS.map((model) => ({
    id: model,
    label: modelLabel(model),
    tiers: [2, 3],
  })),
};

/** Every machine-bound family offered beside (never inside) the key catalogue. */
export const HOST_SUBSCRIPTION_FAMILIES: readonly SubscriptionFamily[] = [
  HOST_SUBSCRIPTION_FAMILY,
  CHATGPT_SUBSCRIPTION_FAMILY,
];

function aliasLabel(alias: string): string {
  return alias.charAt(0).toUpperCase() + alias.slice(1);
}

function modelLabel(model: string): string {
  const match = /^gpt-(\d+(?:\.\d+)?)-(.+)$/.exec(model);
  return match ? `GPT-${match[1]} ${aliasLabel(match[2]!)}` : model;
}

/** Every selectable vendor id, e.g. handed to the routing tables. */
export function llmProviderIds(): readonly LlmProviderEntry['id'][] {
  return LLM_PROVIDER_CATALOG.map((provider) => provider.id);
}

export function findProvider(vendor: string): LlmProviderEntry | undefined {
  return LLM_PROVIDER_CATALOG.find((provider) => provider.id === vendor);
}

/**
 * A billed vendor is ready only with a stored org key. Self-hosted vendors
 * (credentialEnvVar null) are always ready.
 */
export function orgProviderIsReady(
  provider: { readonly id: string; readonly credentialEnvVar: string | null },
  configuredProviderIds: ReadonlySet<string>
): boolean {
  if (provider.credentialEnvVar === null) return true;
  return configuredProviderIds.has(provider.id);
}

/** True when the org has stored at least one billed-vendor key. */
export function orgHasBilledProviderKey(configuredProviderIds: ReadonlySet<string>): boolean {
  return LLM_PROVIDER_CATALOG.some(
    (provider) => provider.credentialEnvVar !== null && configuredProviderIds.has(provider.id)
  );
}

/**
 * Is `value` an `api:` selection the catalogue offers? The ORG level's whole
 * value space: an org default is inherited by every member, so it may name a
 * key-billed choice and nothing that spends a login.
 */
export function isValidTierModelSelection(value: string): boolean {
  const selector = tryParseModelSelector(value);
  if (!selector || selector.mode !== 'api') return false;
  const provider = findProvider(selector.vendor);
  return provider !== undefined && provider.models.some((model) => model.id === selector.model);
}

/** The family a `sub:`/`own:` selector belongs to, when it names an offered model on that tier. */
function subscriptionFamilyOf(
  selector: ModelSelector,
  tier?: TierNumber
): SubscriptionFamily | null {
  const family = [
    HOST_SUBSCRIPTION_FAMILY,
    CHATGPT_SUBSCRIPTION_FAMILY,
    PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY,
  ].find((candidate) => candidate.selectorPrefix === `${selector.mode}:${selector.vendor}`);
  if (!family) return null;
  const model = family.models.find((entry) => entry.id === selector.model);
  if (!model) return null;
  if (tier !== undefined && model.tiers && !model.tiers.includes(tier)) return null;
  return family;
}

/**
 * The ACCOUNT level's admissible value space: a catalogue selection, or a
 * subscription family's model on a tier it may serve. The single union point —
 * every other reader stays on `isValidTierModelSelection`, so widening the
 * account space cannot widen the org space by accident.
 */
export function isAccountTierSelection(value: string, tier?: TierNumber): boolean {
  if (isValidTierModelSelection(value)) return true;
  const selector = tryParseModelSelector(value);
  return selector !== null && subscriptionFamilyOf(selector, tier) !== null;
}

/** Label for a stored selection, or the raw value when unknown. */
export function tierModelSelectionLabel(value: string): string {
  const selector = tryParseModelSelector(value);
  if (!selector) return value;
  const family = subscriptionFamilyOf(selector);
  if (family) {
    const model = family.models.find((entry) => entry.id === selector.model)!;
    return `${family.label} — ${model.label}`;
  }
  const provider = findProvider(selector.vendor);
  if (!provider || selector.mode !== 'api') return formatModelSelector(selector);
  return (
    provider.models.find((model) => model.id === selector.model)?.label ??
    `${provider.label} ${selector.model}`
  );
}
