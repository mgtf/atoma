import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  encryptWebPushPayload,
  fromBase64Url,
  generateVapidKeys,
  MAX_PUSH_PLAINTEXT_BYTES,
  sendWebPush,
  toBase64Url,
  vapidAuthorization,
} from '../src/viz/push/webpush.js';

/** RFC 8291 Appendix A — the complete known-answer vector. */
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('web push payload encryption (RFC 8291)', () => {
  it('reproduces the Appendix A known-answer vector byte for byte', () => {
    const body = encryptWebPushPayload(
      { p256dh: RFC8291.uaPublic, auth: RFC8291.auth },
      Buffer.from(RFC8291.plaintext, 'utf8'),
      {
        ephemeralPrivateKey: fromBase64Url(RFC8291.asPrivate),
        salt: fromBase64Url(RFC8291.salt),
      }
    );
    expect(toBase64Url(body)).toBe(RFC8291.body);
    // Header sanity: salt | rs=4096 | idlen=65 | as_public.
    expect(body.readUInt32BE(16)).toBe(4_096);
    expect(body.readUInt8(20)).toBe(65);
    expect(toBase64Url(body.subarray(21, 86))).toBe(RFC8291.asPublic);
  });

  it('refuses malformed subscription key material and oversized payloads', () => {
    const ok = { p256dh: RFC8291.uaPublic, auth: RFC8291.auth };
    expect(() =>
      encryptWebPushPayload({ ...ok, p256dh: toBase64Url(Buffer.alloc(64)) }, Buffer.from('x'))
    ).toThrow(/65-byte/);
    expect(() =>
      encryptWebPushPayload({ ...ok, auth: toBase64Url(Buffer.alloc(15)) }, Buffer.from('x'))
    ).toThrow(/16 bytes/);
    expect(() =>
      encryptWebPushPayload({ ...ok, auth: 'not base64url!!!' }, Buffer.from('x'))
    ).toThrow(/base64url/);
    expect(() =>
      encryptWebPushPayload(ok, Buffer.alloc(MAX_PUSH_PLAINTEXT_BYTES + 1))
    ).toThrow(/bounded/);
  });
});

describe('VAPID authorization (RFC 8292)', () => {
  it('emits a verifiable ES256 JWT scoped to the push service origin', () => {
    const keys = generateVapidKeys();
    const nowMs = 1_755_700_000_000;
    const header = vapidAuthorization({
      endpoint: 'https://push.example.net/send/abc123',
      keys,
      subject: 'https://viz.example',
      nowMs,
    });
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    expect(match![2]).toBe(keys.publicKey);
    const [head, claims, signature] = match![1]!.split('.');
    expect(JSON.parse(fromBase64Url(head!).toString('utf8'))).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    });
    const parsedClaims = JSON.parse(fromBase64Url(claims!).toString('utf8')) as {
      aud: string;
      exp: number;
      sub: string;
    };
    expect(parsedClaims.aud).toBe('https://push.example.net');
    expect(parsedClaims.sub).toBe('https://viz.example');
    expect(parsedClaims.exp).toBe(Math.floor(nowMs / 1_000) + 12 * 60 * 60);
    const point = fromBase64Url(keys.publicKey);
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: toBase64Url(point.subarray(1, 33)),
        y: toBase64Url(point.subarray(33, 65)),
      },
      format: 'jwk',
    });
    const verified = verify(
      'sha256',
      Buffer.from(`${head}.${claims}`, 'utf8'),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      fromBase64Url(signature!)
    );
    expect(verified).toBe(true);
  });
});

describe('sendWebPush', () => {
  const subscription = { p256dh: RFC8291.uaPublic, auth: RFC8291.auth };

  it('POSTs an aes128gcm body with TTL and VAPID authorization', async () => {
    const vapid = generateVapidKeys();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const result = await sendWebPush({
      endpoint: 'https://push.example.net/send/abc123',
      keys: subscription,
      payload: Buffer.from('{"title":"Atoma"}', 'utf8'),
      vapid,
      subject: 'mailto:ops@example.com',
      fetchImpl: fetchImpl,
    });
    expect(result).toEqual({ ok: true, status: 201, gone: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://push.example.net/send/abc123');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-encoding']).toBe('aes128gcm');
    expect(headers['content-type']).toBe('application/octet-stream');
    expect(headers['ttl']).toBe(String(24 * 60 * 60));
    expect(headers['authorization']).toMatch(/^vapid t=.+, k=.+$/);
    // header(21) + key(65) + ciphertext(plaintext 17 + delimiter 1 + tag 16).
    expect((init.body as Buffer).length).toBe(21 + 65 + 17 + 1 + 16);
  });

  it('reports 404/410 as gone so the caller prunes the subscription', async () => {
    const vapid = generateVapidKeys();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 410 }));
    const result = await sendWebPush({
      endpoint: 'https://push.example.net/send/dead',
      keys: subscription,
      payload: Buffer.from('x'),
      vapid,
      subject: 'mailto:ops@example.com',
      fetchImpl: fetchImpl,
    });
    expect(result.gone).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('refuses plaintext HTTP endpoints outright', async () => {
    await expect(
      sendWebPush({
        endpoint: 'http://push.example.net/send/abc',
        keys: subscription,
        payload: Buffer.from('x'),
        vapid: generateVapidKeys(),
        subject: 'mailto:ops@example.com',
        fetchImpl: vi.fn(),
      })
    ).rejects.toThrow(/HTTPS/);
  });
});
