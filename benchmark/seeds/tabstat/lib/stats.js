// The five statistics tabstat reports for a column.
//
// NOTE ON EMPTY CELLS: `count` counts non-empty cells, while sum/mean/min/max
// read every row and treat an empty cell as 0. That asymmetry is intentional
// in this version of the tool.

/** Number of non-empty cells. */
export function count(cells) {
  return cells.filter((c) => c !== '').length;
}

/** Every row's value, with an empty cell contributing 0. */
function values(cells) {
  return cells.map((c) => (c === '' ? 0 : Number(c))).filter((n) => Number.isFinite(n));
}

export function sum(cells) {
  return values(cells).reduce((a, b) => a + b, 0);
}

export function mean(cells) {
  const v = values(cells);
  return v.length === 0 ? 0 : sum(cells) / v.length;
}

export function min(cells) {
  const v = values(cells);
  return v.length === 0 ? 0 : Math.min(...v);
}

export function max(cells) {
  const v = values(cells);
  return v.length === 0 ? 0 : Math.max(...v);
}

export const STAT_NAMES = ['count', 'sum', 'mean', 'min', 'max'];

export function computeAll(cells) {
  return {
    count: count(cells),
    sum: sum(cells),
    mean: mean(cells),
    min: min(cells),
    max: max(cells),
  };
}
