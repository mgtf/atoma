import { z } from 'zod';

/**
 * WHO PAID FOR THIS RUN — THE ONE ANSWER, PER TIER.
 * =================================================
 *
 * Until 2026-08-28 a run had ONE payer by construction: either the deployment
 * asked for the host subscription through `ATOMA_LLM=claude-cli` and no
 * credential crossed at all, or it did not and every tier billed a key. The
 * journal said so with a single `run.host_subscription` row carrying nothing
 * but an English summary.
 *
 * A per-tier subscription choice ends that. A run may now spend the operator's
 * own Claude or ChatGPT login on L2 and L3 while L1 bills the organisation's Z.ai key, and
 * a row that names the run cannot describe it. This module is the shape that
 * can: four rows, one per tier plus the BASE transport, each naming what was
 * selected, which provider served it and who paid.
 *
 * WHY `base` IS A ROW. Every call that carries no `provider:` prefix reaches
 * the default client — an unpinned tier, `resolveLatestOpus` on the L3 path,
 * anything the router does not redirect. A ledger of three tier rows says "L2
 * and L3 were on the subscription" and stays silent about the account that
 * paid for everything else, which is the omission the 2026-08-27 review
 * punished as finding 2.2. The branch that writes the base credential already
 * knows which one it wrote, so the row costs nothing.
 *
 * NOTHING HERE CARRIES A SECRET. A payer names a KIND and, for a key, its
 * provider — never a credential, never an environment value, never text a
 * tenant supplied. `project_runs.error` is served to tenants and this detail is
 * journaled beside it.
 */

/** The prefix a per-tier subscription selection is stored under. */
export const HOST_SUBSCRIPTION_PREFIX = 'host-subscription';

/** The distinct sentinel for the operator's ChatGPT-backed Codex login. */
export const CHATGPT_SUBSCRIPTION_PREFIX = 'chatgpt-subscription';

/**
 * What the transport can actually serve. `resolveCliModel` maps every pin onto
 * one of these three aliases and reports the ALIAS back as `servedModel`,
 * because a subscription serves whatever generation Claude Code resolves that
 * day. Offering `Opus 5` would be a version promise the transport cannot keep,
 * which is why the picker's label carries the family and no number
 * (design 2026-08-28, Q2).
 */
export const HOST_SUBSCRIPTION_ALIASES = ['opus', 'sonnet', 'haiku'] as const;

export type HostSubscriptionAlias = (typeof HOST_SUBSCRIPTION_ALIASES)[number];

/**
 * Exact Codex slugs offered by the account picker. Codex remains a supervisor
 * transport: these selections are valid on L2/L3 only because L1 owns the
 * tool loop and Codex cannot expose that loop through ToolSandbox.
 */
export const CHATGPT_SUBSCRIPTION_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.4-mini',
] as const;

export type ChatGptSubscriptionModel = (typeof CHATGPT_SUBSCRIPTION_MODELS)[number];

export interface HostSubscriptionRoute {
  readonly provider: 'claude-cli' | 'codex';
  readonly model: HostSubscriptionAlias | ChatGptSubscriptionModel;
}

/**
 * A NON-ROUTABLE SENTINEL, deliberately not `claude-cli:opus`.
 *
 * `claude-cli:` is the exact string two independent guards exist to refuse:
 * `isCatalogueSelection` in the coordinator, and the tier-pin half of
 * `assertTransportHonoursCredentials` (added by review 2026-08-18 §1.6,
 * because `{ATOMA_LLM: 'anthropic', ATOMA_MODEL_L2: 'claude-cli:sonnet'}` used
 * to construct a CLI client that ignored the supplied snapshot). Storing that
 * string in a tenant-readable table would turn every future code path that
 * forwards a pin into an environment into a potential subscription route, and
 * would require deleting a deliberately pinned test. The sentinel adds a
 * concept BESIDE the stated rejection instead of tearing the rejection out; it
 * becomes a transport only inside the coordinator, downstream of the authority
 * check.
 */
export function isHostSubscriptionSelection(value: string): boolean {
  return hostSubscriptionRoute(value) !== null;
}

/** The alias a sentinel names, or null when the value is not one. */
export function hostSubscriptionAlias(value: string): HostSubscriptionAlias | null {
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  if (value.slice(0, separator) !== HOST_SUBSCRIPTION_PREFIX) return null;
  const alias = value.slice(separator + 1);
  return (HOST_SUBSCRIPTION_ALIASES as readonly string[]).includes(alias)
    ? (alias as HostSubscriptionAlias)
    : null;
}

/** The stored spelling for one alias. */
export function hostSubscriptionSelection(alias: HostSubscriptionAlias): string {
  return `${HOST_SUBSCRIPTION_PREFIX}:${alias}`;
}

/** The Codex model named by a ChatGPT sentinel, or null. */
export function chatGptSubscriptionModel(value: string): ChatGptSubscriptionModel | null {
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  if (value.slice(0, separator) !== CHATGPT_SUBSCRIPTION_PREFIX) return null;
  const model = value.slice(separator + 1);
  return (CHATGPT_SUBSCRIPTION_MODELS as readonly string[]).includes(model)
    ? (model as ChatGptSubscriptionModel)
    : null;
}

/** The stored spelling for one ChatGPT subscription model. */
export function chatGptSubscriptionSelection(model: ChatGptSubscriptionModel): string {
  return `${CHATGPT_SUBSCRIPTION_PREFIX}:${model}`;
}

/** Translate a non-routable subscription sentinel into its guarded transport. */
export function hostSubscriptionRoute(value: string): HostSubscriptionRoute | null {
  const alias = hostSubscriptionAlias(value);
  if (alias) return { provider: 'claude-cli', model: alias };
  const model = chatGptSubscriptionModel(value);
  return model ? { provider: 'codex', model } : null;
}

/**
 * WHO paid. `host-selfhosted` is Ollama: the operator's hardware, priced at
 * zero and billed to nobody, which is a different fact from "the operator's
 * API key" and must not be flattened into it.
 */
export const payerKindSchema = z.enum([
  'host-subscription',
  'org-key',
  'host-key',
  'host-selfhosted',
]);

export type PayerKind = z.infer<typeof payerKindSchema>;

/** WHERE the selection came from, so a surprising payer is traceable to a row. */
export const payerSourceSchema = z.enum(['account', 'org', 'host', 'default']);

export type PayerSource = z.infer<typeof payerSourceSchema>;

export const tierPayerSchema = z.object({
  /** The selection as stored/resolved, sentinel included. Null on the base row. */
  selection: z.string().max(200).nullable(),
  /** The provider that served it: a catalogue id, or the subscription prefix. */
  provider: z.string().max(64),
  payer: payerKindSchema,
  source: payerSourceSchema,
});

export type TierPayer = z.infer<typeof tierPayerSchema>;

export const runPayerLedgerSchema = z.object({
  base: tierPayerSchema,
  l1: tierPayerSchema,
  l2: tierPayerSchema,
  l3: tierPayerSchema,
});

export type RunPayerLedger = z.infer<typeof runPayerLedgerSchema>;

/** Parsed at module load: a schema/example mismatch must fail tests at once. */
export const EXAMPLE_RUN_PAYER_LEDGER: RunPayerLedger = runPayerLedgerSchema.parse({
  base: { selection: null, provider: 'anthropic', payer: 'org-key', source: 'default' },
  l1: { selection: 'zai:glm-4.5-air', provider: 'zai', payer: 'org-key', source: 'org' },
  l2: {
    selection: 'host-subscription:sonnet',
    provider: HOST_SUBSCRIPTION_PREFIX,
    payer: 'host-subscription',
    source: 'account',
  },
  l3: { selection: null, provider: 'anthropic', payer: 'org-key', source: 'default' },
});

/** Every tier row, base first, in the order a reader wants them. */
export function ledgerRows(ledger: RunPayerLedger): readonly (readonly [string, TierPayer])[] {
  return [
    ['base', ledger.base],
    ['l1', ledger.l1],
    ['l2', ledger.l2],
    ['l3', ledger.l3],
  ] as const;
}

/** Does any row spend the host's subscription? */
export function ledgerTouchesSubscription(ledger: RunPayerLedger): boolean {
  return ledgerRows(ledger).some(([, row]) => row.payer === 'host-subscription');
}

/** The tiers on the subscription, in tier order, base included when it is. */
export function subscriptionTiers(ledger: RunPayerLedger): readonly string[] {
  return ledgerRows(ledger)
    .filter(([, row]) => row.payer === 'host-subscription')
    .map(([tier]) => tier);
}

/**
 * The journal `detail` for a run that touched the subscription. Structured, so
 * a reader can answer "which tiers, paid by whom" without parsing prose — the
 * present row carries no detail at all and its summary is written twice, in
 * two different wordings, at two emitters.
 */
export function runPayerDetail(ledger: RunPayerLedger): Record<string, unknown> {
  return {
    payers: Object.fromEntries(
      ledgerRows(ledger).map(([tier, row]) => [
        tier,
        { payer: row.payer, provider: row.provider, source: row.source },
      ])
    ),
    subscriptionTiers: subscriptionTiers(ledger),
  };
}

/**
 * THE ONE SUMMARY STRING, rendered by both emitters (`viz/server.ts` and
 * `cli/projects.ts`). They used to write their own wording, so the same fact
 * read differently depending on which surface started the run.
 */
export function hostSubscriptionSummary(ledger: RunPayerLedger): string {
  const tiers = subscriptionTiers(ledger);
  if (tiers.length === 0) return 'Run spent no host subscription';
  const billed = ledgerRows(ledger).filter(([, row]) => row.payer === 'org-key').length;
  const mixed = billed > 0 ? `, ${billed} on the organisation's own key` : '';
  return `Run spent the host subscription on ${tiers.join(', ')}${mixed}`;
}
