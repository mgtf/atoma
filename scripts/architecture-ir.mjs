#!/usr/bin/env node
/**
 * The architecture diagram's source of truth, derived from the subsystem map.
 *
 * WHY A GENERATOR AND NOT A DRAWING. A diagram authored by hand drifts exactly
 * like the prose numbers `readme-facts.mjs` guards: nothing fails when a
 * subsystem is added, renamed or deleted, so the picture quietly becomes a
 * historical document. Here the component list is READ from the AGENTS.md
 * subsystem map — the same table `docs:check` already proves complete — so a
 * subsystem that appears in the repository and not in the diagram is a failing
 * check, not a stale PNG.
 *
 * WHAT IS STILL AUTHORED. Placement and edges. `LAYOUT` below is the one
 * hand-maintained table, and a subsystem missing from it FAILS: adding a
 * subsystem forces a deliberate decision about where it sits and what it talks
 * to, which is the review this generator exists to provoke. Edges may only name
 * ids the map produced.
 *
 * WHAT IS NOT IN THE COMMITTED IR. `meta.repository` and per-component
 * `sources`. Archify's repository evidence pins a full 40-character SHA and
 * verifies every source path AT that revision, which is excellent — and which
 * would make the committed file change on every commit, so the drift check
 * could never be green. Both are therefore INJECTED at render time (`--render`)
 * against the current HEAD: the committed IR stays stable and structural, and
 * the rendered artifact still carries provenance verified against a real
 * commit.
 *
 * Usage:
 *   node scripts/architecture-ir.mjs                 # check (docs:check, CI)
 *   node scripts/architecture-ir.mjs --apply         # rewrite the IR
 *   node scripts/architecture-ir.mjs --render        # + Archify validate/deliver
 *   node scripts/architecture-ir.mjs --render --svg  # + the committable SVG
 *
 * `--render` needs a local Archify checkout and is DEVELOPMENT TOOLING, never a
 * release path: point ARCHIFY_HOME (or --archify) at it. `docs:check` never
 * renders — CI stays hermetic and free of a third-party clone.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { argv, env, exit, stderr, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collectFacts } from './repo-facts.mjs';

export const IR_PATH = 'docs/ir/atoma.architecture.json';
export const RENDER_PATH = 'docs/architecture.html';
export const SVG_PATH = 'docs/architecture.svg';
const REPOSITORY_URL = 'https://github.com/mgtf/atoma';

/**
 * Placement and semantic type per subsystem. Keys are the subsystem directory
 * names from the AGENTS.md map; `band` names the row, `col` the position in it.
 *
 * Both coordinates are AUTHORED, not read from the map. The map's order is
 * documentation order — the sequence a reader should learn the system in — and
 * using it as diagram order produced a first draft whose arrows crossed four
 * unrelated components. Archify's layout validator caught every one, which is
 * the argument for the split: the generator owns membership (nothing can be
 * missing), a human owns arrangement (nothing has to look automatic).
 */
const LAYOUT = Object.freeze({
  cli: { band: 'surfaces', col: 0, type: 'frontend', label: 'CLI' },
  mcp: { band: 'surfaces', col: 1, type: 'messagebus', label: 'MCP stdio' },
  viz: { band: 'surfaces', col: 2, type: 'frontend', label: 'Web console' },

  run: { band: 'supervision', col: 0, type: 'backend', label: 'Run' },
  atoms: { band: 'supervision', col: 1, type: 'backend', label: 'Atoms' },
  core: { band: 'supervision', col: 2, type: 'backend', label: 'Core' },

  tools: { band: 'state', col: 0, type: 'security', label: 'Tools' },
  registry: { band: 'state', col: 1, type: 'database', label: 'Registry' },
  skills: { band: 'state', col: 2, type: 'database', label: 'Skills' },
  contracts: { band: 'state', col: 3, type: 'security', label: 'Contracts' },

  launcher: { band: 'isolation', col: 0, type: 'cloud', label: 'Launcher' },
  preview: { band: 'isolation', col: 1, type: 'cloud', label: 'Preview' },

  auth: { band: 'control', col: 0, type: 'security', label: 'Auth' },
  projects: { band: 'control', col: 1, type: 'database', label: 'Projects' },
  github: { band: 'control', col: 2, type: 'external', label: 'GitHub' },

  platform: { band: 'journal', col: 0, type: 'database', label: 'Platform' },
  sentinel: { band: 'journal', col: 1, type: 'backend', label: 'Sentinel' },
  supervisor: { band: 'journal', col: 2, type: 'backend', label: 'Supervisor' },
});

const BANDS = Object.freeze([
  { id: 'surfaces', row: 0, label: 'Entry surfaces' },
  { id: 'supervision', row: 1, label: 'Supervision and accounting' },
  { id: 'state', row: 2, label: 'Elements and persisted identity' },
  { id: 'isolation', row: 3, label: 'Container isolation' },
  { id: 'control', row: 4, label: 'Gated control plane' },
  { id: 'journal', row: 5, label: 'Audit, live watch and self-repair' },
]);

/**
 * Structural edges. Only ids the subsystem map produced may appear here, and
 * `buildIr` enforces that — a rename in AGENTS.md fails this file rather than
 * rendering a diagram with a dangling arrow.
 */
const EDGES = Object.freeze([
  { from: 'cli', to: 'run', variant: 'emphasis' },
  { from: 'mcp', to: 'run', variant: 'emphasis' },
  // Two columns to the left and one band down: the router infers a sideways
  // approach and then cannot honour it. Stated explicitly, it drops straight.
  { from: 'viz', to: 'run', fromSide: 'bottom', toSide: 'top' },
  { from: 'run', to: 'atoms', variant: 'emphasis' },
  { from: 'atoms', to: 'core', variant: 'emphasis' },
  { from: 'atoms', to: 'tools', variant: 'emphasis' },
  { from: 'atoms', to: 'registry' },
  { from: 'atoms', to: 'skills' },
  { from: 'contracts', to: 'core' },
  { from: 'tools', to: 'launcher', variant: 'security' },
  { from: 'launcher', to: 'preview', variant: 'security' },
  { from: 'auth', to: 'projects', variant: 'security' },
  { from: 'github', to: 'projects' },
  { from: 'projects', to: 'platform' },
  { from: 'sentinel', to: 'platform' },
  { from: 'supervisor', to: 'platform' },
  { from: 'supervisor', to: 'sentinel' },
]);

const CELL_WIDTH = 172;
/**
 * Archify refuses a sublabel that cannot be read at its legible minimum inside
 * the cell it is given, so this budget is not cosmetic — exceed it and
 * `validate` fails with the exact pixel arithmetic.
 */
const SUBLABEL_BUDGET = 30;

/** Trim an AGENTS.md ownership sentence down to a component sublabel. */
function sublabel(owns) {
  const first = owns.split(/[,;:]/)[0].trim();
  return first.length > SUBLABEL_BUDGET ? `${first.slice(0, SUBLABEL_BUDGET - 1).trimEnd()}…` : first;
}

/** The committed IR: structure only, no revision, no evidence. */
export function buildIr({ subsystems, facts }) {
  const known = new Set(subsystems.map((s) => s.name));
  const unplaced = subsystems.filter((s) => !LAYOUT[s.name]);
  if (unplaced.length > 0) {
    throw new Error(
      `architecture-ir: ${unplaced.map((s) => s.dir).join(', ')} appear in the AGENTS.md subsystem map but not in LAYOUT. ` +
        'Place each one in a band and give it its edges — a new subsystem is a diagram decision, not a default.',
    );
  }
  const stale = Object.keys(LAYOUT).filter((name) => !known.has(name));
  if (stale.length > 0) {
    throw new Error(`architecture-ir: LAYOUT still places ${stale.join(', ')}, which the subsystem map no longer lists`);
  }
  for (const edge of EDGES) {
    for (const end of [edge.from, edge.to]) {
      if (!known.has(end)) throw new Error(`architecture-ir: edge ${edge.from} → ${edge.to} names unknown subsystem "${end}"`);
    }
  }

  const inBand = (band) =>
    subsystems.filter((s) => LAYOUT[s.name].band === band.id).sort((a, b) => LAYOUT[a.name].col - LAYOUT[b.name].col);

  const components = [];
  for (const band of BANDS) {
    const members = inBand(band);
    const columns = new Set(members.map((s) => LAYOUT[s.name].col));
    if (columns.size !== members.length) {
      throw new Error(`architecture-ir: band "${band.id}" places two subsystems in the same column`);
    }
    for (const subsystem of members) {
      const placed = LAYOUT[subsystem.name];
      components.push({
        id: subsystem.name,
        type: placed.type,
        label: placed.label,
        sublabel: sublabel(subsystem.owns),
        row: band.row,
        col: placed.col,
      });
    }
  }

  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: {
      title: 'atoma',
      subtitle: `${subsystems.length} subsystems, each under its own AGENTS.md contract`,
      output: RENDER_PATH,
    },
    layout: {
      mode: 'grid',
      origin: [48, 120],
      cols: Math.max(...Object.values(LAYOUT).map((placed) => placed.col)) + 1,
      gapX: 32,
      gapY: 60,
      cellW: CELL_WIDTH,
      cellH: 64,
    },
    components,
    boundaries: BANDS.map((band) => ({
      kind: 'region',
      label: band.label,
      wraps: inBand(band).map((s) => s.name),
    })),
    connections: [...EDGES],
    cards: [
      {
        dot: 'cyan',
        title: 'Read out of this checkout',
        items: [
          `${facts.mcpTools} MCP tools on the HTTP control plane`,
          `${facts.pools.molecules} molecules · ${facts.pools.cells} cells · ${facts.pools.tissues} tissues`,
          `${facts.benchmarkRounds} controlled benchmark rounds recorded`,
        ],
      },
    ],
  };
}

/**
 * The render IR: the committed structure plus provenance Archify can verify.
 * Every component points at its own AGENTS.md, which is the file that actually
 * governs that subtree, and the revision is the current HEAD commit.
 */
export function withRepositoryEvidence(ir, { subsystems, revision }) {
  const doc = new Map(subsystems.map((s) => [s.name, s.doc]));
  return {
    ...ir,
    meta: { ...ir.meta, repository: { url: REPOSITORY_URL, revision } },
    components: ir.components.map((component) => ({
      ...component,
      sources: [{ path: doc.get(component.id), label: 'contract' }],
    })),
  };
}

function serialise(ir) {
  return `${JSON.stringify(ir, null, 2)}\n`;
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function archifyRoot(explicit) {
  const home = explicit ?? env.ARCHIFY_HOME;
  if (!home) {
    throw new Error(
      'rendering needs a local Archify checkout: set ARCHIFY_HOME (or pass --archify <path>) to a clone of https://github.com/tt-a1i/archify',
    );
  }
  const bin = join(resolve(home), 'archify', 'bin', 'archify.mjs');
  if (!existsSync(bin)) throw new Error(`no Archify CLI at ${bin}`);
  return bin;
}

/**
 * Lift a standalone, embeddable SVG out of a delivered Archify page.
 *
 * Archify's own export is a button INSIDE the rendered page — it copies a PNG
 * or a share card from the browser — so there is no headless export command,
 * and GitHub will not render an HTML artifact inside a README. What makes this
 * work anyway is that the artifact's diagram is one inline `<svg>` and every
 * rule that paints it lives in the page's single `<style>`. Lift both, inline
 * the stylesheet into the SVG root, and the result renders standalone.
 *
 * Two details are load-bearing:
 *   - the CSS must be wrapped in CDATA, or an XML parser trips over the first
 *     `<` inside it and renders nothing but a parse error;
 *   - `xmlns` must be declared, since the fragment inside an HTML document
 *     inherits a namespace it does not carry on its own.
 */
export function standaloneSvg(html) {
  const styleOpen = html.indexOf('<style');
  const styleStart = html.indexOf('>', styleOpen) + 1;
  const styleEnd = html.indexOf('</style>', styleStart);
  const svgStart = html.indexOf('<svg');
  const svgEnd = html.indexOf('</svg>', svgStart);
  if (styleOpen === -1 || styleEnd === -1 || svgStart === -1 || svgEnd === -1) {
    throw new Error('architecture-ir: the delivered page has no <style>/<svg> pair to lift');
  }
  const css = html.slice(styleStart, styleEnd);
  const svg = html.slice(svgStart, svgEnd + '</svg>'.length);
  const rootEnd = svg.indexOf('>') + 1;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    svg.slice(0, rootEnd).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ') +
    `\n<style><![CDATA[\n${css}\n]]></style>\n` +
    `${svg.slice(rootEnd)}\n`
  );
}

/**
 * Validate and deliver through Archify. The rendered HTML is NOT committed by
 * default: it is a build output of the IR, and the IR is the reviewable thing.
 */
export function render(repoRoot, { archify, outPath, svg }) {
  const bin = archifyRoot(archify);
  const subsystems = collectFacts(repoRoot).subsystems;
  const ir = JSON.parse(readFileSync(resolve(repoRoot, IR_PATH), 'utf8'));
  const revision = git(repoRoot, ['rev-parse', 'HEAD']);

  const staging = resolve(repoRoot, 'docs/ir/.render');
  mkdirSync(staging, { recursive: true });
  const archifyRun = (args) => execFileSync(process.execPath, [bin, ...args], { cwd: repoRoot, encoding: 'utf8' });

  // The interactive artifact carries provenance: every component links to its
  // own contract file, verified by Archify at a real commit.
  const evidenceIr = join(staging, 'atoma.architecture.evidence.json');
  writeFileSync(evidenceIr, serialise(withRepositoryEvidence(ir, { subsystems, revision })));
  const output = resolve(repoRoot, outPath ?? RENDER_PATH);
  const validation = archifyRun(['validate', 'architecture', evidenceIr, '--repo-root', repoRoot, '--json']);
  archifyRun(['deliver', 'architecture', evidenceIr, output, '--repo-root', repoRoot, '--quality', 'showcase']);

  // The committable SVG is rendered from the PLAIN IR instead. Evidence links
  // are dead weight in an `<img>`-embedded SVG — a browser will not follow
  // them — and pinning a revision would rewrite the file on every render, so
  // an image meant to be reviewed in a diff must not carry one.
  let svgPath = null;
  if (svg) {
    const plainIr = join(staging, 'atoma.architecture.plain.json');
    writeFileSync(plainIr, serialise(ir));
    const plainHtml = join(staging, 'atoma.architecture.plain.html');
    archifyRun(['deliver', 'architecture', plainIr, plainHtml, '--quality', 'showcase']);
    svgPath = resolve(repoRoot, typeof svg === 'string' ? svg : SVG_PATH);
    writeFileSync(svgPath, standaloneSvg(readFileSync(plainHtml, 'utf8')));
  }
  return { revision, output, svgPath, validation };
}

export function run(repoRoot, { apply }) {
  const facts = collectFacts(repoRoot);
  const ir = buildIr({ subsystems: facts.subsystems, facts });
  const path = resolve(repoRoot, IR_PATH);
  const next = serialise(ir);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const problems = [];

  if (current !== next) {
    if (apply) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, next);
    } else {
      problems.push(`${IR_PATH} no longer matches the subsystem map; run \`npm run docs:architecture -- --apply\``);
    }
  }
  return { ir, problems, wrote: apply && current !== next };
}

/* c8 ignore start — CLI wrapper; buildIr and withRepositoryEvidence carry the behaviour. */
if (import.meta.url === pathToFileURL(argv[1] ?? '').href) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  try {
    const result = run(repoRoot, { apply: argv.includes('--apply') || argv.includes('--render') });
    for (const problem of result.problems) stderr.write(`architecture ir failed: ${problem}\n`);
    if (result.problems.length > 0) exit(1);
    stdout.write(
      `architecture ir ok: ${result.wrote ? 'rewritten, ' : ''}${result.ir.components.length} components, ${result.ir.connections.length} edges\n`,
    );
    if (argv.includes('--render')) {
      const rendered = render(repoRoot, {
        archify: flag('--archify'),
        outPath: flag('--out'),
        svg: argv.includes('--svg'),
      });
      stdout.write(`architecture rendered: ${rendered.output} (evidence pinned at ${rendered.revision.slice(0, 12)})\n`);
      if (rendered.svgPath) stdout.write(`architecture svg: ${rendered.svgPath}\n`);
    }
  } catch (error) {
    stderr.write(`architecture ir failed: ${error.message}\n`);
    if (error.stdout) stderr.write(`${error.stdout}\n`);
    if (error.stderr) stderr.write(`${error.stderr}\n`);
    exit(1);
  }
}
/* c8 ignore stop */
