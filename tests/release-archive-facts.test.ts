import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { run as checkReadmeFacts } from '../scripts/readme-facts.mjs';

/**
 * The release workflow copies an explicit list of paths into the archive and
 * then runs `npm run docs:check` inside the extracted install. v0.2.0 failed
 * there: `.nvmrc` and `benchmark/` were read by the README facts generator
 * and were not in the list. This stages exactly what the workflow's
 * "Build release archive" step copies (symlinks stand in for copies) and
 * runs the same generator against the staged root.
 */
const repoRoot = resolve(import.meta.dirname, '..');
const staged = mkdtempSync(join(tmpdir(), 'atoma-release-archive-'));
afterAll(() => rmSync(staged, { recursive: true, force: true }));

function archiveEntries(): { paths: string[]; benchmarkMarkdown: boolean } {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
  const step = /- name: Build release archive[\s\S]*?(?=\n {6}- name:)/.exec(workflow)?.[0];
  expect(step, 'release.yml has a "Build release archive" step').toBeDefined();
  const paths: string[] = [];
  for (const line of step!.split('\n')) {
    const cp = /^\s*cp (?:-R )?(.+?) "release\/\$\{root\}\/"$/.exec(line);
    if (cp?.[1]) paths.push(...cp[1].split(/\s+/));
  }
  return { paths, benchmarkMarkdown: step!.includes('cp benchmark/*.md') };
}

describe('release archive facts', () => {
  it('lets docs:check run inside the extracted install from the copied paths alone', () => {
    const { paths, benchmarkMarkdown } = archiveEntries();
    expect(paths.length).toBeGreaterThan(5);
    for (const entry of paths) {
      // scripts/ is copied for real: Node resolves a symlinked module to its
      // target, which would point the generator back at this checkout.
      if (entry === 'scripts') cpSync(join(repoRoot, entry), join(staged, entry), { recursive: true });
      else if (entry !== 'dist') symlinkSync(join(repoRoot, entry), join(staged, entry));
    }
    if (benchmarkMarkdown) {
      mkdirSync(join(staged, 'benchmark'));
      cpSync(join(repoRoot, 'benchmark'), join(staged, 'benchmark'), {
        recursive: true,
        filter: (src) => src === join(repoRoot, 'benchmark') || src.endsWith('.md'),
      });
    }
    const result = checkReadmeFacts(staged, { apply: false });
    expect(result.problems).toEqual([]);
    expect(result.facts.version).toBe(
      (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version
    );
  });
});
