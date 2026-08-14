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
 *
 * DOUBLE-PREFIX ESCAPE: only the FIRST token is ever a provider, so a
 * model id that itself starts with a provider-looking token is reachable
 * by prefixing its real provider — `ollama:codex:latest` routes the tag
 * `codex:latest` to the ollama client instead of parsing "codex" as a
 * provider. Documented rather than special-cased: the first-colon rule is
 * the whole grammar.
 *
 * A KNOWN provider with an EMPTY model (`zai:`) is rejected HERE, at
 * split time: the old behaviour returned model '' and the empty string
 * travelled to the vendor as a model id, failing far from the typo
 * (review 2026-08-14 §3.9 hardening).
 */
export function splitProviderModel(
  model: string,
  knownProviders: readonly string[]
): { provider: string | null; model: string } {
  const i = model.indexOf(':');
  if (i <= 0) return { provider: null, model };
  const prefix = model.slice(0, i).toLowerCase();
  if (!knownProviders.includes(prefix)) return { provider: null, model };
  const rest = model.slice(i + 1);
  if (rest.length === 0) {
    throw new Error(
      `tier model pin "${model}" names provider "${prefix}" but no model id — ` +
        `use the form ATOMA_MODEL_L1=${prefix}:<model-id>`
    );
  }
  return { provider: prefix, model: rest };
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
  private readonly providers: Record<string, LlmClient>;

  constructor(
    private readonly defaultClient: LlmClient,
    providers: Record<string, LlmClient> = {}
  ) {
    // Normalise the map's keys ONCE: `known` was lowercased while the map
    // kept its original casing, so a mixed-case provider name (e.g.
    // {"ZAI": client}) matched the prefix but missed the lookup — making
    // the "unreachable by construction" throw below reachable for any
    // public-API consumer. One normalisation, both sides agree forever.
    this.providers = Object.fromEntries(
      Object.entries(providers).map(([k, v]) => [k.toLowerCase(), v])
    );
    this.known = Object.keys(this.providers);
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
    // The response (including `servedModel`, the transport's own report of
    // what it actually invoked) flows back UNTOUCHED — the router names
    // providers, never models, so it must not overwrite the served identity
    // the observability layers price on.
    return client.complete({ ...req, model });
  }
}
