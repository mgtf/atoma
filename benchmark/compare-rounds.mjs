#!/usr/bin/env node
/**
 * Round-over-round comparison of the pre-registered questions, and nothing
 * else.
 *
 *   node benchmark/compare-rounds.mjs [round1.csv] [round2.csv] [...]
 *
 * H2 (round 2): after the `when_to_use` fix, at least one recipe compiles and
 * at least one run records a deterministic phase. Round 1 had none of either.
 * H3 (round 3): after record_probe, the compiled script SURVIVES — two or more
 * successful dispatches and no demotion.
 *
 * The DRIFT CHECK is printed first and deliberately so. Round 2 ran on a
 * different day against a subscription-served model that can shift behind its
 * alias; if the control arms disagree, the atoma comparison below is not
 * attributable to the fix and the report has to say that instead.
 */
import { readFileSync, existsSync } from 'node:fs';

// Any number of rounds, oldest first. Defaults to every round on disk.
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['benchmark/results.csv', 'benchmark/results-round2.csv', 'benchmark/results-round3.csv'].filter(
      (f) => existsSync(f)
    );

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
      demotions: Number(c[16] ?? 0),
      dispatchFallbacks: Number(c[17] ?? 0),
    }));
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const usd = (n) => (n === null ? '—' : `$${n.toFixed(4)}`);

function slice(rows, arm, taskId) {
  return rows.filter((r) => r.arm === arm && r.taskId === taskId && r.outcome === 'delivered');
}

const rounds = files.map((f, i) => ({ label: `manche ${i + 1}`, file: f, rows: load(f) })).filter((r) => r.rows.length);

console.log('== DRIFT CHECK (à lire avant le reste) ==');
let ref = null;
for (const r of rounds) {
  const b = mean(slice(r.rows, 'baseline', 'csvstat').map((x) => x.cost));
  if (ref === null) ref = b;
  const drift = ref !== null && b !== null ? ((b - ref) / ref) * 100 : null;
  console.log(
    `  ${r.label}: témoin n=${slice(r.rows, 'baseline', 'csvstat').length} ${usd(b)}` +
      (drift !== null && drift !== 0 ? `   dérive ${drift > 0 ? '+' : ''}${drift.toFixed(1)}% vs manche 1` : '')
  );
}
console.log('  -> une dérive notable rend la comparaison de COÛTS entre manches non attribuable.');

console.log('\n== la question centrale : le chemin zéro-token ==');
for (const r of rounds) {
  const a = slice(r.rows, 'atoma', 'csvstat');
  const detRuns = a.filter((x) => x.det > 0).length;
  const detPhases = a.reduce((s2, x) => s2 + x.det, 0);
  const promos = a.reduce((s2, x) => s2 + x.promotions, 0);
  const demos = a.reduce((s2, x) => s2 + (x.demotions ?? 0), 0);
  const fb = a.reduce((s2, x) => s2 + (x.dispatchFallbacks ?? 0), 0);
  console.log(
    `  ${r.label}: n=${a.length}  compilations=${promos}  dispatches=${detPhases} (sur ${detRuns} runs)  ` +
      `échecs de contrat=${fb}  rétrogradations=${demos}`
  );
}

console.log('\n== économie (à ne comparer qu\'à témoin stable) ==');
for (const r of rounds) {
  const a = slice(r.rows, 'atoma', 'csvstat');
  const costs = a.map((x) => x.cost);
  const b = mean(slice(r.rows, 'baseline', 'csvstat').map((x) => x.cost));
  const total = costs.reduce((x, y) => x + y, 0);
  console.log(
    `  ${r.label}: moyenne ${usd(mean(costs))}  chaud ${usd(mean(costs.slice(1)))}  ` +
      `total ${usd(total)}` + (b !== null ? `  vs témoin-équivalent ${usd(b * costs.length)}` : '')
  );
  console.log(`     série : ${costs.map((c) => c.toFixed(3)).join(' ')}`);
}

console.log('\n== tâche témoin (généralisation) ==');
for (const r of rounds) {
  const h = slice(r.rows, 'atoma', 'logdigest');
  if (h.length) console.log(`  ${r.label}: n=${h.length}  ${usd(mean(h.map((x) => x.cost)))}`);
}
