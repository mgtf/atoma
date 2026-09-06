import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { extname } from 'node:path';
import { ArtifactPolicyError, DEFAULT_ARTIFACT_LIMITS } from '../projects/artifacts.js';
import {
  assertPreviewServablePath,
  readPreviewServableFile,
} from './policy.js';
import { type PreviewClaimRegistry } from './claims.js';
import {
  isReservedPreviewPath,
  PREVIEW_GRANT_COOKIE,
  previewGrantCookie,
  isSamePreviewRedirect,
  previewResponseHeaders,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
} from './gateway.js';

/**
 * THE PREVIEW GATEWAY.
 *
 * One server in front of every preview origin. It answers three questions and
 * refuses everything else:
 *
 *   which preview is this?   — from the Host header alone, before anything
 *   may this browser see it? — from a grant it exchanged for a one-time claim
 *   what does it get back?   — the application's bytes under OUR headers
 *
 * ONE GENERIC 404 for every negative answer: unknown host, expired claim,
 * wrong organisation, a preview that has stopped. Telling them apart would
 * tell an unauthenticated caller which generation hosts exist and which
 * organisations own them, and none of the four is a distinction a legitimate
 * member ever needs.
 */

const MAX_REQUEST_HEADER_BYTES = 16 * 1024;
const MAX_CLAIM_BODY_BYTES = 4 * 1024;

/** What the gateway needs to serve one generation. Never leaves this process. */
export interface PreviewRoute {
  readonly orgId: string;
  readonly projectRunId: string;
  readonly generation: number;
  readonly kind: 'static' | 'node';
  /** Loopback port of the relay, for a node preview. */
  readonly upstreamPort?: number;
  /** Filesystem root of the materialised copy, for a static preview. */
  readonly workspaceRoot?: string;
  /** Effective approved hosts, for the CSP. */
  readonly allowedHosts: readonly string[];
}

/**
 * The live routing table, by generation host.
 *
 * In memory, like the grants: a route names a container that dies with this
 * process, so a route that outlived a restart would point at nothing.
 */
export class PreviewRouteTable {
  private readonly routes = new Map<string, PreviewRoute>();

  set(host: string, route: PreviewRoute): void {
    this.routes.set(host.toLowerCase(), route);
  }

  get(host: string): PreviewRoute | null {
    return this.routes.get(host.toLowerCase()) ?? null;
  }

  delete(host: string): void {
    this.routes.delete(host.toLowerCase());
  }

  get size(): number {
    return this.routes.size;
  }
}

export interface PreviewGatewayOptions {
  readonly host: string;
  readonly port: number;
  readonly routes: PreviewRouteTable;
  readonly claims: PreviewClaimRegistry;
  /** The exact visualizer origin allowed to frame every preview. */
  readonly visualizerOrigin: string;
  /**
   * The scheme browsers reach this gateway on. `https` in production, behind
   * a terminating proxy; `http` only in the loopback development profile,
   * which `snapshotPreviewConfig` refuses to resolve without four conditions.
   */
  readonly publicScheme?: 'https' | 'http';
  readonly log?: (line: string) => void;
}

export interface RunningPreviewGateway {
  readonly port: number;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The gateway's own page, served on the preview origin.
 *
 * It exists because the claim travels in a URL FRAGMENT, which a browser never
 * sends to a server. Only a script on this origin can read it, hand it back,
 * and then erase it from the address bar. Its own CSP is the strictest in the
 * product: one inline script, no network, nothing framed.
 */
function bootstrapPage(): string {
  return `<!doctype html><meta charset="utf-8"><title>Preview</title><script>
(function () {
  var secret = location.hash.slice(1);
  if (!secret) { document.body.textContent = 'This preview link has already been used.'; return; }
  history.replaceState(null, '', '/');
  fetch('/.atoma/claim', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'text/plain' },
    body: secret,
  }).then(function (r) {
    if (r.ok) { location.replace('/'); return; }
    document.body.textContent = 'This preview link is no longer valid.';
  }).catch(function () {
    document.body.textContent = 'This preview could not be opened.';
  });
})();
</script>`;
}

function readBoundedBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

/** The one negative answer, for every negative reason. */
function refuse(res: ServerResponse): void {
  res.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end('not found\n');
}

function readGrantCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === PREVIEW_GRANT_COOKIE) return rest.join('=');
  }
  return null;
}

export function startPreviewGateway(
  opts: PreviewGatewayOptions
): Promise<RunningPreviewGateway> {
  const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));

  const server: Server = createServer(
    { maxHeaderSize: MAX_REQUEST_HEADER_BYTES },
    (req: IncomingMessage, res: ServerResponse) => {
      void handle(req, res).catch(() => {
        if (!res.headersSent) refuse(res);
        else res.end();
      });
    }
  );

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawHost = (req.headers.host ?? '').toLowerCase();
    // Routing is by HOST ALONE, port stripped: a route names a generation, and
    // a generation does not change because a proxy moved a port.
    const host = rawHost.split(':')[0] ?? '';
    const route = opts.routes.get(host);
    if (!route) return refuse(res);
    /**
     * The anchor a self-redirect is judged against, derived from THE REQUEST
     * — the full `Host` header, port included — rather than from configuration.
     *
     * Two reasons, and the second is not hypothetical. It cannot be falsified
     * by misconfiguration: whatever the browser actually asked for is what the
     * application is allowed to redirect within. And an anchor that hardcoded
     * `https://` plus the port-stripped host refused every absolute
     * self-redirect from a gateway not reached on 443 — a 502 on the
     * application's own `Location`, in production as much as in development.
     */
    const requestOrigin = `${opts.publicScheme ?? 'https'}://${rawHost}`;

    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', `https://${host}`).pathname;
    } catch {
      return refuse(res);
    }

    // The gateway's own namespace, intercepted before anything is proxied.
    if (isReservedPreviewPath(pathname)) {
      if (pathname === '/.atoma/claim' && req.method === 'POST') {
        const body = await readBoundedBody(req, MAX_CLAIM_BODY_BYTES);
        if (body === null) return refuse(res);
        const redeemed = opts.claims.redeem(body.trim(), host);
        if (!redeemed.ok) {
          // The REASON is logged for an operator and never returned: telling a
          // caller "expired" rather than "unknown" tells it the secret existed.
          log(`[preview-gateway] claim refused (${redeemed.reason})`);
          return refuse(res);
        }
        res.writeHead(204, {
          // The cookie carries the GRANT token the registry just issued — never
          // the claim secret, which is spent, and never a bare flag.
          'set-cookie': previewGrantCookie(redeemed.token),
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        res.end();
        return;
      }
      return refuse(res);
    }

    // No cookie yet: this is the first hit on a freshly claimed URL, and the
    // secret is in a fragment only a script on this origin can read.
    const presented = readGrantCookie(req.headers.cookie);
    if (!presented) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        // The bootstrap page's own policy: one inline script, no network, and
        // framed only by the visualizer.
        'content-security-policy': [
          "default-src 'none'",
          "script-src 'unsafe-inline'",
          "connect-src 'self'",
          `frame-ancestors ${opts.visualizerOrigin}`,
          "base-uri 'none'",
        ].join('; '),
      });
      res.end(bootstrapPage());
      return;
    }

    const grant = opts.claims.authorise(presented, {
      orgId: route.orgId,
      projectRunId: route.projectRunId,
      generation: route.generation,
      host,
    });
    if (!grant) return refuse(res);

    const policy = previewResponseHeaders({
      visualizerOrigin: opts.visualizerOrigin,
      allowedHosts: route.allowedHosts,
    });

    if (route.kind === 'static') return serveStatic(route, pathname, policy, res);
    return proxyToRelay(route, req, res, policy, requestOrigin);
  }

  function serveStatic(
    route: PreviewRoute,
    pathname: string,
    policy: Record<string, string>,
    res: ServerResponse
  ): void {
    const root = route.workspaceRoot;
    if (!root) return refuse(res);
    // `/` and a directory resolve to index.html; there are no listings.
    const decoded = decodeURIComponent(pathname);
    const relative = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
    const candidate = relative.replace(/^\/+/, '') || 'index.html';
    try {
      const read = readPreviewServableFile(root, candidate);
      if (read === null) {
        // A path that resolves to nothing may still be a single-page app's
        // route; the design defers SPA fallback to a declared signal, so the
        // honest answer today is the same 404 everything else gets.
        return refuse(res);
      }
      res.writeHead(200, {
        ...policy,
        'content-type': CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(read.length),
      });
      res.end(read);
    } catch (error) {
      if (error instanceof ArtifactPolicyError && error.code === 'limit') {
        res.writeHead(413, { ...policy, 'content-type': 'text/plain; charset=utf-8' });
        res.end('file too large to preview\n');
        return;
      }
      refuse(res);
    }
  }

  function proxyToRelay(
    route: PreviewRoute,
    req: IncomingMessage,
    res: ServerResponse,
    policy: Record<string, string>,
    /** The full origin the browser asked for; see `requestOrigin` above. */
    requestOrigin: string
  ): void {
    const port = route.upstreamPort;
    if (port === undefined) return refuse(res);
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: sanitizeRequestHeaders(req.headers),
      },
      (up) => {
        const returned = sanitizeResponseHeaders(up.headers);
        const location = up.headers['location'];
        if (typeof location === 'string' && !isSamePreviewRedirect(location, requestOrigin)) {
          // An application that could redirect the frame anywhere could
          // navigate a member off a surface they believe is theirs.
          log('[preview-gateway] refused an off-origin redirect from the application');
          res.writeHead(502, { ...policy, 'content-type': 'text/plain; charset=utf-8' });
          res.end('the preview tried to navigate away from itself\n');
          up.resume();
          return;
        }
        res.writeHead(up.statusCode ?? 502, { ...returned, ...policy });
        up.pipe(res);
      }
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { ...policy, 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end('the preview application is not answering\n');
    });
    req.pipe(upstream);
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      log(`[preview-gateway] listening on ${opts.host}:${port}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

/** Exported so a caller can size its own reads the same way. */
export const PREVIEW_STATIC_LIMITS = DEFAULT_ARTIFACT_LIMITS;

/** Re-exported for callers that assert what the gateway will refuse to serve. */
export { assertPreviewServablePath };
