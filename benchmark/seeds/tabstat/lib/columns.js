// CSV reading and column extraction. Deliberately minimal: no quoting, no
// escapes — the fixture never needs them and the task is about statistics.
import fs from 'node:fs';

export function readTable(path) {
  const text = fs.readFileSync(path, 'utf8');
  const rows = text.split('\n').filter((l) => l.length > 0);
  const header = rows[0].split(',');
  const body = rows.slice(1).map((r) => r.split(','));
  return { header, body };
}

/** Cells of one column, in row order, as raw strings. */
export function columnCells(table, name) {
  const idx = table.header.indexOf(name);
  if (idx < 0) return null;
  return table.body.map((row) => (row[idx] === undefined ? '' : row[idx]));
}

/** Columns that hold at least one value parsing as a number. */
export function numericColumns(table) {
  return table.header.filter((name) => {
    const cells = columnCells(table, name);
    return cells.some((c) => c !== '' && Number.isFinite(Number(c)));
  });
}
