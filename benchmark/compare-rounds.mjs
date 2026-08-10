#!/usr/bin/env node
/**
 * Round-over-round comparison, answering the pre-registered H2 and nothing
 * else.
 *
 *   node benchmark/compare-rounds.mjs [round1.csv] [round2.csv]
 *
 * H2: after the `when_to_use` fix, at least one recipe compiles and at least
 * one run records a deterministic phase within 14 atoma runs. Round 1 had
 * det=0 across all 19.
 *
 * The DRIFT CHECK is printed first and deliberately so. Round 2 ran on a
 * different day against a subscription-served model that can shift behind its
 * alias; if the control arms disagree, the atoma comparison below is not
 * attributable to the fix and the report has to say that instead.
 */
import { readFileSync, existsSync } from 'node:fs';

const f1 = process.argv[2] ?? 'benchmark/results.csv';
const f2 = process.argv[3] ?? 'benchmark/results-round2.csv';

function load(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split(','))
    .map((c) => ({
      arm: c[1],
      taskId: c[2],
      outcome: c[4],
      cost: c[5] === '' ? null : Number(c[5]),
      durationS: c[6] === '' ? null : Number(c[6]),
      llmCalls: c[7] === '' ? null : Number(c[7]),
      det: Number(c[11] ?? 0),
      learned: Number(c[13] ?? 0),
      promotions: Number(c[14] ?? 0),
      refusals: Number(c[15] ?? 0),
    }));
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const usd = (n) => (n === null ? '—' : `$${n.toFixed(4)}`);

function slice(rows, arm, taskId) {
  return rows.filter((r) => r.arm === arm && r.taskId === taskId && r.outcome === 'delivered');
}

const r1 = load(f1);
const r2 = load(f2);
if (r2.length === 0) {
  console.error(`round 2 not started yet: ${f2}`);
  process.exit(1);
}

const b1 = slice(r1, 'baseline', 'csvstat');
const b2 = slice(r2, 'baseline', 'csvstat');
const a1 = slice(r1, 'atoma', 'csvstat');
const a2 = slice(r2, 'atoma', 'csvstat');

console.log('== DRIFT CHECK (read this before the rest) ==');
const bm1 = mean(b1.map((r) => r.cost));
const bm2 = mean(b2.map((r) => r.cost));
console.log(`  control arm  round 1 n=${b1.length} ${usd(bm1)}   round 2 n=${b2.length} ${usd(bm2)}`);
if (bm1 !== null && bm2 !== null) {
  const drift = (bm2 - bm1) / bm1;
  console.log(
    `  drift ${(drift * 100).toFixed(1)}%  ->  ${
      Math.abs(drift) > 0.25
        ? 'LARGE. The round-to-round atoma comparison below is NOT safely attributable to the fix.'
        : 'within tolerance; the comparison below is usable.'
    }`
  );
}

console.log('\n== H2: did compilation and deterministic dispatch happen? ==');
for (const [label, rows] of [
  ['round 1', a1],
  ['round 2', a2],
]) {
  const detRuns = rows.filter((r) => r.det > 0).length;
  const detPhases = rows.reduce((s, r) => s + r.det, 0);
  const promos = rows.reduce((s, r) => s + r.promotions, 0);
  const refus = rows.reduce((s, r) => s + r.refusals, 0);
  console.log(
    `  ${label}: n=${rows.length}  runs with det>0 = ${detRuns}  total det phases = ${detPhases}  ` +
      `compilations = ${promos}  compile refusals = ${refus}`
  );
}
const h2 = a2.some((r) => r.det > 0) && a2.reduce((s, r) => s + r.promotions, 0) > 0;
console.log(
  `\n  ${h2 ? 'H2 SUPPORTED' : 'H2 NOT SUPPORTED within the runs performed'} — ` +
    'at least one compilation AND at least one deterministic phase was the registered bar.'
);

console.log('\n== economics ==');
for (const [label, rows, base] of [
  ['round 1', a1, bm1],
  ['round 2', a2, bm2],
]) {
  const costs = rows.map((r) => r.cost);
  const warm = mean(costs.slice(1));
  const total = costs.reduce((a, b) => a + b, 0);
  console.log(
    `  ${label}: mean ${usd(mean(costs))}  warm ${usd(warm)}  total ${usd(total)}` +
      (base !== null ? `  vs baseline-equivalent ${usd(base * rows.length)}` : '')
  );
  console.log(`     series: ${costs.map((c) => c.toFixed(3)).join(' ')}`);
  console.log(`     calls : ${rows.map((r) => r.llmCalls ?? '—').join(' ')}`);
}

const ho1 = slice(r1, 'atoma', 'logdigest');
const ho2 = slice(r2, 'atoma', 'logdigest');
if (ho1.length || ho2.length) {
  console.log('\n== held-out task (generalisation) ==');
  console.log(`  round 1 atoma n=${ho1.length} ${usd(mean(ho1.map((r) => r.cost)))}`);
  console.log(`  round 2 atoma n=${ho2.length} ${usd(mean(ho2.map((r) => r.cost)))}`);
}
