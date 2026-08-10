#!/usr/bin/env node
/**
 * Score a benchmark deliverable against its written spec — mechanically, and
 * identically for both arms.
 *
 *   node benchmark/verify-deliverable.mjs <workspace-dir> [csvstat|logdigest]
 *
 * WHY THIS EXISTS. The harness records a run as "delivered" when it prints
 * its completion banner. That says the run finished, NOT that the artefact
 * works. Comparing the cost of a working CLI against the cost of a broken one
 * would be worse than not measuring at all, and the control arm in particular
 * self-certifies — nothing in its path independently checks the deliverable.
 * So correctness is established here, outside both arms, by executing the
 * artefact against the requirements the goal text actually stated.
 *
 * Each check maps to one numbered requirement in `experiment.json`. Output is
 * JSON so it can be joined onto results.csv.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = process.argv[2];
const spec = process.argv[3] ?? 'csvstat';
if (!dir || !existsSync(dir)) {
  console.error(`usage: verify-deliverable.mjs <workspace-dir> [csvstat|logdigest]`);
  process.exit(2);
}

/** Find the CLI entry point without assuming the model named it our way. */
function findEntry(root, name) {
  const candidates = [`${name}.js`, `${name}.mjs`, 'index.js', 'index.mjs', 'cli.js', `bin/${name}.js`, `src/${name}.js`, `src/index.js`];
  for (const c of candidates) if (existsSync(join(root, c))) return c;
  // package.json bin/main
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0];
    if (bin && existsSync(join(root, bin))) return bin;
    if (pkg.main && existsSync(join(root, pkg.main))) return pkg.main;
  } catch {}
  const js = readdirSync(root).filter((f) => /\.(js|mjs)$/.test(f) && !f.startsWith('_skill_'));
  return js[0] ?? null;
}

function run(entry, args, cwd) {
  try {
    const stdout = execFileSync('node', [entry, ...args], {
      cwd,
      timeout: 15000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return {
      code: typeof e.status === 'number' ? e.status : -1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
}

const entry = findEntry(dir, spec);
const checks = [];
const add = (id, req, pass, note = '') => checks.push({ id, req, pass: !!pass, note: String(note).slice(0, 200) });

if (!entry) {
  add('C0', 'a runnable CLI entry point exists', false, 'no .js/.mjs entry found');
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'atoma-verify-'));

  if (spec === 'csvstat') {
    // A fixture the spec's requirements can actually be checked against:
    // numeric + text columns, a missing value, and a quoted field with a comma.
    const csv = join(scratch, 'data.csv');
    writeFileSync(
      csv,
      ['name,score,city', 'ada,10,"London, UK"', 'bob,20,Paris', 'cy,,Paris', 'dee,30,Berlin'].join('\n') + '\n'
    );

    const basic = run(entry, [csv], dir);
    add('C1', 'runs on a well-formed CSV, exit 0', basic.code === 0, `exit=${basic.code} ${basic.stderr.slice(0, 80)}`);

    const help = run(entry, ['--help'], dir);
    const helpText = help.stdout + help.stderr;
    add('C4a', '--help documents --format and --columns', /--format/.test(helpText) && /--columns/.test(helpText), `exit=${help.code}`);

    const js = run(entry, [csv, '--format', 'json'], dir);
    let parsed = null;
    try {
      parsed = JSON.parse(js.stdout.trim());
    } catch {}
    add('C4b', '--format json emits parseable JSON', js.code === 0 && parsed !== null, `exit=${js.code}`);

    const blob = JSON.stringify(parsed ?? {}).toLowerCase() + basic.stdout.toLowerCase();
    // The standard-deviation spelling is deliberately permissive. The first
    // revision accepted only stddev/std_dev/standard and scored a deliverable
    // 9/10 for printing `stdev: 8.16` — a false negative created by the
    // checker, not a missing requirement. A measuring instrument that
    // penalises a correct artefact for its choice of abbreviation measures
    // the instrument.
    add(
      'C2',
      'numeric column reports mean, median and standard deviation',
      /mean/.test(blob) && /median/.test(blob) && /(std\s*_?\s*dev|stdev|standard[_ ]?deviation|σ)/.test(blob)
    );
    add('C3', 'text column reports distinct count and top values', /distinct|unique/.test(blob) && /(top|most)/.test(blob));
    add('C2b', 'reports missing values', /missing|nulls?\b|empty/.test(blob));

    const cols = run(entry, [csv, '--columns', 'score', '--format', 'json'], dir);
    let colsParsed = null;
    try {
      colsParsed = JSON.parse(cols.stdout.trim());
    } catch {}
    const colsBlob = JSON.stringify(colsParsed ?? cols.stdout).toLowerCase();
    add('C4c', '--columns restricts the report', cols.code === 0 && colsBlob.includes('score') && !colsBlob.includes('city'), `exit=${cols.code}`);

    const missing = run(entry, [join(scratch, 'nope.csv')], dir);
    add('C5', 'missing file exits 2 with a stderr message', missing.code === 2 && missing.stderr.trim().length > 0, `exit=${missing.code}`);

    // The quoted-comma requirement: "London, UK" must stay ONE field, so the
    // city column must have 3 distinct values, not 4.
    const quotedOk = /london, uk/i.test(js.stdout + basic.stdout);
    add('C6', 'quoted field containing a comma parsed as one field', quotedOk);
  } else {
    const logf = join(scratch, 'app.log');
    writeFileSync(
      logf,
      [
        '2026-01-01T10:00:00Z ERROR failed to open "a.txt" after 3 tries',
        '2026-01-01T10:00:05Z error failed to open "b.txt" after 7 tries',
        '2026-01-01T10:01:00Z WARN slow query took 120 ms',
        '2026-01-01T10:02:00Z INFO started',
        '2026-01-01T10:03:00Z DEBUG tick 1',
      ].join('\n') + '\n'
    );
    const basic = run(entry, [logf], dir);
    add('C1', 'runs on a log file, exit 0', basic.code === 0, `exit=${basic.code} ${basic.stderr.slice(0, 80)}`);

    const help = run(entry, ['--help'], dir);
    const helpText = help.stdout + help.stderr;
    add('C4a', '--help documents --format, --level and --top', /--format/.test(helpText) && /--level/.test(helpText) && /--top/.test(helpText));

    const js = run(entry, [logf, '--format', 'json'], dir);
    let parsed = null;
    try {
      parsed = JSON.parse(js.stdout.trim());
    } catch {}
    add('C4b', '--format json emits parseable JSON', js.code === 0 && parsed !== null, `exit=${js.code}`);

    const blob = (JSON.stringify(parsed ?? {}) + basic.stdout).toLowerCase();
    add('C1b', 'counts levels case-insensitively (2 errors)', /"?error"?\s*[:=]?\s*"?2/.test(blob) || /error\D{0,12}2\b/.test(blob));
    add('C2', 'reports message templates', /template|pattern/.test(blob));
    add('C3', 'reports a time span', /span|duration|first|last|range/.test(blob));

    const missing = run(entry, [join(scratch, 'nope.log')], dir);
    add('C5', 'missing file exits 2 with a stderr message', missing.code === 2 && missing.stderr.trim().length > 0, `exit=${missing.code}`);
  }
}

// Documentation requirement, identical for both specs.
const readme = join(dir, 'README.md');
const rd = existsSync(readme) ? readFileSync(readme, 'utf8') : '';
add('C7', 'README.md documents the flags with an example', rd.length > 200 && /--format/.test(rd) && /```|\$ /.test(rd), `${rd.length} chars`);

const passed = checks.filter((c) => c.pass).length;
const verdict = {
  dir,
  spec,
  entry,
  passed,
  total: checks.length,
  score: Number((passed / checks.length).toFixed(3)),
  checks,
};
console.log(JSON.stringify(verdict, null, 2));
