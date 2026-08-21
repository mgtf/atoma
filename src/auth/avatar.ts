/**
 * PROVIDER AVATARS — the bytes, not a link.
 *
 * A provider's userinfo response carries a picture URL (`avatar_url` on
 * GitHub, `picture` on OIDC). Two things follow from that being ATTACKER-
 * INFLUENCED data the SERVER dereferences:
 *
 * - SSRF is the real risk, not a theoretical one. `safeAvatarUrl` refuses
 *   anything but an https URL on a public DNS name: no http, no credentials,
 *   no IP literals (which is what closes 169.254.169.254 and every private
 *   range at once), no loopback, no redirects at fetch time.
 * - The declared content type is not evidence. The stored mime comes from
 *   SNIFFING the magic bytes, so a `content-type: image/png` wrapped around
 *   HTML is refused rather than stored and later served back.
 *
 * Everything here is FAIL-OPEN for the login flow: a missing, oversized,
 * unreachable or non-image avatar yields `null` and the login proceeds. The
 * account UI falls back to a procedural orb, which is a complete experience
 * on its own.
 *
 * Storing the bytes (rather than the URL) also keeps the browser from ever
 * talking to a provider CDN to render the app shell: the avatar is served
 * same-origin from `/auth/avatar/<principalId>`, so no viewer IP leaks to
 * GitHub or Google on page load and the PWA shell keeps working offline.
 */

/** Bounded so one login cannot pull an arbitrary blob into the store. */
export const AVATAR_MAX_BYTES = 256 * 1024;
/** Provider picture URLs are short; this only bounds abuse. */
export const AVATAR_MAX_URL_LENGTH = 2_048;
/** Same deadline discipline as the rest of the OAuth flow. */
export const AVATAR_FETCH_TIMEOUT_MS = 5_000;

export const AVATAR_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type AvatarMime = (typeof AVATAR_MIME_TYPES)[number];

export interface AvatarImage {
  readonly mime: AvatarMime;
  readonly bytes: Buffer;
}

/**
 * An absolute https URL on a public DNS hostname, or a throw.
 *
 * IP literals are refused wholesale rather than range-checked: hostnames that
 * are not names cover loopback, RFC 1918, link-local, the cloud metadata
 * address and their IPv6 equivalents in one rule, and no legitimate provider
 * serves avatars from a bare address.
 */
export function safeAvatarUrl(raw: string): URL {
  if (raw.length === 0 || raw.length > AVATAR_MAX_URL_LENGTH) {
    throw new Error('avatar URL length is out of bounds');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('avatar URL is not absolute');
  }
  if (url.protocol !== 'https:') throw new Error('avatar URL must use HTTPS');
  if (url.username || url.password) throw new Error('avatar URL must not carry credentials');
  const hostname = url.hostname.toLowerCase();
  if (hostname.startsWith('[')) throw new Error('avatar URL must not target an IP literal');
  if (/^[0-9.]+$/.test(hostname)) throw new Error('avatar URL must not target an IP literal');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) {
    throw new Error('avatar URL must target a public hostname');
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('avatar URL must target a public hostname');
  }
  return url;
}

/**
 * Normalize a provider picture claim. Unlike the subject and email helpers in
 * `oidc.ts` this NEVER throws: a broken picture claim must not fail a login
 * that is otherwise valid.
 */
export function avatarUrlFromClaim(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  try {
    return safeAvatarUrl(normalized).href;
  } catch {
    return null;
  }
}

/** The declared content type is ignored; these magic bytes are the authority. */
export function sniffImageMime(bytes: Buffer): AvatarMime | null {
  if (bytes.length < 12) return null;
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) return 'image/webp';
  const gif = bytes.subarray(0, 6).toString('latin1');
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  return null;
}

/**
 * Download one avatar. Returns `null` for every failure mode — unreachable
 * host, redirect, timeout, oversized body, non-image bytes — because the
 * caller is a login that must complete either way.
 */
export async function fetchAvatarImage(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
  options: { timeoutMs?: number } = {}
): Promise<AvatarImage | null> {
  let url: URL;
  try {
    url = safeAvatarUrl(rawUrl);
  } catch {
    return null;
  }
  const timeoutMs = options.timeoutMs ?? AVATAR_FETCH_TIMEOUT_MS;
  try {
    const res = await fetchImpl(url.href, {
      headers: { accept: AVATAR_MIME_TYPES.join(',') },
      // A redirect could aim the second request anywhere; the OAuth flow
      // refuses them for the same reason.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const bytes = await boundedBody(res);
    if (!bytes) return null;
    const mime = sniffImageMime(bytes);
    if (!mime) return null;
    return { mime, bytes };
  } catch {
    return null;
  }
}

/** Read at most AVATAR_MAX_BYTES, cancelling the stream past the bound. */
async function boundedBody(res: Response): Promise<Buffer | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > AVATAR_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return total === 0 ? null : Buffer.concat(chunks);
}
