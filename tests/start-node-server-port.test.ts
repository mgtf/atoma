import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { startNodeServerTool, type ServedOrigins } from '../src/tools/builtin.js';

/**
 * "Listen on PORT, default 3000" compiles to `Number(process.env.PORT) ||
 * 3000`, and the tool used to inject PORT=0: falsy, so the server bound 3000
 * and the next start in the same run died on EADDRINUSE against the first.
 * Production run 811782c2 (2026-09-26) rewrote the delivered server to
 * `PORT ?? 0`, breaking its own default, to get past the tool.
 */
const DEFAULT_3000 = [
  "import { createServer } from 'node:http';",
  'const port = Number(process.env.PORT) || 3000;',
  "const server = createServer((_req, res) => { res.end('ok'); });",
  "server.listen(port, () => console.log('LISTENING_ON_PORT=' + server.address().port));",
].join('\n');

const sandboxes: ToolSandbox[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await sandbox.cleanup().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('start_node_server port', () => {
  it('gives a "default 3000" server a real port, so a restart in the same run does not collide', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-node-port-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'server.mjs'), DEFAULT_3000);
    const sandbox = new ToolSandbox(dir);
    sandboxes.push(sandbox);
    const origins: ServedOrigins = new Map();
    const tool = startNodeServerTool({ sandbox, servedOrigins: origins });
    const first = (await tool.execute({ entry: 'server.mjs' })) as { ok: boolean; port: number; error?: string };
    const second = (await tool.execute({ entry: 'server.mjs' })) as { ok: boolean; port: number; error?: string };
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(first.port).not.toBe(3000);
    expect(second.port).not.toBe(first.port);
    const answered = await fetch(`http://127.0.0.1:${second.port}/`).then((res) => res.text());
    expect(answered).toBe('ok');
  }, 30_000);
});
