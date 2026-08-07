import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ensureModuleResolutionBoundary } from '../src/examples/workspace.js';

/**
 * The environment leak this closes: the workspace lives under the atoma
 * repo, whose package.json says "type": "module" — so a task shipping
 * CommonJS .js files WITHOUT a local package.json crashed with "require is
 * not defined in ES module scope", caused by a file outside the sandbox
 * jail that neither the L1 nor any validator can see. 2/10 HTTP burn-in
 * runs hit it (whichever ones picked the CJS style); every one self-repaired
 * in-loop and left nothing durable behind — the defining shape of a defect
 * the skill machinery CANNOT converge on, which is why it gets a structural
 * fix instead.
 */

describe('ensureModuleResolutionBoundary', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'atoma-boundary-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('fences a workspace under a type:module ancestor — CommonJS runs again', () => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ type: 'module' }));
    const workspace = join(repo, 'build', 'app');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'probe.js'), "const http = require('http'); console.log('CJS_OK');");

    // Without the boundary the leak is live (this is the observed crash).
    const before = spawnSync(process.execPath, ['probe.js'], { cwd: workspace, encoding: 'utf8' });
    expect(before.status).not.toBe(0);
    expect(before.stderr).toMatch(/require is not defined in ES module scope/);

    ensureModuleResolutionBoundary(workspace);
    expect(readFileSync(join(repo, 'build', 'package.json'), 'utf8')).toBe('{}\n');

    const after = spawnSync(process.execPath, ['probe.js'], { cwd: workspace, encoding: 'utf8' });
    expect(after.status).toBe(0);
    expect(after.stdout).toContain('CJS_OK');
  });

  it('a task-authored package.json still wins over the sentinel (closer to the file)', () => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ type: 'module' }));
    const workspace = join(repo, 'build', 'app');
    mkdirSync(workspace, { recursive: true });
    ensureModuleResolutionBoundary(workspace);
    // The task ships its own ESM manifest — its .js files must stay ESM.
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(workspace, 'probe.js'), "import http from 'node:http'; console.log('ESM_OK');");
    const res = spawnSync(process.execPath, ['probe.js'], { cwd: workspace, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ESM_OK');
  });

  it('innocent layouts are never touched', () => {
    // (a) no ancestor package.json at all
    const ws1 = join(repo, 'plain', 'build', 'app');
    mkdirSync(ws1, { recursive: true });
    ensureModuleResolutionBoundary(ws1);
    expect(existsSync(join(repo, 'plain', 'build', 'package.json'))).toBe(false);

    // (b) nearest ancestor manifest is CommonJS-flavoured — sentinel would
    // change nothing, so no write into a directory that isn't ours to fix.
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'cjs-project' }));
    const ws2 = join(repo, 'build2', 'app');
    mkdirSync(ws2, { recursive: true });
    ensureModuleResolutionBoundary(ws2);
    expect(existsSync(join(repo, 'build2', 'package.json'))).toBe(false);
  });

  it('creates the harness-owned parent on a first run and is idempotent', () => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ type: 'module' }));
    const workspace = join(repo, 'build', 'app'); // neither build/ nor app/ exist yet
    ensureModuleResolutionBoundary(workspace);
    const sentinel = join(repo, 'build', 'package.json');
    expect(readFileSync(sentinel, 'utf8')).toBe('{}\n');
    // Second call: the sentinel already IS the boundary — untouched, no error.
    writeFileSync(sentinel, '{"custom":true}\n');
    ensureModuleResolutionBoundary(workspace);
    expect(readFileSync(sentinel, 'utf8')).toBe('{"custom":true}\n');
  });
});
