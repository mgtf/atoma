import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * THE PRE-COMMIT HOOK MUST NOT COMMIT WHAT YOU DID NOT STAGE.
 *
 * 2026-08-27, finding 2.8: `eslint --fix` writes the WORKTREE and `git add
 * <file>` then stages the whole file, so a file staged hunk-by-hunk with
 * `git add -p` had its deliberately-omitted hunks swept into the commit —
 * contradicting the hook's own comment and the root rule "preserve unrelated
 * dirty-worktree changes".
 *
 * Run against a REAL repository with `core.hooksPath` pointed at the real
 * hook: the defect is in what git does with the index, so a unit test of the
 * script would prove nothing about it.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];

// Each test drives the real hook, which shells out to node and npx eslint.
// That chain ran ~16s against the default 15s budget when the whole suite
// competed for the machine (measured 2026-08-31), while passing alone in a
// fraction of it — the timeout is a watchdog, so headroom costs nothing.
const HOOK_TEST_TIMEOUT_MS = 60_000;
const posixIt = it.skipIf(process.platform === 'win32');

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
}

/** A repository whose commits run the real `.husky/pre-commit`. */
function repoWithHook(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-precommit-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  cpSync(join(REPO_ROOT, '.husky', 'pre-commit'), join(dir, 'hooks', 'pre-commit'));
  execFileSync('chmod', ['+x', join(dir, 'hooks', 'pre-commit')]);
  // The hook shells out to `node scripts/i18n.mjs` and `npx eslint`, both of
  // which must resolve from the fixture: scripts/ is copied, and eslint is
  // reached through this repository's own node_modules via NODE_PATH-free
  // `npx` falling back to the parent — so the fixture keeps a config that
  // makes eslint a no-op instead of pulling the real ruleset.
  cpSync(join(REPO_ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'src', 'viz', 'client', 'locales'), { recursive: true });
  writeFileSync(join(dir, 'eslint.config.js'), 'export default [];\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }) + '\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'core.hooksPath', 'hooks']);
  return dir;
}

describe('the pre-commit hook preserves what was left unstaged', () => {
  posixIt('does not sweep the unstaged hunks of a partially staged file into the commit', () => {
    const dir = repoWithHook();
    const file = join(dir, 'sample.ts');

    writeFileSync(file, 'export const first = 1;\nexport const second = 2;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--no-verify', '-qm', 'base']);

    // Two independent edits; only the first is staged. `git add -p` is what a
    // human does here — the same index state is produced by staging the file
    // and then editing it again, which is what this does.
    writeFileSync(file, 'export const first = 11;\nexport const second = 2;\n');
    git(dir, ['add', 'sample.ts']);
    writeFileSync(file, 'export const first = 11;\nexport const second = 22;\n');

    git(dir, ['commit', '-qm', 'staged half only']);

    // The commit carries the staged edit…
    const committed = git(dir, ['show', 'HEAD:sample.ts']);
    expect(committed).toContain('first = 11');
    // …and NOT the one deliberately left in the worktree.
    expect(committed).toContain('second = 2;');
    expect(committed).not.toContain('second = 22');
    // Which is still there, untouched, for the next commit.
    expect(readFileSync(file, 'utf8')).toContain('second = 22');
    expect(git(dir, ['status', '--porcelain'])).toContain('sample.ts');
  }, HOOK_TEST_TIMEOUT_MS);

  posixIt('still fixes and re-stages a file that is staged whole', () => {
    // The narrowing must not cost the hook its job on the ordinary case.
    const dir = repoWithHook();
    const file = join(dir, 'whole.ts');
    writeFileSync(file, 'export const value = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--no-verify', '-qm', 'base']);

    writeFileSync(file, 'export const value = 2;\n');
    git(dir, ['add', 'whole.ts']);
    git(dir, ['commit', '-qm', 'whole file']);

    expect(git(dir, ['show', 'HEAD:whole.ts'])).toContain('value = 2');
    // Nothing left behind: index, worktree and HEAD agree.
    expect(git(dir, ['status', '--porcelain']).trim()).toBe('');
  }, HOOK_TEST_TIMEOUT_MS);

  posixIt('does not stage a locale catalog that carries unstaged edits of its own', () => {
    // Same class, the i18n half: `invalidate-staged` writes target catalogs and
    // used to `git add` them whole, whatever else the author had in there.
    const dir = repoWithHook();
    const locales = join(dir, 'src', 'viz', 'client', 'locales');
    const en = join(locales, 'en.json');
    const fr = join(locales, 'fr.json');
    writeFileSync(en, JSON.stringify({ greeting: 'hello', other: 'thing' }, null, 2) + '\n');
    writeFileSync(fr, JSON.stringify({ greeting: 'bonjour', other: 'chose' }, null, 2) + '\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--no-verify', '-qm', 'base']);

    // The EN rewording is staged; fr.json carries an unrelated unstaged edit.
    writeFileSync(en, JSON.stringify({ greeting: 'hi there', other: 'thing' }, null, 2) + '\n');
    git(dir, ['add', 'src/viz/client/locales/en.json']);
    writeFileSync(fr, JSON.stringify({ greeting: 'bonjour', other: 'MON BROUILLON' }, null, 2) + '\n');

    git(dir, ['commit', '-qm', 'reword en']);

    // The draft did not ride along into the commit…
    const committedFr = JSON.parse(git(dir, ['show', 'HEAD:src/viz/client/locales/fr.json']));
    expect(committedFr.other).toBe('chose');
    // …and the stale translation was still blanked on disk, so the next commit
    // (or CI's invalidate-range) picks it up.
    const worktreeFr = JSON.parse(readFileSync(fr, 'utf8'));
    expect(worktreeFr.greeting).toBe('');
    expect(worktreeFr.other).toBe('MON BROUILLON');
  }, HOOK_TEST_TIMEOUT_MS);
});
