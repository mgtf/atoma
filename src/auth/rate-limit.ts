import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

export const VIZ_TRUSTED_PROXIES_ENV = 'ATOMA_VIZ_TRUSTED_PROXIES';

const MAX_FORWARDED_HOPS = 32;
const MAX_TRUSTED_PROXIES = 32;

export interface TrustedProxySnapshot {
  /** Exact socket IP literals. Hostnames and CIDRs are deliberately refused. */
  readonly addresses: readonly string[];
}

/** Resolve the proxy trust boundary once from the host environment. */
export function snapshotTrustedProxies(
  env: NodeJS.ProcessEnv = process.env
): TrustedProxySnapshot {
  const raw = env[VIZ_TRUSTED_PROXIES_ENV];
  if (raw === undefined || raw.trim() === '') {
    return Object.freeze({ addresses: Object.freeze([]) });
  }

  const entries = raw.split(',').map((entry) => entry.trim());
  if (
    entries.length > MAX_TRUSTED_PROXIES ||
    entries.some((entry) => entry.length === 0 || isIP(entry) === 0)
  ) {
    throw new Error(
      `${VIZ_TRUSTED_PROXIES_ENV} must contain at most ${MAX_TRUSTED_PROXIES} comma-separated IP literals`
    );
  }
  return Object.freeze({ addresses: Object.freeze([...new Set(entries)]) });
}

/**
 * Resolve the rate-limit key without trusting forwarding headers by default.
 *
 * Once the direct peer is explicitly trusted, walk X-Forwarded-For from right
 * to left and stop at the first untrusted hop. This remains safe when a proxy
 * appends to an attacker-supplied header instead of replacing it.
 */
export function loginClientAddress(
  req: IncomingMessage,
  trusted: TrustedProxySnapshot
): string {
  const remoteAddress = req.socket.remoteAddress ?? 'unknown';
  if (!trusted.addresses.includes(remoteAddress)) return remoteAddress;

  const header = req.headers['x-forwarded-for'];
  const joined = Array.isArray(header) ? header.join(',') : header;
  if (!joined) return remoteAddress;
  const chain = joined.split(',').map((entry) => entry.trim());
  if (
    chain.length === 0 ||
    chain.length > MAX_FORWARDED_HOPS ||
    chain.some((entry) => entry.length === 0 || isIP(entry) === 0)
  ) {
    return remoteAddress;
  }

  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const address = chain[index]!;
    if (!trusted.addresses.includes(address)) return address;
  }
  return chain[0] ?? remoteAddress;
}

export interface RateLimitDecision {
  accepted: boolean;
  retryAfterSeconds: number;
}

interface FixedWindowBucket {
  count: number;
  resetAt: number;
}

/** Fixed-window limiter whose internal Map can never exceed `maxBuckets`. */
export class BoundedFixedWindowRateLimiter {
  private readonly buckets = new Map<string, FixedWindowBucket>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    private readonly maxBuckets: number
  ) {
    if (
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts <= 0 ||
      !Number.isSafeInteger(windowMs) ||
      windowMs <= 0 ||
      !Number.isSafeInteger(maxBuckets) ||
      maxBuckets <= 0
    ) {
      throw new Error('invalid fixed-window rate limiter configuration');
    }
  }

  attempt(key: string, now = Date.now()): RateLimitDecision {
    const previous = this.buckets.get(key);
    if (previous && previous.resetAt > now) {
      previous.count = Math.min(previous.count + 1, this.maxAttempts + 1);
      return this.decision(previous, now);
    }
    if (previous) this.buckets.delete(key);

    let earliestReset = Number.POSITIVE_INFINITY;
    for (const [candidate, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(candidate);
      } else {
        earliestReset = Math.min(earliestReset, bucket.resetAt);
      }
    }

    if (this.buckets.size >= this.maxBuckets) {
      return {
        accepted: false,
        retryAfterSeconds: retryAfter(earliestReset, now),
      };
    }

    const bucket = { count: 1, resetAt: now + this.windowMs };
    this.buckets.set(key, bucket);
    return this.decision(bucket, now);
  }

  /** Read-only test/diagnostic surface proving the memory bound. */
  get activeBuckets(): number {
    return this.buckets.size;
  }

  private decision(bucket: FixedWindowBucket, now: number): RateLimitDecision {
    return {
      accepted: bucket.count <= this.maxAttempts,
      retryAfterSeconds: retryAfter(bucket.resetAt, now),
    };
  }
}

function retryAfter(resetAt: number, now: number): number {
  if (!Number.isFinite(resetAt)) return 1;
  return Math.max(1, Math.ceil((resetAt - now) / 1_000));
}
