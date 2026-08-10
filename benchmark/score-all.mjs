#!/usr/bin/env node
/**
 * Score every benchmark deliverable and join the scores onto results.csv.
 *
 *   node benchmark/score-all.mjs [--anchor N]
 *
 * MAPPING A RUN TO ITS ARTEFACT. `prepareWorkspace` archives the workspace by
 * renaming it to `build.prevN`, allocating N monotonically. It runs at the
 * START of a run, so the directory it creates holds the PREVIOUS run's
 * output — and the final run's output is still sitting in `build/`.
 *
 * Do NOT use directory mtime for this. A directory's mtime tracks the last
 * time its entries changed, not the rename, so an archive is stamped with
 * roughly the moment its run stopped creating top-level files — which is
 * mid-run, and does not line up with anything. The monotonic suffix is the
 * actual allocation order and is what we key on.
 *
 * ANCHOR. The highest suffix that existed before the benchmark started. Runs
 * 1..k then map to prev(anchor+1)..prev(anchor+k). Verified rather than
 * assumed: each mapping is checked against the task the run was for (a
 * csvstat run must not point at a logdigest workspace), and a mismatch is
 * reported instead of silently scoring the wrong directory.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const anchorIdx = argv.indexOf('--anchor');
// 16 = the smoke-test workspace (`hello.txt`), the last archive created
// before the first benchmark run. Override if the benchmark is re-run.
const ANCHOR = anchorIdx >= 0 ? Number(argv[anchorIdx + 1]) : 16;

const WS = join(homedir(), '.atoma', 'workspaces');
const rows = readFileSync('benchmark/results.csv', 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((l) => l.split(','))
  .map((c) => ({ ts: c[0], arm: c[1], taskId: c[2], runIndex: Number(c[3]), outcome: c[4], cost: c[5] }));

/** Does this directory look like a deliverable for that spec? */
function looksLike(dir, spec) {
  if (!existsSync(dir)) return false;
  const names = readdirSync(dir).join(' ').toLowerCase();
  return spec === 'csvstat' ? /csv/.test(names) : /log/.test(names);
}

const out = [];
let mismatches = 0;

rows.forEach((r, i) => {
  const k = i + 1; // benchmark run ordinal, across all phases
  const archived = join(WS, `build.prev${ANCHOR + k}`);
  const live = join(WS, 'build');
  const dir = existsSync(archived) ? archived : live;
  const ok = looksLike(dir, r.taskId);
  if (!ok) mismatches++;

  let verdict = { passed: 0, total: 0, score: 0, entry: null, error: 'not scored' };
  if (existsSync(dir)) {
    try {
      verdict = JSON.parse(
        execFileSync('node', ['benchmark/verify-deliverable.mjs', dir, r.taskId], {
          encoding: 'utf8',
          timeout: 120000,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      );
    } catch (e) {
      verdict = { passed: 0, total: 0, score: 0, entry: null, error: String(e.message).slice(0, 120) };
    }
  }
  out.push({
    ...r,
    ordinal: k,
    dir: dir.replace(WS + '/', ''),
    mappingOk: ok,
    passed: verdict.passed,
    total: verdict.total,
    score: verdict.score,
    entry: verdict.entry ?? '',
    failed: (verdict.checks ?? []).filter((c) => !c.pass).map((c) => c.id).join(' '),
  });
});

writeFileSync('benchmark/scores.json', JSON.stringify(out, null, 2), 'utf8');

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('run', 4) + pad('arm', 10) + pad('task', 11) + pad('cost', 9) + pad('score', 8) + pad('dir', 16) + 'failed checks');
console.log('-'.repeat(90));
for (const r of out) {
  console.log(
    pad(r.ordinal, 4) +
      pad(r.arm, 10) +
      pad(r.taskId, 11) +
      pad(r.cost === '' ? '—' : `$${r.cost}`, 9) +
      pad(`${r.passed}/${r.total}`, 8) +
      pad(r.dir + (r.mappingOk ? '' : ' ⚠'), 16) +
      (r.failed || '—')
  );
}

const byArm = (arm) => out.filter((r) => r.arm === arm && r.total > 0);
for (const arm of ['baseline', 'atoma']) {
  const g = byArm(arm);
  if (g.length === 0) continue;
  const mean = g.reduce((a, b) => a + b.score, 0) / g.length;
  console.log(`\n${arm}: mean correctness ${(mean * 100).toFixed(1)}% over ${g.length} scored deliverable(s)`);
}
if (mismatches > 0) {
  console.log(`\n⚠ ${mismatches} run(s) mapped to a directory that does not look like their task — check --anchor.`);
}
console.log('\nwrote benchmark/scores.json');
