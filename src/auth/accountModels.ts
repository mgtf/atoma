import type { AuthStore } from './store.js';
import type { PlatformEventSink } from '../contracts/platformEvents.js';
import {
  everyTierUnresolved,
  operatorTierDefaults,
  principalChatGptStarterPins,
  type TierModelPins,
} from '../contracts/tierModels.js';
import { isPrincipalSubscriptionSelection } from '../contracts/runPayers.js';

/**
 * ARM THE STARTER GRADIENT, ONCE, ON AN OTHERWISE UNUSABLE DEPLOYMENT.
 *
 * A member whose account, organisation and host all name nothing cannot launch
 * a run at all: every tier fails on the missing pin. Connecting a personal
 * ChatGPT login is that member's own authorization to spend it — the account
 * choice IS the authorization — so filling the three tiers with it completes
 * the action they took rather than deciding for them.
 *
 * It arms ONLY into emptiness. A value at any level, on any tier, means the
 * run would have resolved something, and an automatic pin must never displace
 * a member's choice, an organisation default or an operator pin. The walk is
 * the run's own (`everyTierUnresolved`), so "unconfigured" here cannot drift
 * from "unresolved" at launch.
 *
 * Journaled under the kind a manual choice uses, because the row answering
 * "who armed this spending" must not depend on where the choice was
 * expressed; `automatic` records that it followed the connect.
 *
 * Returns the stored pins, or null when nothing was armed.
 */
export function armStarterChatGptPins(
  auth: AuthStore,
  principal: { readonly principalId: string; readonly orgId: string },
  env: NodeJS.ProcessEnv,
  emit: PlatformEventSink
): TierModelPins | null {
  const unresolved = everyTierUnresolved({
    account: auth.modelPins(principal.principalId),
    org: auth.orgTierModels(principal.orgId),
    host: operatorTierDefaults(env),
  });
  if (!unresolved) return null;
  const pins = auth.setModelPins(principal.principalId, principalChatGptStarterPins());
  const tiers = (['l1', 'l2', 'l3'] as const).filter((tier) => {
    const value = pins[tier];
    return typeof value === 'string' && isPrincipalSubscriptionSelection(value);
  });
  emit({
    kind: 'principal.subscription_pin',
    actorType: 'principal',
    actorId: principal.principalId,
    orgId: principal.orgId,
    summary: `Account subscription armed on ${tiers.join(', ')} by connecting a personal Codex subscription with no model configured on any tier`,
    detail: {
      tiers: [...tiers],
      selections: Object.fromEntries(tiers.map((tier) => [tier, pins[tier] as string])),
      automatic: true,
    },
  });
  return pins;
}
