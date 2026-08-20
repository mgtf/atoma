import { describe, expect, it, vi } from 'vitest';
import {
  configuredProviders,
  providerByIdFromSnapshot,
  providerFromEnv,
  snapshotProviderRegistry,
  type ProviderConfig,
} from '../src/auth/providers.js';
import {
  OAUTH_MAX_RESPONSE_BYTES,
  buildAuthorizeUrl,
  exchangeCode,
  fetchProviderIdentity,
  newPkcePair,
  newState,
  pkceChallenge,
  refreshAccessToken,
} from '../src/auth/oidc.js';
import {
  isAuthorizationCode,
  isInvitationToken,
  isOauthState,
  MAX_AUTHORIZATION_CODE_LENGTH,
} from '../src/auth/values.js';

const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const REDIRECT_URI = 'http://127.0.0.1:4111/auth/callback';

function github(overrides: NodeJS.ProcessEnv = {}): ProviderConfig {
  const provider = providerFromEnv('github', {
    ATOMA_AUTH_GITHUB_CLIENT_ID: 'github-client',
    ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'github-secret',
    ...overrides,
  });
  if (!provider) throw new Error('test GitHub provider was not configured');
  return provider;
}

function chatgpt(overrides: NodeJS.ProcessEnv = {}): ProviderConfig {
  const provider = providerFromEnv('chatgpt', {
    ATOMA_AUTH_CHATGPT_CLIENT_ID: 'chatgpt-client',
    ...overrides,
  });
  if (!provider) throw new Error('test ChatGPT provider was not configured');
  return provider;
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

function formBody(body: BodyInit | null | undefined): URLSearchParams {
  if (!(body instanceof URLSearchParams)) throw new Error('expected a URLSearchParams body');
  return body;
}

describe('login provider registry', () => {
  it('requires complete confidential-client credentials for GitHub and Google', () => {
    const snapshot = snapshotProviderRegistry({
      ATOMA_AUTH_GITHUB_CLIENT_ID: 'github-id',
      ATOMA_AUTH_GOOGLE_CLIENT_SECRET: 'google-secret',
    });
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({ provider: 'github', issue: 'incomplete_credentials' }),
      expect.objectContaining({ provider: 'google', issue: 'incomplete_credentials' }),
    ]);
    expect(snapshot.diagnostics.map((entry) => entry.message).join('\n')).not.toContain(
      'google-secret'
    );
  });

  it('uses canonical credentials first and retains legacy compatibility', () => {
    const canonical = providerFromEnv('github', {
      ATOMA_AUTH_GITHUB_CLIENT_ID: 'canonical-id',
      ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'canonical-secret',
      GITHUB_CLIENT_ID: 'legacy-id',
      GITHUB_CLIENT_SECRET: 'legacy-secret',
    });
    expect(canonical).toMatchObject({ clientId: 'canonical-id', clientSecret: 'canonical-secret' });

    const legacy = providerFromEnv('google', {
      GOOGLE_CLIENT_ID: 'legacy-google-id',
      GOOGLE_CLIENT_SECRET: 'legacy-google-secret',
    });
    expect(legacy).toMatchObject({
      clientId: 'legacy-google-id',
      clientSecret: 'legacy-google-secret',
    });
  });

  it('uses the current ChatGPT discovery endpoints and its OIDC scopes by default', () => {
    expect(chatgpt()).toMatchObject({
      authorizeUrl: 'https://auth.openai.com/api/accounts/authorize',
      tokenUrl: 'https://auth.openai.com/api/accounts/oauth/token',
      userinfoUrl: 'https://auth.openai.com/api/accounts/oauth/userinfo',
      scope: 'openid profile email',
      protocol: 'openid',
      clientSecret: null,
    });
  });

  it('supports endpoint overrides for every provider and permits loopback HTTP', () => {
    for (const id of ['github', 'google', 'chatgpt'] as const) {
      const upper = id.toUpperCase();
      const env: NodeJS.ProcessEnv = {
        [`ATOMA_AUTH_${upper}_CLIENT_ID`]: `${id}-id`,
        [`ATOMA_AUTH_${upper}_AUTHORIZE_URL`]: 'http://localhost:4888/authorize',
        [`ATOMA_AUTH_${upper}_TOKEN_URL`]: 'http://127.0.0.1:4888/token',
        [`ATOMA_AUTH_${upper}_USERINFO_URL`]: 'http://[::1]:4888/userinfo',
      };
      if (id !== 'chatgpt') env[`ATOMA_AUTH_${upper}_CLIENT_SECRET`] = `${id}-secret`;
      expect(providerFromEnv(id, env)).toMatchObject({
        authorizeUrl: 'http://localhost:4888/authorize',
        tokenUrl: 'http://127.0.0.1:4888/token',
        userinfoUrl: 'http://[::1]:4888/userinfo',
      });
    }
  });

  it('rejects unsafe or malformed endpoint overrides with operator-safe diagnostics', () => {
    for (const unsafe of [
      'http://provider.example/token',
      'javascript:alert(1)',
      'https://user:password@provider.example/token',
      'https://provider.example/token#fragment',
      'not a URL',
    ]) {
      const snapshot = snapshotProviderRegistry({
        ATOMA_AUTH_GITHUB_CLIENT_ID: 'id',
        ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'secret-value',
        ATOMA_AUTH_GITHUB_TOKEN_URL: unsafe,
      });
      expect(snapshot.providers).toEqual([]);
      expect(snapshot.diagnostics).toEqual([
        expect.objectContaining({ provider: 'github', issue: 'invalid_endpoint' }),
      ]);
      expect(snapshot.diagnostics[0]?.message).not.toContain('secret-value');
      expect(snapshot.diagnostics[0]?.message).not.toContain('password');
    }
  });

  it('diagnoses endpoint-only partial configuration instead of enabling it', () => {
    const snapshot = snapshotProviderRegistry({
      ATOMA_AUTH_CHATGPT_TOKEN_URL: 'https://auth.openai.com/api/accounts/oauth/token',
    });
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({ provider: 'chatgpt', issue: 'orphaned_endpoint_override' }),
    ]);
  });

  it('returns an immutable snapshot detached from later environment mutations', () => {
    const env: NodeJS.ProcessEnv = {
      ATOMA_AUTH_GITHUB_CLIENT_ID: 'first-id',
      ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'first-secret',
      ATOMA_AUTH_CHATGPT_CLIENT_ID: 'chatgpt-id',
    };
    const snapshot = snapshotProviderRegistry(env);
    env['ATOMA_AUTH_GITHUB_CLIENT_ID'] = 'second-id';
    delete env['ATOMA_AUTH_CHATGPT_CLIENT_ID'];

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.providers)).toBe(true);
    expect(Object.isFrozen(snapshot.providers[0])).toBe(true);
    expect(snapshot.providers.map((provider) => provider.id)).toEqual(['github', 'chatgpt']);
    expect(providerByIdFromSnapshot('github', snapshot)?.clientId).toBe('first-id');
    expect(providerByIdFromSnapshot('unknown', snapshot)).toBeNull();
    expect(configuredProviders(env).map((provider) => provider.id)).toEqual(['github']);
  });
});

describe('PKCE authorization request', () => {
  it('implements the RFC 7636 S256 vector and generates valid verifier pairs', () => {
    expect(pkceChallenge(RFC_VERIFIER)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const pair = newPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pair.challenge).toBe(pkceChallenge(pair.verifier));
  });

  it('shares exact browser-boundary contracts for state, codes and invitations', () => {
    expect(isOauthState(newState())).toBe(true);
    expect(isOauthState('short')).toBe(false);
    expect(isOauthState('!'.repeat(32))).toBe(false);

    expect(isAuthorizationCode('x'.repeat(MAX_AUTHORIZATION_CODE_LENGTH))).toBe(true);
    expect(isAuthorizationCode('x'.repeat(MAX_AUTHORIZATION_CODE_LENGTH + 1))).toBe(false);
    expect(isAuthorizationCode('line\nbreak')).toBe(false);

    expect(isInvitationToken('A'.repeat(43))).toBe(true);
    expect(isInvitationToken('A'.repeat(42))).toBe(false);
    expect(isInvitationToken(`${'A'.repeat(42)}!`)).toBe(false);
  });

  it('builds a complete authorization-code redirect without losing provider query params', () => {
    const provider = github({
      ATOMA_AUTH_GITHUB_AUTHORIZE_URL: 'https://github.com/login/oauth/authorize?prompt=login',
    });
    const url = new URL(
      buildAuthorizeUrl({
        provider,
        redirectUri: REDIRECT_URI,
        state: 'single-use-state',
        codeChallenge: pkceChallenge(RFC_VERIFIER),
      })
    );
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('github-client');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.get('state')).toBe('single-use-state');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('authorization-code exchange', () => {
  it('sends the client secret and PKCE verifier in a bounded no-redirect request', async () => {
    let seenInit: RequestInit | undefined;
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seenInit = init;
      return jsonResponse({ access_token: 'safe-access-token' });
    }) as typeof fetch;
    await expect(
      exchangeCode(
        {
          provider: github(),
          redirectUri: REDIRECT_URI,
          code: 'authorization-code',
          codeVerifier: RFC_VERIFIER,
        },
        fakeFetch
      )
    ).resolves.toEqual({
      accessToken: 'safe-access-token',
      accessTokenExpiresInSeconds: null,
      refreshToken: null,
      refreshTokenExpiresInSeconds: null,
    });

    expect(seenInit?.redirect).toBe('error');
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
    const form = formBody(seenInit?.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('client_secret')).toBe('github-secret');
    expect(form.get('code_verifier')).toBe(RFC_VERIFIER);
    expect(form.get('redirect_uri')).toBe(REDIRECT_URI);
  });

  it('rotates a refresh token with the same bounded no-redirect client', async () => {
    let seenInit: RequestInit | undefined;
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seenInit = init;
      return jsonResponse({
        access_token: 'rotated-access',
        expires_in: 3600,
        refresh_token: 'rotated-refresh',
        refresh_token_expires_in: 86_400,
      });
    }) as typeof fetch;
    await expect(
      refreshAccessToken({ provider: github(), refreshToken: 'ghr_previous' }, fakeFetch)
    ).resolves.toEqual({
      accessToken: 'rotated-access',
      accessTokenExpiresInSeconds: 3600,
      refreshToken: 'rotated-refresh',
      refreshTokenExpiresInSeconds: 86_400,
    });
    expect(seenInit?.redirect).toBe('error');
    const form = formBody(seenInit?.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('ghr_previous');
    expect(form.get('client_secret')).toBe('github-secret');
    expect(form.has('code')).toBe(false);
  });

  it('does not invent a secret for a PKCE-only ChatGPT client', async () => {
    let form = new URLSearchParams();
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      form = formBody(init?.body);
      return jsonResponse({ access_token: 'token' });
    }) as typeof fetch;
    await exchangeCode(
      {
        provider: chatgpt(),
        redirectUri: REDIRECT_URI,
        code: 'code',
        codeVerifier: RFC_VERIFIER,
      },
      fakeFetch
    );
    expect(form.has('client_secret')).toBe(false);
  });

  it('bounds response bytes before parsing and strictly validates the token', async () => {
    const tooLarge = (async () =>
      new Response('x'.repeat(OAUTH_MAX_RESPONSE_BYTES + 1))) as typeof fetch;
    await expect(
      exchangeCode(
        {
          provider: github(),
          redirectUri: REDIRECT_URI,
          code: 'code',
          codeVerifier: RFC_VERIFIER,
        },
        tooLarge
      )
    ).rejects.toThrow(/response exceeded/);

    for (const body of [
      {},
      { access_token: '' },
      { access_token: 'contains whitespace' },
      { access_token: 'x'.repeat(8_193) },
    ]) {
      const fakeFetch = (async () => jsonResponse(body)) as typeof fetch;
      await expect(
        exchangeCode(
          {
            provider: github(),
            redirectUri: REDIRECT_URI,
            code: 'code',
            codeVerifier: RFC_VERIFIER,
          },
          fakeFetch
        )
      ).rejects.toThrow(/invalid access_token/);
    }
  });

  it('times out an unresponsive provider and never includes secrets or response text in errors', async () => {
    const hangingFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }) as typeof fetch;
    await expect(
      exchangeCode(
        {
          provider: github(),
          redirectUri: REDIRECT_URI,
          code: 'private-code',
          codeVerifier: RFC_VERIFIER,
        },
        hangingFetch,
        { timeoutMs: 5 }
      )
    ).rejects.toThrow(/timed out after 5ms/);

    const failedFetch = (async () =>
      new Response('github-secret private-code provider-details', { status: 400 })) as typeof fetch;
    let message = '';
    try {
      await exchangeCode(
        {
          provider: github(),
          redirectUri: REDIRECT_URI,
          code: 'private-code',
          codeVerifier: RFC_VERIFIER,
        },
        failedFetch
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('token exchange failed with HTTP 400');
  });
});

describe('provider userinfo', () => {
  it('normalizes strict OIDC claims and sends the bearer token without following redirects', async () => {
    let seenInit: RequestInit | undefined;
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seenInit = init;
      return jsonResponse({
        sub: 'stable-subject',
        name: '  Ada Lovelace  ',
        email: ' ada@example.test ',
        email_verified: true,
      });
    }) as typeof fetch;
    await expect(
      fetchProviderIdentity({ provider: chatgpt(), accessToken: 'bearer-token' }, fakeFetch)
    ).resolves.toEqual({
      subject: 'stable-subject',
      displayName: 'Ada Lovelace',
      email: 'ada@example.test',
      emailVerified: true,
    });
    expect(seenInit?.redirect).toBe('error');
    expect(new Headers(seenInit?.headers).get('authorization')).toBe('Bearer bearer-token');
  });

  it('uses GitHub id as the stable subject and never asserts email verification', async () => {
    const fakeFetch = (async () =>
      jsonResponse({ id: 12345, login: 'octocat', email: 'octocat@example.test' })) as typeof fetch;
    await expect(
      fetchProviderIdentity({ provider: github(), accessToken: 'token' }, fakeFetch)
    ).resolves.toEqual({
      subject: '12345',
      displayName: 'octocat',
      email: 'octocat@example.test',
      emailVerified: false,
    });
  });

  it('refuses missing or malformed stable identities, names, emails and verification flags', async () => {
    const badClaims: Array<{ body: unknown; expected: RegExp }> = [
      { body: { name: 'No subject' }, expected: /stable subject \(sub\)/ },
      { body: { sub: ' subject ' }, expected: /stable subject \(sub\)/ },
      { body: { sub: 'subject', name: 'x'.repeat(256) }, expected: /invalid name/ },
      { body: { sub: 'subject', name: '\nAda' }, expected: /invalid name/ },
      { body: { sub: 'subject', email: 'not-an-email' }, expected: /invalid email/ },
      {
        body: { sub: 'subject', email: 'a@example.test', email_verified: 'true' },
        expected: /invalid email_verified/,
      },
    ];
    for (const item of badClaims) {
      const fakeFetch = (async () => jsonResponse(item.body)) as typeof fetch;
      await expect(
        fetchProviderIdentity({ provider: chatgpt(), accessToken: 'token' }, fakeFetch)
      ).rejects.toThrow(item.expected);
    }

    const missingGithubId = (async () => jsonResponse({ login: 'octocat' })) as typeof fetch;
    await expect(
      fetchProviderIdentity({ provider: github(), accessToken: 'token' }, missingGithubId)
    ).rejects.toThrow(/stable subject \(id\)/);
  });

  it('bounds userinfo responses and validates bearer tokens before making a request', async () => {
    const tooLarge = (async () =>
      new Response('x'.repeat(OAUTH_MAX_RESPONSE_BYTES + 1))) as typeof fetch;
    await expect(
      fetchProviderIdentity({ provider: chatgpt(), accessToken: 'token' }, tooLarge)
    ).rejects.toThrow(/response exceeded/);

    const fetchSpy = vi.fn(async () => jsonResponse({ sub: 'subject' }));
    await expect(
      fetchProviderIdentity(
        { provider: chatgpt(), accessToken: 'token with whitespace' },
        fetchSpy as typeof fetch
      )
    ).rejects.toThrow('invalid access token');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
