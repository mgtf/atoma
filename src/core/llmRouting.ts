import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse } from './types.js';

/**
 * Per-tier PROVIDER routing. The provider-agnostic tier vars
 * (ATOMA_MODEL_L1/L2/L3, see `modelForTier`) accept a `provider:model`
 * prefix — e.g. `ATOMA_MODEL_L1=zai:glm-4.5-air` sends every L1 call to
 * the Z.ai client while L2/L3 stay on the session's default provider.
 * This is the missing piece that lets the tier gradient span VENDORS,
 * not just model sizes: cheap tier on the cheapest vendor, top tier
 * wherever the reasoning is best.
 *
 * Prefix resolution is deliberately conservative: the token before the
 * first ':' is treated as a provider ONLY when it names a CONFIGURED
 * provider. Anything else keeps the whole string as a model id for the
 * default client — Ollama tags legitimately contain colons
 * (`qwen3:8b`, `glm-5.1:cloud`) and must flow through untouched.
 */
export function splitProviderModel(
  model: string,
  knownProviders: readonly string[]
): { provider: string | null; model: string } {
  const i = model.indexOf(':');
  if (i <= 0) return { provider: null, model };
  const prefix = model.slice(0, i).toLowerCase();
  if (!knownProviders.includes(prefix)) return { provider: null, model };
  return { provider: prefix, model: model.slice(i + 1) };
}

/**
 * LlmClient facade dispatching each request to the provider named by its
 * model prefix, default client otherwise. Observability decorators
 * (RecordingLlmClient, MetricsLlmClient) wrap THIS client, so every call
 * is recorded exactly once regardless of which provider served it — and
 * the recorded model id keeps its prefix, making the vendor visible in
 * traces and cost tables.
 */
export class RoutingLlmClient implements LlmClient {
  private readonly known: string[];

  constructor(
    private readonly defaultClient: LlmClient,
    private readonly providers: Record<string, LlmClient> = {}
  ) {
    this.known = Object.keys(providers).map((k) => k.toLowerCase());
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const { provider, model } = splitProviderModel(req.model, this.known);
    if (provider === null) return this.defaultClient.complete(req);
    const client = this.providers[provider];
    if (!client) {
      // Unreachable by construction (known derives from providers), kept as
      // a hard failure rather than a silent default-fallback: routing to
      // the wrong vendor is a cost/privacy bug, not a recoverable hiccup.
      throw new Error(`RoutingLlmClient: no client for provider "${provider}"`);
    }
    return client.complete({ ...req, model });
  }
}
