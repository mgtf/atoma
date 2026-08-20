import type { IncomingMessage } from 'node:http';
import type { ProviderConfig } from '../auth/providers.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchProviderIdentity,
  newPkcePair,
} from '../auth/oidc.js';
import type { Viewer } from '../auth/store.js';
import { roleAtLeast } from '../projects/service.js';
import type { GitHubAppClient } from './client.js';
import type { GitHubAppConfig } from './config.js';
import { canonicalGitHubId } from './config.js';
import {
  GitHubInstallationCrossOrgError,
  GITHUB_CONNECT_STATE_TTL_MAX_MS,
  newGitHubConnectState,
  TooManyPendingGitHubConnectStatesError,
  type GitHubStore,
} from './store.js';
import { persistGitHubUserTokens } from './tokens.js';
import { githubAppInstallUrl } from './urls.js';
import {
  GitHubWebhookError,
  GITHUB_WEBHOOK_MAX_BODY_BYTES,
  processGitHubWebhook,
} from './webhook.js';

export { GITHUB_WEBHOOK_MAX_BODY_BYTES };

export const GITHUB_COPY = Object.freeze({
  notConfigured: 'GitHub App is not configured on this deployment.',
  authenticationRequired: 'Sign in before connecting GitHub.',
  adminRequired: 'org:admin role or above is required to connect GitHub.',
  invalidState: 'Missing or invalid GitHub connect state.',
  expiredState: 'GitHub connect transaction expired or was replayed — start again.',
  invalidInstallation: 'Missing or invalid GitHub installation id.',
  linkFailed: 'GitHub installation could not be linked to this organisation.',
  alreadyLinked: 'That GitHub installation is already linked to another organisation.',
  providerFailure: 'GitHub could not be reached. Start the connect flow again.',
});

export type GitHubHttpResult =
  | { readonly kind: 'redirect'; readonly location: string; readonly cookies?: readonly string[] }
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'html'; readonly status: number; readonly body: string; readonly cookies?: readonly string[] };

export async function readBoundedBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) {
      throw new GitHubWebhookError('body_too_large', 'GitHub webhook body exceeds the byte limit');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function webhookStatus(error: GitHubWebhookError): number {
  switch (error.code) {
    case 'invalid_signature':
      return 401;
    case 'body_too_large':
      return 413;
    case 'wrong_app':
      return 400;
    default:
      return 400;
  }
}

export async function handleGitHubWebhook(input: {
  readonly req: IncomingMessage;
  readonly store: GitHubStore;
  readonly config: GitHubAppConfig;
}): Promise<GitHubHttpResult> {
  try {
    const rawBody = await readBoundedBody(input.req, GITHUB_WEBHOOK_MAX_BODY_BYTES);
    const result = processGitHubWebhook({
      store: input.store,
      appId: input.config.appId,
      webhookSecret: input.config.webhookSecret,
      rawBody,
      signature: headerValue(input.req.headers['x-hub-signature-256']),
      deliveryId: headerValue(input.req.headers['x-github-delivery']),
      event: headerValue(input.req.headers['x-github-event']),
    });
    return { kind: 'json', status: 202, body: result };
  } catch (error) {
    if (error instanceof GitHubWebhookError) {
      return { kind: 'json', status: webhookStatus(error), body: { error: error.message } };
    }
    throw error;
  }
}

export function startGitHubConnect(input: {
  readonly viewer: Viewer;
  readonly github: GitHubStore;
  readonly config: GitHubAppConfig;
}): GitHubHttpResult {
  const forbidden = requireAdmin(input.viewer);
  if (forbidden) return forbidden;
  const state = newGitHubConnectState();
  try {
    input.github.createConnectState({
      state,
      principalId: input.viewer.principalId,
      orgId: input.viewer.orgId,
      ttlMs: GITHUB_CONNECT_STATE_TTL_MAX_MS,
    });
  } catch (error) {
    if (error instanceof TooManyPendingGitHubConnectStatesError) {
      return { kind: 'json', status: 429, body: { error: error.message } };
    }
    throw error;
  }
  return {
    kind: 'redirect',
    location: githubAppInstallUrl({
      appSlug: input.config.appSlug,
      state,
      apiBaseUrl: input.config.apiBaseUrl,
    }),
  };
}

export async function completeGitHubSetup(input: {
  readonly viewer: Viewer;
  readonly github: GitHubStore;
  readonly client: GitHubAppClient;
  readonly state: string | null;
  readonly installationId: string | null;
  readonly setupAction: string | null;
  readonly authorizePath: string;
  readonly homePath: string;
}): Promise<GitHubHttpResult> {
  const forbidden = requireAdmin(input.viewer);
  if (forbidden) return forbidden;
  if (!input.state) return htmlError(400, GITHUB_COPY.invalidState);
  const consumed = input.github.consumeConnectState({
    state: input.state,
    principalId: input.viewer.principalId,
    orgId: input.viewer.orgId,
  });
  if (!consumed) return htmlError(401, GITHUB_COPY.expiredState);
  if (input.setupAction === 'request') {
    return { kind: 'redirect', location: input.homePath };
  }
  if (!input.installationId) return htmlError(400, GITHUB_COPY.invalidInstallation);
  try {
    const installationId = canonicalGitHubId(input.installationId, 'GitHub installation id');
    const installation = await input.client.getAppInstallation(installationId);
    input.github.linkInstallation({
      installationId: installation.installationId,
      orgId: input.viewer.orgId,
      accountId: installation.accountId,
      accountLogin: installation.accountLogin,
      targetType: installation.targetType,
      repositorySelection: installation.repositorySelection,
      permissions: installation.permissions,
      connectedByPrincipalId: input.viewer.principalId,
    });
    if (
      installation.targetType === 'User' &&
      !input.github.getUserAuthorization(input.viewer.principalId)
    ) {
      return { kind: 'redirect', location: input.authorizePath };
    }
    return { kind: 'redirect', location: input.homePath };
  } catch (error) {
    if (error instanceof GitHubInstallationCrossOrgError) {
      return htmlError(409, GITHUB_COPY.alreadyLinked);
    }
    console.error('[viz github] setup failed', error);
    return htmlError(502, GITHUB_COPY.linkFailed);
  }
}

export function startGitHubUserAuthorize(input: {
  readonly viewer: Viewer;
  readonly github: GitHubStore;
  readonly provider: ProviderConfig;
  readonly redirectUri: string;
  readonly createOauthState: (state: string, codeVerifier: string) => void;
  readonly serializeOauthCookie: (state: string) => string;
}): GitHubHttpResult {
  const forbidden = requireAdmin(input.viewer);
  if (forbidden) return forbidden;
  const state = newGitHubConnectState();
  const pkce = newPkcePair();
  try {
    input.github.createConnectState({
      state,
      principalId: input.viewer.principalId,
      orgId: input.viewer.orgId,
      ttlMs: GITHUB_CONNECT_STATE_TTL_MAX_MS,
    });
    input.createOauthState(state, pkce.verifier);
  } catch (error) {
    if (error instanceof TooManyPendingGitHubConnectStatesError) {
      return { kind: 'json', status: 429, body: { error: error.message } };
    }
    throw error;
  }
  return {
    kind: 'redirect',
    location: buildAuthorizeUrl({
      provider: input.provider,
      redirectUri: input.redirectUri,
      state,
      codeChallenge: pkce.challenge,
    }),
    cookies: [input.serializeOauthCookie(state)],
  };
}

/**
 * Persist user-to-server tokens (and optionally link an installation) after a
 * GitHub connect/authorize callback. The caller has already consumed the
 * matching oauth PKCE transaction.
 */
export async function completeGitHubUserCallback(input: {
  readonly viewer: Viewer;
  readonly github: GitHubStore;
  readonly config: GitHubAppConfig;
  readonly provider: ProviderConfig;
  readonly redirectUri: string;
  readonly state: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly installationId: string | null;
  readonly client: GitHubAppClient;
  readonly homePath: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<GitHubHttpResult> {
  const consumed = input.github.consumeConnectState({
    state: input.state,
    principalId: input.viewer.principalId,
    orgId: input.viewer.orgId,
  });
  if (!consumed) {
    throw new Error('GitHub connect state did not match the authenticated viewer');
  }
  try {
    const tokens = await exchangeCode(
      {
        provider: input.provider,
        redirectUri: input.redirectUri,
        code: input.code,
        codeVerifier: input.codeVerifier,
      },
      input.fetchImpl
    );
    const identity = await fetchProviderIdentity(
      { provider: input.provider, accessToken: tokens.accessToken },
      input.fetchImpl
    );
    persistGitHubUserTokens({
      github: input.github,
      config: input.config,
      principalId: input.viewer.principalId,
      githubSubject: identity.subject,
      tokens,
    });
    if (input.installationId) {
      const installation = await input.client.verifyInstallation({
        userAccessToken: tokens.accessToken,
        installationId: input.installationId,
      });
      input.github.linkInstallation({
        installationId: installation.installationId,
        orgId: input.viewer.orgId,
        accountId: installation.accountId,
        accountLogin: installation.accountLogin,
        targetType: installation.targetType,
        repositorySelection: installation.repositorySelection,
        permissions: installation.permissions,
        connectedByPrincipalId: input.viewer.principalId,
      });
    }
    return { kind: 'redirect', location: input.homePath };
  } catch (error) {
    if (error instanceof GitHubInstallationCrossOrgError) {
      return htmlError(409, GITHUB_COPY.alreadyLinked);
    }
    console.error('[viz github] user-token callback failed', error);
    return htmlError(502, GITHUB_COPY.providerFailure);
  }
}

function requireAdmin(viewer: Viewer): GitHubHttpResult | null {
  if (!roleAtLeast(viewer.role, 'org:admin')) {
    return { kind: 'json', status: 403, body: { error: GITHUB_COPY.adminRequired } };
  }
  return null;
}

function htmlError(status: number, message: string): GitHubHttpResult {
  return { kind: 'html', status, body: message };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
