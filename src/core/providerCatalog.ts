/**
 * THE PROVIDER/MODEL CATALOGUE FOR TENANT SELECTION.
 * ===================================================
 *
 * One static description of every provider a SaaS deployment may route a
 * tenant run to, and the models each offers, read by three consumers that
 * must not drift: the settings-write validators (`contracts/tierModels.ts`),
 * the run environment builder (`projects/coordinator.ts`), and the GL
 * client's Settings selectors.
 *
 * SCOPE. `claude-cli` and `codex` are deliberately absent: they bind to a
 * machine-local login session, which `docs/saas-architecture.md` refuses on
 * the tenant plane ("login providers" + the subscription-transport door).
 * This catalogue is therefore exactly the credential-honouring transports
 * `PROVIDER_FACTORIES` can build from an injected environment snapshot.
 *
 * The lists are EXTENDED BY DESIGN (owner decision 2026-08-27): every
 * generation a provider still serves, not only the built-in pins, so an
 * organisation can standardise on an older cheaper model if it wants. A new
 * entry is a one-line edit here — there is no second copy of any list.
 *
 * The Ollama entries are SUGGESTIONS, not an inventory: that provider is
 * self-hosted, so what actually resolves depends on the deployment pulling
 * the tags. The listed tags keep it selectable without free text, and stay
 * honest about their role through `suggestive: true`.
 */

export interface ProviderModelEntry {
  /** Selector id after `provider:` as the router receives it. */
  readonly id: string;
  /** Human label rendered by the Settings pickers. */
  readonly label: string;
}

export interface LlmProviderEntry {
  readonly id: 'anthropic' | 'zai' | 'ollama';
  readonly label: string;
  /**
   * The credential the run child needs, when one exists. `null` means the
   * provider needs no secret (self-hosted Ollama); such a provider is always
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
  // Both spellings of the built-in tier pins: the dated snapshot the runner
  // pins by default and the friendly alias, so a stored choice survives
  // either convention.
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (20251001)' },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
  { id: 'claude-sonnet-4-0', label: 'Claude Sonnet 4' },
];

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
    id: 'zai',
    label: 'Z.ai',
    credentialEnvVar: 'ZAI_API_KEY',
    configurableEnvVars: ['ZAI_BASE_URL'],
    suggestive: false,
    models: ZAI_MODELS,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    credentialEnvVar: null,
    configurableEnvVars: ['OLLAMA_BASE_URL', 'OLLAMA_MODEL'],
    suggestive: true,
    models: OLLAMA_MODELS,
  },
] as const;

/** Every selectable provider id, e.g. handed to the routing tables. */
export function llmProviderIds(): readonly LlmProviderEntry['id'][] {
  return LLM_PROVIDER_CATALOG.map((provider) => provider.id);
}

function findProvider(providerId: string): LlmProviderEntry | undefined {
  return LLM_PROVIDER_CATALOG.find((provider) => provider.id === providerId);
}

/**
 * A billed provider is ready only with a stored org key. Self-hosted
 * providers (credentialEnvVar null) are always ready.
 */
export function orgProviderIsReady(
  provider: { readonly id: string; readonly credentialEnvVar: string | null },
  configuredProviderIds: ReadonlySet<string>
): boolean {
  if (provider.credentialEnvVar === null) return true;
  return configuredProviderIds.has(provider.id);
}

/** True when the org has stored at least one billed-provider key. */
export function orgHasBilledProviderKey(configuredProviderIds: ReadonlySet<string>): boolean {
  return LLM_PROVIDER_CATALOG.some(
    (provider) =>
      provider.credentialEnvVar !== null && configuredProviderIds.has(provider.id)
  );
}

/**
 * Is `value` a selection the catalogue offers? Accepts BOTH spellings:
 * a plain bare model id (the historical `auth_principal_model_pins` shape)
 * and the full `provider:model` selector. Ollama tags carry colons, so the
 * split takes everything after the FIRST colon — mirroring
 * `splitProviderModel` without importing the runner into every validator.
 */
export function isValidTierModelSelection(value: string): boolean {
  const colonIndex = value.indexOf(':');
  if (colonIndex === -1) {
    return LLM_PROVIDER_CATALOG.some((provider) =>
      provider.models.some((model) => model.id === value)
    );
  }
  const provider = findProvider(value.slice(0, colonIndex));
  if (!provider) return false;
  const modelId = value.slice(colonIndex + 1);
  return modelId.length > 0 && provider.models.some((model) => model.id === modelId);
}

/** Label for a stored selection, or the raw value when unknown. */
export function tierModelSelectionLabel(value: string): string {
  const colonIndex = value.indexOf(':');
  if (colonIndex === -1) return value;
  const provider = findProvider(value.slice(0, colonIndex));
  if (!provider) return value;
  const modelId = value.slice(colonIndex + 1);
  return (
    provider.models.find((model) => model.id === modelId)?.label ?? `${provider.label} ${modelId}`
  );
}
