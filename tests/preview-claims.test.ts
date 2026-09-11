import { describe, expect, it } from 'vitest';
import {
  claimHashesMatch,
  mintPreviewClaim,
  PREVIEW_CLAIM_TTL_MS,
  PREVIEW_GRANT_TTL_MS,
  PreviewClaimRegistry,
  previewClaimHash,
  type PreviewClaimBinding,
} from '../src/preview/claims.js';
import {
  clearedPreviewGrantCookie,
  isReservedPreviewPath,
  isSamePreviewRedirect,
  PREVIEW_GRANT_COOKIE,
  previewGenerationHost,
  previewGrantCookie,
  previewOrigin,
  previewResponseHeaders,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
} from '../src/preview/gateway.js';

/**
 * A claim is the only thing standing between an authenticated member and an
 * origin that carries no Atoma cookie, so its refusals are the boundary, not
 * input validation. A fake clock drives every expiry: a test that slept would
 * be measuring the machine.
 */

const ORG = '33333333-3333-4333-8333-333333333333';
const RUN = '11111111-1111-4111-8111-111111111111';
const HOST = 'p0123456789abcdef0123456789abcdef.previews.example.net';

function binding(overrides: Partial<PreviewClaimBinding> = {}): PreviewClaimBinding {
  return {
    principalId: 'principal-1',
    sessionId: 'session-1',
    orgId: ORG,
    projectRunId: RUN,
    generation: 1,
    host: HOST,
    ...overrides,
  };
}

function clockedRegistry(start = 1_000): {
  registry: PreviewClaimRegistry;
  advance: (ms: number) => void;
  now: () => number;
} {
  let at = start;
  const registry = new PreviewClaimRegistry(() => at);
  return { registry, advance: (ms) => (at += ms), now: () => at };
}

/** The grant token a successful redemption issued. */
function token(redeemed: ReturnType<PreviewClaimRegistry['redeem']>): string {
  return redeemed.ok ? redeemed.token : '';
}

describe('preview claim minting', () => {
  it('mints a 256-bit secret and stores only its hash', () => {
    const claim = mintPreviewClaim(binding(), 0);
    // base64url of 32 bytes: no padding, 43 characters.
    expect(claim.secret).toHaveLength(43);
    expect(claim.secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(claim.hash).toBe(previewClaimHash(claim.secret));
    expect(claim.hash).not.toContain(claim.secret);
    expect(claim.expiresAt).toBe(PREVIEW_CLAIM_TTL_MS);
  });

  it('never mints the same secret twice', () => {
    const seen = new Set(
      Array.from({ length: 200 }, () => mintPreviewClaim(binding(), 0).secret)
    );
    expect(seen.size).toBe(200);
  });

  it('compares digests without throwing on a malformed one', () => {
    const hash = previewClaimHash('x');
    expect(claimHashesMatch(hash, hash)).toBe(true);
    expect(claimHashesMatch(hash, previewClaimHash('y'))).toBe(false);
    // A length mismatch must be false, never an exception: a lookup that
    // crashed on a malformed input is a denial of service wearing a TypeError.
    expect(claimHashesMatch(hash, 'short')).toBe(false);
    expect(claimHashesMatch('', '')).toBe(true);
  });
});

describe('preview claim redemption', () => {
  it('exchanges a fresh claim for a grant', () => {
    const { registry, now } = clockedRegistry();
    const claim = mintPreviewClaim(binding(), now());
    registry.register(claim);

    const redeemed = registry.redeem(claim.secret, HOST);

    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;
    expect(redeemed.grant.binding.projectRunId).toBe(RUN);
    expect(redeemed.grant.expiresAt).toBe(now() + PREVIEW_GRANT_TTL_MS);
    // The token is the credential the cookie will carry.
    expect(redeemed.token).toHaveLength(43);
  });

  it('spends a claim on first presentation, whatever the outcome', () => {
    const { registry, now } = clockedRegistry();
    const claim = mintPreviewClaim(binding(), now());
    registry.register(claim);

    // First presentation to the WRONG host: refused, and still consumed.
    expect(registry.redeem(claim.secret, 'other.previews.example.net')).toEqual({
      ok: false,
      reason: 'wrong-host',
    });
    // A retry against the right host now finds nothing: a leaked value cannot
    // be probed repeatedly for a match.
    expect(registry.redeem(claim.secret, HOST)).toEqual({ ok: false, reason: 'unknown' });
    expect(registry.size.claims).toBe(0);
  });

  it('refuses a claim older than its thirty seconds', () => {
    const { registry, advance, now } = clockedRegistry();
    const claim = mintPreviewClaim(binding(), now());
    registry.register(claim);
    advance(PREVIEW_CLAIM_TTL_MS + 1);

    expect(registry.redeem(claim.secret, HOST)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a secret it never minted', () => {
    const { registry } = clockedRegistry();
    expect(registry.redeem('not-a-claim', HOST)).toEqual({ ok: false, reason: 'unknown' });
  });
});

describe('preview grants', () => {
  it('authorises only the generation it was minted for', () => {
    const { registry, now } = clockedRegistry();
    const claim = mintPreviewClaim(binding({ generation: 3 }), now());
    registry.register(claim);
    const redeemed = registry.redeem(claim.secret, HOST);

    expect(registry.authorise(token(redeemed), { orgId: ORG, projectRunId: RUN, generation: 3, host: HOST })).not.toBeNull();
    // A restart mints generation 4 and a new origin; every earlier grant is
    // unusable without anything having to hunt it down.
    expect(registry.authorise(token(redeemed), { orgId: ORG, projectRunId: RUN, generation: 4, host: HOST })).toBeNull();
  });

  it('refuses a token it never issued, even on a route that has a live grant', () => {
    // REGRESSION, and it was a real hole: grants were keyed by
    // (org, run, generation, host) and `authorise` checked only that one
    // existed — so ANY cookie value was accepted for as long as some member
    // held a live grant on that origin. The token is what makes the cookie a
    // credential rather than a flag.
    const { registry, now } = clockedRegistry();
    const claim = mintPreviewClaim(binding(), now());
    registry.register(claim);
    const redeemed = registry.redeem(claim.secret, HOST);
    const key = { orgId: ORG, projectRunId: RUN, generation: 1, host: HOST };

    expect(registry.authorise(token(redeemed), key)).not.toBeNull();
    for (const forged of ['', 'anything', claim.secret, previewClaimHash('x')]) {
      expect(registry.authorise(forged, key)).toBeNull();
    }
  });

  it('authorises only the organisation it was minted for', () => {
    const { registry, now } = clockedRegistry();
    const claim = mintPreviewClaim(binding(), now());
    registry.register(claim);
    const redeemed = registry.redeem(claim.secret, HOST);

    expect(
      registry.authorise(token(redeemed), { orgId: 'another-org', projectRunId: RUN, generation: 1, host: HOST })
    ).toBeNull();
  });

  it('expires after five minutes unless the parent renews it', () => {
    const { registry, advance, now } = clockedRegistry();
    const claim = mintPreviewClaim(binding(), now());
    registry.register(claim);
    const redeemed = registry.redeem(claim.secret, HOST);
    const key = { orgId: ORG, projectRunId: RUN, generation: 1, host: HOST };

    advance(PREVIEW_GRANT_TTL_MS - 1);
    expect(registry.renew(token(redeemed), key)).not.toBeNull();

    advance(PREVIEW_GRANT_TTL_MS - 1);
    expect(registry.authorise(token(redeemed), key)).not.toBeNull();

    advance(PREVIEW_GRANT_TTL_MS + 1);
    expect(registry.authorise(token(redeemed), key)).toBeNull();
    // A grant that has lapsed cannot be renewed back into life.
    expect(registry.renew(token(redeemed), key)).toBeNull();
  });

  it('renews by binding, so the parent can extend a grant it can never read', () => {
    // The grant token is a cookie on the PREVIEW origin. The control plane is
    // not sent it and cannot read it, so a heartbeat that could only renew by
    // token could not renew at all — and every viewing session was capped at
    // the grant's five minutes with a healthy container behind it.
    const { registry, advance, now } = clockedRegistry();
    const claim = mintPreviewClaim(binding(), now());
    registry.register(claim);
    const redeemed = registry.redeem(claim.secret, HOST);
    const key = { orgId: ORG, projectRunId: RUN, generation: 1, host: HOST };
    const beat = { principalId: 'principal-1', orgId: ORG, projectRunId: RUN, generation: 1 };

    advance(PREVIEW_GRANT_TTL_MS - 1);
    expect(registry.renewRun(beat)).toBe(1);
    advance(PREVIEW_GRANT_TTL_MS - 1);
    expect(registry.authorise(token(redeemed), key)).not.toBeNull();
  });

  it('renews only the grant of the principal that is beating', () => {
    const { registry, advance, now } = clockedRegistry();
    const mine = mintPreviewClaim(binding(), now());
    const theirs = mintPreviewClaim(binding({ principalId: 'principal-2' }), now());
    registry.register(mine);
    registry.register(theirs);
    const myToken = token(registry.redeem(mine.secret, HOST));
    const theirToken = token(registry.redeem(theirs.secret, HOST));
    const key = { orgId: ORG, projectRunId: RUN, generation: 1, host: HOST };

    advance(PREVIEW_GRANT_TTL_MS - 1);
    // One member watching must not keep another member's credential alive
    // after that member closed the tab.
    expect(
      registry.renewRun({ principalId: 'principal-1', orgId: ORG, projectRunId: RUN, generation: 1 })
    ).toBe(1);
    advance(2);
    expect(registry.authorise(myToken, key)).not.toBeNull();
    expect(registry.authorise(theirToken, key)).toBeNull();
  });

  it('renews nothing for a generation that has moved on', () => {
    const { registry, now } = clockedRegistry();
    const claim = mintPreviewClaim(binding(), now());
    registry.register(claim);
    registry.redeem(claim.secret, HOST);

    expect(
      registry.renewRun({ principalId: 'principal-1', orgId: ORG, projectRunId: RUN, generation: 2 })
    ).toBe(0);
  });

  it('revokes every grant and claim for one run, in one call', () => {
    const { registry, now } = clockedRegistry();
    const live = mintPreviewClaim(binding(), now());
    const pending = mintPreviewClaim(binding({ generation: 2 }), now());
    registry.register(live);
    registry.register(pending);
    registry.redeem(live.secret, HOST);

    // Six events share this one revocation — logout, membership loss, stop,
    // restart, idle and hard expiry — because six revocations would be five
    // chances to forget one.
    expect(registry.revokeRun(ORG, RUN)).toBe(2);
    expect(registry.size).toEqual({ claims: 0, grants: 0 });
  });

  it('revokes everything one principal holds, for logout', () => {
    const { registry, now } = clockedRegistry();
    const mine = mintPreviewClaim(binding(), now());
    const theirs = mintPreviewClaim(binding({ principalId: 'principal-2' }), now());
    registry.register(mine);
    registry.register(theirs);
    registry.redeem(mine.secret, HOST);

    expect(registry.revokePrincipal('principal-1')).toBe(1);
    expect(registry.size.claims).toBe(1);
  });

  it('sweeps what has aged out', () => {
    const { registry, advance, now } = clockedRegistry();
    registry.register(mintPreviewClaim(binding(), now()));
    advance(PREVIEW_CLAIM_TTL_MS + 1);
    expect(registry.sweep()).toBe(1);
    expect(registry.size.claims).toBe(0);
  });
});

describe('preview origins', () => {
  it('gives every generation its own host', () => {
    const first = previewGenerationHost(ORG, RUN, 1);
    const second = previewGenerationHost(ORG, RUN, 2);
    expect(first).not.toBe(second);
    // Deterministic, so the gateway can route from the Host header alone.
    expect(previewGenerationHost(ORG, RUN, 1)).toBe(first);
    // A valid DNS label: starts with a letter, lowercase alphanumeric.
    expect(first).toMatch(/^[a-z][a-z0-9]{1,62}$/);
  });

  it('separates organisations and runs', () => {
    expect(previewGenerationHost(ORG, RUN, 1)).not.toBe(
      previewGenerationHost('other-org', RUN, 1)
    );
    expect(previewGenerationHost(ORG, RUN, 1)).not.toBe(previewGenerationHost(ORG, 'other-run', 1));
  });

  it('builds an https origin under the preview domain', () => {
    const origin = previewOrigin(
      { domain: 'previews.example.net', scheme: 'https', port: null },
      ORG,
      RUN,
      1
    );
    expect(origin).toBe(`https://${previewGenerationHost(ORG, RUN, 1)}.previews.example.net`);
    expect(new URL(origin).protocol).toBe('https:');
  });
});

describe('preview gateway header policy', () => {
  it('frames only the visualizer and closes every other frame', () => {
    const headers = previewResponseHeaders({
      visualizerOrigin: 'https://app.example.com',
      allowedHosts: [],
    });
    const csp = headers['content-security-policy']!;
    expect(csp).toContain('frame-ancestors https://app.example.com');
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain('sandbox allow-scripts allow-same-origin allow-forms');
    expect(headers['permissions-policy']).toContain('document-domain=()');
  });

  it('opens exactly the approved hosts, and nothing wider', () => {
    const headers = previewResponseHeaders({
      visualizerOrigin: 'https://app.example.com',
      allowedHosts: ['api.example.org'],
    });
    const csp = headers['content-security-policy']!;
    expect(csp).toContain("connect-src 'self' https://api.example.org");
    expect(csp).not.toContain('*');
    // Never `unsafe-eval`: it is the directive that turns a data string into
    // code, and nothing in the commonest deliverable needs it.
    expect(csp).not.toContain('unsafe-eval');
  });

  it('carries the rest of the response policy', () => {
    const headers = previewResponseHeaders({
      visualizerOrigin: 'https://app.example.com',
      allowedHosts: [],
    });
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(headers['permissions-policy']).toContain('camera=()');
    expect(headers['permissions-policy']).toContain('geolocation=()');
  });

  it('never hands the member’s identity or route to the application', () => {
    const forwarded = sanitizeRequestHeaders({
      host: 'p1.previews.example.net',
      cookie: `${PREVIEW_GRANT_COOKIE}=secret`,
      referer: 'https://app.example.com/runs/123',
      'x-forwarded-for': '203.0.113.7',
      'x-real-ip': '203.0.113.7',
      forwarded: 'for=203.0.113.7',
      'user-agent': 'kept',
    });
    expect(Object.keys(forwarded).sort()).toEqual(['host', 'user-agent']);
  });

  it('drops every header an application could weaken the boundary with', () => {
    const returned = sanitizeResponseHeaders({
      'content-type': 'text/html',
      'content-security-policy': "default-src *",
      'x-frame-options': 'ALLOWALL',
      'set-cookie': 'session=stolen',
      'cache-control': 'public, max-age=31536000',
      'x-app-header': 'kept',
    });
    expect(Object.keys(returned).sort()).toEqual(['content-type', 'x-app-header']);
  });

  it('intercepts its own namespace instead of proxying it', () => {
    expect(isReservedPreviewPath('/.atoma')).toBe(true);
    expect(isReservedPreviewPath('/.atoma/claim')).toBe(true);
    expect(isReservedPreviewPath('/.atomacounterfeit')).toBe(false);
    expect(isReservedPreviewPath('/index.html')).toBe(false);
  });

  it('refuses a redirect that would navigate the member off the preview', () => {
    const origin = 'https://p1.previews.example.net';
    expect(isSamePreviewRedirect('/next', origin)).toBe(true);
    expect(isSamePreviewRedirect(`${origin}/next`, origin)).toBe(true);
    // A value that is not a URL is a RELATIVE REFERENCE and stays here, which
    // is the correct reading rather than a lenient one.
    expect(isSamePreviewRedirect('not a url', origin)).toBe(true);

    expect(isSamePreviewRedirect('https://elsewhere.example/', origin)).toBe(false);
    expect(isSamePreviewRedirect('//elsewhere.example/', origin)).toBe(false);
  });

  it('judges a redirect against the origin the browser actually asked for', () => {
    // THE ANCHOR CARRIES THE PORT. The gateway used to build it as
    // `https://` + the port-stripped Host, which refused the application's own
    // absolute `Location` on any gateway not reached on 443 — a 502 on a
    // correct redirect, in production as much as under the loopback
    // development profile where the port is part of the origin by design.
    const dev = previewOrigin(
      { domain: 'previews.localhost', scheme: 'http', port: 4311 },
      ORG,
      RUN,
      1
    );
    expect(dev).toMatch(/^http:\/\/p[0-9a-f]{32}\.previews\.localhost:4311$/);
    expect(isSamePreviewRedirect(`${dev}/next`, dev)).toBe(true);
    // A different port is a different origin, and still refused.
    expect(isSamePreviewRedirect(`${dev.replace(':4311', ':4312')}/next`, dev)).toBe(false);
    // So is the same host over the other scheme.
    expect(isSamePreviewRedirect(`${dev.replace('http:', 'https:')}/next`, dev)).toBe(false);
  });

  it('refuses a backslash redirect that a browser resolves off-origin', () => {
    // REGRESSION, and it was a real hole: a "looks relative, so it is safe"
    // shortcut allowed `/\evil.example`, which starts with a single slash and
    // yet resolves to `https://evil.example` in every WHATWG-compliant
    // browser, because a special scheme treats a backslash as a separator. A
    // generated application could have navigated the member off the preview.
    const origin = 'https://p1.previews.example.net';
    const backslash = String.fromCharCode(92);
    for (const location of [
      `/${backslash}evil.example`,
      `${backslash}${backslash}evil.example`,
      `/${backslash}${backslash}evil.example`,
    ]) {
      expect(isSamePreviewRedirect(location, origin)).toBe(false);
    }
  });
});

describe('preview grant cookie', () => {
  it('cannot be widened to a parent domain', () => {
    const cookie = previewGrantCookie('value', 300);
    expect(cookie.startsWith('__Host-')).toBe(true);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    // Framed cross-site by the visualizer, and partitioned so it is not a
    // third-party cookie the rest of the web can rely on.
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Partitioned');
    expect(cookie).not.toContain('Domain=');
  });

  it('clears with the same attributes it was set with', () => {
    const cleared = clearedPreviewGrantCookie();
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Partitioned');
    expect(cleared).toContain('SameSite=None');
  });
});
