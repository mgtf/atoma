import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PreviewRouteTable,
  startPreviewGateway,
  type RunningPreviewGateway,
} from '../src/preview/gatewayServer.js';
import { mintPreviewClaim, PreviewClaimRegistry } from '../src/preview/claims.js';
import { PREVIEW_GRANT_COOKIE } from '../src/preview/gateway.js';

/**
 * The gateway is the only thing between an unauthenticated caller and a
 * tenant's generated application, so its refusals are driven over real
 * sockets. A mocked request would prove the branch, not the boundary.
 */

const ORG = '33333333-3333-4333-8333-333333333333';
const RUN = '11111111-1111-4111-8111-111111111111';
const HOST = 'p0123456789abcdef0123456789abcdef.previews.example.net';
const VISUALIZER = 'https://app.example.com';

let root: string;
let workspace: string;
let running: RunningPreviewGateway | null = null;
const upstreams: Server[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atoma-preview-gateway-'));
  workspace = join(root, 'copy');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'index.html'), '<h1>delivered</h1>');
  writeFileSync(join(workspace, '.env'), 'SECRET=1');
  mkdirSync(join(workspace, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(workspace, 'node_modules', 'pkg', 'index.js'), 'module.exports=1;');
});

afterEach(async () => {
  await running?.close();
  running = null;
  for (const server of upstreams.splice(0)) {
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  }
  rmSync(root, { recursive: true, force: true });
});

async function gateway(
  route: Parameters<PreviewRouteTable['set']>[1],
  claims = new PreviewClaimRegistry()
): Promise<{ port: number; claims: PreviewClaimRegistry }> {
  const routes = new PreviewRouteTable();
  routes.set(HOST, route);
  running = await startPreviewGateway({
    host: '127.0.0.1',
    port: 0,
    routes,
    claims,
    visualizerOrigin: VISUALIZER,
    log: () => undefined,
  });
  return { port: running.port, claims };
}

interface Reply {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

/**
 * A low-level client, because the boundary is keyed on the HOST HEADER and
 * `fetch` refuses to set one — it is a forbidden header name in undici, so a
 * `fetch`-based test would silently address the gateway by its loopback
 * address and never reach the route under test.
 */
function call(
  port: number,
  path: string,
  init: {
    method?: string;
    body?: string;
    host?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: init.method ?? 'GET',
        headers: { host: init.host ?? HOST, ...(init.headers ?? {}) },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
        );
      }
    );
    request.on('error', reject);
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

/** Header lookup that matches the `Headers`-style reads the assertions use. */
function header(reply: Reply, name: string): string | null {
  const value = reply.headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** Redeem a claim the way the bootstrap page does, and keep the cookie. */
async function grantCookie(port: number, claims: PreviewClaimRegistry): Promise<string> {
  const claim = mintPreviewClaim(
    {
      principalId: 'p1',
      sessionId: 's1',
      orgId: ORG,
      projectRunId: RUN,
      generation: 1,
      host: HOST,
    },
    Date.now()
  );
  claims.register(claim);
  const reply = await call(port, '/.atoma/claim', { method: 'POST', body: claim.secret });
  expect(reply.status).toBe(204);
  const setCookie = header(reply, 'set-cookie') ?? '';
  expect(setCookie).not.toMatch(/Max-Age=|Expires=/i);
  const value = /__Host-AtomaPreview=([^;]+)/.exec(setCookie)?.[1] ?? '';
  expect(value).not.toBe('');
  return `${PREVIEW_GRANT_COOKIE}=${value}`;
}

const staticRoute = (): Parameters<PreviewRouteTable['set']>[1] => ({
  orgId: ORG,
  projectRunId: RUN,
  generation: 1,
  kind: 'static',
  workspaceRoot: workspace,
  allowedHosts: [],
});

describe('preview gateway routing', () => {
  it('answers one generic 404 for a host it does not serve', async () => {
    const { port } = await gateway(staticRoute());
    const reply = await call(port, '/', { host: 'unknown.previews.example.net' });
    expect(reply.status).toBe(404);
    // Nothing in the body distinguishes "no such preview" from "not yours".
    expect(reply.body).toBe('not found\n');
  });

  it('serves its own bootstrap page when no grant has been exchanged', async () => {
    const { port } = await gateway(staticRoute());
    const reply = await call(port, '/');
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('location.hash');
    // The claim never reaches the server in a request line, so only a script
    // on this origin can hand it back.
    expect(header(reply, 'content-security-policy')).toContain("default-src 'none'");
    expect(header(reply, 'content-security-policy')).toContain(
      `frame-ancestors ${VISUALIZER}`
    );
  });

  it('refuses a forged cookie with the same generic 404', async () => {
    const { port } = await gateway(staticRoute());
    const reply = await call(port, '/', {
      headers: { cookie: `${PREVIEW_GRANT_COOKIE}=forged` },
    });
    expect(reply.status).toBe(404);
  });

  it('refuses a claim that was minted for another host', async () => {
    const claims = new PreviewClaimRegistry();
    const { port } = await gateway(staticRoute(), claims);
    const claim = mintPreviewClaim(
      {
        principalId: 'p1',
        sessionId: 's1',
        orgId: ORG,
        projectRunId: RUN,
        generation: 1,
        host: 'elsewhere.previews.example.net',
      },
      Date.now()
    );
    claims.register(claim);

    const reply = await call(port, '/.atoma/claim', { method: 'POST', body: claim.secret });
    expect(reply.status).toBe(404);
    expect(header(reply, 'set-cookie')).toBeNull();
  });

  it('spends a claim once, so a copied link is already used', async () => {
    const claims = new PreviewClaimRegistry();
    const { port } = await gateway(staticRoute(), claims);
    const claim = mintPreviewClaim(
      { principalId: 'p1', sessionId: 's1', orgId: ORG, projectRunId: RUN, generation: 1, host: HOST },
      Date.now()
    );
    claims.register(claim);

    expect((await call(port, '/.atoma/claim', { method: 'POST', body: claim.secret })).status).toBe(204);
    expect((await call(port, '/.atoma/claim', { method: 'POST', body: claim.secret })).status).toBe(404);
  });

  it('never proxies its own namespace', async () => {
    const { port, claims } = await gateway(staticRoute());
    const cookie = await grantCookie(port, claims);
    const reply = await call(port, '/.atoma/anything', { headers: { cookie } });
    expect(reply.status).toBe(404);
  });
});

describe('preview gateway static serving', () => {
  it('serves the delivered page under the full response policy', async () => {
    const { port, claims } = await gateway(staticRoute());
    const cookie = await grantCookie(port, claims);

    const reply = await call(port, '/', { headers: { cookie } });

    expect(reply.status).toBe(200);
    expect(reply.body).toBe('<h1>delivered</h1>');
    expect(header(reply, 'content-type')).toContain('text/html');
    const csp = header(reply, 'content-security-policy') ?? '';
    expect(csp).toContain(`frame-ancestors ${VISUALIZER}`);
    expect(csp).toContain("object-src 'none'");
    expect(header(reply, 'referrer-policy')).toBe('no-referrer');
    expect(header(reply, 'cache-control')).toBe('no-store');
    expect(header(reply, 'x-content-type-options')).toBe('nosniff');
  });

  it('refuses what publication refuses, and the dependency tree too', async () => {
    const { port, claims } = await gateway(staticRoute());
    const cookie = await grantCookie(port, claims);

    for (const path of ['/.env', '/node_modules/pkg/index.js', '/../copy/index.html']) {
      expect((await call(port, path, { headers: { cookie } })).status).toBe(404);
    }
  });

  it('refuses a traversal however it is spelled', async () => {
    const { port, claims } = await gateway(staticRoute());
    const cookie = await grantCookie(port, claims);

    for (const path of ['/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2findex.html']) {
      expect((await call(port, path, { headers: { cookie } })).status).toBe(404);
    }
  });
});

describe('preview gateway proxying', () => {
  async function upstream(
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
  ): Promise<number> {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    upstreams.push(server);
    const address = server.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  it('replaces whatever headers the application tried to set', async () => {
    const port = await upstream((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': 'default-src *',
        'x-frame-options': 'ALLOWALL',
        'set-cookie': 'stolen=1',
        'x-app-header': 'kept',
      });
      res.end('<p>app</p>');
    });
    const { port: gatewayPort, claims } = await gateway({
      orgId: ORG,
      projectRunId: RUN,
      generation: 1,
      kind: 'node',
      upstreamPort: port,
      allowedHosts: ['api.example.org'],
    });
    const cookie = await grantCookie(gatewayPort, claims);

    const reply = await call(gatewayPort, '/', { headers: { cookie } });

    expect(reply.body).toBe('<p>app</p>');
    // An application cannot weaken the boundary that contains it.
    expect(header(reply, 'content-security-policy')).toContain(
      `frame-ancestors ${VISUALIZER}`
    );
    expect(header(reply, 'content-security-policy')).not.toContain('default-src *');
    expect(header(reply, 'x-frame-options')).toBeNull();
    expect(header(reply, 'set-cookie')).toBeNull();
    // Its own headers still come through.
    expect(header(reply, 'x-app-header')).toBe('kept');
    expect(header(reply, 'content-security-policy')).toContain('https://api.example.org');
  });

  it('never hands the member’s cookie or address to the application', async () => {
    let seen: Record<string, unknown> = {};
    const port = await upstream((req, res) => {
      seen = { ...req.headers };
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const { port: gatewayPort, claims } = await gateway({
      orgId: ORG,
      projectRunId: RUN,
      generation: 1,
      kind: 'node',
      upstreamPort: port,
      allowedHosts: [],
    });
    const cookie = await grantCookie(gatewayPort, claims);

    await call(gatewayPort, '/', {
      headers: { cookie, referer: `${VISUALIZER}/runs/1`, 'x-forwarded-for': '203.0.113.7' },
    });

    expect(seen['cookie']).toBeUndefined();
    expect(seen['referer']).toBeUndefined();
    expect(seen['x-forwarded-for']).toBeUndefined();
  });

  it('refuses a redirect that would navigate the member off the preview', async () => {
    const port = await upstream((_req, res) => {
      res.writeHead(302, { location: 'https://elsewhere.example/phish' });
      res.end();
    });
    const { port: gatewayPort, claims } = await gateway({
      orgId: ORG,
      projectRunId: RUN,
      generation: 1,
      kind: 'node',
      upstreamPort: port,
      allowedHosts: [],
    });
    const cookie = await grantCookie(gatewayPort, claims);

    const reply = await call(gatewayPort, '/', { headers: { cookie } });

    expect(reply.status).toBe(502);
    expect(header(reply, 'location')).toBeNull();
  });

  it('passes a redirect that stays on the preview', async () => {
    const port = await upstream((req, res) => {
      if (req.url === '/') {
        res.writeHead(302, { location: '/next' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('arrived');
    });
    const { port: gatewayPort, claims } = await gateway({
      orgId: ORG,
      projectRunId: RUN,
      generation: 1,
      kind: 'node',
      upstreamPort: port,
      allowedHosts: [],
    });
    const cookie = await grantCookie(gatewayPort, claims);

    const reply = await call(gatewayPort, '/', { headers: { cookie } });
    expect(reply.status).toBe(302);
    expect(header(reply, 'location')).toBe('/next');
  });

  it('answers 502 when the application is not there', async () => {
    const { port: gatewayPort, claims } = await gateway({
      orgId: ORG,
      projectRunId: RUN,
      generation: 1,
      kind: 'node',
      upstreamPort: 1,
      allowedHosts: [],
    });
    const cookie = await grantCookie(gatewayPort, claims);

    const reply = await call(gatewayPort, '/', { headers: { cookie } });
    expect(reply.status).toBe(502);
    expect(reply.body).toContain('not answering');
  });
});



describe('browser grant retention and server expiry', () => {
  it('keeps a renewed token usable after five minutes, then refuses it without heartbeat', async () => {
    let now = Date.now();
    const claims = new PreviewClaimRegistry(() => now);
    const { port } = await gateway(staticRoute(), claims);
    const cookie = await grantCookie(port, claims);
    now += 240_000;
    claims.renewRun({ principalId: 'p1', orgId: ORG, projectRunId: RUN, generation: 1 });
    now += 120_000;
    expect((await call(port, '/', { headers: { cookie } })).status).toBe(200);
    now += 300_001;
    expect((await call(port, '/', { headers: { cookie } })).status).toBe(404);
  });
});
