/**
 * The ONE way into a preview's application container.
 *
 * The app sits on a per-preview `--internal` network whose host gateway is
 * removed, so nothing outside can address it. This relay is attached to that
 * network AND to the one the gateway can reach, which makes it the single
 * path in — and a fixed upstream is the whole of what it will carry.
 *
 * IT IS NOT A PROXY, and every refusal below exists to keep it from becoming
 * one. It is attached to both networks, so a general proxy here would let the
 * generated application inside the isolate reach whatever the relay can reach:
 * the gateway, the host, another preview. Because the upstream is fixed and
 * absolute request-targets are refused, an app that connects to this relay
 * can only ever reach ITSELF.
 *
 * Two shapes are forwarded, because that is what a web application needs:
 *   origin-form HTTP/1.1   → the app's own routes
 *   Upgrade: websocket     → the app's own socket endpoints
 * Everything else is refused rather than guessed. A relay that guesses is a
 * relay that eventually forwards something the boundary never saw.
 *
 * NOTHING OF THE PAYLOAD IS LOGGED. This carries a tenant's application
 * traffic; the operator diagnostics it emits are a listening line, a bounded
 * refusal reason and an upstream connection error, never a path, a header
 * value or a body.
 */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';

/** A header cap that fits real browsers and refuses a header-smuggling wall. */
export const PREVIEW_INGRESS_MAX_HEADER_BYTES = 16 * 1024;

/** Aligned with the preview's own idle bound by the caller; a floor here. */
export const PREVIEW_INGRESS_DEFAULT_SOCKET_TIMEOUT_MS = 120_000;

/** How long a stop lets live connections finish before taking them. */
export const PREVIEW_INGRESS_DEFAULT_DRAIN_MS = 250;

/**
 * Hop-by-hop headers, which belong to one connection and must not be
 * forwarded onto the next (RFC 9110 §7.6.1). `Upgrade` is handled by the
 * upgrade path and removed here so it can never ride an ordinary request.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface PreviewIngressOptions {
  /** Where the relay listens. The gateway is the only thing that reaches it. */
  readonly port: number;
  /** The application container's name on the per-preview internal network. */
  readonly upstreamHost: string;
  /** Fixed by contract: the app is told `PORT` and must honour it. */
  readonly upstreamPort: number;
  readonly socketTimeoutMs?: number;
  /**
   * How long `close()` lets live connections finish before destroying them.
   *
   * A WebSocket is a HIJACKED connection: `Server#close` stops accepting and
   * then waits for open connections, and an upgraded one never ends on its
   * own — so a relay without this bound has a `close()` that never resolves,
   * and a teardown that never resolves is a leaked container. Brief on
   * purpose: a preview being stopped is being stopped.
   */
  readonly drainMs?: number;
  /** Where operator diagnostics go. Defaults to stderr. */
  readonly log?: (line: string) => void;
}

export interface RunningPreviewIngress {
  readonly port: number;
  close(): Promise<void>;
}

/** Strip hop-by-hop headers before handing a request or response onward. */
export function forwardableHeaders(
  headers: NodeJS.Dict<string | string[]>
): NodeJS.Dict<string | string[]> {
  const out: NodeJS.Dict<string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Is this request-target the origin-form a server receives, rather than the
 * absolute-form a PROXY receives?
 *
 * The distinction is the whole boundary. `GET http://elsewhere/ HTTP/1.1` is
 * how a client asks a proxy to fetch something; accepting it here would turn
 * the one component attached to both networks into a relay out of the
 * isolate. `*` (OPTIONS server-wide) is refused for the same reason it has no
 * meaning against a fixed upstream.
 */
export function isOriginFormTarget(target: string | undefined): boolean {
  if (!target) return false;
  if (!target.startsWith('/')) return false;
  // `//host/path` is parsed as a scheme-relative URL by enough clients and
  // intermediaries that treating it as a path is a smuggling risk.
  if (target.startsWith('//')) return false;
  return true;
}

export function startPreviewIngress(
  opts: PreviewIngressOptions
): Promise<RunningPreviewIngress> {
  const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const socketTimeoutMs = opts.socketTimeoutMs ?? PREVIEW_INGRESS_DEFAULT_SOCKET_TIMEOUT_MS;
  const drainMs = opts.drainMs ?? PREVIEW_INGRESS_DEFAULT_DRAIN_MS;

  /**
   * Sockets this relay HIJACKED for an upgrade.
   *
   * Measured, and the reason this set exists: `Server#closeAllConnections`
   * does NOT reach a socket that was handed to an `upgrade` handler, and
   * `Server#close` never resolves while one is open — so a relay that relied
   * on either would have a stop that hangs for ever on the one shape it
   * exists to carry. Whoever hijacks a socket owns closing it.
   */
  const hijacked = new Set<Socket>();
  const trackHijacked = (socket: Socket): void => {
    hijacked.add(socket);
    socket.once('close', () => hijacked.delete(socket));
  };

  const refuse = (res: ServerResponse, status: number, reason: string): void => {
    log(`[preview-ingress] REFUSE ${status} — ${reason}`);
    res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' });
    res.end(`${reason}\n`);
  };

  const server = createServer(
    { maxHeaderSize: PREVIEW_INGRESS_MAX_HEADER_BYTES },
    (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'CONNECT') {
        // Unreachable through `createServer`'s request path, which routes
        // CONNECT to its own event, but stated so the refusal is total.
        refuse(res, 405, 'this relay does not tunnel');
        return;
      }
      if (!isOriginFormTarget(req.url)) {
        refuse(res, 400, 'this relay serves one application, not arbitrary targets');
        return;
      }

      const upstream = httpRequest(
        {
          host: opts.upstreamHost,
          port: opts.upstreamPort,
          method: req.method ?? 'GET',
          path: req.url,
          // The incoming Host is PRESERVED on purpose: the application is
          // serving that origin, and rewriting it would make every absolute
          // URL the app builds point at an internal container name.
          headers: forwardableHeaders(req.headers),
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, forwardableHeaders(up.headers));
          up.pipe(res);
        }
      );
      upstream.setTimeout(socketTimeoutMs, () => upstream.destroy());
      upstream.on('error', (err) => {
        // The MESSAGE, never the target: an operator needs to know the app did
        // not answer, not what the member was browsing.
        log(`[preview-ingress] upstream unavailable — ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain', connection: 'close' });
        }
        res.end('the preview application is not answering\n');
      });
      req.pipe(upstream);
    }
  );

  // CONNECT would make this a tunnel to anywhere the relay can reach, which is
  // both networks. Refused before a byte is relayed.
  server.on('connect', (_req: IncomingMessage, socket: Socket) => {
    log('[preview-ingress] REFUSE 405 — this relay does not tunnel');
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
  });

  // WebSockets are the app's own, so the upgrade is relayed verbatim to the
  // fixed upstream — and only for an origin-form target, like every other
  // request.
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!isOriginFormTarget(req.url)) {
      log('[preview-ingress] REFUSE 400 — upgrade to a target this relay does not serve');
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    trackHijacked(socket);
    const upstream = netConnect(opts.upstreamPort, opts.upstreamHost, () => {
      trackHijacked(upstream);
      const headers = Object.entries(req.headers)
        .map(([name, value]) =>
          Array.isArray(value)
            ? value.map((one) => `${name}: ${one}`).join('\r\n')
            : `${name}: ${String(value)}`
        )
        .join('\r\n');
      upstream.write(`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', (err) => {
      log(`[preview-ingress] upgrade upstream unavailable — ${err.message}`);
      socket.destroy();
    });
    socket.on('error', () => upstream.destroy());
  });

  server.setTimeout(socketTimeoutMs);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '0.0.0.0', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      // The readiness marker the launcher waits on. Same contract as the
      // egress proxy's: a log line, because these units sit on networks the
      // control plane cannot reach and there is nothing to probe.
      log(`[preview-ingress] listening on ${port}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            let settled = false;
            const finish = (): void => {
              if (settled) return;
              settled = true;
              clearTimeout(drainTimer);
              done();
            };
            // Stop accepting, let what is in flight finish, then take the
            // rest. `closeAllConnections` is what ends a hijacked WebSocket;
            // without it this promise waits for a peer that has no reason to
            // hang up.
            server.close(finish);
            server.closeIdleConnections();
            const drainTimer = setTimeout(() => {
              server.closeAllConnections();
              // The hijacked ones the server no longer tracks.
              for (const socket of hijacked) socket.destroy();
              hijacked.clear();
              finish();
            }, drainMs);
            // Never hold the process open for the grace period alone.
            drainTimer.unref?.();
          }),
      });
    });
  });
}

// Container entry point.
if (process.argv[1] && /previewIngress\.(ts|js)$/.test(process.argv[1])) {
  const upstreamHost = process.env['ATOMA_PREVIEW_UPSTREAM_HOST'];
  const upstreamPort = Number(process.env['ATOMA_PREVIEW_UPSTREAM_PORT'] ?? 8080);
  if (!upstreamHost || !Number.isInteger(upstreamPort)) {
    process.stderr.write('[preview-ingress] refusing to start without a fixed upstream\n');
    process.exit(2);
  }
  void startPreviewIngress({
    port: Number(process.env['ATOMA_PREVIEW_INGRESS_PORT'] ?? 8081),
    upstreamHost,
    upstreamPort,
  });
}
