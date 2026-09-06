#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vizEntry = resolve(root, 'dist/viz/server.js');
const vizIndex = resolve(root, 'dist/viz/client/index.html');
const mcpTools = resolve(root, 'dist/mcp/tools.js');
const releaseVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
if (!existsSync(vizEntry) || !existsSync(vizIndex)) {
  throw new Error('compiled viz server/client missing (run npm run build first)');
}
if (!existsSync(mcpTools)) {
  throw new Error(`compiled MCP catalogue missing: ${mcpTools} (run npm run build first)`);
}
// Also runs on the production host after npm ci --omit=dev, before activation.
await import('./sqlite-release-smoke.mjs');
const smokeRoot = mkdtempSync(join(tmpdir(), 'atoma-release-smoke-'));

const freePort = async () =>
  await new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => (error ? rejectPort(error) : resolvePort(port)));
    });
  });

/**
 * THE MCP, THROUGH THE COMPILED SERVER. One surface for everyone (decision
 * 2026-09-05): on the ungated loopback the caller is the operator and the
 * catalogue is the operator's — operator runs, registry, skills, ledger,
 * traces, friction — with nothing tenant-shaped, since this store has no
 * organisations. Plain JSON responses, one session, the prompt surface with a
 * completion, and a deliberately refused call.
 */
const mcpSmoke = async (base) => {
  const accessResponse = await fetch(`${base}/api/tokens`);
  const access = await accessResponse.json();
  if (!accessResponse.ok || access.mode !== 'operator' || access.mcpUrl !== `${base}/mcp`) {
    throw new Error('compiled MCP access discovery did not publish the operator URL');
  }
  let sessionId = null;
  let nextId = 1;
  const call = async (method, params = {}) => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    if (!response.ok) throw new Error(`MCP ${method} → HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const frame = await response.json();
    if (frame.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(frame.error)}`);
    return frame.result;
  };
  const notify = async (method) => {
    await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    });
  };
  const initialized = await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'atoma-release-smoke', version: releaseVersion },
  });
  if (!sessionId) throw new Error('compiled MCP returned no session id');
  if (!initialized?.capabilities?.completions) throw new Error('compiled MCP does not advertise the completions capability');
  await notify('notifications/initialized');
  const { tools } = await call('tools/list');
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('compiled MCP listed no tools');
  const names = tools.map((tool) => tool.name);
  for (const required of ['atoma_operator_run_start', 'atoma_operator_run_cancel', 'atoma_registry_list', 'atoma_run_trace']) {
    if (!names.includes(required)) throw new Error(`compiled MCP is missing ${required}`);
  }
  for (const tenantOnly of ['atoma_projects_list', 'atoma_run_start', 'atoma_org_members', 'atoma_journal_tail']) {
    if (names.includes(tenantOnly)) throw new Error(`ungated MCP must not expose ${tenantOnly}`);
  }
  const families = await call('tools/call', { name: 'atoma_families', arguments: {} });
  const familiesText = families?.content?.[0]?.text;
  if (typeof familiesText !== 'string' || !Array.isArray(JSON.parse(familiesText).families)) {
    throw new Error('atoma_families returned no families');
  }
  const refused = await call('tools/call', { name: 'atoma_run_trace', arguments: { file: '../etc/passwd' } });
  if (!JSON.stringify(refused).includes('refused')) throw new Error('atoma_run_trace did not refuse a traversal');
  const { prompts } = await call('prompts/list');
  if (!Array.isArray(prompts) || prompts.length < 4) {
    throw new Error(`expected the compiled MCP prompt surface, got ${Array.isArray(prompts) ? prompts.length : 'none'}`);
  }
  for (const required of ['atoma_goal_build', 'atoma_inspect_trace', 'atoma_inspect_agent']) {
    if (!prompts.some((prompt) => prompt.name === required)) throw new Error(`compiled MCP is missing prompt ${required}`);
  }
  const completed = await call('completion/complete', {
    ref: { type: 'ref/prompt', name: 'atoma_goal_build' },
    argument: { name: 'goal', value: '' },
  });
  if (!Array.isArray(completed?.completion?.values) || completed.completion.values.length === 0) {
    throw new Error('compiled MCP returned no goal completions for the build family');
  }
  // A caller without a session must be told to initialise, never served.
  const noSession = await fetch(`${base}/mcp`, { method: 'GET', headers: { accept: 'text/event-stream' } });
  if (noSession.status !== 400) throw new Error(`MCP GET without a session answered ${noSession.status}, expected 400`);
  return { tools: tools.length, prompts: prompts.length };
};

try {
  const port = await freePort();
  // EXPLICIT --dir and --db. The compiled server defaults `--dir` from
  // ATOMA_RUNS_DIR and now hosts a resident watch, so an inherited variable
  // would aim this smoke at whatever corpus the machine happens to have.
  const vizRuns = join(smokeRoot, 'runs');
  const viz = spawn(
    process.execPath,
    [
      vizEntry,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--dir', vizRuns,
      '--db', join(smokeRoot, 'store.db'),
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let vizStderr = '';
  viz.stderr.on('data', (chunk) => {
    vizStderr += chunk.toString();
  });
  const vizExited = new Promise((resolveExit) => viz.once('exit', resolveExit));
  try {
    const deadline = Date.now() + 10_000;
    let response;
    while (Date.now() < deadline) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) break;
      } catch {
        // Server is still starting.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    if (!response?.ok) throw new Error(`compiled viz did not become ready: ${vizStderr.slice(-500)}`);
    const html = await response.text();
    const asset = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    if (!asset) throw new Error('compiled viz index has no module asset');
    const assetResponse = await fetch(`http://127.0.0.1:${port}${asset}`);
    if (!assetResponse.ok) throw new Error(`compiled viz asset failed: ${assetResponse.status}`);
    const manifestResponse = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
    const manifest = await manifestResponse.json();
    if (
      !manifestResponse.ok ||
      !manifestResponse.headers.get('content-type')?.startsWith('application/manifest+json') ||
      manifest.short_name !== 'Atoma' ||
      !Array.isArray(manifest.icons) ||
      manifest.icons.length < 3
    ) {
      throw new Error('compiled viz PWA manifest is missing or invalid');
    }
    for (const path of [
      '/favicon.svg',
      '/apple-touch-icon.png',
      '/icons/atoma-192.png',
      '/icons/atoma-512.png',
      '/icons/atoma-maskable-512.png',
      '/og-card.png',
      '/sw.js',
    ]) {
      const staticResponse = await fetch(`http://127.0.0.1:${port}${path}`);
      if (!staticResponse.ok) {
        throw new Error(`compiled viz PWA asset failed: ${path} → ${staticResponse.status}`);
      }
    }
    const mcp = await mcpSmoke(`http://127.0.0.1:${port}`);
    process.stdout.write(`release smoke: MCP over HTTP — ${mcp.tools} operator tools, ${mcp.prompts} prompts\n`);
    const burninResponse = await fetch(`http://127.0.0.1:${port}/api/burnin`);
    const burnin = await burninResponse.json();
    if (!burninResponse.ok || !Array.isArray(burnin.rows)) {
      throw new Error('compiled viz /api/burnin did not return rows');
    }
  } finally {
    if (viz.exitCode === null) viz.kill('SIGTERM');
    await Promise.race([
      vizExited,
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    if (viz.exitCode === null) {
      viz.kill('SIGKILL');
      await Promise.race([
        vizExited,
        new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
      ]);
    }
  }
  process.stdout.write('release smoke ok: compiled viz UI/API and the MCP through it\n');
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}
