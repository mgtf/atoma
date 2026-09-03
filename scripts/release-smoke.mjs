#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'dist/mcp/stdio.js');
const vizEntry = resolve(root, 'dist/viz/server.js');
const vizIndex = resolve(root, 'dist/viz/client/index.html');
const releaseVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
if (!existsSync(entry)) {
  throw new Error(`compiled MCP entry missing: ${entry} (run npm run build first)`);
}
if (!existsSync(vizEntry) || !existsSync(vizIndex)) {
  throw new Error('compiled viz server/client missing (run npm run build first)');
}
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

const child = spawn(process.execPath, [entry], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

const send = (message) => {
  child.stdin.write(`${JSON.stringify(message)}\n`);
};

const frames = () =>
  stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`non-JSON stdout from compiled MCP: ${line.slice(0, 200)}`);
      }
    });

const waitForFrame = async (id, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = frames().find((candidate) => candidate.id === id);
    if (frame) return frame;
    if (child.exitCode !== null) {
      throw new Error(`compiled MCP exited before frame ${id}; stderr: ${stderr.slice(-500)}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`timed out waiting for MCP frame ${id}; stderr: ${stderr.slice(-500)}`);
};

const exited = new Promise((resolveExit) => child.once('exit', resolveExit));

try {
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'atoma-release-smoke', version: releaseVersion },
    },
  });
  const initialized = await waitForFrame(1);
  if (!initialized.result) throw new Error(`MCP initialize failed: ${JSON.stringify(initialized)}`);

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const listed = await waitForFrame(2);
  const tools = listed.result?.tools;
  if (!Array.isArray(tools) || tools.length !== 13) {
    throw new Error(`expected 13 compiled MCP tools, got ${Array.isArray(tools) ? tools.length : 'none'}`);
  }
  const names = tools.map((tool) => tool.name);
  for (const required of ['atoma_run_start', 'atoma_run_cancel', 'atoma_registry_list']) {
    if (!names.includes(required)) throw new Error(`compiled MCP is missing ${required}`);
  }

  // The PROMPT surface ships in the same build and is just as droppable: a
  // packaged `dist/` missing `prompts.js` would still pass the tool count
  // above. `completion/complete` is prompt-scoped by protocol — there is no
  // tool ref — so proving one completion answers proves the whole capability.
  send({ jsonrpc: '2.0', id: 3, method: 'prompts/list' });
  const promptList = await waitForFrame(3);
  const prompts = promptList.result?.prompts;
  if (!Array.isArray(prompts) || prompts.length < 4) {
    throw new Error(
      `expected the compiled MCP prompt surface, got ${Array.isArray(prompts) ? prompts.length : 'none'}`
    );
  }
  for (const required of ['atoma_goal_build', 'atoma_inspect_trace', 'atoma_inspect_agent']) {
    if (!prompts.some((prompt) => prompt.name === required)) {
      throw new Error(`compiled MCP is missing prompt ${required}`);
    }
  }
  if (!initialized.result?.capabilities?.completions) {
    throw new Error('compiled MCP does not advertise the completions capability');
  }
  send({
    jsonrpc: '2.0',
    id: 4,
    method: 'completion/complete',
    params: {
      ref: { type: 'ref/prompt', name: 'atoma_goal_build' },
      argument: { name: 'goal', value: '' },
    },
  });
  const completed = await waitForFrame(4);
  if (!Array.isArray(completed.result?.completion?.values) || completed.result.completion.values.length === 0) {
    throw new Error('compiled MCP returned no goal completions for the build family');
  }

  // Re-parse every complete line after both responses: stdout purity is part
  // of the release contract, not just a unit-test property.
  frames();
  child.stdin.end();
  const exitCode = await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('compiled MCP did not stop after stdin closed')), 10_000)
    ),
  ]);
  if (exitCode !== 0) throw new Error(`compiled MCP exited ${exitCode}; stderr: ${stderr.slice(-500)}`);
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
  process.stdout.write(
    `release smoke ok: ${tools.length} MCP tools, ${prompts.length} prompts with completions, JSON-only stdout, compiled viz UI/API\n`
  );
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(smokeRoot, { recursive: true, force: true });
}
