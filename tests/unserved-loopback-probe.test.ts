import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { ToolSandbox } from '../src/tools/sandbox.js';
import {
  fetchUrlTool,
  validateHtmlTool,
  unservedLoopbackProbeRefusal,
  describeServedOrigins,
  type ServedOrigins,
} from '../src/tools/builtin.js';
import {
  PROBE_URL_REFUSAL_PREFIX,
  SMOKE_PREFLIGHT_REFUSAL_PREFIX,
  isPreflightRefusal,
} from '../src/contracts/attestation.js';

/**
 * Production run `d3098d25` (2026-09-21,
 * docs/incidents/progressive-runs-2026-09-21.md): the final review probed
 * bare `http://localhost/` while the run's own server was bound to an
 * OS-assigned port, read `ERR_CONNECTION_REFUSED` as a dead service, and
 * replayed near-duplicate executions into the 1800 s deadline — $3.50
 * recorded, nothing delivered. `start_node_server`/`start_static_server`
 * never bind the protocol default, so a portless loopback URL is a shape
 * error about the REQUEST: both probe tools refuse it pre-flight and name the
 * origins the run actually registered.
 */

const sandboxes: ToolSandbox[] = [];
const dirs: string[] = [];

function makeSandbox(): ToolSandbox {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-unserved-'));
  dirs.push(dir);
  const sandbox = new ToolSandbox(dir);
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(async () => {
  for (const s of sandboxes.splice(0)) await s.cleanup().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function origins(entries: Array<[number, { kind: 'node' | 'static'; entry?: string }]>): ServedOrigins {
  return new Map(entries.map(([port, o]) => [port, { ...o, pid: process.pid }]));
}

/** A loopback port that is closed at the time of use. */
async function closedPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port assigned'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

describe('unservedLoopbackProbeRefusal', () => {
  const registry = origins([[40207, { kind: 'node', entry: 'server.mjs' }]]);

  it('refuses a portless loopback URL and names the registered origins', () => {
    const refusal = unservedLoopbackProbeRefusal('http://localhost/', registry);
    expect(refusal).toContain('names no port');
    expect(refusal).toContain('http://localhost:40207/ (node, entry server.mjs)');
  });

  it('refuses every loopback spelling and https too', () => {
    for (const url of [
      'http://127.0.0.1/health',
      'http://[::1]/notes',
      'http://0.0.0.0/',
      'https://localhost/',
    ]) {
      expect(unservedLoopbackProbeRefusal(url, registry)).not.toBeNull();
    }
  });

  it('permits explicit ports (registered or not), non-loopback hosts and malformed URLs', () => {
    expect(unservedLoopbackProbeRefusal('http://localhost:40207/api', registry)).toBeNull();
    // run_shell-started servers are invisible to the registry; an explicit
    // port must not be refused on the registry's ignorance.
    expect(unservedLoopbackProbeRefusal('http://localhost:5111/api', registry)).toBeNull();
    expect(unservedLoopbackProbeRefusal('https://example.com/', registry)).toBeNull();
    expect(unservedLoopbackProbeRefusal('not a url', registry)).toBeNull();
    expect(unservedLoopbackProbeRefusal('ws://localhost/', registry)).toBeNull();
  });

  it('still refuses with an empty registry, pointing at the server tools', () => {
    const refusal = unservedLoopbackProbeRefusal('http://localhost/', new Map());
    expect(refusal).toContain('No server is registered');
  });
});

describe('fetch_url', () => {
  it('refuses a portless loopback URL pre-flight with the contract prefix', async () => {
    const tool = fetchUrlTool({
      sandbox: makeSandbox(),
      servedOrigins: origins([[40207, { kind: 'node', entry: 'server.mjs' }]]),
    });
    const result = (await tool.execute({ url: 'http://localhost/health' })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error.startsWith(PROBE_URL_REFUSAL_PREFIX)).toBe(true);
    expect(result.error).toContain('http://localhost:40207/');
  });

  it('appends the registered origins to a refused connection on an unregistered port', async () => {
    const port = await closedPort();
    const tool = fetchUrlTool({
      sandbox: makeSandbox(),
      servedOrigins: origins([[40207, { kind: 'static' }]]),
    });
    const result = (await tool.execute({
      url: `http://127.0.0.1:${port}/`,
      timeoutMs: 5_000,
    })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain(describeServedOrigins(origins([[40207, { kind: 'static' }]])));
  });
});

describe('validate_html', () => {
  it('refuses a portless loopback URL pre-flight, before any browser launches', async () => {
    const tool = validateHtmlTool({
      sandbox: makeSandbox(),
      servedOrigins: origins([[40207, { kind: 'node', entry: 'server.mjs' }]]),
    });
    const result = (await tool.execute({ url: 'http://localhost/' })) as {
      ok: boolean;
      errors: string[];
      requestedInteractions: number;
      ignoredInteractions: number;
    };
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.startsWith(PROBE_URL_REFUSAL_PREFIX)).toBe(true);
    expect(result.errors[0]).toContain('http://localhost:40207/');
    // The ledger must read this as a refusal about the request, never as a
    // failed observation of the artefact.
    expect(isPreflightRefusal(result)).toBe(true);
    expect(result.requestedInteractions).toBe(0);
    expect(result.ignoredInteractions).toBe(0);
  });

  it('reports URL and smoke refusals together, order-independent', async () => {
    const tool = validateHtmlTool({ sandbox: makeSandbox(), servedOrigins: new Map() });
    const result = (await tool.execute({
      url: 'http://localhost/',
      smoke: 'const broken = true',
    })) as { ok: boolean; errors: string[] };
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith(PROBE_URL_REFUSAL_PREFIX))).toBe(true);
    expect(result.errors.some((e) => e.startsWith(SMOKE_PREFLIGHT_REFUSAL_PREFIX))).toBe(true);
    expect(isPreflightRefusal(result)).toBe(true);
  });
});
