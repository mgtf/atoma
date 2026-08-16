#!/usr/bin/env node
/**
 * Score a tabstat MAINTENANCE deliverable by executing it.
 *
 *   node benchmark/verify-tabstat.mjs <workspace-dir> [tabstat-maint|tabstat-maint-2]
 *
 * WRITTEN BEFORE ANY ROUND-12 RUN and validated in both directions before use:
 * it must FAIL the untouched seed (otherwise "change nothing" scores full
 * marks) and PASS a reference fix. Round 10 taught that a scorer which cannot
 * discriminate is worse than none, because it converts a task the arms did not
 * do into evidence that they did.
 *
 * WHAT MAKES THIS TASK HARDER THAN `wclite-maint`. Three coupled clauses over
 * three source files and eleven documented invocations — and, crucially, **only
 * three of the ten documented statistics actually change**:
 *
 *   units: mean 13.00 → 16.25   min 0 → 8    sum 65, max 30, count 4 UNCHANGED
 *   delta: mean 0.80 → 1.00     min -4, sum 4, max 7, count 4       UNCHANGED
 *
 * So the deliverable can fail in two opposite directions: under-updating the
 * record, or whitewashing values that did not move. `wclite-maint` had a single
 * changed number and could not tell those apart; every arm scored full marks on
 * it. The manifest replay check carries most of that weight, because it is
 * mechanical and symmetric — a stale entry and an over-written entry both fail.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const spec = process.argv[3] ?? 'tabstat-maint';
if (!dir) {
  console.error('usage: verify-tabstat.mjs <workspace-dir> [tabstat-maint|tabstat-maint-2]');
  process.exit(64);
}

function run(args) {
  try {
    const stdout = execFileSync('node', ['tabstat.js', ...args], {
      cwd: dir, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? -1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

const checks = [];
const check = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });

if (!existsSync(join(dir, 'tabstat.js'))) {
  console.log(JSON.stringify({ dir, spec, score: 0, total: 0, checks: [{ id: 'artefact', ok: false, detail: 'tabstat.js absent' }] }));
  process.exit(0);
}

/** `  mean 16.25` → 16.25; null when the statistic is absent or a dash. */
function statOf(stdout, name) {
  const m = stdout.match(new RegExp(`^\\s*${name}\\s+(\\S+)`, 'm'));
  return m ? m[1] : null;
}

const readme = existsSync(join(dir, 'README.md')) ? readFileSync(join(dir, 'README.md'), 'utf8') : '';

if (spec === 'tabstat-maint-2') {
  // HELD-OUT GOAL: --column also accepts a 1-based index, and NOTHING else
  // moves. The regression surface is the whole point here — the seed's own
  // statistics must still read exactly as recorded, so this spec fails any run
  // that "improved" the empty-cell handling it was not asked to touch.
  const byName = run(['--column', 'units', 'data.csv']);
  const byIndex = run(['--column', '2', 'data.csv']);
  check('index-selects-same-column',
    byIndex.status === 0 && byIndex.stdout === byName.stdout,
    `index: ${byIndex.stdout.trim().replace(/\n/g, ' | ')}`);

  const reserveByName = run(['--column', 'reserve', 'data.csv']);
  const reserveByIndex = run(['--column', '5', 'data.csv']);
  check('index-works-for-last-column',
    reserveByIndex.status === 0 && reserveByIndex.stdout === reserveByName.stdout,
    `index 5: ${reserveByIndex.stdout.trim().replace(/\n/g, ' | ')}`);

  check('name-selection-still-works',
    byName.status === 0 && statOf(byName.stdout, 'count') === '4',
    byName.stdout.trim().replace(/\n/g, ' | '));

  // The seeded behaviour is UNCHANGED by this goal: empty cells still count as
  // zero. A run that also applied the primary task's change fails here.
  check('existing-statistics-unchanged',
    statOf(byName.stdout, 'mean') === '13.00' && statOf(byName.stdout, 'min') === '0' &&
    statOf(byName.stdout, 'sum') === '65' && statOf(byName.stdout, 'max') === '30',
    byName.stdout.trim().replace(/\n/g, ' | '));

  const unknown = run(['--column', 'nope', 'data.csv']);
  check('unknown-column-still-exits-3', unknown.status === 3, `exit ${unknown.status}`);
} else {

// ── clause 1: empty cells leave the numeric statistics ─────────────────────
const units = run(['--column', 'units', 'data.csv']);
check('units-mean-excludes-empties', units.status === 0 && statOf(units.stdout, 'mean') === '16.25',
  `mean ${statOf(units.stdout, 'mean')} (expected 16.25)`);
check('units-min-excludes-empties', statOf(units.stdout, 'min') === '8',
  `min ${statOf(units.stdout, 'min')} (expected 8)`);

// ── the other half of clause 1: what must NOT move ─────────────────────────
check('units-unchanged-stats-preserved',
  statOf(units.stdout, 'sum') === '65' && statOf(units.stdout, 'max') === '30' && statOf(units.stdout, 'count') === '4',
  `sum ${statOf(units.stdout, 'sum')} max ${statOf(units.stdout, 'max')} count ${statOf(units.stdout, 'count')} (expected 65 / 30 / 4)`);

const delta = run(['--column', 'delta', 'data.csv']);
check('delta-mean-changed-rest-unchanged',
  delta.status === 0 && statOf(delta.stdout, 'mean') === '1.00' && statOf(delta.stdout, 'min') === '-4' &&
  statOf(delta.stdout, 'sum') === '4' && statOf(delta.stdout, 'max') === '7',
  delta.stdout.trim().replace(/\n/g, ' | '));

// ── clause 3: count is explicitly told not to change ───────────────────────
const cnt = run(['--stat', 'count', '--column', 'units', 'data.csv']);
check('count-clause-unchanged', cnt.status === 0 && /\b4\b/.test(cnt.stdout) && !/\b5\b/.test(cnt.stdout),
  cnt.stdout.trim());

// ── clause 2: a column with no numeric values ──────────────────────────────
const reserve = run(['--column', 'reserve', 'data.csv']);
check('empty-column-text-dashes',
  reserve.status === 0 && statOf(reserve.stdout, 'count') === '0' &&
  ['sum', 'mean', 'min', 'max'].every((s) => statOf(reserve.stdout, s) === '-'),
  reserve.stdout.trim().replace(/\n/g, ' | '));

const reserveJson = run(['--format', 'json', '--column', 'reserve', 'data.csv']);
let rj = null;
try { rj = JSON.parse(reserveJson.stdout); } catch { /* handled */ }
check('empty-column-json-nulls',
  rj && rj.reserve && rj.reserve.count === 0 &&
  ['sum', 'mean', 'min', 'max'].every((s) => rj.reserve[s] === null),
  reserveJson.stdout.trim().replace(/\s+/g, ' ').slice(0, 120));

// A non-numeric column is the same case, and its count must survive it.
const region = run(['--column', 'region', 'data.csv']);
check('non-numeric-column-keeps-count',
  region.status === 0 && statOf(region.stdout, 'count') === '5' &&
  ['sum', 'mean', 'min', 'max'].every((s) => statOf(region.stdout, s) === '-'),
  region.stdout.trim().replace(/\n/g, ' | '));

// ── json shape for a normal column ─────────────────────────────────────────
const unitsJson = run(['--format', 'json', '--column', 'units', 'data.csv']);
let uj = null;
try { uj = JSON.parse(unitsJson.stdout); } catch { /* handled */ }
check('json-units-values',
  uj && uj.units && uj.units.count === 4 && uj.units.sum === 65 && uj.units.mean === 16.25 &&
  uj.units.min === 8 && uj.units.max === 30,
  unitsJson.stdout.trim().replace(/\s+/g, ' ').slice(0, 140));

// ── the documentation ──────────────────────────────────────────────────────
// Four signals, each chosen to be unambiguous in BOTH directions. Layout is
// deliberately not policed — a run may restructure the README.
//
// The prose clause is the delicate one and it is deliberately NARROW: it looks
// for the seed's own sentence verbatim, not for the words "as zero". A broad
// pattern would flag a CORRECT README that says "empty cells are no longer
// counted as zero" — a false contradiction, which is the defect round 8 found
// in its own QUOTED SPAN signal and the reason the 2026-08-10 amendment exists.
// Any real edit to that sentence clears it. Per the standing rule, a failure of
// this check is inspected before it is recorded.
const flat = readme.replace(/\s+/g, ' ');
const staleReadme = [];
if (/\bmean\s+13\.00\b/.test(readme)) staleReadme.push('still documents mean 13.00');
if (/\bmin\s+0\b/.test(readme)) staleReadme.push('still documents min 0');
if (/an empty cell counting as zero/i.test(flat)) staleReadme.push("still carries the seed's empty-cell sentence");
if (!/16\.25/.test(readme)) staleReadme.push('does not document the new mean 16.25');
check('readme-updated', readme.length > 0 && staleReadme.length === 0,
  staleReadme.length ? staleReadme.join('; ') : 'superseded values gone, new value documented');

}

// ── shared: nothing else may regress, on either goal ───────────────────────
const help = run(['--help']);
const missing = run(['missing.csv']);
check('help-and-error-paths-unchanged',
  help.status === 0 && /usage/i.test(help.stdout) && missing.status === 2,
  `help exit ${help.status}, missing exit ${missing.status}`);

// ── THE MANIFEST — symmetric against both under- and over-updating ─────────
const manifestPath = join(dir, '.atoma-probes.json');
let manifest = null;
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* handled below */ }
check('manifest-parses', manifest && manifest.version === 1 && Array.isArray(manifest.entries),
  manifest ? 'shape' : 'unreadable');

if (manifest && Array.isArray(manifest.entries)) {
  check('manifest-entries-preserved', manifest.entries.length >= 11, `${manifest.entries.length} entries`);

  const stale = [];
  for (const e of manifest.entries.slice(0, 16)) {
    if (typeof e?.cmd !== 'string' || e.stdout === undefined) continue;
    const argv = e.cmd.replace(/^node\s+tabstat\.js\s*/, '').trim();
    const got = run(argv ? argv.split(/\s+/) : []);
    if (got.status !== (e.exitCode ?? 0) || String(got.stdout) !== String(e.stdout)) stale.push(e.cmd);
  }
  check('manifest-matches-live', stale.length === 0,
    stale.length ? `stale: ${stale.join('; ')}` : 'every recorded entry replays identically');
}

const score = checks.filter((c) => c.ok).length;
console.log(JSON.stringify({ dir, spec, score, total: checks.length, full: score === checks.length, checks }, null, 2));
