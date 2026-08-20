import {
  createCipheriv,
  createDecipheriv,
  createSign,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { canonicalGitHubId } from './config.js';

export const GITHUB_TOKEN_ENVELOPE_VERSION = 1 as const;
export const GITHUB_TOKEN_ALGORITHM = 'A256GCM' as const;
export type GitHubTokenKind = 'access' | 'refresh';

export interface EncryptedGitHubToken {
  readonly version: typeof GITHUB_TOKEN_ENVELOPE_VERSION;
  readonly algorithm: typeof GITHUB_TOKEN_ALGORITHM;
  readonly keyId: string;
  readonly kind: GitHubTokenKind;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export interface GitHubAppJwtInput {
  readonly appId: string;
  readonly privateKey: KeyObject;
  /** Date, epoch milliseconds, or the current time when omitted. */
  readonly now?: Date | number;
}

export interface EncryptGitHubTokenInput {
  readonly token: string;
  readonly kind: GitHubTokenKind;
  readonly principalId: string;
  readonly key: KeyObject;
  readonly keyId: string;
  readonly random?: (size: number) => Buffer;
}

export interface DecryptGitHubTokenInput {
  readonly envelope: EncryptedGitHubToken;
  readonly expectedKind: GitHubTokenKind;
  readonly principalId: string;
  readonly key: KeyObject;
  readonly keyId: string;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function epochSeconds(now: Date | number | undefined): number {
  const milliseconds = now instanceof Date ? now.getTime() : now ?? Date.now();
  if (!Number.isFinite(milliseconds)) throw new Error('GitHub JWT time must be finite');
  return Math.floor(milliseconds / 1000);
}

/** Create the short-lived RS256 bearer GitHub requires for App endpoints. */
export function createGitHubAppJwt(input: GitHubAppJwtInput): string {
  const appId = canonicalGitHubId(input.appId, 'GitHub App id');
  if (input.privateKey.type !== 'private' || input.privateKey.asymmetricKeyType !== 'rsa') {
    throw new Error('GitHub App JWT requires an RSA private key');
  }
  const now = epochSeconds(input.now);
  const header = base64urlJson({ alg: 'RS256', typ: 'JWT' });
  // Backdate by one minute for small clock differences; GitHub permits at most ten minutes.
  const payload = base64urlJson({ iat: now - 60, exp: now + (9 * 60), iss: appId });
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput, 'ascii');
  signer.end();
  return `${signingInput}.${signer.sign(input.privateKey).toString('base64url')}`;
}

function assertSecretKey(key: KeyObject): void {
  if (key.type !== 'secret' || key.symmetricKeySize !== 32) {
    throw new Error('GitHub token encryption requires a 32-byte secret key');
  }
}

function safeBinding(value: string, label: string, max: number): string {
  const hasControl = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (!value || value.length > max || hasControl) {
    throw new Error(`${label} has an invalid value`);
  }
  return value;
}

function encryptionKeyId(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new Error('encryption key id has an invalid value');
  }
  return value;
}

function aad(kind: GitHubTokenKind, principalId: string, keyId: string): Buffer {
  return Buffer.from(
    `atoma:github-token:v${GITHUB_TOKEN_ENVELOPE_VERSION}:${kind}:${safeBinding(principalId, 'principal id', 255)}:${safeBinding(keyId, 'encryption key id', 64)}`,
    'utf8'
  );
}

function assertToken(token: string): void {
  const printableAscii = [...token].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 33 && code <= 126;
  });
  if (token.length < 1 || token.length > 16_384 || !printableAscii) {
    throw new Error('GitHub token has an invalid format');
  }
}

function isCanonicalBase64url(value: unknown, bytes?: number): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  if (bytes !== undefined && decoded.length !== bytes) return false;
  return decoded.toString('base64url') === value;
}

export function encryptGitHubToken(input: EncryptGitHubTokenInput): EncryptedGitHubToken {
  assertSecretKey(input.key);
  assertToken(input.token);
  const keyId = encryptionKeyId(input.keyId);
  const iv = (input.random ?? randomBytes)(12);
  if (!Buffer.isBuffer(iv) || iv.length !== 12) {
    throw new Error('GitHub token nonce source must return exactly 12 bytes');
  }
  const cipher = createCipheriv('aes-256-gcm', input.key, iv, { authTagLength: 16 });
  cipher.setAAD(aad(input.kind, input.principalId, keyId));
  const ciphertext = Buffer.concat([
    cipher.update(input.token, 'utf8'),
    cipher.final(),
  ]);
  return Object.freeze({
    version: GITHUB_TOKEN_ENVELOPE_VERSION,
    algorithm: GITHUB_TOKEN_ALGORITHM,
    keyId,
    kind: input.kind,
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  });
}

export function decryptGitHubToken(input: DecryptGitHubTokenInput): string {
  assertSecretKey(input.key);
  const envelope = parseEncryptedGitHubToken(input.envelope);
  const keyId = encryptionKeyId(input.keyId);
  if (envelope.kind !== input.expectedKind || envelope.keyId !== keyId) {
    throw new Error('GitHub token envelope does not match the requested binding');
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      input.key,
      Buffer.from(envelope.iv, 'base64url'),
      { authTagLength: 16 }
    );
    decipher.setAAD(aad(input.expectedKind, input.principalId, keyId));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    assertToken(plaintext);
    return plaintext;
  } catch {
    throw new Error('GitHub token envelope authentication failed');
  }
}

export function serializeEncryptedGitHubToken(envelope: EncryptedGitHubToken): string {
  const parsed = parseEncryptedGitHubToken(envelope);
  return JSON.stringify(parsed);
}

/** Strictly parse storage data; unknown versions and non-canonical encodings fail closed. */
export function parseEncryptedGitHubToken(value: unknown): EncryptedGitHubToken {
  let candidate: unknown = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      throw new Error('GitHub token envelope is not valid JSON');
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('GitHub token envelope has an invalid shape');
  }
  const record = candidate as Record<string, unknown>;
  const expectedKeys = ['algorithm', 'ciphertext', 'iv', 'keyId', 'kind', 'tag', 'version'];
  if (
    Object.keys(record).sort().join(',') !== expectedKeys.join(',') ||
    record['version'] !== GITHUB_TOKEN_ENVELOPE_VERSION ||
    record['algorithm'] !== GITHUB_TOKEN_ALGORITHM ||
    (record['kind'] !== 'access' && record['kind'] !== 'refresh') ||
    typeof record['keyId'] !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(record['keyId']) ||
    !isCanonicalBase64url(record['iv'], 12) ||
    !isCanonicalBase64url(record['tag'], 16) ||
    !isCanonicalBase64url(record['ciphertext'])
  ) {
    throw new Error('GitHub token envelope has an invalid shape');
  }
  return Object.freeze({
    version: GITHUB_TOKEN_ENVELOPE_VERSION,
    algorithm: GITHUB_TOKEN_ALGORITHM,
    keyId: record['keyId'],
    kind: record['kind'],
    iv: record['iv'],
    ciphertext: record['ciphertext'],
    tag: record['tag'],
  });
}
