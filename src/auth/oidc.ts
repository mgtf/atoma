import { createHash, randomBytes } from 'node:crypto';
import { avatarUrlFromClaim } from './avatar.js';
import type { ProviderConfig } from './providers.js';
import {
  hasControlCharacters,
  isAuthorizationCode,
  OAUTH_STATE_BYTES,
} from './values.js';

/** OAuth/OIDC requests must not hold a viz request open indefinitely. */
export const OAUTH_FETCH_TIMEOUT_MS = 10_000;
/** Bounds both success and error bodies before any JSON parsing. */
export const OAUTH_MAX_RESPONSE_BYTES = 64 * 1024;

const MAX_ACCESS_TOKEN_LENGTH = 8_192;
const MAX_SUBJECT_LENGTH = 255;
const MAX_DISPLAY_NAME_LENGTH = 255;
const MAX_EMAIL_LENGTH = 320;

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface OauthHttpOptions {
  /** Test seam; production callers use OAUTH_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

export function newPkcePair(): PkcePair {
  // RFC 7636: verifier 43-128 chars from the unreserved set. 64 bytes
  // base64url -> 86 chars, comfortably in range.
  const verifier = randomBytes(64).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function newState(): string {
  return randomBytes(OAUTH_STATE_BYTES).toString('base64url');
}

/** Build the browser-facing authorization redirect URL. */
export function buildAuthorizeUrl(input: {
  provider: ProviderConfig;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = safeHttpUrl(input.provider.authorizeUrl, 'authorization endpoint');
  safeHttpUrl(input.redirectUri, 'redirect URI');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.provider.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  if (input.provider.scope) url.searchParams.set('scope', input.provider.scope);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.href;
}

export interface ExchangedTokens {
  accessToken: string;
  /** Present when the provider enables expiring GitHub App user tokens. */
  accessTokenExpiresInSeconds: number | null;
  /** Rotating credential used only by the control plane, never by a worker. */
  refreshToken: string | null;
  refreshTokenExpiresInSeconds: number | null;
}

/** Exchange an authorization code with PKCE using a bounded, no-redirect request. */
export async function exchangeCode(
  input: { provider: ProviderConfig; redirectUri: string; code: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
  options: OauthHttpOptions = {}
): Promise<ExchangedTokens> {
  safeHttpUrl(input.provider.tokenUrl, 'token endpoint');
  safeHttpUrl(input.redirectUri, 'redirect URI');
  if (!isAuthorizationCode(input.code)) throw new Error('invalid authorization code');
  assertPkceVerifier(input.codeVerifier);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: input.provider.clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  if (input.provider.clientSecret) body.set('client_secret', input.provider.clientSecret);

  const res = await fetchWithDeadline(
    fetchImpl,
    input.provider.tokenUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      redirect: 'error',
    },
    'token exchange',
    options.timeoutMs
  );
  const text = await boundedResponseText(res, 'token exchange');
  if (!res.ok) throw new Error(`token exchange failed with HTTP ${res.status}`);
  return parseExchangedTokens(parseJsonObject(text, 'token exchange'), 'token exchange');
}

/**
 * Rotate a GitHub App user-to-server token. The control plane stores the
 * refresh credential encrypted; workers never see it.
 */
export async function refreshAccessToken(
  input: { provider: ProviderConfig; refreshToken: string },
  fetchImpl: typeof fetch = fetch,
  options: OauthHttpOptions = {}
): Promise<ExchangedTokens> {
  safeHttpUrl(input.provider.tokenUrl, 'token endpoint');
  const refresh = oauthToken(input.refreshToken);
  if (!refresh) throw new Error('invalid refresh token');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: input.provider.clientId,
    refresh_token: refresh,
  });
  if (input.provider.clientSecret) body.set('client_secret', input.provider.clientSecret);

  const res = await fetchWithDeadline(
    fetchImpl,
    input.provider.tokenUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      redirect: 'error',
    },
    'token refresh',
    options.timeoutMs
  );
  const text = await boundedResponseText(res, 'token refresh');
  if (!res.ok) throw new Error(`token refresh failed with HTTP ${res.status}`);
  return parseExchangedTokens(parseJsonObject(text, 'token refresh'), 'token refresh');
}

function parseExchangedTokens(raw: Record<string, unknown>, operation: string): ExchangedTokens {
  const accessToken = oauthToken(raw['access_token']);
  if (!accessToken) {
    throw new Error(`${operation} returned an invalid access_token`);
  }
  const refreshValue = raw['refresh_token'];
  const refreshToken = refreshValue === undefined ? null : oauthToken(refreshValue);
  if (refreshValue !== undefined && !refreshToken) {
    throw new Error(`${operation} returned an invalid refresh_token`);
  }
  return {
    accessToken,
    accessTokenExpiresInSeconds: optionalLifetime(raw['expires_in'], 'expires_in'),
    refreshToken,
    refreshTokenExpiresInSeconds: optionalLifetime(
      raw['refresh_token_expires_in'],
      'refresh_token_expires_in'
    ),
  };
}

function oauthToken(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ACCESS_TOKEN_LENGTH &&
    /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value)
    ? value
    : null;
}

function optionalLifetime(value: unknown, field: string): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`token exchange returned an invalid ${field}`);
  }
  return value as number;
}

export interface ProviderIdentity {
  /** Stable per-provider subject — the only join key. */
  subject: string;
  displayName: string;
  email: string | null;
  emailVerified: boolean;
  /**
   * Provider picture URL, or null. Deliberately the ONLY optional claim that
   * cannot fail a login: `avatarUrlFromClaim` swallows a malformed value
   * instead of throwing (see `avatar.ts`), because a broken profile picture is
   * not a reason to refuse an otherwise valid identity.
   */
  avatarUrl: string | null;
}

/** Fetch and strictly normalize the stable identity from userinfo. */
export async function fetchProviderIdentity(
  input: { provider: ProviderConfig; accessToken: string },
  fetchImpl: typeof fetch = fetch,
  options: OauthHttpOptions = {}
): Promise<ProviderIdentity> {
  safeHttpUrl(input.provider.userinfoUrl, 'userinfo endpoint');
  assertAccessToken(input.accessToken);

  const res = await fetchWithDeadline(
    fetchImpl,
    input.provider.userinfoUrl,
    {
      headers: { authorization: `Bearer ${input.accessToken}`, accept: 'application/json' },
      redirect: 'error',
    },
    'userinfo',
    options.timeoutMs
  );
  const text = await boundedResponseText(res, 'userinfo');
  if (!res.ok) throw new Error(`userinfo failed with HTTP ${res.status}`);
  const raw = parseJsonObject(text, 'userinfo');

  if (input.provider.protocol === 'oauth2') return githubIdentity(raw);
  return oidcIdentity(raw);
}

async function fetchWithDeadline(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
  requestedTimeoutMs: number | undefined
): Promise<Response> {
  const timeoutMs = timeout(requestedTimeoutMs);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch {
    if (signal.aborted) throw new Error(`${operation} timed out after ${timeoutMs}ms`);
    throw new Error(`${operation} request failed`);
  }
}

async function boundedResponseText(res: Response, operation: string): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > OAUTH_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`${operation} response exceeded ${OAUTH_MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${operation} response exceeded`)) {
      throw error;
    }
    throw new Error(`${operation} returned an unreadable response`);
  } finally {
    reader.releaseLock();
  }
}

function parseJsonObject(text: string, operation: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${operation} returned a non-object JSON value`);
  }
  return parsed as Record<string, unknown>;
}

function githubIdentity(raw: Record<string, unknown>): ProviderIdentity {
  const subject = githubSubject(raw['id']);
  const displayName =
    optionalDisplayName(raw, 'name') ??
    optionalDisplayName(raw, 'login') ??
    `github-${subject}`;
  return {
    subject,
    displayName,
    email: optionalEmail(raw['email']),
    // GitHub's basic /user response is not a verified-email assertion.
    emailVerified: false,
    avatarUrl: avatarUrlFromClaim(raw['avatar_url']),
  };
}

function oidcIdentity(raw: Record<string, unknown>): ProviderIdentity {
  const subject = requiredSubject(raw['sub'], 'sub');
  const displayName =
    optionalDisplayName(raw, 'name') ?? optionalDisplayName(raw, 'username') ?? subject;
  const email = optionalEmail(raw['email']);
  const verified = raw['email_verified'];
  if (verified !== undefined && typeof verified !== 'boolean') {
    throw new Error('userinfo returned an invalid email_verified claim');
  }
  return {
    subject,
    displayName,
    email,
    emailVerified: email !== null && verified === true,
    avatarUrl: avatarUrlFromClaim(raw['picture']),
  };
}

function githubSubject(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error('userinfo returned an invalid stable subject (id)');
    }
    return String(value);
  }
  if (typeof value === 'string' && /^[1-9][0-9]{0,63}$/.test(value)) return value;
  throw new Error('userinfo returned no valid stable subject (id)');
}

function requiredSubject(value: unknown, claim: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SUBJECT_LENGTH ||
    value.trim() !== value ||
    /\s/u.test(value) ||
    hasControlCharacters(value)
  ) {
    throw new Error(`userinfo returned no valid stable subject (${claim})`);
  }
  return value;
}

function optionalDisplayName(raw: Record<string, unknown>, claim: string): string | null {
  const value = raw[claim];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`userinfo returned an invalid ${claim} claim`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_DISPLAY_NAME_LENGTH ||
    hasControlCharacters(value)
  ) {
    throw new Error(`userinfo returned an invalid ${claim} claim`);
  }
  return normalized;
}

function optionalEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('userinfo returned an invalid email claim');
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_EMAIL_LENGTH ||
    !/^[^\s@]+@[^\s@]+$/u.test(normalized) ||
    hasControlCharacters(value)
  ) {
    throw new Error('userinfo returned an invalid email claim');
  }
  return normalized;
}

function assertAccessToken(value: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_ACCESS_TOKEN_LENGTH ||
    !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value)
  ) {
    throw new Error('invalid access token');
  }
}

function assertPkceVerifier(verifier: string): void {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error('invalid PKCE verifier');
}

function timeout(requested: number | undefined): number {
  if (requested === undefined) return OAUTH_FETCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(requested) || requested <= 0 || requested > OAUTH_FETCH_TIMEOUT_MS) {
    throw new Error('invalid OAuth request timeout');
  }
  return requested;
}

function safeHttpUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not an absolute URL`);
  }
  if (url.username || url.password || url.hash) throw new Error(`${label} is unsafe`);
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return url;
  throw new Error(`${label} must use HTTPS`);
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]';
}
