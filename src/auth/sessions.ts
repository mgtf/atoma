import { randomBytes } from 'node:crypto';
import { AuthStore, type Viewer } from './store.js';
import { isSessionToken, MAX_LOGOUT_SESSION_CANDIDATES } from './values.js';

/**
 * SESSION COOKIES — the bearer between browser and gate.
 *
 * Opaque tokens, never JWTs: the store keeps only the SHA-256 (see
 * AuthStore.createSession), revocation is a DELETE, and no secret ever has
 * to be minted for verification. A 32-byte random token carries more
 * entropy than any signature claim and leaks nothing if logged by a proxy.
 *
 * Cookie shape follows the conservative set the viz origin needs:
 * HttpOnly + SameSite=Lax always; `Secure` is derived from the configured
 * public HTTPS origin. HTTPS names use __Host- with Path=/ and no Domain.
 * Plain HTTP is accepted only for loopback development.
 */
export const SESSION_COOKIE = 'atoma_session';
export const OAUTH_TX_COOKIE = 'atoma_oauth_tx';
export const LOGGED_OUT_SESSION_VALUE = 'logged_out';

/** Login sessions last a week of wall clock, sliding-window free by design:
 *  re-login is one redirect, and a session that cannot expire is a session
 *  that cannot be scoped. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The authorization transaction (state + PKCE binding) lives minutes. */
export const OAUTH_TX_TTL_MS = 10 * 60 * 1000;

export interface CookieOptions {
  secure: boolean;
  path?: string;
  maxAgeSeconds?: number;
}

/** HTTPS cookies cannot be planted by a sibling or child domain. */
export function authCookieName(name: string, secure: boolean): string {
  return secure ? `__Host-${name}` : name;
}

/** Serialize one cookie header value. */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${authCookieName(name, opts.secure)}=${value}`, 'Path=' + (opts.secure ? '/' : (opts.path ?? '/')), 'HttpOnly', 'SameSite=Lax'];
  if (opts.secure) parts.push('Secure');
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAgeSeconds)}`);
  return parts.join('; ');
}

export interface ParsedCookie {
  name: string;
  value: string;
}

/**
 * Parse a Cookie header. Deliberately small: the viz server speaks to one
 * browser at a time, and a full RFC 6265 parser is another surface to get
 * wrong. Handles the `a=b; c=d` shape and ignores malformed segments.
 *
 * Note a browser never SENDS attributes (Path/Max-Age/… belong to
 * Set-Cookie only), but a header produced by round-tripping our own
 * serializer may carry them; segments whose name is a known attribute are
 * skipped so both spellings parse to the same jar.
 */
const COOKIE_ATTRIBUTES = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite', 'partitioned']);

export function parseCookieHeader(header: string | undefined): ParsedCookie[] {
  if (!header) return [];
  const out: ParsedCookie[] = [];
  for (const seg of header.split(';')) {
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const name = seg.slice(0, eq).trim();
    const value = seg.slice(eq + 1).trim();
    if (name.length > 0 && !COOKIE_ATTRIBUTES.has(name.toLowerCase())) out.push({ name, value });
  }
  return out;
}

/** Generate the clear session token (goes into the cookie, never persisted). */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface SessionIssued {
  token: string;
  setCookie: string;
  viewer: Viewer;
}

/**
 * Full login-finalisation: mint the token, persist its hash, return both
 * the clear token and the Set-Cookie header the server must send.
 */
export function issueSession(store: AuthStore, viewer: Viewer, opts: { secure: boolean }): SessionIssued {
  const token = newSessionToken();
  store.createSession({ principalId: viewer.principalId, orgId: viewer.orgId, token, ttlMs: SESSION_TTL_MS });
  return {
    token,
    setCookie: serializeCookie(SESSION_COOKIE, token, {
      secure: opts.secure,
      maxAgeSeconds: SESSION_TTL_MS / 1000,
    }),
    viewer,
  };
}

/**
 * Replace the root session bearer with an inert tombstone on logout.
 *
 * Deleting it would expose a more-specific same-name Domain/Path cookie that
 * the browser did not send to `/auth/logout`. Keeping this host-only root
 * cookie makes that later request ambiguous, so the gate continues to fail
 * closed. Its lifetime matches the longest session the hidden bearer could
 * still represent; the next successful login replaces the tombstone.
 */
export function retireSessionCookie(opts: { secure: boolean }): string {
  return serializeCookie(SESSION_COOKIE, LOGGED_OUT_SESSION_VALUE, {
    secure: opts.secure,
    maxAgeSeconds: SESSION_TTL_MS / 1000,
  });
}

/** Read the session token out of a request's Cookie header, if present. */
export function sessionTokenFromCookieHeader(header: string | undefined, secure = false): string | null {
  const found = parseCookieHeader(header).filter((cookie) => cookie.name === authCookieName(SESSION_COOKIE, secure));
  // Duplicate same-name cookies have ambiguous Path precedence. Fail closed
  // rather than letting a caller and a browser disagree about which bearer
  // was authenticated or revoked.
  return found.length === 1 && isSessionToken(found[0]!.value) ? found[0]!.value : null;
}

export type LogoutSessionCandidates =
  | { readonly overflow: false; readonly tokens: readonly string[] }
  | { readonly overflow: true; readonly tokens: readonly [] };

/**
 * Collect every plausible session bearer presented to logout.
 *
 * The admission gate still rejects duplicate names. Logout is different: it
 * must revoke the real server-side session even when a second Path/Domain
 * cookie made the browser header ambiguous. Only canonical opaque tokens are
 * candidates, duplicates are collapsed, and an over-limit header yields no
 * partial batch so an attacker cannot choose which token survives by order.
 */
export function logoutSessionCandidatesFromCookieHeader(
  header: string | undefined,
  secure = false
): LogoutSessionCandidates {
  const tokens = new Set<string>();
  for (const cookie of parseCookieHeader(header)) {
    if (cookie.name !== authCookieName(SESSION_COOKIE, secure) || !isSessionToken(cookie.value)) continue;
    tokens.add(cookie.value);
    if (tokens.size > MAX_LOGOUT_SESSION_CANDIDATES) {
      return { overflow: true, tokens: [] };
    }
  }
  return { overflow: false, tokens: [...tokens] };
}
