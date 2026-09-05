import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * WHO MAY OPEN THIS PREVIEW, AND FOR HOW LONG.
 *
 * A preview lives on its own origin, which carries no Atoma cookie — that is
 * the whole point of putting it on a separate registrable domain. So the
 * gateway needs its own way to know that the browser in front of it was sent
 * by an authenticated member, and a CLAIM is that way: a one-time secret the
 * control plane mints after checking the session, which the gateway exchanges
 * for a short grant on the preview origin.
 *
 * FOUR PROPERTIES, and each closes a specific hole:
 *
 * 1. ONE USE. A claim is consumed on first presentation, so a copied link is
 *    a link that has already been spent. Consumption happens BEFORE
 *    validation, exactly as `consumeOauthState` does, so a leaked value
 *    cannot be probed repeatedly for a match.
 * 2. THIRTY SECONDS. It exists only to survive the redirect that follows
 *    minting. Anything longer is a bearer token in a URL.
 * 3. BOUND TO EVERYTHING IT DEPENDS ON. Principal, session, org, run,
 *    generation and the exact host. A claim minted for one member's session
 *    on one generation cannot open another's, another org's, or a generation
 *    that has since restarted — which is what makes `Restart` a security
 *    boundary and not merely a refresh.
 * 4. STORED HASHED. The store holds SHA-256 of the secret, so a reader of the
 *    table learns nothing it could present.
 *
 * The RAW value travels in a URL FRAGMENT, never a query string or a path: a
 * fragment is not sent to the server, so it stays out of request lines, access
 * logs and `Referer` headers. The gateway's own bootstrap page posts it back
 * to the preview origin and then replaces the URL.
 */

/** 256 bits, per the design. Anything shorter is not a secret. */
export const PREVIEW_CLAIM_BYTES = 32;
export const PREVIEW_CLAIM_TTL_MS = 30_000;
/** How long one exchanged grant lasts before the parent must renew it. */
export const PREVIEW_GRANT_TTL_MS = 300_000;

export interface PreviewClaimBinding {
  readonly principalId: string;
  /**
   * The session a claim was minted for, WHERE THE TRANSPORT KNOWS IT.
   *
   * Null today from the HTTP path: `Viewer` carries no session id, and
   * inventing one from the principal would be a field lying about what it
   * binds. What the session dimension would add is narrow — a claim lives
   * thirty seconds and is one-time, and logout already revokes every grant a
   * principal holds through `revokePrincipal` — so the gap is recorded rather
   * than papered over, and the field is here for the day the gate exposes it.
   */
  readonly sessionId: string | null;
  readonly orgId: string;
  readonly projectRunId: string;
  readonly generation: number;
  /** The exact host this claim may be presented to. */
  readonly host: string;
}

export interface MintedPreviewClaim {
  /** Handed to the browser in a fragment. Never stored, never logged. */
  readonly secret: string;
  readonly hash: string;
  readonly expiresAt: number;
  readonly binding: PreviewClaimBinding;
}

export type PreviewClaimRefusal =
  | 'unknown'
  | 'expired'
  | 'wrong-host'
  | 'wrong-generation'
  | 'wrong-principal';

export interface PreviewGrant {
  readonly binding: PreviewClaimBinding;
  readonly expiresAt: number;
}

/**
 * What a successful redemption hands back: the grant, and the SECRET the
 * browser must present from then on.
 *
 * The cookie carries this token and the registry verifies it. An earlier shape
 * keyed grants by (org, run, generation, host) alone and checked only that one
 * existed — which meant any cookie value at all was accepted for as long as
 * some member held a live grant on that origin. The token is what makes the
 * cookie a credential rather than a flag.
 */
export interface RedeemedPreviewClaim {
  readonly grant: PreviewGrant;
  readonly token: string;
}

/** SHA-256 of the presented secret. The store never holds the secret itself. */
export function previewClaimHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Compare two hex digests without leaking where they diverge.
 *
 * Both are SHA-256 hex, so lengths match by construction — but the length
 * check stays, because `timingSafeEqual` THROWS on a mismatch and a lookup
 * that crashed on a malformed input would be a denial of service wearing a
 * type error.
 */
export function claimHashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

export function mintPreviewClaim(
  binding: PreviewClaimBinding,
  now: number,
  randomness: (bytes: number) => Buffer = randomBytes
): MintedPreviewClaim {
  const secret = randomness(PREVIEW_CLAIM_BYTES).toString('base64url');
  return {
    secret,
    hash: previewClaimHash(secret),
    expiresAt: now + PREVIEW_CLAIM_TTL_MS,
    binding,
  };
}

interface StoredClaim {
  readonly hash: string;
  readonly expiresAt: number;
  readonly binding: PreviewClaimBinding;
}

/**
 * The claims and grants a gateway is currently honouring.
 *
 * IN MEMORY ON PURPOSE. A claim lives thirty seconds and a grant five
 * minutes; both are shorter than any restart, and both MUST NOT survive one —
 * "on gateway/launcher restart all grants and hosts fail closed, users reopen
 * explicitly" (design §10). Persisting them would be persisting the one thing
 * the design wants forgotten.
 */
export class PreviewClaimRegistry {
  private readonly claims = new Map<string, StoredClaim>();
  private readonly grants = new Map<string, PreviewGrant>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly randomness: (bytes: number) => Buffer = randomBytes
  ) {}

  /** Record a minted claim so the gateway can recognise it once. */
  register(claim: MintedPreviewClaim): void {
    this.claims.set(claim.hash, {
      hash: claim.hash,
      expiresAt: claim.expiresAt,
      binding: claim.binding,
    });
  }

  /**
   * Exchange a presented secret for a grant, or say why not.
   *
   * CONSUMED FIRST, unconditionally: whatever happens next, this secret is
   * spent. A validation that ran before deletion would leave a rejected claim
   * available for the next attempt, which is how a leaked value becomes a
   * value worth guessing against.
   */
  redeem(
    secret: string,
    presentedHost: string
  ):
    | ({ readonly ok: true } & RedeemedPreviewClaim)
    | { readonly ok: false; readonly reason: PreviewClaimRefusal } {
    const hash = previewClaimHash(secret);
    const found = this.claims.get(hash);
    this.claims.delete(hash);
    if (!found || !claimHashesMatch(found.hash, hash)) return { ok: false, reason: 'unknown' };
    const at = this.now();
    if (at > found.expiresAt) return { ok: false, reason: 'expired' };
    // The host is part of the binding, so a claim minted for one generation's
    // origin cannot be replayed against another's.
    if (found.binding.host !== presentedHost) return { ok: false, reason: 'wrong-host' };
    const token = this.randomness(PREVIEW_CLAIM_BYTES).toString('base64url');
    const grant: PreviewGrant = {
      binding: found.binding,
      expiresAt: at + PREVIEW_GRANT_TTL_MS,
    };
    this.grants.set(previewClaimHash(token), grant);
    return { ok: true, grant, token };
  }

  /**
   * Is this presented token still good for this host and generation?
   *
   * BOTH halves are checked: the token must be one this registry issued, and
   * its binding must name the route being asked for. A grant also names its
   * generation, so a restart — which mints a new one — leaves every previous
   * grant unusable without anything having to hunt them down, which is what
   * makes a new origin per generation a boundary rather than a cosmetic
   * change.
   */
  authorise(
    token: string,
    binding: Pick<PreviewClaimBinding, 'orgId' | 'projectRunId' | 'generation' | 'host'>
  ): PreviewGrant | null {
    const key = previewClaimHash(token);
    const grant = this.grants.get(key);
    if (!grant) return null;
    if (this.now() > grant.expiresAt) {
      this.grants.delete(key);
      return null;
    }
    if (
      grant.binding.host !== binding.host ||
      grant.binding.orgId !== binding.orgId ||
      grant.binding.projectRunId !== binding.projectRunId ||
      grant.binding.generation !== binding.generation
    ) {
      return null;
    }
    return grant;
  }

  /**
   * Extend every grant this principal holds on ONE generation.
   *
   * This is what the parent's heartbeat calls, and it is BY BINDING rather
   * than by token on purpose: the grant token is a cookie on the preview
   * origin, which the control plane can neither read nor be sent — that
   * separation is the whole reason the preview lives on its own registrable
   * domain. So the parent proves the right to extend the way it proves
   * everything else, with its own authenticated session, and the registry
   * matches on the binding that session establishes.
   *
   * SCOPED TO THE PRINCIPAL. Two members may watch one generation, each with
   * their own grant; A's heartbeat must not keep B's credential alive after B
   * closed the tab. B's own grant then lapses on its own five-minute clock
   * while the container's idle TTL, which is a different question, governs the
   * container.
   *
   * Without this the grant was a HARD five-minute cap on watching anything:
   * the heartbeat kept the container alive for its full idle TTL while the
   * credential in front of it expired, and the member got the gateway's one
   * generic 404 with a preview still running behind it.
   */
  renewRun(
    binding: Pick<PreviewClaimBinding, 'principalId' | 'orgId' | 'projectRunId' | 'generation'>
  ): number {
    const at = this.now();
    let renewed = 0;
    for (const [key, grant] of this.grants) {
      if (at > grant.expiresAt) {
        this.grants.delete(key);
        continue;
      }
      if (
        grant.binding.principalId !== binding.principalId ||
        grant.binding.orgId !== binding.orgId ||
        grant.binding.projectRunId !== binding.projectRunId ||
        grant.binding.generation !== binding.generation
      ) {
        continue;
      }
      this.grants.set(key, { binding: grant.binding, expiresAt: at + PREVIEW_GRANT_TTL_MS });
      renewed += 1;
    }
    return renewed;
  }

  /** The authenticated parent's heartbeat is the ONLY thing that extends one. */
  renew(
    token: string,
    binding: Pick<PreviewClaimBinding, 'orgId' | 'projectRunId' | 'generation' | 'host'>
  ): PreviewGrant | null {
    const grant = this.authorise(token, binding);
    if (!grant) return null;
    const renewed: PreviewGrant = {
      binding: grant.binding,
      expiresAt: this.now() + PREVIEW_GRANT_TTL_MS,
    };
    this.grants.set(previewClaimHash(token), renewed);
    return renewed;
  }

  /**
   * Revoke every grant and claim for one run.
   *
   * Called on logout, membership loss, stop, restart, idle and hard expiry —
   * six events with one revocation, because six revocations would be five
   * chances to forget one.
   */
  revokeRun(orgId: string, projectRunId: string, generation?: number): number {
    let revoked = 0;
    for (const [key, grant] of this.grants) {
      if (grant.binding.orgId === orgId && grant.binding.projectRunId === projectRunId &&
        (generation === undefined || grant.binding.generation === generation)) {
        this.grants.delete(key);
        revoked += 1;
      }
    }
    for (const [key, claim] of this.claims) {
      if (claim.binding.orgId === orgId && claim.binding.projectRunId === projectRunId &&
        (generation === undefined || claim.binding.generation === generation)) {
        this.claims.delete(key);
        revoked += 1;
      }
    }
    return revoked;
  }

  /** Revoke everything one principal holds, for logout. */
  revokePrincipal(principalId: string): number {
    let revoked = 0;
    for (const [key, grant] of this.grants) {
      if (grant.binding.principalId === principalId) {
        this.grants.delete(key);
        revoked += 1;
      }
    }
    for (const [key, claim] of this.claims) {
      if (claim.binding.principalId === principalId) {
        this.claims.delete(key);
        revoked += 1;
      }
    }
    return revoked;
  }

  /** Drop what has aged out. Cheap, and keeps a long-lived gateway bounded. */
  sweep(): number {
    const at = this.now();
    let dropped = 0;
    for (const [key, claim] of this.claims) {
      if (at > claim.expiresAt) {
        this.claims.delete(key);
        dropped += 1;
      }
    }
    for (const [key, grant] of this.grants) {
      if (at > grant.expiresAt) {
        this.grants.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): { readonly claims: number; readonly grants: number } {
    return { claims: this.claims.size, grants: this.grants.size };
  }

}
