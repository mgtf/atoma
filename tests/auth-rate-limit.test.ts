import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  BoundedFixedWindowRateLimiter,
  loginClientAddress,
  snapshotTrustedProxies,
} from '../src/auth/rate-limit.js';

function request(remoteAddress: string, forwardedFor?: string): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  } as unknown as IncomingMessage;
}

describe('authentication request rate boundary', () => {
  it('ignores X-Forwarded-For unless the direct peer is explicitly trusted', () => {
    const req = request('10.0.0.5', '198.51.100.7');
    expect(loginClientAddress(req, snapshotTrustedProxies({}))).toBe('10.0.0.5');
    expect(
      loginClientAddress(
        req,
        snapshotTrustedProxies({ ATOMA_VIZ_TRUSTED_PROXIES: '10.0.0.6' })
      )
    ).toBe('10.0.0.5');
  });

  it('walks a configured proxy chain from right to left', () => {
    const trusted = snapshotTrustedProxies({
      ATOMA_VIZ_TRUSTED_PROXIES: '10.0.0.5,10.0.0.6',
    });
    expect(
      loginClientAddress(
        request('10.0.0.5', '198.51.100.99, 203.0.113.8, 10.0.0.6'),
        trusted
      )
    ).toBe('203.0.113.8');
    expect(loginClientAddress(request('10.0.0.5', 'not-an-ip'), trusted))
      .toBe('10.0.0.5');
  });

  it('snapshots only a bounded exact-IP allowlist', () => {
    const env = { ATOMA_VIZ_TRUSTED_PROXIES: '127.0.0.1,::1,127.0.0.1' };
    const snapshot = snapshotTrustedProxies(env);
    env.ATOMA_VIZ_TRUSTED_PROXIES = '203.0.113.1';
    expect(snapshot.addresses).toEqual(['127.0.0.1', '::1']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.addresses)).toBe(true);

    for (const value of ['proxy.internal', '10.0.0.0/8', '127.0.0.1,']) {
      expect(() =>
        snapshotTrustedProxies({ ATOMA_VIZ_TRUSTED_PROXIES: value })
      ).toThrow(/IP literals/);
    }
  });

  it('never exceeds its bucket cap and admits new keys after expiry', () => {
    const limiter = new BoundedFixedWindowRateLimiter(2, 1_000, 2);
    expect(limiter.attempt('a', 0).accepted).toBe(true);
    expect(limiter.attempt('a', 0).accepted).toBe(true);
    expect(limiter.attempt('a', 0)).toEqual({
      accepted: false,
      retryAfterSeconds: 1,
    });
    expect(limiter.attempt('b', 0).accepted).toBe(true);
    expect(limiter.activeBuckets).toBe(2);
    expect(limiter.attempt('c', 0).accepted).toBe(false);
    expect(limiter.activeBuckets).toBe(2);

    expect(limiter.attempt('c', 1_001).accepted).toBe(true);
    expect(limiter.activeBuckets).toBe(1);
  });
});
