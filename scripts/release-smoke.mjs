#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'dist/mcp/stdio.js');
if (!existsSync(entry)) {
  throw new Error(`compiled MCP entry missing: ${entry} (run npm run build first)`);
}

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
      clientInfo: { name: 'atoma-release-smoke', version: '0.1.0' },
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
  process.stdout.write(`release smoke ok: ${tools.length} MCP tools, JSON-only stdout\n`);
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
}
