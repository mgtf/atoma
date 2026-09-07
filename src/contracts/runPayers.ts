import { z } from 'zod';
import {
  parseModelSelector,
  transportOf,
  tryParseModelSelector,
  type ModelSelector,
} from './modelSelector.js';

/**
 * WHO PAID FOR THIS RUN — THE ONE ANSWER, PER TIER.
 * =================================================
 *
 * A run may spend the operator's own Claude or ChatGPT login on L2 and L3
 * while L1 bills the organisation's Z.ai key, and a row that names the run
 * cannot describe it. This module is the shape that can: three rows, one per
 * tier, each naming what was selected, which transport served it and who
 * paid. Since 2026-09-07 every tier carries its own full selector and there
 * is no base transport for "everything else", so the ledger has exactly the
 * three tier rows and nothing unaccounted for.
 *
 * THE PAYER IS THE SELECTOR'S FIRST SEGMENT. `sub:` is the host's login,
 * `own:` the requester's, and `api:` a key — the organisation's if it brought
 * one, else the host's, or nobody's for a self-hosted Ollama. The mode is the
 * fact; nothing here infers a payer from a transport name any more.
 *
 * NOTHING HERE CARRIES A SECRET. A payer names a KIND and a transport — never
 * a credential, never an environment value, never text a tenant supplied.
 * `project_runs.error` is served to tenants and this detail is journaled
 * beside it.
 */

/**
 * What the Claude Code transport can actually serve. `resolveCliModel` maps
 * every pin onto one of these three aliases and reports the ALIAS back as
 * `servedModel`, because a subscription serves whatever generation Claude Code
 * resolves that day. Offering `Opus 5` would be a version promise the
 * transport cannot keep, which is why the picker's label carries the family
 * and no number (design 2026-08-28, Q2).
 */
export const HOST_SUBSCRIPTION_ALIASES = ['opus', 'sonnet', 'haiku'] as const;

export type HostSubscriptionAlias = (typeof HOST_SUBSCRIPTION_ALIASES)[number];

/**
 * Exact Codex slugs a ChatGPT subscription serves. Codex remains a supervisor
 * transport: these selections are valid on L2/L3 only because L1 owns the
 * tool loop and Codex cannot expose that loop through ToolSandbox.
 */
export const CHATGPT_SUBSCRIPTION_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.4-mini',
] as const;

export type ChatGptSubscriptionModel = (typeof CHATGPT_SUBSCRIPTION_MODELS)[number];

/** The stored spelling of the host's Claude login on one tier. */
export function hostClaudeSelection(alias: HostSubscriptionAlias): string {
  return `sub:anthropic:${alias}`;
}

/** The stored spelling of the host's ChatGPT login on one tier. */
export function hostChatGptSelection(model: ChatGptSubscriptionModel): string {
  return `sub:openai:${model}`;
}

/** The stored spelling of the requester's own ChatGPT login on one tier. */
export function principalChatGptSelection(model: ChatGptSubscriptionModel): string {
  return `own:openai:${model}`;
}

/** Is `value` a `sub:` selector (the host's own login)? */
export function isHostSubscriptionSelection(value: string): boolean {
  return tryParseModelSelector(value)?.mode === 'sub';
}

/** Is `value` an `own:` selector (the requester's own login)? */
export function isPrincipalSubscriptionSelection(value: string): boolean {
  return tryParseModelSelector(value)?.mode === 'own';
}

/** The Claude alias a `sub:anthropic:` selector names, or null. */
export function hostSubscriptionAlias(value: string): HostSubscriptionAlias | null {
  const selector = tryParseModelSelector(value);
  if (!selector || selector.mode !== 'sub' || selector.vendor !== 'anthropic') return null;
  return (HOST_SUBSCRIPTION_ALIASES as readonly string[]).includes(selector.model)
    ? (selector.model as HostSubscriptionAlias)
    : null;
}

/** The Codex model a `sub:openai:` selector names, or null. */
export function chatGptSubscriptionModel(value: string): ChatGptSubscriptionModel | null {
  return codexModelOf(value, 'sub');
}

/** The Codex model an `own:openai:` selector names, or null. */
export function principalChatGptSubscriptionModel(
  value: string
): ChatGptSubscriptionModel | null {
  return codexModelOf(value, 'own');
}

function codexModelOf(value: string, mode: 'sub' | 'own'): ChatGptSubscriptionModel | null {
  const selector = tryParseModelSelector(value);
  if (!selector || selector.mode !== mode || selector.vendor !== 'openai') return null;
  return (CHATGPT_SUBSCRIPTION_MODELS as readonly string[]).includes(selector.model)
    ? (selector.model as ChatGptSubscriptionModel)
    : null;
}

/** One Codex process has one credential home, so a pin set cannot name both owners. */
export function selectionsMixCodexOwners(
  selections: Iterable<string | null | undefined>
): boolean {
  let host = false;
  let principal = false;
  for (const selection of selections) {
    if (!selection) continue;
    const selector = tryParseModelSelector(selection);
    if (!selector || selector.vendor !== 'openai') continue;
    host ||= selector.mode === 'sub';
    principal ||= selector.mode === 'own';
    if (host && principal) return true;
  }
  return false;
}

/**
 * WHO paid. `host-selfhosted` is Ollama: the operator's hardware, priced at
 * zero and billed to nobody, which is a different fact from "the operator's
 * API key" and must not be flattened into it.
 */
export const payerKindSchema = z.enum([
  'host-subscription',
  'principal-subscription',
  'org-key',
  'host-key',
  'host-selfhosted',
]);

export type PayerKind = z.infer<typeof payerKindSchema>;

/**
 * The payer a selector implies, given whether the organisation brought the
 * key for an `api:` vendor. The mode decides; only `api:` needs the second
 * fact.
 */
export function payerForSelector(selector: ModelSelector, orgBroughtKey: boolean): PayerKind {
  if (selector.mode === 'sub') return 'host-subscription';
  if (selector.mode === 'own') return 'principal-subscription';
  if (selector.vendor === 'ollama') return 'host-selfhosted';
  return orgBroughtKey ? 'org-key' : 'host-key';
}

/** WHERE the selection came from, so a surprising payer is traceable to a row. */
export const payerSourceSchema = z.enum(['account', 'org', 'host']);

export type PayerSource = z.infer<typeof payerSourceSchema>;

export const tierPayerSchema = z.object({
  /** The full selector as resolved for the run. */
  selection: z.string().max(200),
  /** The transport that served it (`contracts/modelSelector.ts` `transportOf`). */
  provider: z.string().max(64),
  payer: payerKindSchema,
  source: payerSourceSchema,
});

export type TierPayer = z.infer<typeof tierPayerSchema>;

export const runPayerLedgerSchema = z.object({
  l1: tierPayerSchema,
  l2: tierPayerSchema,
  l3: tierPayerSchema,
});

export type RunPayerLedger = z.infer<typeof runPayerLedgerSchema>;

/** Build one row from a resolved selector; the transport is derived, never typed twice. */
export function tierPayerRow(input: {
  readonly selection: string;
  readonly payer: PayerKind;
  readonly source: PayerSource;
}): TierPayer {
  const selector = parseModelSelector(input.selection);
  return tierPayerSchema.parse({
    selection: input.selection,
    provider: transportOf(selector),
    payer: input.payer,
    source: input.source,
  });
}

/** Parsed at module load: a schema/example mismatch must fail tests at once. */
export const EXAMPLE_RUN_PAYER_LEDGER: RunPayerLedger = runPayerLedgerSchema.parse({
  l1: tierPayerRow({ selection: 'api:zai:glm-4.5-air', payer: 'org-key', source: 'org' }),
  l2: tierPayerRow({
    selection: hostClaudeSelection('sonnet'),
    payer: 'host-subscription',
    source: 'account',
  }),
  l3: tierPayerRow({
    selection: 'api:anthropic:claude-opus-5',
    payer: 'host-key',
    source: 'host',
  }),
});

/** Every tier row, in the order a reader wants them. */
export function ledgerRows(ledger: RunPayerLedger): readonly (readonly [string, TierPayer])[] {
  return [
    ['l1', ledger.l1],
    ['l2', ledger.l2],
    ['l3', ledger.l3],
  ] as const;
}

/** Does any row spend the host's subscription? */
export function ledgerTouchesSubscription(ledger: RunPayerLedger): boolean {
  return ledgerRows(ledger).some(([, row]) => row.payer === 'host-subscription');
}

/** Does any row spend the requesting principal's own subscription? */
export function ledgerTouchesPrincipalSubscription(ledger: RunPayerLedger): boolean {
  return ledgerRows(ledger).some(([, row]) => row.payer === 'principal-subscription');
}

/** Any CLI subscription, regardless of whether host or requester owns it. */
export function ledgerTouchesAnySubscription(ledger: RunPayerLedger): boolean {
  return ledgerRows(ledger).some(
    ([, row]) => row.payer === 'host-subscription' || row.payer === 'principal-subscription'
  );
}

/** The tiers on the host subscription, in tier order. */
export function subscriptionTiers(ledger: RunPayerLedger): readonly string[] {
  return ledgerRows(ledger)
    .filter(([, row]) => row.payer === 'host-subscription')
    .map(([tier]) => tier);
}

export function principalSubscriptionTiers(ledger: RunPayerLedger): readonly string[] {
  return ledgerRows(ledger)
    .filter(([, row]) => row.payer === 'principal-subscription')
    .map(([tier]) => tier);
}

/** The distinct subscription transports a ledger spends, in tier order. */
export function subscriptionTransports(ledger: RunPayerLedger): readonly string[] {
  const out: string[] = [];
  for (const [, row] of ledgerRows(ledger)) {
    if (row.payer !== 'host-subscription' && row.payer !== 'principal-subscription') continue;
    if (!out.includes(row.provider)) out.push(row.provider);
  }
  return out;
}

/**
 * The journal `detail` for a run that touched a subscription. Structured, so
 * a reader can answer "which tiers, paid by whom" without parsing prose.
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
    principalSubscriptionTiers: principalSubscriptionTiers(ledger),
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

/** Audit summary for a run spending only the requester's own subscription rows. */
export function principalSubscriptionSummary(ledger: RunPayerLedger): string {
  const tiers = principalSubscriptionTiers(ledger);
  if (tiers.length === 0) return 'Run spent no requester subscription';
  return `Run spent the requester subscription on ${tiers.join(', ')}`;
}
