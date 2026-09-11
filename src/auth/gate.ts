import type { IncomingMessage } from 'node:http';
import { AuthStore, type Viewer } from './store.js';
import { authCookieName, parseCookieHeader, SESSION_COOKIE } from './sessions.js';
import { isLoopbackHost } from './providers.js';

/**
 * THE GATE — one resolver from an HTTP request to a Viewer.
 *
 * `ATOMA_VIZ_AUTH` is the switch, and it is read HERE, at call time, from
 * the HOST environment — the same launch-time/host-policy pattern as
 * `ATOMA_REQUIRE_ISOLATION` (A1) and the credential snapshot (A6). Nothing
 * a run or a request supplies can turn the gate off: when the flag is set,
 * `/api/*` without a valid session is a 401, and the store is opened only
 * when the gate is actually on (no auth tables appear on the developer
 * path).
 */

export const VIZ_AUTH_ENV = 'ATOMA_VIZ_AUTH';
export const VIZ_PUBLIC_ORIGIN_ENV = 'ATOMA_VIZ_PUBLIC_ORIGIN';

export function vizAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[VIZ_AUTH_ENV];
  if (value === undefined || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new Error(`${VIZ_AUTH_ENV} must be one of: 0, false, 1, true`);
}

export interface AuthGate {
  enabled: boolean;
  store: AuthStore | null;
  resolve(req: IncomingMessage): Viewer | null;
}

export interface OpenAuthGateOptions {
  env?: NodeJS.ProcessEnv;
  /** The primary product store selected by the viz server (`--db`). */
  dbPath?: string;
}

/**
 * Canonical browser origin for OAuth redirects and cookie policy.
 *
 * Request Host / X-Forwarded-* headers are attacker-controlled unless a
 * deployment has an explicit trusted-proxy boundary. Authentication instead
 * has one operator-owned origin. Plain HTTP is accepted only for loopback
 * development; every remotely reachable deployment must use HTTPS.
 */
export function authPublicOrigin(env: NodeJS.ProcessEnv = process.env): URL {
  const raw = env[VIZ_PUBLIC_ORIGIN_ENV]?.trim();
  if (!raw) {
    throw new Error(`${VIZ_PUBLIC_ORIGIN_ENV} is required when ${VIZ_AUTH_ENV} is enabled`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${VIZ_PUBLIC_ORIGIN_ENV} must be an absolute http(s) origin`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error(`${VIZ_PUBLIC_ORIGIN_ENV} must use https (http is allowed only on loopback)`);
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${VIZ_PUBLIC_ORIGIN_ENV} must contain only scheme, host and optional port`);
  }
  return new URL(url.origin);
}

export function openAuthGate(options: OpenAuthGateOptions = {}): AuthGate {
  const env = options.env ?? process.env;
  if (!vizAuthEnabled(env)) {
    return { enabled: false, store: null, resolve: () => null };
  }
  const secure = env[VIZ_PUBLIC_ORIGIN_ENV] !== undefined && authPublicOrigin(env).protocol === 'https:';
  const store = AuthStore.open(options.dbPath);
  return {
    enabled: true,
    store,
    resolve(req) {
      // Duplicate names are ambiguous because user agents may order cookies
      // with different paths differently. Never let cookie tossing choose the
      // session the gate resolves.
      const sessionCookies = parseCookieHeader(req.headers.cookie)
        .filter((cookie) => cookie.name === authCookieName(SESSION_COOKIE, secure));
      if (sessionCookies.length !== 1 || !sessionCookies[0]!.value) return null;
      try {
        return store.resolveSession(sessionCookies[0]!.value);
      } catch {
        return null;
      }
    },
  };
}
