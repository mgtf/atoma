import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { Duplex } from 'node:stream';
import { once } from 'node:events';
import {
  forwardableHeaders,
  isOriginFormTarget,
  PREVIEW_INGRESS_MAX_HEADER_BYTES,
  startPreviewIngress,
  type RunningPreviewIngress,
} from '../src/tools/previewIngress.js';

/**
 * The relay is the ONE component attached to both a preview's internal
 * network and the network the gateway reaches, so its refusals are a
 * tenant-isolation boundary rather than input validation. These drive real
 * sockets against a real upstream: the claim under test is what the relay
 * puts on the wire, which a mock could not observe.
 */

const closers: Array<() => Promise<void>> = [];

/**
 * A hijacked (upgraded) connection never ends on its own, and `Server#close`
 * waits for open connections — so a test that opens a WebSocket and then
 * awaits a plain close hangs on its own fixture rather than on the relay.
 */
function forceClose(server: Server, hijacked: Duplex[] = []): Promise<void> {
  return new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
    // Measured: `closeAllConnections` does NOT reach a socket handed to an
    // `upgrade` handler, and `close` never resolves while one is open. A
    // fixture that hijacks must destroy what it hijacked.
    for (const socket of hijacked) socket.destroy();
    if (hijacked.length > 0) done();
  });
}

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** A real upstream that reports exactly what the relay sent it. */
async function upstream(
  handler?: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ port: number; seen: Array<{ method: string; url: string; headers: NodeJS.Dict<string | string[]> }> }> {
  const seen: Array<{ method: string; url: string; headers: NodeJS.Dict<string | string[]> }> = [];
  const server: Server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-from': 'app' });
    res.end('served by the app');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  closers.push(() => forceClose(server));
  const address = server.address();
  return { port: typeof address === 'object' && address ? address.port : 0, seen };
}

async function relay(upstreamPort: number, lines: string[] = []): Promise<RunningPreviewIngress> {
  const running = await startPreviewIngress({
    port: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort,
    log: (line) => lines.push(line),
  });
  closers.push(() => running.close());
  return running;
}

/** Speak HTTP/1.1 by hand, because the refusals are about the request LINE. */
function rawRequest(port: number, requestLine: string, headers = 'host: preview.test\r\n'): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write(`${requestLine}\r\n${headers}connection: close\r\n\r\n`);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      data += chunk;
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

describe('preview ingress request-target discipline', () => {
  it('accepts only the origin form a server receives', () => {
    expect(isOriginFormTarget('/')).toBe(true);
    expect(isOriginFormTarget('/app/index.html?q=1')).toBe(true);

    // Absolute form is what a client sends a PROXY. Accepting it would make
    // the one component on both networks a way out of the isolate.
    expect(isOriginFormTarget('http://elsewhere/')).toBe(false);
    expect(isOriginFormTarget('https://elsewhere/')).toBe(false);
    // Scheme-relative is treated as a host by enough intermediaries to be a
    // smuggling risk.
    expect(isOriginFormTarget('//elsewhere/path')).toBe(false);
    expect(isOriginFormTarget('*')).toBe(false);
    expect(isOriginFormTarget(undefined)).toBe(false);
  });

  it('forwards an origin-form request to the fixed upstream', async () => {
    const app = await upstream();
    const running = await relay(app.port);

    const response = await rawRequest(running.port, 'GET /health HTTP/1.1');

    expect(response).toContain('200 OK');
    expect(response).toContain('served by the app');
    expect(app.seen).toHaveLength(1);
    expect(app.seen[0]?.url).toBe('/health');
  });

  it('refuses an absolute request-target rather than fetching it', async () => {
    const app = await upstream();
    const running = await relay(app.port);

    const response = await rawRequest(running.port, 'GET http://example.com/ HTTP/1.1');

    expect(response).toContain('400');
    // The decisive assertion: nothing reached ANY upstream.
    expect(app.seen).toHaveLength(0);
  });

  it('refuses CONNECT rather than opening a tunnel across both networks', async () => {
    const app = await upstream();
    const running = await relay(app.port);

    const response = await rawRequest(running.port, 'CONNECT example.com:443 HTTP/1.1');

    expect(response).toContain('405');
    expect(app.seen).toHaveLength(0);
  });

  it('reaches only itself when the application inside calls the relay', async () => {
    // The app is what would be calling; the relay's fixed upstream means the
    // call lands back on the app rather than anywhere else.
    const app = await upstream();
    const running = await relay(app.port);

    await rawRequest(running.port, 'GET /loop HTTP/1.1');

    expect(app.seen.map((r) => r.url)).toEqual(['/loop']);
  });
});

describe('preview ingress header handling', () => {
  it('drops hop-by-hop headers on the way through', () => {
    const forwarded = forwardableHeaders({
      host: 'preview.test',
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'proxy-authorization': 'Basic x',
      'transfer-encoding': 'chunked',
      upgrade: 'websocket',
      te: 'trailers',
      'x-app-header': 'kept',
    });

    expect(Object.keys(forwarded).sort()).toEqual(['host', 'x-app-header']);
  });

  it('preserves the incoming Host so the app builds its own URLs correctly', async () => {
    const app = await upstream();
    const running = await relay(app.port);

    await rawRequest(running.port, 'GET / HTTP/1.1', 'host: gen-7.preview.test\r\n');

    expect(app.seen[0]?.headers['host']).toBe('gen-7.preview.test');
  });

  it('refuses a header block past the cap instead of buffering it', async () => {
    const app = await upstream();
    const running = await relay(app.port);

    const padding = 'x'.repeat(PREVIEW_INGRESS_MAX_HEADER_BYTES + 1024);
    const response = await rawRequest(
      running.port,
      'GET / HTTP/1.1',
      `host: preview.test\r\nx-pad: ${padding}\r\n`
    );

    expect(response).toMatch(/431|400/);
    expect(app.seen).toHaveLength(0);
  });
});

describe('preview ingress upstream failure', () => {
  it('answers 502 without leaking what was being browsed', async () => {
    const lines: string[] = [];
    // Nothing is listening on this port: the app never came up.
    const running = await startPreviewIngress({
      port: 0,
      upstreamHost: '127.0.0.1',
      upstreamPort: 1,
      log: (line) => lines.push(line),
    });
    closers.push(() => running.close());

    const response = await rawRequest(running.port, 'GET /private/report?token=abc HTTP/1.1');

    expect(response).toContain('502');
    expect(response).toContain('not answering');
    // The diagnostics name the failure, never the path or the query.
    const logged = lines.join('\n');
    expect(logged).toContain('upstream unavailable');
    expect(logged).not.toContain('/private/report');
    expect(logged).not.toContain('token=abc');
  });

  it('announces readiness with the marker the launcher waits on', async () => {
    const lines: string[] = [];
    const app = await upstream();
    await relay(app.port, lines);

    expect(lines.some((line) => /\[preview-ingress\] listening on \d+/.test(line))).toBe(true);
  });
});

describe('preview ingress teardown', () => {
  it('resolves close() even while a WebSocket is live', async () => {
    // REGRESSION. `Server#closeAllConnections` does not reach a socket handed
    // to an `upgrade` handler, and `Server#close` never resolves while one is
    // open — measured. A relay whose close() hung would leak the container a
    // stop was supposed to remove, on the one shape the relay exists to
    // carry.
    const server: Server = createServer();
    const appSockets: Duplex[] = [];
    server.on('upgrade', (_req, socket) => {
      appSockets.push(socket);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\n\r\n');
      socket.write('open');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    closers.push(() => forceClose(server, appSockets));
    const address = server.address();
    const appPort = typeof address === 'object' && address ? address.port : 0;

    const running = await startPreviewIngress({
      port: 0,
      upstreamHost: '127.0.0.1',
      upstreamPort: appPort,
      drainMs: 20,
      log: () => undefined,
    });

    const client = netConnect(running.port, '127.0.0.1', () => {
      client.write(
        'GET /s HTTP/1.1\r\nhost: p\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n'
      );
    });
    await once(client, 'data');

    await expect(running.close()).resolves.toBeUndefined();
    client.destroy();
  });
});

describe('preview ingress websocket upgrade', () => {
  it('relays an upgrade to the fixed upstream and pipes both directions', async () => {
    const server: Server = createServer();
    const appSockets: Duplex[] = [];
    server.on('upgrade', (req, socket) => {
      appSockets.push(socket);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n'
      );
      socket.write('from-app');
      socket.on('data', (chunk: Buffer) => socket.write(`echo:${chunk.toString()}`));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    closers.push(() => forceClose(server, appSockets));
    const address = server.address();
    const appPort = typeof address === 'object' && address ? address.port : 0;

    const running = await relay(appPort);

    const received = await new Promise<string>((resolve, reject) => {
      const socket = netConnect(running.port, '127.0.0.1', () => {
        socket.write(
          'GET /socket HTTP/1.1\r\nhost: preview.test\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n'
        );
      });
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        data += chunk;
        if (data.includes('from-app')) {
          socket.write('ping');
        }
        if (data.includes('echo:ping')) {
          socket.end();
          resolve(data);
        }
      });
      socket.on('error', reject);
    });

    expect(received).toContain('101 Switching Protocols');
    expect(received).toContain('from-app');
    expect(received).toContain('echo:ping');
  });

  it('refuses an upgrade to a target it does not serve', async () => {
    const app = await upstream();
    const running = await relay(app.port);

    const response = await new Promise<string>((resolve, reject) => {
      const socket = netConnect(running.port, '127.0.0.1', () => {
        socket.write(
          'GET http://elsewhere/socket HTTP/1.1\r\nhost: preview.test\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n'
        );
      });
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        data += chunk;
      });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });

    expect(response).toContain('400');
    expect(app.seen).toHaveLength(0);
  });
});
