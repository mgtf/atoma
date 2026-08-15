#!/usr/bin/env node
/**
 * Score every deliverable of a benchmark round, both arms, by executing it.
 *
 *   node benchmark/score-round.mjs --csv benchmark/results-round9.csv \
 *     --first-archive 197 [--workspaces ~/.atoma/workspaces] [--base build] \
 *     [--out benchmark/results-round9-scores.json]
 *
 * WHY THIS EXISTS. Round 8 scored its deliverables by hand and an off-by-one
 * in the workspace anchor produced a false 83.3% that had to be caught by
 * reading the artefacts' semantics. The mapping is in fact fully determined,
 * so it should be computed rather than guessed:
 *
 *   `prepareWorkspace` archives the CURRENT workspace at the START of each
 *   run, taking the first free `<base>.prev<n>`. So for a round of R runs
 *   whose first archive index is A:
 *
 *     run 1 .. R-1 deliverable  →  <base>.prev<A + k>      (archived by run k+1)
 *     run R        deliverable  →  <base>/                 (still live)
 *
 *   and `<base>.prev<A>` is the PRE-ROUND leftover, which belongs to no run.
 *
 * A is not guessable after the fact, which is the whole lesson: record it
 * BEFORE the round (`ls ~/.atoma/workspaces | grep -c build.prev` + 1) and
 * pass it here. The script then re-derives the same three facts round 8
 * checked by hand — the artefact exists, its mtime falls after its run
 * started, and the archives are in ascending time order — and refuses to
 * report a score for any run whose mapping fails them.
 *
 * Scoring itself is delegated to `verify-maint.mjs` unchanged, so this adds a
 * mapping, not a second instrument.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) {
    console.error(`--${name} requires a value`);
    process.exit(64);
  }
  return v;
}

const csvPath = arg('csv');
const firstArchive = Number(arg('first-archive'));
const workspaces = resolve(arg('workspaces', join(homedir(), '.atoma', 'workspaces')));
const base = arg('base', 'build');
const outPath = arg('out');

if (!csvPath || !Number.isInteger(firstArchive) || firstArchive < 1) {
  console.error('usage: score-round.mjs --csv <round.csv> --first-archive <n> [--workspaces <dir>] [--base build] [--out <json>]');
  process.exit(64);
}

const lines = readFileSync(resolve(csvPath), 'utf8').trim().split('\n');
const header = lines[0].split(',');
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) {
    console.error(`CSV is missing the '${name}' column — wrong schema for this scorer`);
    process.exit(65);
  }
  return i;
};
const [iTs, iArm, iTask, iRun, iOutcome, iCost] = [
  col('timestamp'), col('arm'), col('task_id'), col('run_index'), col('outcome'), col('cost_usd'),
];

const rows = lines.slice(1).filter((l) => l.trim().length > 0).map((l) => {
  const c = l.split(',');
  return {
    ts: c[iTs],
    arm: c[iArm],
    taskId: c[iTask],
    runIndex: Number(c[iRun]),
    outcome: c[iOutcome],
    costUsd: c[iCost] === '' ? null : Number(c[iCost]),
  };
});

const results = [];
let previousMtime = 0;

rows.forEach((row, k) => {
  const isLast = k === rows.length - 1;
  const dir = isLast
    ? join(workspaces, base)
    : join(workspaces, `${base}.prev${firstArchive + k + 1}`);

  const problems = [];
  if (!existsSync(dir)) problems.push('workspace absent');
  else {
    const mtime = statSync(dir).mtimeMs;
    // The archive holds run k's deliverable, so its last write cannot predate
    // the moment run k started. This is the check that would have caught the
    // round-8 anchor error mechanically.
    if (mtime < Date.parse(row.ts)) problems.push(`mtime ${new Date(mtime).toISOString()} predates run start ${row.ts}`);
    if (mtime < previousMtime) problems.push('archives out of chronological order');
    previousMtime = mtime;
    if (!existsSync(join(dir, 'wclite.js'))) problems.push('no wclite.js in the mapped workspace');
  }

  if (problems.length > 0) {
    results.push({ ...row, dir, mappingOk: false, problems, score: null, total: null });
    return;
  }

  let scored;
  try {
    const stdout = execFileSync(
      'node',
      [join(import.meta.dirname, 'verify-maint.mjs'), dir, row.taskId],
      { encoding: 'utf8', timeout: 120000 }
    );
    scored = JSON.parse(stdout);
  } catch (e) {
    results.push({ ...row, dir, mappingOk: true, problems: [`scorer failed: ${String(e.message ?? e).slice(0, 200)}`], score: null, total: null });
    return;
  }
  results.push({
    ...row,
    dir,
    mappingOk: true,
    problems: [],
    score: scored.score,
    total: scored.total,
    full: scored.full,
    failed: (scored.checks ?? []).filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`),
  });
});

// ── report ────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('arm', 10) + pad('task', 16) + pad('run', 5) + pad('outcome', 11) + pad('cost', 10) + pad('score', 8) + 'workspace');
for (const r of results) {
  console.log(
    pad(r.arm, 10) + pad(r.taskId, 16) + pad(r.runIndex, 5) + pad(r.outcome, 11) +
      pad(r.costUsd === null ? '—' : `$${r.costUsd.toFixed(4)}`, 10) +
      pad(r.score === null ? 'UNMAPPED' : `${r.score}/${r.total}`, 8) +
      r.dir.replace(workspaces + '/', '')
  );
  for (const p of r.problems) console.log(`    ! ${p}`);
  for (const f of r.failed ?? []) console.log(`    ✗ ${f}`);
}

const byArm = (arm) => results.filter((r) => r.arm === arm && r.score !== null);
for (const arm of ['baseline', 'atoma']) {
  const xs = byArm(arm);
  if (xs.length === 0) continue;
  const full = xs.filter((r) => r.full).length;
  console.log(`\n${arm}: ${full}/${xs.length} deliverables at full marks` +
    ` (scores: ${xs.map((r) => `${r.score}/${r.total}`).join(', ')})`);
}

if (outPath) {
  writeFileSync(resolve(outPath), JSON.stringify({ csv: resolve(csvPath), firstArchive, workspaces, base, results }, null, 2));
  console.log(`\nwritten: ${outPath}`);
}
