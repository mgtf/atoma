#!/usr/bin/env node
/**
 * Score a wclite MAINTENANCE deliverable by executing it.
 *
 *   node benchmark/verify-maint.mjs <workspace-dir> [wclite-maint|wclite-maint-2]
 *
 * WHY THIS EXISTS, and why it is committed rather than improvised. Rounds 5-7
 * each reported a correctness figure from an "independent scorer" that was
 * never checked in, so none of those numbers can be reproduced from the repo —
 * the same reproducibility hole that made an earlier benchmark worthless when
 * `runs/` turned out to be gitignored. It also matters more here than
 * anywhere: at these thresholds the pipeline's own validators are largely
 * skipped, so "delivered" proves almost nothing, and round 5's headline
 * (4.69x) was inflated by seven deliverables whose README contradicted their
 * own artefact. The scorer is the only thing standing between a cost win and
 * a wrong one.
 *
 * Each check maps to a clause of the goal text in `experiment.json`. It
 * EXECUTES the CLI rather than reading claims about it, and it is applied
 * identically to both arms.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const spec = process.argv[3] ?? 'wclite-maint';
if (!dir) {
  console.error('usage: verify-maint.mjs <workspace-dir> [wclite-maint|wclite-maint-2]');
  process.exit(64);
}

/** Run the CLI and capture status + stdout, never throwing. */
function run(args) {
  try {
    const stdout = execFileSync('node', ['wclite.js', ...args], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status ?? -1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

const checks = [];
const check = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });

if (!existsSync(join(dir, 'wclite.js'))) {
  console.log(JSON.stringify({ dir, spec, score: 0, total: 0, checks: [{ id: 'artefact', ok: false, detail: 'wclite.js absent' }] }));
  process.exit(0);
}

const readme = existsSync(join(dir, 'README.md')) ? readFileSync(join(dir, 'README.md'), 'utf8') : '';

// ── clauses common to both maintenance goals: nothing else may regress ──────
const lines = run(['--lines', 'sample.txt']);
check('lines-unchanged', lines.status === 0 && /\b3\b/.test(lines.stdout), lines.stdout.trim());

const words = run(['--words', 'sample.txt']);
check('words-unchanged', words.status === 0 && /\b6\b/.test(words.stdout), words.stdout.trim());

const help = run(['--help']);
check('help-unchanged', help.status === 0 && /usage/i.test(help.stdout), `exit ${help.status}`);

const missing = run(['missing.txt']);
check('missing-file-exit-2', missing.status === 2, `exit ${missing.status}`);

if (spec === 'wclite-maint') {
  // THE CHANGE: --chars must exclude the trailing newline. sample.txt is 36
  // bytes and ends in one, so the required answer is 35.
  const chars = run(['--chars', 'sample.txt']);
  check('chars-excludes-trailing-newline', chars.status === 0 && /\b35\b/.test(chars.stdout) && !/\b36\b/.test(chars.stdout), chars.stdout.trim());

  const all = run(['sample.txt']);
  check('default-mode-consistent', all.status === 0 && /\b35\b/.test(all.stdout) && /lines\s*3/.test(all.stdout) && /words\s*6/.test(all.stdout), all.stdout.trim().replace(/\n/g, ' | '));

  // THE ROUND-5 DEFECT: a README still documenting `chars 36` about a CLI that
  // now prints 35. This is the check that found seven wrong deliverables.
  check('readme-updated', /chars[^\n]*\b35\b/.test(readme) && !/chars[^\n]*\b36\b/.test(readme), readme.match(/[^\n]*chars[^\n]*/)?.[0]?.trim() ?? '(aucune ligne chars)');
} else {
  // Held-out goal: a directory argument must exit 2 with a specific message.
  const dirArg = run(['.']);
  check('directory-exits-2', dirArg.status === 2, `exit ${dirArg.status}`);
  check('directory-message', /not a regular file/i.test(String(dirArg.stderr ?? '') + dirArg.stdout), (dirArg.stderr ?? '').trim().slice(0, 80));

  const chars = run(['--chars', 'sample.txt']);
  check('chars-unchanged', chars.status === 0 && /\b36\b/.test(chars.stdout), chars.stdout.trim());
}

const score = checks.filter((c) => c.ok).length;
console.log(JSON.stringify({ dir, spec, score, total: checks.length, full: score === checks.length, checks }, null, 2));
