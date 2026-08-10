#!/usr/bin/env node
/**
 * Render the benchmark result as a self-contained SVG — no dependencies, no
 * chart library, so it can be committed and rendered by GitHub directly.
 *
 *   node benchmark/plot.mjs [results.csv] [out.svg]
 *
 * Two panels, because the two questions are different:
 *   LEFT   per-run cost. Does atoma get cheaper with experience at all?
 *   RIGHT  cumulative cost. When does the total spend cross the baseline's —
 *          the pre-registered metric N*.
 *
 * The cumulative panel is the one that answers the registered question; the
 * per-run panel is what makes a flat or rising series impossible to hide.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const csvPath = process.argv[2] ?? 'benchmark/results.csv';
const outPath = process.argv[3] ?? 'docs/benchmark-cost-curve.svg';

const rows = readFileSync(csvPath, 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((l) => l.split(','))
  .map((c) => ({
    arm: c[1],
    taskId: c[2],
    runIndex: Number(c[3]),
    outcome: c[4],
    cost: c[5] === '' ? null : Number(c[5]),
    durationS: c[6] === '' ? null : Number(c[6]),
  }));

const primary = rows.filter((r) => r.taskId === (process.env.PRIMARY_ID ?? 'csvstat'));
const delivered = (arm) =>
  primary
    .filter((r) => r.arm === arm && r.outcome === 'delivered' && r.cost !== null)
    .sort((a, b) => a.runIndex - b.runIndex)
    .map((r) => r.cost);

const base = delivered('baseline');
const atoma = delivered('atoma');
if (atoma.length === 0) {
  console.error('no delivered atoma rows yet — nothing to plot');
  process.exit(1);
}
const baseMean = base.length ? base.reduce((a, b) => a + b, 0) / base.length : 0;

const cumA = [];
const cumB = [];
let s = 0;
atoma.forEach((c, i) => {
  s += c;
  cumA.push(s);
  cumB.push(baseMean * (i + 1));
});
const breakEven = cumA.findIndex((v, i) => v < cumB[i]);
const nStar = breakEven === -1 ? null : breakEven + 1;

// ── layout ──────────────────────────────────────────────────────────────────
const W = 920,
  H = 424,
  PAD = { t: 80, r: 24, b: 72, l: 62 },
  GAP = 56;
const panelW = (W - PAD.l - PAD.r - GAP) / 2;
const panelH = H - PAD.t - PAD.b;

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fmt = (v) => `$${v.toFixed(2)}`;

function panel(x0, title, series, yMax, xCount) {
  const sx = (i) => x0 + (xCount <= 1 ? panelW / 2 : (i / (xCount - 1)) * panelW);
  const sy = (v) => PAD.t + panelH - (v / yMax) * panelH;
  const out = [];
  out.push(
    `<text x="${x0}" y="${PAD.t - 18}" class="ttl">${esc(title)}</text>`
  );
  // grid + y labels
  for (let g = 0; g <= 4; g++) {
    const v = (yMax / 4) * g;
    const y = sy(v);
    out.push(`<line x1="${x0}" y1="${y}" x2="${x0 + panelW}" y2="${y}" class="grid"/>`);
    out.push(`<text x="${x0 - 8}" y="${y + 4}" class="ax" text-anchor="end">${fmt(v)}</text>`);
  }
  // x labels
  for (let i = 0; i < xCount; i++) {
    out.push(
      `<text x="${sx(i)}" y="${PAD.t + panelH + 18}" class="ax" text-anchor="middle">${i + 1}</text>`
    );
  }
  out.push(
    `<text x="${x0 + panelW / 2}" y="${PAD.t + panelH + 38}" class="ax" text-anchor="middle">run</text>`
  );
  for (const s of series) {
    const pts = s.values.map((v, i) => `${sx(i)},${sy(v)}`).join(' ');
    out.push(
      `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5" ${
        s.dash ? `stroke-dasharray="6 4"` : ''
      }/>`
    );
    s.values.forEach((v, i) => {
      out.push(`<circle cx="${sx(i)}" cy="${sy(v)}" r="3.5" fill="${s.color}"/>`);
    });
  }
  return { svg: out.join('\n'), sx, sy };
}

const yMax1 = Math.max(...atoma, ...(base.length ? base : [0])) * 1.15 || 1;
const yMax2 = Math.max(cumA.at(-1), cumB.at(-1)) * 1.1;

const p1 = panel(PAD.l, 'Cost per run', [
  ...(base.length
    ? [{ values: atoma.map(() => baseMean), color: '#b91c1c', dash: true }]
    : []),
  { values: atoma, color: '#047857' },
], yMax1, atoma.length);

const p2 = panel(PAD.l + panelW + GAP, 'Cumulative cost', [
  { values: cumB, color: '#b91c1c', dash: true },
  { values: cumA, color: '#047857' },
], yMax2, atoma.length);

let marker = '';
if (nStar !== null) {
  const x = p2.sx(nStar - 1);
  marker =
    `<line x1="${x}" y1="${PAD.t}" x2="${x}" y2="${PAD.t + panelH}" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 3"/>` +
    `<text x="${x + 6}" y="${PAD.t + 14}" class="mark">break-even N*=${nStar}</text>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-sans-serif,system-ui,sans-serif">
<style>
  .ttl{font-size:14px;font-weight:600;fill:#0f172a}
  .ax{font-size:11px;fill:#64748b}
  .lg{font-size:12px;fill:#334155}
  .mark{font-size:11px;fill:#0f766e;font-weight:600}
  .grid{stroke:#e2e8f0;stroke-width:1}
  .sub{font-size:11px;fill:#64748b}
  @media (prefers-color-scheme: dark){
    .ttl{fill:#e2e8f0}.ax{fill:#94a3b8}.lg{fill:#cbd5e1}.grid{stroke:#334155}.sub{fill:#94a3b8}
    svg{background:transparent}
  }
</style>
<text x="${PAD.l}" y="22" class="ttl">atoma vs single frontier agent — same task, repeated</text>
<text x="${PAD.l}" y="38" class="sub">baseline n=${base.length} (mean ${fmt(baseMean)}) · atoma n=${atoma.length} · ${
  nStar === null ? 'no break-even within the runs performed' : `cumulative break-even at run ${nStar}`
}</text>
${p1.svg}
${p2.svg}
${marker}
<g transform="translate(${PAD.l},${H - 8})">
  <line x1="0" y1="-4" x2="22" y2="-4" stroke="#b91c1c" stroke-width="2.5" stroke-dasharray="6 4"/>
  <text x="28" y="0" class="lg">frontier direct</text>
  <line x1="140" y1="-4" x2="162" y2="-4" stroke="#047857" stroke-width="2.5"/>
  <text x="168" y="0" class="lg">atoma</text>
</g>
</svg>
`;

writeFileSync(outPath, svg, 'utf8');
console.log(
  `wrote ${outPath}  (baseline n=${base.length} mean ${fmt(baseMean)}, atoma n=${atoma.length}, N*=${nStar ?? 'none'})`
);
