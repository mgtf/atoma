/**
 * The single peer a containerised run can reach.
 *
 * The run sits on a `--internal` docker network with no route anywhere. This
 * proxy is attached to BOTH that network and an external one, so it is the
 * only path out — and `decideEgress` is the whole of what it will carry.
 *
 * Two verbs, because that is all a package manager needs:
 *   CONNECT host:port   → the HTTPS tunnel (npm, yarn, any TLS fetch)
 *   GET/POST http://…   → plain HTTP, absolute-form request line
 *
 * DELIBERATELY NOT a general proxy. No auth passthrough, no upgrade
 * handling, no chaining. Every unknown shape is refused rather than
 * forwarded: a proxy that guesses is a proxy that eventually forwards
 * something the policy never saw.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { decideEgress, DEFAULT_EGRESS_ALLOWLIST } from './egressPolicy.js';

export interface EgressProxyOptions {
  readonly port: number;
  readonly allowlist?: readonly string[];
  /** Defaults to 80/443. Widen only for a private registry on another port. */
  readonly allowedPorts?: readonly number[];
  /** Where decisions are written. Defaults to stderr. */
  readonly log?: (line: string) => void;
}

export interface RunningEgressProxy {
  readonly port: number;
  close(): Promise<void>;
}

export function startEgressProxy(opts: EgressProxyOptions): Promise<RunningEgressProxy> {
  const allowlist = opts.allowlist ?? DEFAULT_EGRESS_ALLOWLIST;
  const log = opts.log ?? ((l: string) => process.stderr.write(l + '\n'));

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Absolute-form request line is what a client sends to a proxy. A
    // relative path means someone is talking to us as if we were an origin
    // server, which is not a shape this proxy serves.
    const target = req.url ?? '';
    const d = decideEgress(target, { allowlist, defaultPort: 80, ...(opts.allowedPorts ? { allowedPorts: opts.allowedPorts } : {}) });
    log(`[egress] ${d.allowed ? 'ALLOW' : 'DENY '} http ${d.host}:${d.port} — ${d.reason}`);
    if (!d.allowed) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end(`egress denied: ${d.host}:${d.port} — ${d.reason}\n`);
      return;
    }
    const upstream = httpRequest(
      { host: d.host, port: d.port, method: req.method, path: new URL(target).pathname + new URL(target).search, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`upstream error: ${err.message}\n`);
    });
    req.pipe(upstream);
  });

  // CONNECT is where npm actually goes. Once the tunnel is open the proxy
  // sees only ciphertext, which is why the decision has to happen HERE, on
  // the host name, before a single byte is relayed.
  server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const d = decideEgress(req.url ?? '', { allowlist, defaultPort: 443, ...(opts.allowedPorts ? { allowedPorts: opts.allowedPorts } : {}) });
    log(`[egress] ${d.allowed ? 'ALLOW' : 'DENY '} CONNECT ${d.host}:${d.port} — ${d.reason}`);
    if (!d.allowed) {
      clientSocket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\negress denied: ${d.reason}\n`);
      return;
    }
    const upstream = netConnect(d.port, d.host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const fail = (err: Error): void => {
      log(`[egress] ERROR CONNECT ${d.host}:${d.port} — ${err.message}`);
      clientSocket.destroy();
    };
    upstream.on('error', fail);
    clientSocket.on('error', () => upstream.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '0.0.0.0', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      log(`[egress] listening on ${port}; allowlist: ${allowlist.join(', ')}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

// Container entry point.
if (process.argv[1] && /egressProxy\.(ts|js)$/.test(process.argv[1])) {
  const raw = process.env['ATOMA_EGRESS_ALLOWLIST'];
  const ports = process.env['ATOMA_EGRESS_PORTS'];
  void startEgressProxy({
    port: Number(process.env['ATOMA_EGRESS_PORT'] ?? 3128),
    ...(raw ? { allowlist: raw.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
    ...(ports
      ? { allowedPorts: ports.split(',').map((p) => Number(p.trim())).filter(Number.isInteger) }
      : {}),
  });
}
