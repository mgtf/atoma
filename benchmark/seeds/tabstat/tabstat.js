#!/usr/bin/env node
// tabstat — per-column statistics for a simple CSV file.
import { readTable, columnCells, numericColumns } from './lib/columns.js';
import { computeAll, STAT_NAMES } from './lib/stats.js';

function usage() {
  console.log('Usage: node tabstat.js [--column <name>] [--stat <name>] [--format text|json] <file.csv>');
  console.log('  --column <name>   report one column only (default: every numeric column)');
  console.log('  --stat <name>     report one statistic only: count, sum, mean, min, max');
  console.log('  --format <fmt>    text (default) or json');
  console.log('  --help            print this message');
}

function fail(message, code) {
  console.error('tabstat: ' + message);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.includes('--help')) { usage(); process.exit(0); }

function optionValue(name) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const wantedColumn = optionValue('column');
const wantedStat = optionValue('stat');
const format = optionValue('format') ?? 'text';
const consumed = new Set();
for (const name of ['column', 'stat', 'format']) {
  const i = argv.indexOf('--' + name);
  if (i >= 0) { consumed.add(i); consumed.add(i + 1); }
}
const files = argv.filter((a, i) => !consumed.has(i) && !a.startsWith('--'));

if (files.length !== 1) fail('exactly one csv file argument is required', 2);
if (format !== 'text' && format !== 'json') fail('unknown format: ' + format, 2);
if (wantedStat !== undefined && !STAT_NAMES.includes(wantedStat)) fail('unknown statistic: ' + wantedStat, 2);

let table;
try { table = readTable(files[0]); }
catch { fail('cannot read file: ' + files[0], 2); }

const columns = wantedColumn === undefined ? numericColumns(table) : [wantedColumn];
for (const name of columns) {
  if (columnCells(table, name) === null) fail('unknown column: ' + name, 3);
}

/** Text rendering: integers bare, means to two decimals. */
function renderValue(stat, value) {
  return stat === 'mean' ? value.toFixed(2) : String(value);
}

const report = {};
for (const name of columns) {
  const all = computeAll(columnCells(table, name));
  report[name] = wantedStat ? { [wantedStat]: all[wantedStat] } : all;
}

if (format === 'json') {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const name of columns) {
    console.log(name);
    for (const stat of STAT_NAMES) {
      if (report[name][stat] === undefined) continue;
      console.log(`  ${stat} ${renderValue(stat, report[name][stat])}`);
    }
  }
}
