import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { ToolSandbox } from '../src/tools/sandbox.js';
import {
  bindObservedDocument,
  defaultBuiltinTools,
  designatedDocumentFor,
  servedOriginHoldsPort,
  startNodeServerTool,
  startStaticServerTool,
  validateHtmlTool,
  type ServedOrigins,
} from '../src/tools/builtin.js';
import { pidsListeningOn, processHoldsListeningPort } from '../src/tools/listeningPorts.js';

/**
 * A browser observation is bound to the document it was TAKEN AGAINST, or to
 * nothing (docs/depth-routing-experiment-2026-09-13.md §5.2, decision 7).
 *
 * The old binding mapped the URL's pathname to a sandbox file BEFORE the page
 * opened and checked only that the host was loopback. Its own comment said it
 * was silent for a Node server; the code was not. So an `index.html` present
 * and unchanged at the workspace root bound the observation even when the
 * Node server returned another page — a valid digest over the wrong file,
 * which is false coverage at the root acceptance.
 *
 * Three conditions now, all mechanical: the FINAL response URL's port is one
 * THIS tool set bound and its process HOLDS the listening socket now; the
 * response bytes equal the designated file's bytes at that instant; otherwise
 * no `document` at all. Two false bindings the owner reproduced against the
 * first cut with a real browser are pinned below: a registered server
 * redirecting to a stranger, and a registered server that closed its listener
 * while alive as a stranger reused its port. The pure function carries the
 * cases; the browser tests prove the wiring.
 */

const sandboxes: ToolSandbox[] = [];
const dirs: string[] = [];
const servers: Server[] = [];

const INDEX = '<!doctype html><title>root</title><h1 id="root">root page</h1>';
const OTHER = '<!doctype html><title>other</title><h1 id="other">another page</h1>';

function workspace(files: Record<string, string> = { 'index.html': INDEX }): ToolSandbox {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-docbind-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const abs = join(dir, name);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  const sandbox = new ToolSandbox(dir);
  sandboxes.push(sandbox);
  return sandbox;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A server that serves `body` at every path, listening on `port` (0 = any). */
async function strangerServer(body: string, port = 0): Promise<{ port: number; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not listen');
  return { port: address.port, server };
}

/** A port this very process listens on, so `{ pid: process.pid }` is a truthful origin. */
async function ownListener(body = INDEX): Promise<number> {
  return (await strangerServer(body)).port;
}

/** A pid that certainly belonged to a process and certainly does not any more. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('no pid');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return pid;
}

async function waitForExit(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`pid ${pid} still alive`);
}

/** The Node server the family requires: `index.html` at the workspace root, served at `/`. */
const NODE_SERVES_ROOT_INDEX = `
const http = require('http');
const fs = require('fs');
const path = require('path');
const server = http.createServer((req, res) => {
  const file = req.url === '/' ? 'index.html' : req.url.slice(1);
  try {
    const bytes = fs.readFileSync(path.join(__dirname, file));
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(bytes);
  } catch {
    res.writeHead(404); res.end();
  }
});
server.listen(Number(process.env.PORT) || 0, '127.0.0.1', function () {
  console.log('LISTENING_ON_PORT=' + this.address().port);
});
`;

/** The decisive negative: root `index.html` exists and is unchanged, the server returns something else. */
const NODE_SERVES_OTHER_PAGE = `
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(${JSON.stringify(OTHER)});
});
server.listen(Number(process.env.PORT) || 0, '127.0.0.1', function () {
  console.log('LISTENING_ON_PORT=' + this.address().port);
});
`;

/** Answers the root file, then on GET /release closes its listener and stays alive on a timer. */
const NODE_RELEASES_PORT_AND_LIVES = `
const http = require('http');
const fs = require('fs');
setInterval(() => {}, 1000);
const server = http.createServer((req, res) => {
  if (req.url === '/release') {
    res.setHeader('connection', 'close');
    res.end('released');
    server.close(() => fs.writeFileSync('closed.flag', 'yes'));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(fs.readFileSync('index.html'));
});
server.listen(Number(process.env.PORT) || 0, '127.0.0.1', function () {
  console.log('LISTENING_ON_PORT=' + this.address().port);
});
`;

/** Redirects every request to the URL in REDIRECT_TO. */
const NODE_REDIRECTS = (to: string) => `
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(302, { location: ${JSON.stringify(to)} + req.url.slice(1) });
  res.end();
});
server.listen(Number(process.env.PORT) || 0, '127.0.0.1', function () {
  console.log('LISTENING_ON_PORT=' + this.address().port);
});
`;

/** Serves the root file at /, and 302-redirects / to /other.html when asked via /go. */
const NODE_REDIRECTS_SAME_ORIGIN = `
const http = require('http');
const fs = require('fs');
const server = http.createServer((req, res) => {
  if (req.url === '/go') { res.writeHead(302, { location: '/other.html' }); res.end(); return; }
  const file = req.url === '/' ? 'index.html' : req.url.slice(1);
  try { const bytes = fs.readFileSync(file); res.writeHead(200, { 'content-type': 'text/html' }); res.end(bytes); }
  catch { res.writeHead(404); res.end(); }
});
server.listen(Number(process.env.PORT) || 0, '127.0.0.1', function () {
  console.log('LISTENING_ON_PORT=' + this.address().port);
});
`;

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      readFileSync(path);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw new Error(`${path} never appeared`);
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const s of sandboxes.splice(0)) await s.cleanup().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('designatedDocumentFor — a designation, not a proof', () => {
  it('maps a directory request to index.html and reports the port', () => {
    const sandbox = workspace({ 'index.html': INDEX, 'sub/index.html': OTHER });
    expect(designatedDocumentFor(sandbox, 'http://127.0.0.1:4321/')).toMatchObject({ path: 'index.html', port: 4321 });
    expect(designatedDocumentFor(sandbox, 'http://localhost:4321/sub/')).toMatchObject({ path: 'sub/index.html', port: 4321 });
  });

  it('is silent on a non-loopback host and a missing file; a bare origin designates index.html', () => {
    const sandbox = workspace();
    expect(designatedDocumentFor(sandbox, 'http://example.com/index.html')).toBeUndefined();
    expect(designatedDocumentFor(sandbox, 'http://127.0.0.1:4321/missing.html')).toBeUndefined();
    // `new URL` normalises an empty path to `/`, so a bare origin is a
    // directory request — the same designation the trailing slash gets.
    expect(designatedDocumentFor(sandbox, 'http://127.0.0.1:4321')).toMatchObject({ path: 'index.html', port: 4321 });
  });
});

describe('port ownership is asked of the kernel', () => {
  it('sees this process on a port it listens on, and nobody on a free port', async () => {
    const port = await ownListener();
    expect(await pidsListeningOn(port)).toContain(process.pid);
    expect(await processHoldsListeningPort(process.pid, port)).toBe(true);
    const free = await ownListener();
    // Close it and ask again: the kernel table is the witness, not our memory.
    const s = servers.pop()!;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
    expect(await processHoldsListeningPort(process.pid, free)).toBe(false);
  });

  it('an ALIVE registered process that no longer listens does not hold the port', async () => {
    const sandbox = workspace({ 'index.html': INDEX, 'server.js': NODE_RELEASES_PORT_AND_LIVES });
    const origins: ServedOrigins = new Map();
    const served = (await startNodeServerTool({ sandbox, servedOrigins: origins }).execute({ entry: 'server.js' })) as {
      ok: boolean;
      port: number;
      pid: number;
    };
    expect(served.ok, JSON.stringify(served)).toBe(true);
    expect(await servedOriginHoldsPort(origins, served.port)).toBeDefined();
    await (await fetch(`http://127.0.0.1:${served.port}/release`, { headers: { connection: 'close' } })).text();
    await waitForFile(join(sandbox.root, 'closed.flag'));
    // Still alive…
    expect(() => process.kill(served.pid, 0)).not.toThrow();
    // …and no longer the owner.
    expect(await servedOriginHoldsPort(origins, served.port)).toBeUndefined();
  });
});

describe('bindObservedDocument — the mechanical cases', () => {
  it('binds when our origin, holding the port, returned the designated file byte for byte', async () => {
    const sandbox = workspace();
    const port = await ownListener();
    const origins: ServedOrigins = new Map([[port, { kind: 'node', pid: process.pid, entry: 'server.js' }]]);
    const bound = await bindObservedDocument({ sandbox, url: `http://127.0.0.1:${port}/`, origins, response: Buffer.from(INDEX) });
    expect(bound).toEqual({ path: 'index.html', sha256: sha256(INDEX) });
    // The equality makes the response digest the FILE's digest too, which is
    // what `documentStillMatches` re-reads at verdict time.
    expect(bound?.sha256).toBe(sha256(readFileSync(join(sandbox.root, 'index.html'))));
  });

  it('DECISIVE NEGATIVE: root index.html present and unchanged, server returned another page — unbound', async () => {
    const sandbox = workspace();
    const port = await ownListener();
    const origins: ServedOrigins = new Map([[port, { kind: 'node', pid: process.pid, entry: 'server.js' }]]);
    expect(
      await bindObservedDocument({ sandbox, url: `http://127.0.0.1:${port}/`, origins, response: Buffer.from(OTHER) })
    ).toBeUndefined();
    // The file is untouched: the OLD rule would have bound this observation.
    expect(readFileSync(join(sandbox.root, 'index.html'), 'utf8')).toBe(INDEX);
  });

  it('refuses an origin this tool set never bound, even with equal bytes', async () => {
    const sandbox = workspace();
    const port = await ownListener();
    expect(
      await bindObservedDocument({ sandbox, url: `http://127.0.0.1:${port}/`, origins: new Map(), response: Buffer.from(INDEX) })
    ).toBeUndefined();
    expect(
      await bindObservedDocument({ sandbox, url: `http://127.0.0.1:${port}/`, origins: undefined, response: Buffer.from(INDEX) })
    ).toBeUndefined();
  });

  it('refuses a STALE origin: the port was ours, its process has exited', async () => {
    const sandbox = workspace();
    const port = await ownListener();
    const origins: ServedOrigins = new Map([[port, { kind: 'static', pid: await deadPid() }]]);
    expect(await servedOriginHoldsPort(origins, port)).toBeUndefined();
    expect(
      await bindObservedDocument({ sandbox, url: `http://127.0.0.1:${port}/`, origins, response: Buffer.from(INDEX) })
    ).toBeUndefined();
    // An origin recorded without a pid cannot be proven to hold anything.
    expect(await servedOriginHoldsPort(new Map([[port, { kind: 'static', pid: undefined }]]), port)).toBeUndefined();
  });

  it('binds nothing when no response bytes were captured', async () => {
    const sandbox = workspace();
    const port = await ownListener();
    const origins: ServedOrigins = new Map([[port, { kind: 'static', pid: process.pid }]]);
    expect(await bindObservedDocument({ sandbox, url: `http://127.0.0.1:${port}/`, origins, response: undefined })).toBeUndefined();
  });
});

describe('the tool set shares ONE origin registry', () => {
  it('registers the static server and the node server with kind, pid and entry', async () => {
    const sandbox = workspace({ 'index.html': INDEX, 'server.js': NODE_SERVES_ROOT_INDEX });
    const origins: ServedOrigins = new Map();
    const tools = defaultBuiltinTools({ sandbox, servedOrigins: origins });
    const byName = (name: string) => tools.find((t) => t.declaration.name === name)!;

    const node = (await byName('start_node_server').execute({ entry: 'server.js' })) as { ok: boolean; port: number; pid: number };
    expect(node.ok).toBe(true);
    expect(origins.get(node.port)).toEqual({ kind: 'node', pid: node.pid, entry: 'server.js' });

    const stat = (await byName('start_static_server').execute({})) as { ok: boolean; port: number; pid: number };
    expect(stat.ok).toBe(true);
    expect(origins.get(stat.port)).toEqual({ kind: 'static', pid: stat.pid });
  });
});

describe('validate_html binds on the response the browser actually loaded', () => {
  it('POSITIVE, static: the workspace-root index.html served verbatim is bound with its digest', async () => {
    const sandbox = workspace();
    const origins: ServedOrigins = new Map();
    const served = (await startStaticServerTool({ sandbox, servedOrigins: origins }).execute({})) as { ok: boolean; url: string };
    expect(served.ok, JSON.stringify(served)).toBe(true);
    const res = (await validateHtmlTool({ sandbox, servedOrigins: origins }).execute({ url: served.url })) as {
      ok: boolean;
      document?: { path: string; sha256: string };
    };
    expect(res.ok).toBe(true);
    expect(res.document).toEqual({ path: 'index.html', sha256: sha256(INDEX) });
  });

  it('POSITIVE, node: a server we launched returning the root index.html byte for byte is bound', async () => {
    const sandbox = workspace({ 'index.html': INDEX, 'server.js': NODE_SERVES_ROOT_INDEX });
    const origins: ServedOrigins = new Map();
    const served = (await startNodeServerTool({ sandbox, servedOrigins: origins }).execute({ entry: 'server.js' })) as {
      ok: boolean;
      url: string;
    };
    expect(served.ok, JSON.stringify(served)).toBe(true);
    const res = (await validateHtmlTool({ sandbox, servedOrigins: origins }).execute({
      url: served.url,
      smoke: '({ ok: !!document.getElementById("root") })',
    })) as { ok: boolean; document?: { path: string; sha256: string } };
    expect(res.ok).toBe(true);
    expect(res.document).toEqual({ path: 'index.html', sha256: sha256(INDEX) });
  });

  it('DECISIVE NEGATIVE, node: root index.html unchanged while our server returns another page — observed, UNBOUND', async () => {
    const sandbox = workspace({ 'index.html': INDEX, 'server.js': NODE_SERVES_OTHER_PAGE });
    const origins: ServedOrigins = new Map();
    const served = (await startNodeServerTool({ sandbox, servedOrigins: origins }).execute({ entry: 'server.js' })) as {
      ok: boolean;
      url: string;
    };
    expect(served.ok, JSON.stringify(served)).toBe(true);
    const res = (await validateHtmlTool({ sandbox, servedOrigins: origins }).execute({
      url: served.url,
      smoke: '({ ok: !!document.getElementById("other") })',
    })) as { ok: boolean; document?: { path: string; sha256: string }; smokeResult?: { ok: boolean } };
    // The observation itself stands — the page loaded and the smoke ran.
    expect(res.ok).toBe(true);
    expect(res.smokeResult).toEqual({ ok: true });
    // The binding does not: launched by start_node_server, bytes differ.
    expect(res.document).toBeUndefined();
    expect(readFileSync(join(sandbox.root, 'index.html'), 'utf8')).toBe(INDEX);
  });

  it('STALE ORIGIN: our server exited and a stranger answers on its port with the very same bytes — UNBOUND', async () => {
    const sandbox = workspace({ 'index.html': INDEX, 'server.js': NODE_SERVES_ROOT_INDEX });
    const origins: ServedOrigins = new Map();
    const served = (await startNodeServerTool({ sandbox, servedOrigins: origins }).execute({ entry: 'server.js' })) as {
      ok: boolean;
      url: string;
      port: number;
      pid: number;
    };
    expect(served.ok, JSON.stringify(served)).toBe(true);
    process.kill(served.pid, 'SIGKILL');
    await waitForExit(served.pid);
    // Same port, same bytes, not our process.
    await strangerServer(INDEX, served.port);
    const res = (await validateHtmlTool({ sandbox, servedOrigins: origins }).execute({ url: served.url })) as {
      ok: boolean;
      document?: { path: string; sha256: string };
    };
    expect(res.ok).toBe(true);
    expect(res.document).toBeUndefined();
  });

  it('REDIRECT (reproduced false binding): our server 302s to a stranger serving the root bytes — UNBOUND, and said so', async () => {
    const { port: foreign } = await strangerServer(INDEX);
    const sandbox = workspace({ 'index.html': INDEX, 'server.js': NODE_REDIRECTS(`http://127.0.0.1:${foreign}/`) });
    const origins: ServedOrigins = new Map();
    const served = (await startNodeServerTool({ sandbox, servedOrigins: origins }).execute({ entry: 'server.js' })) as {
      ok: boolean;
      url: string;
    };
    expect(served.ok, JSON.stringify(served)).toBe(true);
    const res = (await validateHtmlTool({ sandbox, servedOrigins: origins }).execute({
      url: served.url,
      smoke: '({ ok: !!document.getElementById("root"), location: location.href })',
    })) as { ok: boolean; warnings: string[]; document?: { path: string; sha256: string }; smokeResult?: { ok: boolean; location: string } };
    // The browser really landed on the stranger and saw the root bytes…
    expect(res.smokeResult?.ok).toBe(true);
    expect(res.smokeResult?.location).toContain(`:${foreign}/`);
    // …so the first cut bound this to index.html under OUR port. Not any more.
    expect(res.document).toBeUndefined();
    expect(res.warnings.some((w) => /redirected to http:\/\/127\.0\.0\.1:\d+\/; the document binding follows the final response/.test(w))).toBe(true);
  });

  it('SAME-ORIGIN REDIRECT: the binding follows the FINAL path, not the requested one', async () => {
    const sandbox = workspace({ 'index.html': INDEX, 'other.html': OTHER, 'server.js': NODE_REDIRECTS_SAME_ORIGIN });
    const origins: ServedOrigins = new Map();
    const served = (await startNodeServerTool({ sandbox, servedOrigins: origins }).execute({ entry: 'server.js' })) as {
      ok: boolean;
      url: string;
    };
    expect(served.ok, JSON.stringify(served)).toBe(true);
    const res = (await validateHtmlTool({ sandbox, servedOrigins: origins }).execute({ url: `${served.url}go` })) as {
      ok: boolean;
      warnings: string[];
      document?: { path: string; sha256: string };
    };
    expect(res.ok).toBe(true);
    expect(res.document).toEqual({ path: 'other.html', sha256: sha256(OTHER) });
    // Same origin: no redirect warning, the port never changed hands.
    expect(res.warnings.some((w) => /redirected to/.test(w))).toBe(false);
  });

  it('PORT REUSE (reproduced false binding): our server closed its listener and lives on, a stranger reuses the port — UNBOUND', async () => {
    const sandbox = workspace({ 'index.html': INDEX, 'server.js': NODE_RELEASES_PORT_AND_LIVES });
    const origins: ServedOrigins = new Map();
    const served = (await startNodeServerTool({ sandbox, servedOrigins: origins }).execute({ entry: 'server.js' })) as {
      ok: boolean;
      url: string;
      port: number;
      pid: number;
    };
    expect(served.ok, JSON.stringify(served)).toBe(true);
    await (await fetch(`http://127.0.0.1:${served.port}/release`, { headers: { connection: 'close' } })).text();
    await waitForFile(join(sandbox.root, 'closed.flag'));
    expect(() => process.kill(served.pid, 0)).not.toThrow(); // alive, by design of the repro
    await strangerServer(INDEX, served.port); // same port, same bytes, not the registered holder
    const res = (await validateHtmlTool({ sandbox, servedOrigins: origins }).execute({ url: served.url })) as {
      ok: boolean;
      document?: { path: string; sha256: string };
    };
    expect(res.ok).toBe(true);
    expect(res.document).toBeUndefined();
  });

  it('UNKNOWN ORIGIN: a loopback server this tool set never started is not bound, even serving the root file', async () => {
    const sandbox = workspace();
    const { port } = await strangerServer(INDEX);
    const res = (await validateHtmlTool({ sandbox, servedOrigins: new Map() }).execute({
      url: `http://127.0.0.1:${port}/`,
    })) as { ok: boolean; document?: { path: string; sha256: string } };
    expect(res.ok).toBe(true);
    expect(res.document).toBeUndefined();
  });
});
