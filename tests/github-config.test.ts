import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalGitHubId,
  GITHUB_APP_ENV,
  snapshotGitHubAppConfig,
} from '../src/github/config.js';

function rsaPem(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString();
}

function validEnv(privateKey = rsaPem()): NodeJS.ProcessEnv {
  return {
    [GITHUB_APP_ENV.appId]: '123456',
    [GITHUB_APP_ENV.appSlug]: 'atoma-test',
    [GITHUB_APP_ENV.privateKey]: privateKey,
    [GITHUB_APP_ENV.webhookSecret]: 'w'.repeat(32),
    [GITHUB_APP_ENV.tokenEncryptionKey]: randomBytes(32).toString('base64url'),
    [GITHUB_APP_ENV.oauthClientId]: 'client-id',
    [GITHUB_APP_ENV.oauthClientSecret]: 'client-secret',
  };
}

describe('GitHub App configuration snapshot', () => {
  it('resolves one immutable snapshot and derives a non-secret key id', () => {
    const env = validEnv();
    const config = snapshotGitHubAppConfig(env);
    env[GITHUB_APP_ENV.appId] = '999';
    env[GITHUB_APP_ENV.oauthClientId] = 'changed';

    expect(config).toMatchObject({
      appId: '123456',
      appSlug: 'atoma-test',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      apiBaseUrl: 'https://api.github.com',
    });
    expect(config.privateKey.type).toBe('private');
    expect(config.tokenEncryptionKey.symmetricKeySize).toBe(32);
    expect(config.tokenEncryptionKeyId).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('accepts the existing provider snapshot explicitly and legacy env credentials as fallback', () => {
    const explicitEnv = validEnv();
    delete explicitEnv[GITHUB_APP_ENV.oauthClientId];
    delete explicitEnv[GITHUB_APP_ENV.oauthClientSecret];
    const explicit = snapshotGitHubAppConfig(explicitEnv, {
      oauth: { clientId: 'provider-client', clientSecret: 'provider-secret' },
    });
    expect(explicit.clientId).toBe('provider-client');

    const legacyEnv = validEnv();
    delete legacyEnv[GITHUB_APP_ENV.oauthClientId];
    delete legacyEnv[GITHUB_APP_ENV.oauthClientSecret];
    legacyEnv[GITHUB_APP_ENV.legacyOauthClientId] = 'legacy-client';
    legacyEnv[GITHUB_APP_ENV.legacyOauthClientSecret] = 'legacy-secret';
    expect(snapshotGitHubAppConfig(legacyEnv).clientId).toBe('legacy-client');
  });

  it('loads a PEM path only through the supplied snapshot reader', () => {
    const pem = rsaPem();
    const env = validEnv();
    delete env[GITHUB_APP_ENV.privateKey];
    env[GITHUB_APP_ENV.privateKeyPath] = '/operator/github-app.pem';
    const reads: string[] = [];
    const config = snapshotGitHubAppConfig(env, {
      readFile: (path) => {
        reads.push(path);
        return pem;
      },
    });
    expect(reads).toEqual(['/operator/github-app.pem']);
    expect(config.privateKey.asymmetricKeyType).toBe('rsa');
  });

  it('requires exactly one PEM source without exposing secret values', () => {
    const env = validEnv();
    env[GITHUB_APP_ENV.privateKeyPath] = '/also-set.pem';
    expect(() => snapshotGitHubAppConfig(env)).toThrow(/exactly one/);

    delete env[GITHUB_APP_ENV.privateKey];
    delete env[GITHUB_APP_ENV.privateKeyPath];
    expect(() => snapshotGitHubAppConfig(env)).toThrow(/exactly one/);
  });

  it('refuses weak or malformed launch inputs', () => {
    const malformedId = validEnv();
    malformedId[GITHUB_APP_ENV.appId] = '001';
    expect(() => snapshotGitHubAppConfig(malformedId)).toThrow(/canonical/);

    const shortWebhook = validEnv();
    shortWebhook[GITHUB_APP_ENV.webhookSecret] = 'short';
    expect(() => snapshotGitHubAppConfig(shortWebhook)).toThrow(/at least 32 bytes/);

    const wrongAes = validEnv();
    wrongAes[GITHUB_APP_ENV.tokenEncryptionKey] = randomBytes(31).toString('base64url');
    expect(() => snapshotGitHubAppConfig(wrongAes)).toThrow(/exactly 32 bytes|canonical unpadded/);

    const http = validEnv();
    http[GITHUB_APP_ENV.apiUrl] = 'http://github.example.test/api';
    expect(() => snapshotGitHubAppConfig(http)).toThrow(/HTTPS/);
  });
});

describe('canonicalGitHubId', () => {
  it('canonicalizes safe numeric ids and preserves large string ids', () => {
    expect(canonicalGitHubId(42)).toBe('42');
    expect(canonicalGitHubId('9007199254740992')).toBe('9007199254740992');
  });

  it('rejects lossy, signed, zero, padded, and out-of-range ids', () => {
    for (const value of [Number.MAX_SAFE_INTEGER + 1, 0, -1, '0', '01', '+1', '9223372036854775808']) {
      expect(() => canonicalGitHubId(value)).toThrow();
    }
  });
});
