import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The `tabstat` benchmark seed and its scorer are EVIDENCE INSTRUMENTS, and
 * both fail silently if they drift.
 *
 * - A seed whose README/manifest no longer match its own CLI hands both arms a
 *   task that cannot be passed, and the resulting failures read as model
 *   failures. Round 3 already paid for a hand-transcribed manifest once.
 * - A scorer that passes the UNTOUCHED seed scores "change nothing" as full
 *   marks. That is not hypothetical: round 10's instrument could not
 *   discriminate on `wclite-maint` and every deliverable of every arm came back
 *   at 10/10, which is what made a harder task necessary in the first place.
 *
 * Both properties are cheap to assert and expensive to lose, so they are
 * asserted here rather than trusted to a pre-round checklist.
 */
const repoRoot = join(import.meta.dirname, '..');
const seedDir = join(repoRoot, 'benchmark', 'seeds', 'tabstat');

function node(script: string, args: readonly string[]): { status: number; stdout: string } {
  try {
    return {
      status: 0,
      stdout: execFileSync('node', [join(repoRoot, 'benchmark', script), ...args], {
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { status: err.status ?? -1, stdout: String(err.stdout ?? '') };
  }
}

describe('tabstat benchmark seed', () => {
  it('is self-consistent: every documented invocation replays as recorded', () => {
    const { status, stdout } = node('make-tabstat-seed.mjs', ['--check']);
    expect(stdout + status).toContain('self-consistent');
    expect(status).toBe(0);
  });
});

describe('verify-tabstat scorer', () => {
  it('REFUSES the untouched seed — doing nothing must not score full marks', () => {
    const { stdout } = node('verify-tabstat.mjs', [seedDir, 'tabstat-maint']);
    const result = JSON.parse(stdout) as { score: number; total: number; full: boolean };
    expect(result.full).toBe(false);
    expect(result.score).toBeLessThan(result.total);
  });

  it('refuses the untouched seed on the held-out goal too', () => {
    const { stdout } = node('verify-tabstat.mjs', [seedDir, 'tabstat-maint-2']);
    const result = JSON.parse(stdout) as { full: boolean; checks: { id: string; ok: boolean }[] };
    expect(result.full).toBe(false);
    // The index feature is what the held-out goal asks for and the seed lacks.
    expect(result.checks.find((c) => c.id === 'index-selects-same-column')?.ok).toBe(false);
  });

  it('scores a workspace with no artefact at zero rather than throwing', () => {
    const { stdout } = node('verify-tabstat.mjs', [join(repoRoot, 'benchmark'), 'tabstat-maint']);
    const result = JSON.parse(stdout) as { score: number; checks: { id: string }[] };
    expect(result.score).toBe(0);
    expect(result.checks[0]?.id).toBe('artefact');
  });
});
