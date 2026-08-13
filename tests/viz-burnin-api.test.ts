import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const children: ReturnType<typeof spawn>[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGTERM');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function startViz(port: number, root: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/viz/server.ts',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--dir',
      join(root, 'runs'),
      '--db',
      join(root, 'missing.db'),
      '--skills-dir',
      join(root, 'skills'),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  children.push(child);
  return child;
}

async function waitForResponse(url: string, init?: RequestInit): Promise<Response | undefined> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, init);
    } catch {
      // The tsx process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

describe('GET /api/burnin', () => {
  it('normalizes legacy provider attribution and lifecycle defaults', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-viz-burnin-'));
    roots.push(root);
    const csv = join(root, 'results.csv');
    writeFileSync(
      csv,
      [
        'timestamp,task_id,family,outcome,cost_usd,duration_s,llm_calls,opus_calls,sonnet_calls,haiku_calls,deterministic_phases,escalations,learned_skills,promotions,refusals,demotions,dispatch_fallbacks,trace,provider,other_calls,learned_event_skills,compile_errors',
        '2026-08-03T08:47:27.027Z,http-echo,http,delivered,0.2519,211,18,1,0,17,0,0,0,legacy.json',
        '2026-08-13T08:25:36.355Z,new-run,files,delivered,0.1574,126,11,0,0,0,1,0,0,1,0,0,0,new.json,ollama+zai+codex,11,0,0',
        '2026-08-13T09:00:00.000Z,no-model,files,error,,,,0,0,0,0,0,0,0,0,0,0,none.json',
      ].join('\n') + '\n'
    );
    const port = await freePort();
    startViz(port, root, { ATOMA_BURNIN_CSV: csv });

    const response = await waitForResponse(`http://127.0.0.1:${port}/api/burnin`);
    expect(response?.ok).toBe(true);
    const payload = (await response!.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(payload.rows).toHaveLength(3);
    expect(payload.rows[0]).toMatchObject({
      taskId: 'http-echo',
      provider: 'claude-legacy',
      otherCalls: 0,
      refusals: 0,
      compileErrors: 0,
    });
    expect(payload.rows[1]).toMatchObject({
      taskId: 'new-run',
      provider: 'ollama+zai+codex',
      otherCalls: 11,
    });
    expect(payload.rows[2]).toMatchObject({
      taskId: 'no-model',
      provider: 'unknown',
    });
    expect(payload.rows.every((row) => row['provider'] !== '')).toBe(true);
  }, 20_000);
});

describe('development UI routing', () => {
  it('redirects the API root to Vite while keeping API routes local', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-viz-dev-root-'));
    roots.push(root);
    const port = await freePort();
    startViz(port, root, {
      ATOMA_BURNIN_CSV: join(root, 'missing.csv'),
      ATOMA_VIZ_DEV_URL: 'http://127.0.0.1:5173',
    });

    const rootResponse = await waitForResponse(
      `http://127.0.0.1:${port}/?lang=fr`,
      { redirect: 'manual' }
    );
    expect(rootResponse?.status).toBe(307);
    expect(rootResponse?.headers.get('location')).toBe('http://127.0.0.1:5173/?lang=fr');

    const apiResponse = await fetch(`http://127.0.0.1:${port}/api/burnin`);
    expect(apiResponse.ok).toBe(true);
    expect(await apiResponse.json()).toMatchObject({ rows: [] });
  }, 20_000);
});
