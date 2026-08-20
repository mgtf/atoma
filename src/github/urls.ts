/**
 * Browser-facing GitHub App URLs. The REST API host is not the web host
 * (`api.github.com` vs `github.com`), and GitHub Enterprise keeps the API
 * under `/api/v3` on the same origin as the install UI.
 */

export function githubWebOrigin(apiBaseUrl: string): string {
  let api: URL;
  try {
    api = new URL(apiBaseUrl);
  } catch {
    throw new Error('GitHub API base URL has an invalid value');
  }
  if (api.hostname === 'api.github.com') return 'https://github.com';
  const loopback =
    api.hostname === 'localhost' ||
    api.hostname === '127.0.0.1' ||
    api.hostname === '::1' ||
    api.hostname === '[::1]';
  if (loopback) return api.origin;
  return api.origin;
}

/** Install URL that carries our connect `state` through to the setup callback. */
export function githubAppInstallUrl(input: {
  readonly appSlug: string;
  readonly state: string;
  readonly apiBaseUrl: string;
}): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(input.appSlug)) {
    throw new Error('GitHub App slug has an invalid value');
  }
  if (!input.state || input.state.length > 512) {
    throw new Error('GitHub connect state has an invalid value');
  }
  const url = new URL(`/apps/${input.appSlug}/installations/new`, githubWebOrigin(input.apiBaseUrl));
  url.searchParams.set('state', input.state);
  return url.href;
}
