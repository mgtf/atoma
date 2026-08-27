import {
  createPublicKey,
  createSecretKey,
  generateKeyPairSync,
  verify,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createGitHubAppJwt,
  decryptGitHubToken,
  encryptGitHubToken,
  parseEncryptedGitHubToken,
  serializeEncryptedGitHubToken,
} from '../src/github/crypto.js';

describe('GitHub App JWT', () => {
  it('signs a short-lived, backdated RS256 App JWT', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const now = Date.UTC(2026, 7, 20, 12, 0, 0);
    const jwt = createGitHubAppJwt({ appId: '123456', privateKey, now });
    const [headerPart, payloadPart, signaturePart] = jwt.split('.');
    expect(JSON.parse(Buffer.from(headerPart!, 'base64url').toString('utf8'))).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(payloadPart!, 'base64url').toString('utf8'))).toEqual({
      iat: (now / 1000) - 60,
      exp: (now / 1000) + 540,
      iss: '123456',
    });
    expect(verify(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`, 'ascii'),
      createPublicKey(privateKey),
      Buffer.from(signaturePart!, 'base64url')
    )).toBe(true);
  });
});

describe('encrypted GitHub user tokens', () => {
  const key = createSecretKey(Buffer.alloc(32, 7));
  const keyId = 'key-2026-08';
  const principalId = 'dd4c210b-b14e-4612-875f-431aa67daa88';

  it('round-trips a versioned A256GCM envelope without serializing plaintext', () => {
    const envelope = encryptGitHubToken({
      token: 'ghu_secret-access-token',
      kind: 'access',
      principalId,
      key,
      keyId,
      random: () => Buffer.alloc(12, 3),
    });
    const serialized = serializeEncryptedGitHubToken(envelope);
    expect(envelope).toMatchObject({ version: 1, algorithm: 'A256GCM', kind: 'access', keyId });
    expect(serialized).not.toContain('secret-access-token');
    expect(decryptGitHubToken({
      envelope: parseEncryptedGitHubToken(serialized),
      expectedKind: 'access',
      principalId,
      key,
      keyId,
    })).toBe('ghu_secret-access-token');
  });

  it('binds ciphertext to principal, token kind, and key id', () => {
    const envelope = encryptGitHubToken({
      token: 'ghr_refresh-token',
      kind: 'refresh',
      principalId,
      key,
      keyId,
    });
    expect(() => decryptGitHubToken({
      envelope,
      expectedKind: 'access',
      principalId,
      key,
      keyId,
    })).toThrow(/binding/);
    expect(() => decryptGitHubToken({
      envelope,
      expectedKind: 'refresh',
      principalId: 'e6afbd2f-b7d2-4288-9efe-21cbade17fc4',
      key,
      keyId,
    })).toThrow(/authentication failed/);
    expect(() => decryptGitHubToken({
      envelope,
      expectedKind: 'refresh',
      principalId,
      key,
      keyId: 'other-key',
    })).toThrow(/binding/);
  });

  it('detects ciphertext/tag tampering and unknown envelope shapes', () => {
    const envelope = encryptGitHubToken({
      token: 'ghu_access',
      kind: 'access',
      principalId,
      key,
      keyId,
    });
    const tampered = {
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith('A') ? 'B' : 'A'}`,
    };
    expect(() => decryptGitHubToken({
      envelope: tampered,
      expectedKind: 'access',
      principalId,
      key,
      keyId,
    })).toThrow(/authentication failed|invalid shape/);
    expect(() => parseEncryptedGitHubToken({ ...envelope, version: 2 })).toThrow(
      /invalid shape|unsupported version/
    );
    expect(() => parseEncryptedGitHubToken({ ...envelope, extra: true })).toThrow(/invalid shape/);
  });
});
