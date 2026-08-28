// NAME CONSTRAINED BY THE DEV PROXY. This was `auth-session.ts`, and the Vite
// dev server proxies `/auth` by PREFIX — so as a root module of the MUI client
// it was requested at `/auth-session.ts`, swallowed by the proxy, and 404'd in
// dev only. Same failure `cae2bfa` fixed by renaming `api-*.ts`; the guard in
// `tests/viz-client-bundle-boundary.test.ts` now refuses the whole class
// (2026-08-27, 3.7).
/** Server-owned no-JS fallback selector; provider hrefs are built on it. */
export const AUTH_LOGIN_PATH = '/auth/login';

export type AuthNavigator = (path: string) => void;

function replaceLocation(path: string): void {
  globalThis.location.replace(path);
}

function currentLocationSearch(): string {
  return typeof location === 'undefined' ? '' : location.search;
}

/**
 * Where an unauthenticated browser belongs: the APP SHELL — its arrival gate
 * is the login. Keep the one bearer needed to complete first admission;
 * discard all other query state.
 */
export function authLoginPath(search = currentLocationSearch()): string {
  const invitation = new URLSearchParams(search).get('invite');
  return invitation ? `/?invite=${encodeURIComponent(invitation)}` : '/';
}

export interface LoginBounceParams {
  /** Bounded failure code from the server's `?authNotice=` bounce, or null. */
  notice: string | null;
  /** Invitation bearer riding the URL, or null. */
  invite: string | null;
}

/**
 * The two query parameters the arrival gate consumes, validated: the notice
 * is a bounded code (display steering, never free text) and the invitation
 * is length-capped. Everything else in the URL is ignored.
 */
export function loginBounceParams(search = currentLocationSearch()): LoginBounceParams {
  const params = new URLSearchParams(search);
  const notice = params.get('authNotice');
  const invite = params.get('invite');
  return {
    notice: notice && /^[A-Za-z]{1,64}$/.test(notice) ? notice : null,
    invite: invite && invite.length <= 512 ? invite : null,
  };
}

/**
 * The server-owned login start for one provider. The invitation MUST ride
 * this link: it is the bearer that admits the account the visitor signs in
 * with — dropping it would refuse the invitee or found a stray organisation.
 */
export function providerLoginHref(providerId: string, invite: string | null): string {
  return `${AUTH_LOGIN_PATH}?provider=${encodeURIComponent(providerId)}${
    invite ? `&invite=${encodeURIComponent(invite)}` : ''
  }`;
}

/**
 * A 401 from the viz API means the server-side session expired or was
 * revoked. Move back to the arrival gate instead of leaving stale run data
 * and a generic query error on screen.
 */
export function redirectIfAuthenticationRequired(
  status: number,
  navigate: AuthNavigator = replaceLocation,
  search?: string
): boolean {
  if (status !== 401) return false;
  navigate(authLoginPath(search ?? currentLocationSearch()));
  return true;
}
