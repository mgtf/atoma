/**
 * Offline tool-loop friction report over persisted run traces.
 *
 *   npm run friction                     # last 20 runs under ./runs
 *   npm run friction -- --last 50
 *   npm run friction -- --dir ./runs --csv burnin/results.csv
 *   npm run friction -- --tier hard     # hard | soft | all (default all)
 *
 * Run after each burn-in batch. HARD rows are thrown tool errors; SOFT rows
 * are failure-shaped results and may be task-intrinsic (deliberate
 * error-case probes land there — check `args` before reading them as
 * defects). The `args` column counts DISTINCT discriminator arguments: a
 * high-`args` row is N unrelated task-specific failures sharing one error
 * text, not a cross-run pattern.
 *
 * Interpretation contract (from the 2026-08-07 adversarial review): a
 * signature justifies action when it recurs across two consecutive batches
 * AND its root cause is shown to live INSIDE the sandbox, in artefacts the
 * L1 can read — that class is candidate for a recipe/contract line. A cause
 * in the host, the repo or the harness is an ENVIRONMENT defect: fix it
 * structurally (six of six root-caused classes to date were this kind).
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCliArgs } from './args.js';
import type { VizRun } from '../viz/trace.js';
import {
  computeFrictionRows,
  extractFrictionEvents,
  type FrictionEvent,
  type FrictionRow,
} from '../viz/friction.js';

function printHelp(): void {
  console.log(`friction — recurring tool-loop failure signatures from run traces

usage:
  npm run friction [-- --dir <runsDir>] [--csv <burninCsv>] [--last <n>] [--tier hard|soft|all]

defaults: --dir \${ATOMA_RUNS_DIR:-./runs} · --csv burnin/results.csv · --last 20 · --tier all`);
}

/** trace filename → family, from the burn-in CSV (header-driven, tolerant). */
function familyMapFromCsv(csvPath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(csvPath)) return map;
  const lines = readFileSync(csvPath, 'utf8').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return map;
  const header = lines[0]!.split(',').map((h) => h.trim());
  const familyIdx = header.indexOf('family');
  const traceIdx = header.indexOf('trace');
  if (familyIdx < 0 || traceIdx < 0) return map;
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const trace = cols[traceIdx]?.trim();
    const family = cols[familyIdx]?.trim();
    if (trace && family) map.set(trace, family);
  }
  return map;
}

/**
 * How long ago, compactly. The report is a lifetime tally, so without this a
 * defect fixed weeks ago keeps topping the list: the favicon 404 held the
 * first four rows the morning AFTER it was fixed. It is also what makes
 * CLAUDE.md's action rule ("recurring across two CONSECUTIVE batches")
 * checkable from the report instead of by hand.
 */
export function ageLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '?';
  const mins = Math.floor((Date.now() - ms) / 60_000);
  // SUB-DAY resolution, learned the hard way on this column's first real use:
  // a plain "today" made the favicon 404 — fixed at 09:01 that same morning —
  // read as a live signature, because the runs that produced it started at
  // 04:39. On the day a fix lands, day granularity cannot separate "before
  // the fix" from "just now", which is precisely when the distinction
  // matters. Hours below a day; days above.
  if (mins < 60) return `${Math.max(mins, 1)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function renderRows(rows: FrictionRow[], title: string, note: string): void {
  console.log(`\n== ${title} ==${rows.length === 0 ? ' (none)' : ''}`);
  if (note) console.log(note);
  if (rows.length === 0) return;
  const widths = { runs: 4, events: 6, args: 4, tool: 18 };
  console.log(
    `${'runs'.padStart(widths.runs)}  ${'events'.padStart(widths.events)}  ${'args'.padStart(widths.args)}  ${'last'.padStart(6)}  ${'tool'.padEnd(widths.tool)}  signature / sample`
  );
  for (const r of rows) {
    const sig = r.signature.slice(r.signature.indexOf('|') + 1);
    console.log(
      `${String(r.runs).padStart(widths.runs)}  ${String(r.events).padStart(widths.events)}  ${String(r.distinctArgs).padStart(widths.args)}  ${ageLabel(r.lastSeen).padStart(6)}  ${r.tool.padEnd(widths.tool)}  ${sig.slice(0, 90)}`
    );
    console.log(
      `${''.padStart(widths.runs + widths.events + widths.args + 14)}  ${r.tool === '' ? '' : ''}↳ ${r.sample.slice(0, 100).replace(/\s+/g, ' ')}  [families: ${r.families.join(',')}] [approved runs: ${r.approvedRuns}/${r.runs}]`
    );
  }
}

function main(): void {
  const { command, flags } = parseCliArgs(process.argv);
  if (command !== null && command !== 'report') {
    printHelp();
    process.exit(1);
  }
  const dir = resolve(flags['dir'] ?? process.env['ATOMA_RUNS_DIR'] ?? './runs');
  const csv = flags['csv'] ?? 'burnin/results.csv';
  const last = Math.max(1, Number(flags['last'] ?? 20) || 20);
  const tier = flags['tier'] ?? 'all';

  if (!existsSync(dir)) {
    console.error(`no runs directory at ${dir}`);
    process.exit(1);
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, last)
    .map((x) => x.f);

  const events: FrictionEvent[] = [];
  let parsed = 0;
  for (const f of files) {
    let run: VizRun;
    try {
      run = JSON.parse(readFileSync(join(dir, f), 'utf8')) as VizRun;
    } catch {
      continue; // a partial flush mid-write is not this report's problem
    }
    parsed++;
    events.push(...extractFrictionEvents(run, f));
  }

  const rows = computeFrictionRows(events, familyMapFromCsv(csv));
  const hard = rows.filter((r) => r.severity === 'hard');
  const soft = rows.filter((r) => r.severity === 'soft');

  console.log(`friction report — ${parsed} run(s) scanned under ${dir} (newest ${last})`);
  console.log(`${events.length} friction event(s), ${rows.length} distinct signature(s)`);
  if (tier === 'hard' || tier === 'all') {
    renderRows(hard, 'HARD (executor threw)', 'These are real tool failures the model had to recover from.');
  }
  if (tier === 'soft' || tier === 'all') {
    renderRows(
      soft,
      'SOFT (failure-shaped results)',
      'May be task-intrinsic: deliberate error-case probes land here. High `args` = N unrelated task failures sharing one text, not a pattern.'
    );
  }
  console.log(
    '\nact only on a signature recurring across two consecutive batches WHOSE ROOT CAUSE LIVES INSIDE THE SANDBOX;\nhost/repo/harness causes are environment defects — fix them structurally (see CLAUDE.md).'
  );
}

main();
