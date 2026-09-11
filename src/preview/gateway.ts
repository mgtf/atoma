import { createHash } from 'node:crypto';
import { PREVIEW_BROWSER_SANDBOX } from '../contracts/preview.js';

/**
 * THE GATEWAY'S POLICY — what a preview origin is, and what it may say.
 *
 * Everything here is a pure function over identity and configuration, so the
 * rules can be asserted without a socket. The server that applies them is a
 * transport; these are the decisions.
 *
 * THE ORIGIN IS THE ASSET. A preview serves model-authored code to a member's
 * browser, so it gets its own host namespace (no host-only Atoma cookie ever reaches
 * it) and its own host PER GENERATION. A restart mints a new generation and
 * therefore a new origin, which is what makes stale service workers, storage
 * and caches from a previous generation unable to control the next — a
 * property no amount of cache-busting on one origin can provide.
 */

/** Reserved for the gateway's own endpoints; never proxied to the app. */
export const PREVIEW_RESERVED_PREFIX = '/.atoma/';
export const PREVIEW_GRANT_COOKIE = '__Host-AtomaPreview';

/**
 * The DNS label for one generation.
 *
 * Derived, not stored: the gateway must be able to route a request to the
 * right preview from the Host header alone, before it has consulted anything.
 * Its inputs are UUIDs, so the label is not enumerable by anyone who does not
 * already know the run — and knowing it still gets nobody past the grant.
 */
export function previewGenerationHost(
  orgId: string,
  projectRunId: string,
  generation: number
): string {
  const digest = createHash('sha256')
    .update(`${orgId}:${projectRunId}:${generation}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  // A leading letter keeps it a valid DNS label whatever the digest starts
  // with, and `p` reads as "preview" in a log nobody has context for.
  return `p${digest}`;
}

/**
 * Where a browser reaches one generation.
 *
 * The scheme and the port come from the resolved configuration rather than
 * being written here, because the loopback development profile serves plain
 * HTTP on the gateway's own port while production is HTTPS on 443 behind a
 * proxy. `snapshotPreviewConfig` is the ONE place that decides which, under
 * four conditions it refuses to boot without; this function only spends the
 * answer.
 */
export interface PreviewPublicBase {
  readonly domain: string;
  readonly scheme: 'https' | 'http';
  /** Null when it is the default for the scheme, which is production's case. */
  readonly port: number | null;
}

export function previewOrigin(
  base: PreviewPublicBase,
  orgId: string,
  projectRunId: string,
  generation: number
): string {
  const host = `${previewGenerationHost(orgId, projectRunId, generation)}.${base.domain}`;
  return `${base.scheme}://${host}${base.port === null ? '' : `:${base.port}`}`;
}

/** Is this the gateway's own namespace rather than the application's? */
export function isReservedPreviewPath(pathname: string): boolean {
  return pathname === PREVIEW_RESERVED_PREFIX.slice(0, -1) || pathname.startsWith(PREVIEW_RESERVED_PREFIX);
}

/**
 * Headers the gateway REMOVES before handing a request to the application.
 *
 * The grant cookie is ours and means nothing to the app; the client's address
 * and the forwarding chain are the member's; the referrer would tell generated
 * code which visualizer origin sent it. None of them are the application's
 * business, and all of them are things a hostile deliverable would like.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  'cookie',
  'referer',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'forwarded',
]);

export function sanitizeRequestHeaders(
  headers: NodeJS.Dict<string | string[]>
): NodeJS.Dict<string | string[]> {
  const out: NodeJS.Dict<string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Headers the gateway REPLACES on the way back, whatever the app said.
 *
 * An application that could set its own `Content-Security-Policy`,
 * `X-Frame-Options` or `Set-Cookie` could weaken the boundary it is contained
 * by — so those are dropped here and re-imposed by `previewResponseHeaders`.
 * This is the difference between a policy and a suggestion.
 */
const REPLACED_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'set-cookie',
  'permissions-policy',
  'referrer-policy',
  'cross-origin-resource-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'strict-transport-security',
  'cache-control',
]);

export function sanitizeResponseHeaders(
  headers: NodeJS.Dict<string | string[]>
): NodeJS.Dict<string | string[]> {
  const out: NodeJS.Dict<string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (REPLACED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

export interface PreviewResponsePolicyInput {
  /** The exact visualizer origin allowed to frame this preview. */
  readonly visualizerOrigin: string;
  /** Effective approved HTTPS hosts: requested by the run AND approved. */
  readonly allowedHosts: readonly string[];
}

/**
 * The headers every preview response carries.
 *
 * The CSP host allowlist is a BROWSER RESOURCE POLICY, not a remote-browser
 * boundary: generated JavaScript runs on the member's own machine, so an
 * approved but hostile domain could still observe what the member types into
 * the preview. The chrome says so permanently; this function cannot fix it,
 * and pretending otherwise would be the dangerous part.
 */
export function previewResponseHeaders(
  input: PreviewResponsePolicyInput
): Record<string, string> {
  const hosts = input.allowedHosts.map((host) => `https://${host}`);
  const self = ["'self'", ...hosts].join(' ');
  return {
    'content-security-policy': [
      // Enforce the iframe boundary even when a preview is opened directly.
      `sandbox ${PREVIEW_BROWSER_SANDBOX}`,
      `default-src ${self}`,
      `connect-src ${self}`,
      // `'unsafe-inline'` IS A DEVIATION from the design's literal
      // "scripts/styles = 'self'", and it is deliberate. A generated
      // deliverable is routinely a single HTML file with inline `<script>`
      // and `<style>`; refusing those would make the feature not work at all
      // for the commonest shape a run produces. What the host allowlist
      // actually buys is EXFILTRATION control, and that lives in `default-src`
      // and `connect-src`, which stay closed — inline script is same-document
      // and reaches nothing new. There is also no trusted application here to
      // protect from injected script: the application IS model-authored code
      // the member chose to open. `'unsafe-eval'` is NOT granted, because
      // nothing in the commonest shape needs it and it is the one that turns
      // a data string into code.
      `script-src ${self} 'unsafe-inline'`,
      `style-src ${self} 'unsafe-inline'`,
      `img-src ${self} data: blob:`,
      `font-src ${self} data:`,
      `media-src ${self}`,
      // The preview may be framed by the visualizer and by nothing else.
      `frame-ancestors ${input.visualizerOrigin}`,
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    'permissions-policy': [
      'document-domain=()',
      'accelerometer=()',
      'camera=()',
      'clipboard-read=()',
      'clipboard-write=()',
      'display-capture=()',
      'fullscreen=()',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'microphone=()',
      'payment=()',
      'usb=()',
    ].join(', '),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
  };
}

/**
 * May this `Location` be passed back to the browser?
 *
 * Only a redirect that stays on this preview's own origin. An application that
 * could redirect the frame anywhere would be able to navigate a member off the
 * preview and onto a page of its choosing, from inside a surface the member
 * believes is theirs.
 */
export function isSamePreviewRedirect(location: string, previewOriginUrl: string): boolean {
  // ALWAYS RESOLVED, never pattern-matched. A "looks relative, so it is safe"
  // shortcut was here and it was wrong: `/\evil.example` starts with a single
  // slash and resolves to `https://evil.example` in every WHATWG-compliant
  // browser, because a special scheme treats a backslash as a separator. The
  // parser is the only thing that knows what a browser will do with a string,
  // so the parser decides.
  try {
    const target = new URL(location, previewOriginUrl);
    return target.origin === new URL(previewOriginUrl).origin;
  } catch {
    return false;
  }
}

/**
 * The session cookie carries an opaque token, not an authorization lifetime.
 * The registry enforces expiry and heartbeat renewal independently.
 *
 * `__Host-` forces Secure, Path=/ and no Domain — so it cannot be widened to a
 * parent domain. `SameSite=None` because the preview is framed cross-site by
 * the visualizer, and `Partitioned` so the browser keys it to that embedding
 * rather than leaving a third-party cookie the rest of the web can rely on.
 */
export function previewGrantCookie(value: string, maxAgeSeconds?: number): string {
  return [
    `${PREVIEW_GRANT_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=None',
    'Partitioned',
    ...(maxAgeSeconds === undefined ? [] : [`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`]),
  ].join('; ');
}

/** Clearing it is the same cookie with no lifetime, so the attributes match. */
export function clearedPreviewGrantCookie(): string {
  return previewGrantCookie('', 0);
}
