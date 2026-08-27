import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

/**
 * SHARED SECRET-AT-REST CIPHER MECHANICS.
 * =======================================
 *
 * ONE implementation of AES-256-GCM envelope encryption for credentials the
 * platform stores on behalf of somebody else — currently GitHub installation
 * tokens (`src/github/crypto.ts`) and organisation provider keys
 * (`src/auth/store.ts`). Extracted so the second consumer did not hand-roll
 * a second copy of the IV/tag/canonical-base64url plumbing, which is where
 * drift would hide.
 *
 * OWNERSHIP SPLIT, stated because it matters: this module owns the ENVELOPE
 * and the cipher round-trip. Each consumer owns its ADDITIONAL
 * AUTHENTICATED DATA sentence (the `aad` string) and passes the SAME builder
 * to both directions — the AAD binds an envelope to its subject so a token
 * minted for one principal/org can never be decrypted as another's.
 *
 * An envelope authenticates under exactly one (key, keyId, aad) triple;
 * anything else fails closed with a single generic message. Plaintext rules
 * (printable ASCII, length ceilings) stay with the consumers — they are
 * facts about the credential kinds, not about the cipher.
 */

export const SECRET_ENVELOPE_VERSION = 1 as const;
export const SECRET_ENVELOPE_ALGORITHM = 'A256GCM' as const;

/** Versioned storage shape. Consumers may wrap it with their own fields. */
export interface EncryptedSecretEnvelope {
  readonly version: typeof SECRET_ENVELOPE_VERSION;
  readonly algorithm: typeof SECRET_ENVELOPE_ALGORITHM;
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export function isValidSecretKeyId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

/** 32 bytes, any source. Derive from operator env input via `secretEncryptionKeyFromText`. */
export function assertAes256SecretKey(key: KeyObject): void {
  if (key.type !== 'secret' || key.symmetricKeySize !== 32) {
    throw new Error('secret encryption requires a 32-byte secret key');
  }
}

function canonicalBase64url(value: unknown, bytes?: number): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  if (bytes !== undefined && decoded.length !== bytes) return false;
  return decoded.toString('base64url') === value;
}

/**
 * Strictly parse stored envelope data against the consumer's full key set.
 * Unknown versions, missing or EXTRA members, and non-canonical encodings
 * all refuse — storage bytes are written by exactly one writer shape.
 */
export function parseEncryptedSecretEnvelope(
  value: unknown,
  members: readonly string[]
): EncryptedSecretEnvelope {
  let candidate: unknown = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      throw new Error('encrypted secret envelope is not valid JSON');
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('encrypted secret envelope has an invalid shape');
  }
  const record = candidate as Record<string, unknown>;
  if (record['version'] !== SECRET_ENVELOPE_VERSION) {
    throw new Error('encrypted secret envelope has an unsupported version');
  }
  if (
    Object.keys(record).sort().join(',') !== [...members].sort().join(',') ||
    record['algorithm'] !== SECRET_ENVELOPE_ALGORITHM ||
    typeof record['keyId'] !== 'string' ||
    !isValidSecretKeyId(record['keyId']) ||
    !canonicalBase64url(record['iv'], 12) ||
    !canonicalBase64url(record['tag'], 16) ||
    !canonicalBase64url(record['ciphertext'])
  ) {
    throw new Error('encrypted secret envelope has an invalid shape');
  }
  // Reconstructed from the CONSUMER'S member list, not a fixed one, so
  // consumer fields (GitHub's `kind`) survive storage round-trips instead
  // of being silently dropped by this function.
  const out: Record<string, unknown> = {};
  for (const member of members) out[member] = record[member];
  return Object.freeze(out) as unknown as EncryptedSecretEnvelope;
}

export function encryptBoundSecret(input: {
  readonly plaintext: string;
  readonly key: KeyObject;
  readonly keyId: string;
  /** Consumer-owned AAD; the identical value must bind the decryption. */
  readonly aad: string;
  readonly random?: (size: number) => Buffer;
}): EncryptedSecretEnvelope {
  assertAes256SecretKey(input.key);
  if (!isValidSecretKeyId(input.keyId)) {
    throw new Error('encryption key id has an invalid value');
  }
  const ivSource = input.random ?? randomBytes;
  const iv = ivSource(12);
  if (!Buffer.isBuffer(iv) || iv.length !== 12) {
    throw new Error('nonce source must return exactly 12 bytes');
  }
  const cipher = createCipheriv('aes-256-gcm', input.key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(input.aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]);
  return Object.freeze({
    version: SECRET_ENVELOPE_VERSION,
    algorithm: SECRET_ENVELOPE_ALGORITHM,
    keyId: input.keyId,
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  });
}

export function decryptBoundSecret(input: {
  readonly envelope: unknown;
  readonly key: KeyObject;
  readonly keyId: string;
  readonly aad: string;
}): string {
  // Strict STORAGE-boundary parse: raw bytes (or unknown shapes) are
  // validated against the exact shared member set before any cipher runs.
  const envelope = parseEncryptedSecretEnvelope(
    input.envelope,
    ['algorithm', 'ciphertext', 'iv', 'keyId', 'tag', 'version']
  );
  return gcmDecryptWithKeyId({ ...input, envelope });
}

/**
 * Cipher-only half over an ALREADY-VALIDATED envelope. Consumers whose
 * envelopes carry extra validated members (GitHub's `kind`) route through
 * here after their own strict parse, so validation and membership stay
 * one-pass while the mechanics remain single-sourced.
 */
export function gcmDecryptWithKeyId(input: {
  readonly envelope: EncryptedSecretEnvelope;
  readonly key: KeyObject;
  readonly keyId: string;
  readonly aad: string;
}): string {
  assertAes256SecretKey(input.key);
  // The stored envelope's own keyId is authoritative: a caller asking under
  // a DIFFERENT generation is a binding mismatch, not a decryption.
  if (input.envelope.keyId !== input.keyId) {
    throw new Error('encrypted secret envelope does not match the requested binding');
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      input.key,
      Buffer.from(input.envelope.iv, 'base64url'),
      { authTagLength: 16 }
    );
    decipher.setAAD(Buffer.from(input.aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(input.envelope.tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(input.envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('encrypted secret envelope authentication failed');
  }
}

/**
 * Accept the operator's key spellings. STRICT form: 64 hex digits, or
 * `base64url:` + 43 canonical chars — the exact contract the GitHub App
 * token-encryption variable has always had, preserved bit for bit.
 * The error wording is delegated so each env var can name itself.
 */
export function parseEncryptionKeyBytes(
  raw: string,
  fail: (message: string) => Error = (message) => new Error(message)
): Buffer {
  let bytes: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    bytes = Buffer.from(raw, 'hex');
  } else {
    const payload = raw.startsWith('base64url:') ? raw.slice('base64url:'.length) : raw;
    if (!/^[A-Za-z0-9_-]{43}$/.test(payload)) {
      throw fail('must be 32 bytes encoded as 64 hex characters or canonical unpadded base64url');
    }
    bytes = Buffer.from(payload, 'base64url');
  }
  if (bytes.length !== 32) {
    throw fail('must decode to exactly 32 bytes');
  }
  return bytes;
}

/**
 * Accept the operator's `ATOMA_SECRET_ENCRYPTION_KEY` spellings: the strict
 * GitHub form above, plus a PASSPHRASE form — any text of at least 32
 * printable ASCII characters is hashed to 32 bytes, because demanding a
 * random 32-byte string of a small deployment just produces a weak one.
 */
export function secretEncryptionKeyFromText(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const payload = raw.startsWith('base64url:') ? raw.slice('base64url:'.length) : raw;
  if (/^[A-Za-z0-9_-]{43}$/.test(payload)) return Buffer.from(payload, 'base64url');
  const printableAscii =
    Buffer.byteLength(raw, 'utf8') >= 32 &&
    [...raw].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      // Printables include the space; only control characters refuse, so a
      // normal passphrase of any shape works.
      return code >= 32 && code !== 127;
    });
  if (!printableAscii) {
    throw new Error(
      'the secret encryption key must be 32 bytes: 64 hex digits, base64url:<43 chars>, or at least 32 printable characters'
    );
  }
  return createHash('sha256').update(raw, 'utf8').digest();
}
