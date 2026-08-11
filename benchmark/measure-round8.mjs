#!/usr/bin/env node
/**
 * Round 8 measurement instrument.
 *
 * WRITTEN BEFORE THE DATA EXISTS, deliberately. Round 7's diagnosis was built
 * after the fact by grepping for a phrase that matched the run summary rather
 * than the artefact, and it was wrong. Every detector below is fixed here, in
 * advance, so the numbers cannot be defined to suit the outcome.
 *
 *   node benchmark/measure-round8.mjs [runsDir] [csv] [logsDir]
 *
 * Reports the four registered conditions of H8 (PROTOCOL.md), plus the two
 * observational counts. Zero LLM calls.
 */
import fs from 'node:fs';
import path from 'node:path';

const runsDir = process.argv[2] ?? 'runs';
const csvPath = process.argv[3] ?? 'benchmark/results-round8.csv';
const logsDir = process.argv[4] ?? 'benchmark/logs';

/**
 * CONDITION 1 detector — a validator rejection whose reasoning turns on the
 * child reporting work that was already done.
 *
 * This is the EXACT regex used in the offline investigation that established
 * the baseline: 5 hits across 302 archived runs, all in round 7's two
 * expensive runs, zero in the 121-run main corpus. Changing it after seeing
 * round 8 would invalidate the comparison, so it is frozen here.
 */
const ALREADY_SATISFIED_RE =
  /child (claims|reports|found)[^.]{0,80}(already|no edit (is )?(needed|required))|already (correct|excludes|applied|satisfied|done)[^.]{0,60}(however|but the task)|contradict(s|ing) the task/i;

/** CONDITION 2 — no atoma run above this. Round 7's cascade runs: 1.09, 1.38. */
const CASCADE_COST_THRESHOLD = 0.9;

const PREDICATE_REFUSAL_RE = /not offered: its compiled body writes \[/;
// Columns of results-round8.csv, by index — see the header.
const COL = { arm: 1, taskId: 2, cost: 5, dispatches: 11, gateFallbacks: 17 };
const QUOTED_SPAN_FOUND_RE = /QUOTED SPAN .* — FOUND/;
const QUOTED_SPAN_NOTFOUND_RE = /QUOTED SPAN .* — NOT FOUND/;

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// ── traces ────────────────────────────────────────────────────────────────
let rejections = 0;
let alreadySatisfied = 0;
let spanFound = 0;
let spanNotFound = 0;
const alreadySatisfiedRuns = new Set();
const samples = [];

const traceFiles = fs.existsSync(runsDir)
  ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.json') && f !== 'index.json')
  : [];

for (const f of traceFiles) {
  const run = readJson(path.join(runsDir, f));
  if (!run) continue;
  for (const e of run.events ?? []) {
    if (e.kind !== 'llm') continue;
    const uc = String(e.userContent ?? '');
    if (QUOTED_SPAN_FOUND_RE.test(uc)) spanFound++;
    if (QUOTED_SPAN_NOTFOUND_RE.test(uc)) spanNotFound++;
    if (!/validate/.test(e.role ?? '')) continue;
    const resp = String(e.response ?? '');
    if (!/"approved"\s*:\s*false/.test(resp)) continue;
    rejections++;
    if (ALREADY_SATISFIED_RE.test(resp)) {
      alreadySatisfied++;
      alreadySatisfiedRuns.add(f);
      const m = resp.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.){0,150})/);
      if (m) samples.push(m[1].replace(/\\n/g, ' '));
    }
  }
}

// ── csv ───────────────────────────────────────────────────────────────────
const rows = fs.existsSync(csvPath)
  ? fs
      .readFileSync(csvPath, 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => l.split(','))
  : [];
const atoma = rows.filter((r) => r[COL.arm] === 'atoma');
const baseline = rows.filter((r) => r[COL.arm] === 'baseline');
const cost = (r) => Number(r[COL.cost]);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const primaryAtoma = atoma.filter((r) => r[COL.taskId] === 'wclite-maint');
const maxCost = primaryAtoma.length ? Math.max(...primaryAtoma.map(cost)) : 0;
const cascadeRuns = primaryAtoma.filter((r) => cost(r) > CASCADE_COST_THRESHOLD);

// ── per-run logs ──────────────────────────────────────────────────────────
// The predicate's ONLY signal is a debug line, so the logs are its only
// source. Scoped to this round's task logs; note they are overwritten by the
// next round on the same task, so measure before re-running.
let predicateRefusals = 0;
if (fs.existsSync(logsDir)) {
  for (const f of fs.readdirSync(logsDir).filter((x) => /^atoma-wclite-maint/.test(x))) {
    for (const line of fs.readFileSync(path.join(logsDir, f), 'utf8').split('\n')) {
      if (PREDICATE_REFUSAL_RE.test(line)) predicateRefusals++;
    }
  }
}
const sumCol = (rows, c) => rows.reduce((a, r) => a + (Number(r[c]) || 0), 0);
const gateFallbacks = sumCol(primaryAtoma, COL.gateFallbacks);
const dispatches = sumCol(primaryAtoma, COL.dispatches);

// ── report ────────────────────────────────────────────────────────────────
const pass = (b) => (b ? 'RÉUSSI ' : 'ÉCHOUÉ ');
console.log('═══ Manche 8 — conditions enregistrées (PROTOCOL.md) ═══\n');
console.log(
  `1. rejets « déjà satisfait »        ${pass(alreadySatisfied === 0)} ${alreadySatisfied}` +
    `  (cible 0 ; manche 7 : 5 sur 2 runs)  → ${alreadySatisfiedRuns.size} run(s)`
);
console.log(
  `2. aucun run en cascade             ${pass(cascadeRuns.length === 0)} max $${maxCost.toFixed(4)}` +
    `  (seuil $${CASCADE_COST_THRESHOLD} ; manche 7 : $1.09 et $1.38)`
);
console.log(
  `3. le prédicat tire                 ${pass(predicateRefusals >= 3 && gateFallbacks <= 1)} ` +
    `${predicateRefusals} refus, ${gateFallbacks} gate fallback(s)  (cibles ≥3 et ≤1 ; manche 7 : 0 et 5)`
);
console.log(`4. correctness                       à évaluer par benchmark/score-all.mjs (cible ≥ 5/6)\n`);

console.log('── observé, non décisif ──');
console.log(`   QUOTED SPAN FOUND / NOT FOUND     ${spanFound} / ${spanNotFound}`);
console.log(`   rejets de validateur, tous motifs ${rejections}`);
console.log(`   dispatches déterministes          ${dispatches}`);
console.log(`   coût moyen atoma (primaire)       $${mean(primaryAtoma.map(cost)).toFixed(4)}  (n=${primaryAtoma.length})`);
console.log(`   coût moyen témoin                 $${mean(baseline.map(cost)).toFixed(4)}  (n=${baseline.length})`);
if (baseline.length && primaryAtoma.length) {
  console.log(`   ratio                             ${(mean(baseline.map(cost)) / mean(primaryAtoma.map(cost))).toFixed(2)}×  (non enregistré — voir PROTOCOL.md)`);
}
if (samples.length) {
  console.log('\n── échantillon des rejets « déjà satisfait » ──');
  for (const s of samples.slice(0, 5)) console.log('   • ' + s.slice(0, 130));
}
