import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';

/**
 * WEB PUSH PROTOCOL (RFC 8291 payload encryption + RFC 8292 VAPID).
 * =================================================================
 *
 * This is the ONE implementation, on `node:crypto` alone — the repository
 * deliberately carries no HTTP or crypto dependency, and the whole protocol
 * is P-256 ECDH + HKDF + AES-128-GCM + one ES256 JWT. Correctness is pinned
 * by the RFC 8291 Appendix A known-answer test (tests/webpush.test.ts), which
 * is why `encryptWebPushPayload` accepts injectable ephemeral key material:
 * production callers never pass it, the test must.
 *
 * Push payloads travel through a third-party push service (FCM, Mozilla,
 * APNs web push). Encryption keeps the service blind, but callers still keep
 * payloads boring: a title, a bounded excerpt, a same-origin path. No
 * credentials, no trace prose.
 */

/** One aes128gcm record: 16-byte tag + 1 delimiter byte inside rs=4096. */
const RECORD_SIZE = 4_096;
/** Conservative plaintext bound: push services reject ~4 KB bodies anyway. */
export const MAX_PUSH_PLAINTEXT_BYTES = 3_000;

const P256_UNCOMPRESSED_POINT_BYTES = 65;
const AUTH_SECRET_BYTES = 16;
const VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/** Base64url with no padding — the wire spelling of every Web Push key. */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('expected unpadded base64url');
  }
  return Buffer.from(value, 'base64url');
}

/** VAPID keypair, both halves base64url: 65-byte point, 32-byte scalar. */
export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
}

/** Browser subscription keys as `PushSubscription.toJSON().keys` spells them. */
export interface WebPushSubscriptionKeys {
  readonly p256dh: string;
  readonly auth: string;
}

function leftPadTo32(scalar: Buffer): Buffer {
  if (scalar.length > 32) throw new Error('P-256 private scalar exceeds 32 bytes');
  if (scalar.length === 32) return scalar;
  return Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]);
}

function decodeUncompressedPoint(value: string, label: string): Buffer {
  const point = fromBase64Url(value);
  if (point.length !== P256_UNCOMPRESSED_POINT_BYTES || point[0] !== 0x04) {
    throw new Error(`${label} must be a 65-byte uncompressed P-256 point`);
  }
  return point;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: toBase64Url(ecdh.getPublicKey()),
    privateKey: toBase64Url(leftPadTo32(ecdh.getPrivateKey())),
  };
}

function vapidSigningKey(keys: VapidKeys) {
  const point = decodeUncompressedPoint(keys.publicKey, 'VAPID public key');
  const scalar = leftPadTo32(fromBase64Url(keys.privateKey));
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64Url(point.subarray(1, 33)),
      y: toBase64Url(point.subarray(33, 65)),
      d: toBase64Url(scalar),
    },
    format: 'jwk',
  });
}

/**
 * `Authorization: vapid t=<ES256 JWT>, k=<public key>` for one endpoint.
 * The audience is the push service ORIGIN, never the full endpoint path.
 */
export function vapidAuthorization(input: {
  readonly endpoint: string;
  readonly keys: VapidKeys;
  readonly subject: string;
  readonly nowMs?: number;
}): string {
  const audience = new URL(input.endpoint).origin;
  const encode = (value: object) => toBase64Url(Buffer.from(JSON.stringify(value), 'utf8'));
  const expiresAt = Math.floor((input.nowMs ?? Date.now()) / 1_000) + VAPID_TOKEN_TTL_SECONDS;
  const signingInput = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({
    aud: audience,
    exp: expiresAt,
    sub: input.subject,
  })}`;
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: vapidSigningKey(input.keys),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${signingInput}.${toBase64Url(signature)}, k=${input.keys.publicKey}`;
}

/**
 * RFC 8291 aes128gcm body: `salt(16) | rs(4) | idlen(1) | as_public(65)`
 * followed by one sealed record (`plaintext | 0x02`, AES-128-GCM).
 * `testOverrides` exists ONLY for the Appendix A known-answer test.
 */
export function encryptWebPushPayload(
  subscription: WebPushSubscriptionKeys,
  plaintext: Uint8Array,
  testOverrides?: {
    readonly ephemeralPrivateKey?: Uint8Array;
    readonly salt?: Uint8Array;
  }
): Buffer {
  if (plaintext.byteLength > MAX_PUSH_PLAINTEXT_BYTES) {
    throw new Error(`push payloads are bounded to ${MAX_PUSH_PLAINTEXT_BYTES} bytes`);
  }
  const uaPublic = decodeUncompressedPoint(subscription.p256dh, 'subscription p256dh');
  const authSecret = fromBase64Url(subscription.auth);
  if (authSecret.length !== AUTH_SECRET_BYTES) {
    throw new Error('subscription auth secret must be 16 bytes');
  }
  const ecdh = createECDH('prime256v1');
  if (testOverrides?.ephemeralPrivateKey) {
    ecdh.setPrivateKey(Buffer.from(testOverrides.ephemeralPrivateKey));
  } else {
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const salt = testOverrides?.salt ? Buffer.from(testOverrides.salt) : randomBytes(16);
  if (salt.length !== 16) throw new Error('aes128gcm salt must be 16 bytes');
  const contentKey = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16)
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12)
  );
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  // 0x02 marks the LAST (and only) record of the stream.
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(P256_UNCOMPRESSED_POINT_BYTES, 20);
  return Buffer.concat([header, asPublic, sealed]);
}

export interface WebPushSendResult {
  readonly ok: boolean;
  readonly status: number;
  /** 404/410 — the browser dropped the subscription; the row must be pruned. */
  readonly gone: boolean;
}

/** POST one encrypted notification to a subscription's push service. */
export async function sendWebPush(input: {
  readonly endpoint: string;
  readonly keys: WebPushSubscriptionKeys;
  readonly payload: Uint8Array;
  readonly vapid: VapidKeys;
  readonly subject: string;
  readonly ttlSeconds?: number;
  readonly urgency?: 'very-low' | 'low' | 'normal' | 'high';
  readonly fetchImpl?: typeof fetch;
}): Promise<WebPushSendResult> {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== 'https:') {
    throw new Error('push endpoints must be HTTPS');
  }
  // Copy into a plain Uint8Array: fetch's BodyInit wants an ArrayBuffer-backed
  // view, which Buffer's ArrayBufferLike typing no longer satisfies.
  const body = new Uint8Array(encryptWebPushPayload(input.keys, input.payload));
  const doFetch = input.fetchImpl ?? fetch;
  const response = await doFetch(endpoint.href, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'content-encoding': 'aes128gcm',
      ttl: String(input.ttlSeconds ?? 24 * 60 * 60),
      urgency: input.urgency ?? 'normal',
      authorization: vapidAuthorization({
        endpoint: endpoint.href,
        keys: input.vapid,
        subject: input.subject,
      }),
    },
    body,
  });
  // Push services answer with tiny bodies; drain so the connection is reusable.
  await response.arrayBuffer().catch(() => undefined);
  return {
    ok: response.ok,
    status: response.status,
    gone: response.status === 404 || response.status === 410,
  };
}
