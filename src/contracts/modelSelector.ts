import { z } from 'zod';

/**
 * THE MODEL SELECTOR — ONE GRAMMAR FOR EVERY TIER, EVERYWHERE.
 * ============================================================
 *
 *   <mode>:<vendor>:<model>
 *
 * Three fixed segments. The first two are closed vocabularies; the third is
 * whatever the vendor serves, colons included (`api:ollama:qwen3:4b`).
 *
 * MODE answers WHO PAYS and HOW THE CALL TRAVELS:
 *   api — the vendor's API, billed to a key (or to nobody, for a self-hosted
 *         Ollama). The only mode an ORGANISATION default may name, because an
 *         org default is inherited by every member by construction and a
 *         payer-bearing value there would be somebody's money nobody chose.
 *   sub — the HOST's own subscription, spent through the vendor's CLI on the
 *         machine's login session: Claude Code for anthropic, Codex for
 *         openai. Admissible from the host environment and from a platform
 *         admin's own account pin on the deployment that declares it.
 *   own — the REQUESTING MEMBER's own subscription, through the same CLI
 *         bound to a private profile. Account pins only, never the host env:
 *         a machine cannot own a person's login.
 *
 * VENDOR is the company whose model answers. It is not a transport: the same
 * vendor is reached by different transports depending on the mode, and that
 * mapping (`transportOf`) is stated once, here.
 *
 * Until 2026-09-07 the payer hid inside the vendor name (`anthropic` meant
 * key, `claude-cli` meant subscription, `codex` meant ChatGPT), a process-wide
 * `ATOMA_LLM` chose a "base" provider for unprefixed pins, and three built-in
 * defaults filled whatever was unset. All of that is gone: every tier names
 * its selector in full, there is no base and there is no default, and a
 * spelling this file does not parse is refused at launch with the grammar in
 * the message. Stored pins written under the old spellings are not migrated;
 * the store is reset (owner decision, 2026-09-07).
 */

/**
 * Default base URL of Z.ai's ANTHROPIC-COMPATIBLE endpoint — the same one
 * Claude Code users point ANTHROPIC_BASE_URL at to run GLM models. A vendor
 * fact, stated once for the run transports and the supervisor sessions alike.
 */
export const ZAI_DEFAULT_BASE_URL = 'https://api.z.ai/api/anthropic';

export const MODEL_SELECTOR_MODES = ['api', 'sub', 'own'] as const;
export type ModelSelectorMode = (typeof MODEL_SELECTOR_MODES)[number];

export const MODEL_SELECTOR_VENDORS = ['anthropic', 'openai', 'zai', 'ollama'] as const;
export type ModelSelectorVendor = (typeof MODEL_SELECTOR_VENDORS)[number];

/** Vendors that offer a CLI subscription atoma can drive. */
export const SUBSCRIPTION_VENDORS = ['anthropic', 'openai'] as const satisfies readonly ModelSelectorVendor[];

export interface ModelSelector {
  readonly mode: ModelSelectorMode;
  readonly vendor: ModelSelectorVendor;
  /** The vendor's own model id, verbatim. */
  readonly model: string;
}

/**
 * How a (mode, vendor) pair is actually reached. `anthropic-api` also serves
 * Z.ai's Anthropic-compatible endpoint under its own key, which is why zai is
 * a vendor of its own here and not an anthropic base URL.
 */
export const MODEL_TRANSPORTS = [
  'anthropic-api',
  'openai-api',
  'zai-api',
  'ollama',
  'claude-cli',
  'codex-cli',
] as const;
export type ModelTransport = (typeof MODEL_TRANSPORTS)[number];

export class ModelSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelSelectorError';
  }
}

export const MODEL_SELECTOR_GRAMMAR =
  '<api|sub|own>:<anthropic|openai|zai|ollama>:<model>, for example api:anthropic:claude-sonnet-5, ' +
  'sub:anthropic:sonnet or sub:openai:gpt-5.6-sol';

function isMode(value: string): value is ModelSelectorMode {
  return (MODEL_SELECTOR_MODES as readonly string[]).includes(value);
}

function isVendor(value: string): value is ModelSelectorVendor {
  return (MODEL_SELECTOR_VENDORS as readonly string[]).includes(value);
}

/**
 * Parse one selector or throw `ModelSelectorError` naming what is wrong and
 * the grammar. `where` is the env var or setting the value came from, so the
 * message points at the line to fix.
 */
export function parseModelSelector(raw: string, where = 'model selector'): ModelSelector {
  const value = raw.trim();
  const first = value.indexOf(':');
  const second = first === -1 ? -1 : value.indexOf(':', first + 1);
  if (first <= 0 || second === -1) {
    throw new ModelSelectorError(
      `${where}="${raw}" is not a model selector; expected ${MODEL_SELECTOR_GRAMMAR}`
    );
  }
  const mode = value.slice(0, first).toLowerCase();
  const vendor = value.slice(first + 1, second).toLowerCase();
  const model = value.slice(second + 1);
  if (!isMode(mode)) {
    throw new ModelSelectorError(
      `${where}="${raw}" names mode "${mode}"; expected one of ${MODEL_SELECTOR_MODES.join(', ')} (${MODEL_SELECTOR_GRAMMAR})`
    );
  }
  if (!isVendor(vendor)) {
    throw new ModelSelectorError(
      `${where}="${raw}" names vendor "${vendor}"; expected one of ${MODEL_SELECTOR_VENDORS.join(', ')} (${MODEL_SELECTOR_GRAMMAR})`
    );
  }
  if (model.length === 0) {
    throw new ModelSelectorError(`${where}="${raw}" names no model after ${mode}:${vendor}:`);
  }
  if (mode !== 'api' && !(SUBSCRIPTION_VENDORS as readonly string[]).includes(vendor)) {
    throw new ModelSelectorError(
      `${where}="${raw}": ${vendor} has no subscription atoma can drive; use api:${vendor}:${model}`
    );
  }
  return { mode, vendor, model };
}

/** `parseModelSelector` that answers null instead of throwing. */
export function tryParseModelSelector(raw: string | null | undefined): ModelSelector | null {
  if (raw === null || raw === undefined) return null;
  try {
    return parseModelSelector(raw);
  } catch {
    return null;
  }
}

export function formatModelSelector(selector: ModelSelector): string {
  return `${selector.mode}:${selector.vendor}:${selector.model}`;
}

/** The transport a selector rides — the ONE statement of the mapping. */
export function transportOf(selector: Pick<ModelSelector, 'mode' | 'vendor'>): ModelTransport {
  if (selector.mode === 'api') {
    switch (selector.vendor) {
      case 'anthropic':
        return 'anthropic-api';
      case 'openai':
        return 'openai-api';
      case 'zai':
        return 'zai-api';
      case 'ollama':
        return 'ollama';
    }
  }
  return selector.vendor === 'anthropic' ? 'claude-cli' : 'codex-cli';
}

/**
 * The Codex CLI cannot host a tool loop: it cannot expose only atoma's tools
 * while disabling every built-in, so calls would bypass ToolSandbox and the
 * declared-tools scope gate. L1 is the tier that owns tools, so a Codex
 * selector is refused there — at the settings write, at doctor, and at launch.
 */
export function selectorAdmitsTools(selector: Pick<ModelSelector, 'mode' | 'vendor'>): boolean {
  return transportOf(selector) !== 'codex-cli';
}

export function selectorSpendsSubscription(selector: Pick<ModelSelector, 'mode'>): boolean {
  return selector.mode !== 'api';
}

/** Zod form of the grammar, for the stored-pin schemas. */
export const modelSelectorStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => tryParseModelSelector(value) !== null, {
    message: `must be a model selector: ${MODEL_SELECTOR_GRAMMAR}`,
  });

export const TIERS = [1, 2, 3] as const;
export type TierNumber = (typeof TIERS)[number];

export function tierPinVariable(tier: TierNumber): `ATOMA_MODEL_L${TierNumber}` {
  return `ATOMA_MODEL_L${tier}`;
}

/**
 * The three tier selectors of one environment, all REQUIRED. There is no
 * default: a tier nobody configured is a launch error naming the variable,
 * never a silent model choice. `own` is refused here — the host environment
 * cannot name a member's personal subscription; only an account pin can, and
 * the project coordinator forwards it into a run child that authorises it
 * through `ATOMA_SUBSCRIPTION_TIERS`, which is the one place `own` may reach
 * an environment.
 */
export function readTierSelectors(
  env: NodeJS.ProcessEnv,
  opts: { readonly allowOwn?: boolean } = {}
): Record<TierNumber, ModelSelector> {
  const missing = TIERS.filter((tier) => !env[tierPinVariable(tier)]?.trim());
  if (missing.length > 0) {
    throw new ModelSelectorError(
      `${missing.map(tierPinVariable).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        `Every tier names its model as ${MODEL_SELECTOR_GRAMMAR}; there is no default.`
    );
  }
  const out = {} as Record<TierNumber, ModelSelector>;
  for (const tier of TIERS) {
    const variable = tierPinVariable(tier);
    const selector = parseModelSelector(env[variable]!, variable);
    if (selector.mode === 'own' && !opts.allowOwn) {
      throw new ModelSelectorError(
        `${variable}=${env[variable]!.trim()}: a personal subscription (own:) is an account ` +
          'setting, not a host environment value; use sub: for the host login or api: for a key'
      );
    }
    if (tier === 1 && !selectorAdmitsTools(selector)) {
      throw new ModelSelectorError(
        `${variable}=${env[variable]!.trim()}: Codex cannot expose tools through ToolSandbox, so ` +
          'L1 cannot use it; pin L1 to a tool-capable selector (for example api:openai:gpt-5.4-mini ' +
          'or api:anthropic:claude-haiku-4-5-20251001) and keep sub:openai on L2/L3'
      );
    }
    out[tier] = selector;
  }
  return out;
}

/** Distinct transports the three selectors reach, in tier order. */
export function referencedTransports(
  selectors: Readonly<Record<TierNumber, ModelSelector>>
): ModelTransport[] {
  const seen: ModelTransport[] = [];
  for (const tier of TIERS) {
    const transport = transportOf(selectors[tier]);
    if (!seen.includes(transport)) seen.push(transport);
  }
  return seen;
}
