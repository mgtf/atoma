import type { ProviderConfig } from '../auth/providers.js';
import type { ExchangedTokens } from '../auth/oidc.js';
import { fetchProviderIdentity, refreshAccessToken } from '../auth/oidc.js';
import type { GitHubAppConfig } from './config.js';
import { decryptGitHubToken, encryptGitHubToken } from './crypto.js';
import type { GitHubStore } from './store.js';

/** Refresh one minute before the stored access expiry so publish does not race it. */
export const GITHUB_USER_TOKEN_MARGIN_MS = 60_000;

export function persistGitHubUserTokens(input: {
  readonly github: GitHubStore;
  readonly config: GitHubAppConfig;
  readonly principalId: string;
  readonly githubSubject: string;
  readonly tokens: ExchangedTokens;
  readonly now?: number;
}): void {
  const now = input.now ?? Date.now();
  const expiresIn = input.tokens.accessTokenExpiresInSeconds;
  if (expiresIn === null) {
    throw new Error('GitHub user access token has no expiry');
  }
  const accessExpiresAt = now + expiresIn * 1_000;
  if (accessExpiresAt <= now) throw new Error('GitHub user access token is already expired');
  const refreshExpiresIn = input.tokens.refreshTokenExpiresInSeconds;
  const refreshToken = input.tokens.refreshToken;
  if ((refreshToken === null) !== (refreshExpiresIn === null)) {
    throw new Error('GitHub refresh token and expiry must be supplied together');
  }
  input.github.saveUserAuthorization({
    principalId: input.principalId,
    githubSubject: input.githubSubject,
    accessToken: encryptGitHubToken({
      token: input.tokens.accessToken,
      kind: 'access',
      principalId: input.principalId,
      key: input.config.tokenEncryptionKey,
      keyId: input.config.tokenEncryptionKeyId,
    }),
    accessExpiresAt,
    refreshToken:
      refreshToken === null
        ? null
        : encryptGitHubToken({
            token: refreshToken,
            kind: 'refresh',
            principalId: input.principalId,
            key: input.config.tokenEncryptionKey,
            keyId: input.config.tokenEncryptionKeyId,
          }),
    refreshExpiresAt: refreshExpiresIn === null ? null : now + refreshExpiresIn * 1_000,
    now,
  });
}

/**
 * Decrypt a stored user-to-server token, refreshing it when it is inside the
 * expiry margin. The refresh credential never leaves this module as plaintext
 * except for the one HTTP call to GitHub's token endpoint.
 */
export async function resolveGitHubUserAccessToken(input: {
  readonly github: GitHubStore;
  readonly config: GitHubAppConfig;
  readonly provider: ProviderConfig;
  readonly principalId: string;
  readonly now?: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<string> {
  const now = input.now ?? Date.now();
  const authorization = input.github.getUserAuthorization(input.principalId);
  if (!authorization) {
    throw new Error('no GitHub user authorization is stored for this principal');
  }
  const accessExpiresAt = Date.parse(authorization.accessExpiresAt);
  if (!Number.isFinite(accessExpiresAt)) {
    throw new Error('GitHub user access token expiry is invalid');
  }
  if (accessExpiresAt - GITHUB_USER_TOKEN_MARGIN_MS > now) {
    return decryptGitHubToken({
      envelope: authorization.accessToken,
      expectedKind: 'access',
      principalId: input.principalId,
      key: input.config.tokenEncryptionKey,
      keyId: input.config.tokenEncryptionKeyId,
    });
  }
  if (!authorization.refreshToken || !authorization.refreshExpiresAt) {
    throw new Error('GitHub user access token is expired and no refresh token is stored');
  }
  const refreshExpiresAt = Date.parse(authorization.refreshExpiresAt);
  if (!Number.isFinite(refreshExpiresAt) || refreshExpiresAt <= now) {
    throw new Error('GitHub user refresh token is expired');
  }
  const refreshToken = decryptGitHubToken({
    envelope: authorization.refreshToken,
    expectedKind: 'refresh',
    principalId: input.principalId,
    key: input.config.tokenEncryptionKey,
    keyId: input.config.tokenEncryptionKeyId,
  });
  const rotated = await refreshAccessToken(
    { provider: input.provider, refreshToken },
    input.fetchImpl
  );
  persistGitHubUserTokens({
    github: input.github,
    config: input.config,
    principalId: input.principalId,
    githubSubject: authorization.githubSubject,
    tokens: rotated,
    now,
  });
  return rotated.accessToken;
}

/** Persist tokens from a GitHub login or connect callback. Failures are the caller's. */
export async function persistGitHubUserTokensFromAccessToken(input: {
  readonly github: GitHubStore;
  readonly config: GitHubAppConfig;
  readonly provider: ProviderConfig;
  readonly principalId: string;
  readonly tokens: ExchangedTokens;
  readonly fetchImpl?: typeof fetch;
  readonly now?: number;
}): Promise<void> {
  const identity = await fetchProviderIdentity(
    { provider: input.provider, accessToken: input.tokens.accessToken },
    input.fetchImpl
  );
  persistGitHubUserTokens({
    github: input.github,
    config: input.config,
    principalId: input.principalId,
    githubSubject: identity.subject,
    tokens: input.tokens,
    now: input.now,
  });
}
