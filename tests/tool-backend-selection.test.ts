import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRunnerArgs } from '../src/run/runner.js';
import { localToolBackend } from '../src/run/toolBackend.js';

/**
 * The container path is a SECOND code path that only runs when someone asks
 * for it, and this repo has twice paid for exactly that shape: the
 * `research-brief.ts` entrypoint silently drifted away from every safety
 * guarantee the build path gained, and `curriculum.ts`'s copy of the provider
 * switch stopped matching the original. Unexercised alternatives rot.
 *
 * A burn-in batch is not the insurance — it would answer a question nobody is
 * asking (local stays local; a SaaS deployment always containerises, by
 * construction). Keeping the SELECTION honest is. The tool layer itself is
 * covered against a real container in `container-isolation.test.ts`.
 */

const dirs: string[] = [];
afterEach(() => {
  delete process.env['ATOMA_CONTAINER'];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ws(): string {
  const d = mkdtempSync(join(tmpdir(), 'atoma-backend-'));
  dirs.push(d);
  return d;
}

describe('backend selection', () => {
  it('defaults to local', () => {
    expect(parseRunnerArgs(['a goal']).container).toBe(false);
  });

  it('--container opts in, --no-container opts back out', () => {
    expect(parseRunnerArgs(['--container', 'g']).container).toBe(true);
    expect(parseRunnerArgs(['--container', '--no-container', 'g']).container).toBe(false);
  });

  it('ATOMA_CONTAINER=1 opts in, and the flag still overrides it', () => {
    process.env['ATOMA_CONTAINER'] = '1';
    expect(parseRunnerArgs(['g']).container).toBe(true);
    expect(parseRunnerArgs(['--no-container', 'g']).container).toBe(false);
  });

  it('neither flag is mistaken for the goal', () => {
    // parseRunnerArgs takes the first NON-flag token as the goal; a new flag
    // that slipped through would silently become the task description.
    expect(parseRunnerArgs(['--container', 'reverse a word']).goal).toBe('reverse a word');
    expect(parseRunnerArgs(['--no-container', 'reverse a word']).goal).toBe('reverse a word');
  });
});

describe('the two backends expose the same shape', () => {
  it('local declares the full builtin set and a real root', async () => {
    const b = localToolBackend({ workspaceRoot: ws(), logger: console as never });
    const names = b.toolDecls.map((t) => t.name);
    // The container backend is asserted against a live worker elsewhere; this
    // pins that both sides agree on WHAT a backend must provide.
    expect(names).toContain('write_file');
    expect(names).toContain('run_shell');
    expect(names).toContain('validate_html');
    expect(b.rootLabel).toContain('atoma-backend-');
    expect(typeof b.executor.execute).toBe('function');
    expect(b.executor.has('read_file')).toBe(true);
    await b.cleanup();
    await b.cleanup(); // must be safe twice — shutdown paths can both fire
  });
});
