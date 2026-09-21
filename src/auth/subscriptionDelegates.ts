import type { PlatformEventSink } from '../contracts/platformEvents.js';
import type { AuthStore, Viewer } from './store.js';

/**
 * HOST-SUBSCRIPTION DELEGATION — one body, three doors.
 *
 * Until 2026-09-22 exactly one kind of account could name `sub:` on a tier:
 * a platform admin, on the deployment that declares an organisation for its
 * own login session. That tied "may spend the operator's subscription" to
 * "holds every operator power", so handing a colleague the first meant
 * handing them the second — burn-in, the operator corpus, cross-organisation
 * reads and the four writes included.
 *
 * A delegation separates the two. It changes exactly ONE of the three facts
 * the coordinator re-asks per run (`assertSubscriptionPinIsHonourable`): the
 * authority of the requester. The pin still has to be the delegate's OWN
 * account pin, and the run still has to belong to the declared organisation.
 *
 * The CLI, the HTTP route and the MCP tool all call THIS function — the
 * `orgModels.ts` shape — because a rule stated three times is a rule with
 * three future spellings, and this one decides who spends money.
 */

export const HOST_SUBSCRIPTION_ORG_ENV = 'ATOMA_HOST_SUBSCRIPTION_ORG';

/** The ONE organisation where this deployment allows its own login to be spent. */
export function declaredHostSubscriptionOrg(env: NodeJS.ProcessEnv = process.env): string | null {
  return env[HOST_SUBSCRIPTION_ORG_ENV]?.trim() || null;
}

export class SubscriptionDelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionDelegationError';
  }
}

/**
 * Who is minting the row. The CLI acts by possession of the machine, exactly
 * as `grant-admin` does; a browser or MCP session acts as a principal and
 * must carry the platform-admin flag. A delegate can never delegate further:
 * the authority to hand out operator spend is not itself delegated.
 */
export type SubscriptionDelegationActor =
  | { readonly kind: 'cli' }
  | { readonly kind: 'principal'; readonly viewer: Viewer };

export interface SubscriptionDelegationResult {
  readonly principalId: string;
  readonly displayName: string;
  readonly orgId: string;
  readonly delegated: boolean;
  /** The row already had this state; nothing changed and nothing was journaled. */
  readonly already: boolean;
}

/** May this viewer hand out, or withdraw, the host subscription? */
export function mayManageSubscriptionDelegations(viewer: Viewer): boolean {
  return viewer.platformAdmin;
}

/**
 * Grant or withdraw one delegation, journaled at the moment of the decision.
 *
 * Every refusal names what is missing and THROWS: an authority that quietly
 * did nothing would leave the operator believing a colleague can launch, and
 * the refusal would only surface later, mid-run, as a payer error.
 */
export function setSubscriptionDelegate(input: {
  readonly auth: AuthStore;
  readonly actor: SubscriptionDelegationActor;
  /** A principal id or a unique identity email, resolved by the store. */
  readonly principalRef: string;
  /** Defaults to the declared organisation, and may never name another one. */
  readonly orgId?: string | undefined;
  readonly declaredOrg: string | null;
  readonly delegated: boolean;
  readonly emit: PlatformEventSink;
}): SubscriptionDelegationResult {
  if (input.actor.kind === 'principal' && !mayManageSubscriptionDelegations(input.actor.viewer)) {
    throw new SubscriptionDelegationError(
      'platform admin required to delegate the host subscription'
    );
  }
  if (!input.declaredOrg) {
    throw new SubscriptionDelegationError(
      `this deployment declares no organisation for its own login session; set ${HOST_SUBSCRIPTION_ORG_ENV} before delegating it`
    );
  }
  const orgId = input.orgId?.trim() || input.declaredOrg;
  if (orgId !== input.declaredOrg) {
    // Not a convenience check: the coordinator refuses a `sub:` pin in any
    // other organisation anyway, so a row written here would be an authority
    // nobody could exercise and nobody would think to withdraw.
    throw new SubscriptionDelegationError(
      `organisation ${orgId} is not the one this deployment declares for its own login session (${input.declaredOrg})`
    );
  }

  let result: { principalId: string; displayName: string; already: boolean };
  try {
    result = input.delegated
      ? input.auth.grantSubscriptionDelegate(
          input.principalRef,
          orgId,
          input.actor.kind === 'cli' ? 'cli' : input.actor.viewer.principalId
        )
      : input.auth.revokeSubscriptionDelegate(input.principalRef, orgId);
  } catch (error) {
    throw new SubscriptionDelegationError(
      error instanceof Error ? error.message : String(error)
    );
  }

  if (!result.already) {
    // Journaled from whichever process decided, like the admin flag: operator
    // spend changing hands must survive in the journal even when no server is
    // running to hold an in-process bus.
    input.emit({
      kind: input.delegated ? 'admin.subscription_delegated' : 'admin.subscription_revoked',
      actorType: input.actor.kind === 'cli' ? 'cli' : 'principal',
      actorId: input.actor.kind === 'cli' ? null : input.actor.viewer.principalId,
      orgId,
      summary: input.delegated
        ? `Host subscription delegated to ${result.displayName}`
        : `Host subscription delegation withdrawn from ${result.displayName}`,
      detail: { principalId: result.principalId, displayName: result.displayName },
    });
  }

  return {
    principalId: result.principalId,
    displayName: result.displayName,
    orgId,
    delegated: input.delegated,
    already: result.already,
  };
}
