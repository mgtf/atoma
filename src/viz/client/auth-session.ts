export const AUTH_LOGIN_PATH = '/auth/login';

export type AuthNavigator = (path: string) => void;

function replaceLocation(path: string): void {
  globalThis.location.replace(path);
}

function currentLocationSearch(): string {
  return typeof location === 'undefined' ? '' : location.search;
}

/** Keep the one bearer needed to complete first admission; discard all other query state. */
export function authLoginPath(search = currentLocationSearch()): string {
  const invitation = new URLSearchParams(search).get('invite');
  return invitation
    ? `${AUTH_LOGIN_PATH}?invite=${encodeURIComponent(invitation)}`
    : AUTH_LOGIN_PATH;
}

/**
 * A 401 from the viz API means the server-side session expired or was
 * revoked. Move back to the server-owned login selector instead of leaving
 * stale run data and a generic query error on screen.
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
