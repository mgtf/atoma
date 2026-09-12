import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { startEgressProxy, type RunningEgressProxy } from '../src/tools/egressProxy.js';

/**
 * The proxy end to end, against a real origin server standing in for both an
 * allowed dependency host and the control plane.
 *
 * The policy is unit-tested separately; what these prove is that the proxy
 * ASKS it before relaying a byte — including on CONNECT, where everything
 * after the handshake is ciphertext and the host name is the last thing the
 * proxy will ever be able to see.
 */

let proxy: RunningEgressProxy | null = null;
let origin: Server | null = null;
afterEach(async () => {
  await proxy?.close();
  proxy = null;
  await new Promise<void>((r) => (origin ? origin.close(() => r()) : r()));
  origin = null;
});

function startOrigin(): Promise<number> {
  return new Promise((resolve) => {
    origin = createServer((_q, r) => r.end('ORIGIN_PAYLOAD'));
    origin.listen(0, '127.0.0.1', () => resolve((origin!.address() as { port: number }).port));
  });
}

// Tests widen the port set explicitly: the shipped default is 80/443, and a
// local origin necessarily listens on an ephemeral port. Widening it HERE
// rather than in the policy keeps the strict default under test elsewhere.
async function through(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${proxyPort}`, {
    method: 'GET',
    headers: { 'x-forwarded-target': url },
  }).catch(() => null);
  void res;
  // Node's fetch has no proxy support, so speak the proxy protocol directly:
  // an absolute-form request line is exactly what a proxy client sends.
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => {
      s.write(`GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    s.on('data', (c) => (buf += c.toString()));
    s.on('end', () => {
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(buf)?.[1] ?? 0);
      resolve({ status, body: buf.slice(buf.indexOf('\r\n\r\n') + 4) });
    });
    s.on('error', () => resolve({ status: 0, body: '' }));
  });
}

describe('egress proxy', () => {
  it('keeps its process alive when a denied CONNECT client resets the socket', async () => {
    const port = await startOrigin();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/tools/egressProxy.ts'], {
      env: { PATH: process.env.PATH, ATOMA_EGRESS_PORT: '0', ATOMA_EGRESS_ALLOWLIST: 'localhost', ATOMA_EGRESS_PORTS: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let logs = '';
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    try {
      const proxyPort = await new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.once('exit', () => reject(new Error(logs)));
        child.stderr.on('data', (chunk: Buffer) => {
          logs = (logs + chunk.toString()).slice(-16_000);
          const match = /listening on (\d+)/.exec(logs);
          if (match) resolve(Number(match[1]));
        });
      });
      for (let i = 0; i < 20 && child.exitCode === null; i += 1) {
        await new Promise<void>(resolve => {
          const socket = connect(proxyPort, '127.0.0.1', () => {
            socket.write('CONNECT denied.invalid:443 HTTP/1.1\r\nHost: denied.invalid:443\r\n\r\n');
            setImmediate(() => { socket.resetAndDestroy(); resolve(); });
          });
          socket.on('error', () => resolve());
        });
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(child.exitCode, logs).toBeNull();
      expect(logs).toContain('DENY  CONNECT denied.invalid:443');
      const result = await through(proxyPort, `http://localhost:${port}/after-reset`);
      expect(result.status).toBe(200);
      expect(result.body).toContain('ORIGIN_PAYLOAD');
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  }, 15_000);

  it('relays an ALLOWED host', async () => {
    const port = await startOrigin();
    proxy = await startEgressProxy({ port: 0, allowlist: ['localhost'], allowedPorts: [port], log: () => {} });
    const r = await through(proxy.port, `http://localhost:${port}/pkg`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('ORIGIN_PAYLOAD');
  }, 20_000);

  it('REFUSES a host that is not on the allowlist, without contacting it', async () => {
    const port = await startOrigin();
    // Port is allowed; the HOST is not — so the refusal is about the
    // allowlist, not a side effect of the port rule.
    proxy = await startEgressProxy({ port: 0, allowlist: ['registry.npmjs.org'], allowedPorts: [port], log: () => {} });
    const r = await through(proxy.port, `http://localhost:${port}/pkg`);
    expect(r.status).toBe(403);
    expect(r.body).toContain('egress denied');
    expect(r.body).not.toContain('ORIGIN_PAYLOAD');
  }, 20_000);

  it('refuses the control plane even when an origin is listening there', async () => {
    const port = await startOrigin();
    proxy = await startEgressProxy({ port: 0, allowlist: ['registry.npmjs.org'], allowedPorts: [port], log: () => {} });
    for (const host of ['127.0.0.1', 'localhost']) {
      const r = await through(proxy.port, `http://${host}:${port}/api/run`);
      expect(r.status, `${host} must be refused`).toBe(403);
    }
  }, 20_000);

  it('refuses a CONNECT tunnel to a denied host before relaying anything', async () => {
    proxy = await startEgressProxy({ port: 0, allowlist: ['registry.npmjs.org'], log: () => {} });
    const net = await import('node:net');
    const reply = await new Promise<string>((resolve) => {
      const s = net.connect(proxy!.port, '127.0.0.1', () => {
        s.write('CONNECT host.docker.internal:4111 HTTP/1.1\r\nHost: host.docker.internal:4111\r\n\r\n');
      });
      let buf = '';
      s.on('data', (c) => {
        buf += c.toString();
        if (buf.includes('\r\n\r\n')) {
          s.destroy();
          resolve(buf);
        }
      });
      s.on('error', () => resolve(''));
      s.on('close', () => resolve(buf));
    });
    expect(reply).toMatch(/403/);
    expect(reply).not.toMatch(/200 Connection Established/);
  }, 20_000);
});
