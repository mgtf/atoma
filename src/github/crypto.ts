import { createSign, type KeyObject } from 'node:crypto';
import { canonicalGitHubId } from './config.js';
import type { EncryptedSecretEnvelope } from '../core/secretCrypto.js';
import {
  gcmDecryptWithKeyId,
  encryptBoundSecret,
  isValidSecretKeyId,
  parseEncryptedSecretEnvelope,
  SECRET_ENVELOPE_VERSION,
} from '../core/secretCrypto.js';

export const GITHUB_TOKEN_ENVELOPE_VERSION = SECRET_ENVELOPE_VERSION;
export const GITHUB_TOKEN_ALGORITHM = 'A256GCM' as const;
export type GitHubTokenKind = 'access' | 'refresh';

/** Historical name of the GitHub envelope: the shared secret shape + `kind`. */
export interface EncryptedGitHubToken extends EncryptedSecretEnvelope {
  readonly kind: GitHubTokenKind;
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

const GITHUB_ENVELOPE_MEMBERS = [
  'algorithm',
  'ciphertext',
  'iv',
  'keyId',
  'kind',
  'tag',
  'version',
] as const;

function isEnvelopeKind(value: unknown): value is GitHubTokenKind {
  return value === 'access' || value === 'refresh';
}

/**
 * The consumer-owned AAD sentence. It binds one envelope to one
 * (kind, principal) pair and is part of the authenticated data, so a token
 * stored for another principal or kind never decrypts here. The binding
 * values are checked before they become AAD bytes.
 */
function aad(kind: GitHubTokenKind, principalId: string, keyId: string): string {
  const hasControl = [...`${principalId}${keyId}`].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (!principalId || principalId.length > 255 || hasControl) {
    throw new Error('encryption key id has an invalid value');
  }
  return `atoma:github-token:v${GITHUB_TOKEN_ENVELOPE_VERSION}:${kind}:${principalId}:${safeKeyId(keyId)}`;
}

function safeKeyId(keyId: string): string {
  if (!isValidSecretKeyId(keyId)) {
    throw new Error('encryption key id has an invalid value');
  }
  return keyId;
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

export function encryptGitHubToken(input: EncryptGitHubTokenInput): EncryptedGitHubToken {
  assertToken(input.token);
  safeKeyId(input.keyId);
  const shared = encryptBoundSecret({
    plaintext: input.token,
    key: input.key,
    keyId: input.keyId,
    aad: aad(input.kind, input.principalId, input.keyId),
    random: input.random,
  });
  return Object.freeze({ ...shared, kind: input.kind });
}

export function decryptGitHubToken(input: DecryptGitHubTokenInput): string {
  // Strict re-parse against the FULL member set first, so a tampered `kind`
  // or a foreign shared-secret shape refuses before any cipher runs.
  const parsed = parseEncryptedGitHubToken(input.envelope);
  if (parsed.kind !== input.expectedKind || parsed.keyId !== input.keyId) {
    throw new Error('GitHub token envelope does not match the requested binding');
  }
  try {
    return gcmDecryptWithKeyId({
      envelope: parsed,
      key: input.key,
      keyId: input.keyId,
      aad: aad(input.expectedKind, input.principalId, input.keyId),
    });
  } catch {
    throw new Error('GitHub token envelope authentication failed');
  }
}

export function serializeEncryptedGitHubToken(envelope: EncryptedGitHubToken): string {
  return JSON.stringify(parseEncryptedGitHubToken(envelope));
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
  if (!isEnvelopeKind((candidate as Record<string, unknown>)['kind'])) {
    throw new Error('GitHub token envelope has an invalid shape');
  }
  // Unknown versions, extra/missing members and non-canonical base64url all
  // refuse inside the shared parser with the historical message.
  const parsed = parseEncryptedSecretEnvelope(candidate, GITHUB_ENVELOPE_MEMBERS);
  return Object.freeze(parsed as unknown as EncryptedGitHubToken);
}
