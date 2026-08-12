import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { get } from 'node:http';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { startStaticServerTool } from '../src/tools/builtin.js';

/**
 * REAL integration tests — this tool had ZERO and its default path
 * (port=0) failed 100% of the time in production: python prints the
 * "Serving HTTP on :: port N" line on STDOUT, block-buffered when piped,
 * while the boot parser only listened on stderr. Every web run burned
 * LLM round-trips rediscovering that a hard-coded port "works".
 */

function fetchStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

describe('start_static_server — boot contract', () => {
  const dirs: string[] = [];
  const sandboxes: ToolSandbox[] = [];
  afterEach(async () => {
    for (const s of sandboxes.splice(0)) await s.cleanup();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('port=0 (the DEFAULT) boots and serves — the 100%-failure regression', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-static-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>ok</title>', 'utf8');
    const sandbox = new ToolSandbox(dir);
    sandboxes.push(sandbox);
    const tool = startStaticServerTool({ sandbox });
    const res = (await tool.execute({ port: 0 })) as { ok: boolean; url: string; port: number };
    expect(res.ok).toBe(true);
    expect(res.port).toBeGreaterThan(0);
    expect(await fetchStatus(res.url)).toBe(200);
  }, 15_000);

  it('busy fixed port auto-retries onto a WORKING OS-assigned server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-static2-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), 'hi', 'utf8');
    const sandbox = new ToolSandbox(dir);
    sandboxes.push(sandbox);
    const tool = startStaticServerTool({ sandbox });
    // Occupy a port with a first server, then ask a second for the same.
    const first = (await tool.execute({ port: 0 })) as { port: number };
    const second = (await tool.execute({ port: first.port })) as {
      ok: boolean;
      url: string;
      retriedFromPort?: number;
    };
    expect(second.ok).toBe(true);
    expect(second.retriedFromPort).toBe(first.port);
    // The retried server actually serves — the old parser could never
    // confirm a port=0 boot, so this path was structurally dead.
    expect(await fetchStatus(second.url)).toBe(200);
  }, 20_000);

  it('rejects out-of-range ports before Python can wrap them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-static3-'));
    dirs.push(dir);
    const sandbox = new ToolSandbox(dir);
    sandboxes.push(sandbox);
    const tool = startStaticServerTool({ sandbox });
    // macOS rejects 70000, but Linux Python wraps it to 4464 and serves
    // successfully. The contract must be platform-neutral before spawning.
    const t0 = Date.now();
    await expect(tool.execute({ port: 70000 })).rejects.toThrow(/between 0 and 65535/);
    await expect(tool.execute({ port: -1 })).rejects.toThrow(/between 0 and 65535/);
    await expect(tool.execute({ port: 1.5 })).rejects.toThrow(/between 0 and 65535/);
    expect(Date.now() - t0).toBeLessThan(100);
  }, 15_000);
});

describe('list_files — dangling symlink tolerance (audit rank-6)', () => {
  it('reports a dangling symlink as kind:symlink instead of throwing ENOENT', async () => {
    const { listFilesTool } = await import('../src/tools/builtin.js');
    const { symlinkSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'atoma-lstat-'));
    writeFileSync(join(dir, 'real.txt'), 'x', 'utf8');
    symlinkSync(join(dir, 'gone.txt'), join(dir, 'dangling'));
    const sandbox = new ToolSandbox(dir);
    const tool = listFilesTool({ sandbox });
    // statSync followed the link, hit ENOENT, and the whole listing threw —
    // breaking the read-back probe on an otherwise valid deliverable.
    const res = (await tool.execute({ path: '.' })) as {
      entries: { name: string; kind: string }[];
    };
    const kinds = Object.fromEntries(res.entries.map((e) => [e.name, e.kind]));
    expect(kinds['dangling']).toBe('symlink');
    expect(kinds['real.txt']).toBe('file');
    await sandbox.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
});
