import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The mender's CI host (`.github/workflows/mender.yml`). What the file must
 * keep true, read as text because a workflow has no other test surface here:
 * it answers the dispatch the analyst sends, it is the ONE place the idle gate
 * is off, it runs one mend at a time, it never merges, and its records survive
 * a failed run.
 */

const workflow = readFileSync('.github/workflows/mender.yml', 'utf8');

describe('the mender workflow', () => {
  it('answers the analyst dispatch and the manual form with the same request shape', () => {
    expect(workflow).toContain('repository_dispatch:');
    expect(workflow).toContain('types: [atoma-mend]');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('--finding-file "${RUNNER_TEMP}/request.json"');
    expect(workflow).toContain('toJSON(github.event.client_payload)');
  });

  it('is the one host with the idle gate off, mends one at a time, and never merges', () => {
    expect(workflow).toContain('--no-idle-gate');
    expect(workflow).toMatch(/group: mender\n\s+cancel-in-progress: false/);
    // The prose says a person merges; no step does.
    expect(workflow).not.toMatch(/gh pr merge|--auto\b|enable-auto-merge/);
    expect(workflow).toMatch(/permissions:\n\s+contents: write\n\s+pull-requests: write/);
  });

  it('cuts the worktree from a full checkout and keeps the record whatever happened', () => {
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('path: ${{ runner.temp }}/supervisor');
    expect(workflow).toContain('--supervisor-dir "${RUNNER_TEMP}/supervisor"');
  });

  it('keeps its shell steps syntactically valid Bash', () => {
    const steps = [...workflow.matchAll(/ {8}run: \|\n((?: {10}.*\n)+)/g)].map((match) => match[1]!.replace(/^ {10}/gm, ''));
    expect(steps.length).toBeGreaterThanOrEqual(2);
    for (const script of steps) {
      // `${{ … }}` expressions are substituted by Actions before bash sees them.
      const parsed = spawnSync('bash', ['-n'], { input: script.replace(/\$\{\{[^}]*\}\}/g, 'x'), encoding: 'utf8' });
      expect(parsed.status, parsed.stderr).toBe(0);
    }
  });
});
