/**
 * Facts about this repository, derived from tracked artefacts only.
 *
 * One module, two consumers: `readme-facts.mjs` renders and asserts the
 * outward-facing claims, `architecture-ir.mjs` builds the Archify diagram IR.
 * Both must agree by construction, which is only true while the derivation
 * lives in ONE place — the same reason `agent-docs-predicates.mjs` and
 * `i18n-predicates.mjs` exist beside their scripts.
 *
 * Rules this module holds itself to:
 *   - Pure. No process.exit, no writes, no network. Tests import it directly.
 *   - Dependency-free (node: builtins only), because `docs:check` runs before
 *     `npm run build` in `npm run check` and must not need a compiled dist.
 *   - Every fact comes from a TRACKED file. A number that can only be read out
 *     of `runs/`, a live store, or an archived CSV is not a fact this module
 *     may invent — AGENTS.md requires public numeric claims to be reproducible
 *     from a repository artefact today, and its 2026-08-18 exception says the
 *     pre-reset corpus measurements are narrative, not reproducible. Those stay
 *     hand-written prose and are NOT covered here. See KNOWN_NARRATIVE.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Claims a reader may expect this module to derive, and which it deliberately
 * does not. Exported so the reason travels with the code instead of being
 * rediscovered as a gap by the next person who notices the README has numbers
 * this generator ignores.
 */
export const KNOWN_NARRATIVE = Object.freeze([
  'the 156-run burn-in corpus totals: those measurement CSVs were archived out of the tree (AGENTS.md, 2026-08-18)',
  'the benchmark badges: cross-round ratios are not comparable, so one generated number would misstate them',
]);

const ENGLISH_NUMBERS = Object.freeze([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two',
  'twenty-three', 'twenty-four', 'twenty-five', 'twenty-six', 'twenty-seven',
  'twenty-eight', 'twenty-nine', 'thirty', 'thirty-one', 'thirty-two',
  'thirty-three', 'thirty-four', 'thirty-five', 'thirty-six', 'thirty-seven',
  'thirty-eight', 'thirty-nine', 'forty',
]);

/** `13` -> `thirteen`; past the table, the digits. README prose spells these out. */
export function englishNumber(value) {
  return ENGLISH_NUMBERS[value] ?? String(value);
}

function read(repoRoot, relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

/**
 * A derivation that returned nothing has not found "zero of something"; it has
 * lost its grip on the file it reads. Every counter below funnels through here,
 * so a refactor that changes a source's shape fails loudly at the docs gate
 * instead of quietly publishing a smaller number.
 */
function requirePositive(count, what, where) {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(
      `repo-facts: found ${count} ${what} in ${where}; the derivation no longer matches that file's shape`,
    );
  }
  return count;
}

/**
 * The subsystem map in AGENTS.md, which `docs:check` already proves is complete
 * and correctly linked. Reading the TABLE rather than the directory listing is
 * deliberate: the table carries each subsystem's one-line ownership sentence,
 * the only human-authored summary of what that subtree is for.
 */
export function readSubsystems(repoRoot) {
  const agents = read(repoRoot, 'AGENTS.md');
  const rows = [];
  const rowPattern = /^\|\s*`(src\/[a-z-]+\/)`\s*\|\s*\[[^\]]+\]\(([^)]+)\)\s*\|\s*([^|]+?)\s*\|$/gm;
  for (const match of agents.matchAll(rowPattern)) {
    const dir = match[1].replace(/\/$/, '');
    rows.push({
      dir,
      name: dir.slice('src/'.length),
      doc: match[2],
      owns: match[3].replace(/`/g, ''),
    });
  }
  requirePositive(rows.length, 'subsystem rows', 'the AGENTS.md subsystem map');
  return rows;
}

/**
 * The MCP catalogue (`src/mcp/tools.ts`): every tool the server can expose,
 * across all tiers. `tests/mcp-http.test.ts` asserts it behaviourally; this
 * reads the table, so the README sentence and the server cannot disagree
 * without the gate saying so.
 */
export function countMcpTools(repoRoot) {
  const catalogue = read(repoRoot, 'src/mcp/tools.ts');
  const names = new Set();
  for (const match of catalogue.matchAll(/^\s+name: '(atoma_[a-z_]+)',$/gm)) names.add(match[1]);
  return requirePositive(names.size, 'atoma_* catalogue rows', 'src/mcp/tools.ts');
}

/** The curated agent-name pools AGENTS.md quotes as 118 / 40 / 20. */
export function readAgentPools(repoRoot) {
  const pool = (file, what) => {
    const source = read(repoRoot, `src/registry/taxonomies/${file}`);
    const count = [...source.matchAll(/^\s*\{\s*ordinal:\s*\d+/gm)].length;
    return requirePositive(count, what, `src/registry/taxonomies/${file}`);
  };
  return {
    molecules: pool('molecules.ts', 'molecule entries'),
    cells: pool('cells.ts', 'cell entries'),
    tissues: pool('tissues.ts', 'tissue entries'),
  };
}

/**
 * Supported Node, from the two files that actually decide it: `.nvmrc` pins the
 * development version and `engines` states the supported range. The README
 * prints a third, prose form ("22.14+ / 24+"), and that is what drifts.
 */
export function readNodeSupport(repoRoot) {
  const nvmrc = read(repoRoot, '.nvmrc').trim();
  const engines = readPackageJson(repoRoot).engines?.node ?? '';
  const pinned = /^(\d+)\.(\d+)/.exec(nvmrc);
  if (!pinned) throw new Error(`repo-facts: .nvmrc does not pin a version: ${JSON.stringify(nvmrc)}`);
  const pinnedMajor = Number(pinned[1]);
  const supported = [...new Set([pinnedMajor, ...[...engines.matchAll(/(\d+)(?:\.\d+)*/g)].map((m) => Number(m[1]))])]
    .sort((a, b) => a - b);
  return {
    nvmrc,
    engines,
    /** "22.14+ / 24+" — the shape the README body and its footer print. */
    display: supported.map((m) => (m === pinnedMajor ? `${pinned[1]}.${pinned[2]}+` : `${m}+`)).join(' / '),
  };
}

export function readPackageJson(repoRoot) {
  return JSON.parse(read(repoRoot, 'package.json'));
}

/**
 * Pre-registered controlled rounds. Round 1 is `benchmark/RESULT.md` — it was
 * written before there was a second round to number against — and every round
 * after it is `ROUND<n>.md`. Counting only the numbered files would publish
 * eleven where the README argues twelve, so round 1 is counted explicitly and
 * the sequence is required to be contiguous: a gap means a write-up was lost,
 * which is a different problem from a round never having been run.
 */
export function countBenchmarkRounds(repoRoot) {
  const dir = resolve(repoRoot, 'benchmark');
  const numbered = readdirSync(dir)
    .map((name) => /^ROUND(\d+)\.md$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
  requirePositive(numbered.length, 'ROUND<n>.md write-ups', 'benchmark/');
  if (!existsSync(join(dir, 'RESULT.md'))) {
    throw new Error('repo-facts: benchmark/RESULT.md is missing; it is the round 1 write-up');
  }
  const expected = numbered.map((_, index) => index + 2);
  if (numbered.join(',') !== expected.join(',')) {
    throw new Error(
      `repo-facts: benchmark round write-ups are not contiguous: found ${numbered.join(', ')} after RESULT.md (round 1)`,
    );
  }
  return numbered.length + 1;
}

/**
 * Locale catalogs. `en.json` is the source; the rest are targets CI fills.
 * Counted, never read for content — an agent must not author translations.
 */
export function readLocaleCatalogs(repoRoot) {
  const catalogs = readdirSync(resolve(repoRoot, 'src/viz/client/locales')).filter((n) => n.endsWith('.json'));
  requirePositive(catalogs.length, 'locale catalogs', 'src/viz/client/locales/');
  if (!catalogs.includes('en.json')) {
    throw new Error('repo-facts: en.json is missing; it is the source catalog');
  }
  return { total: catalogs.length, targets: catalogs.length - 1 };
}

/** Every `npm run <script>` an outward-facing document tells a reader to type. */
export function collectNpmRunCommands(markdown) {
  const cited = new Set();
  for (const match of markdown.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) cited.add(match[1]);
  return [...cited].sort();
}

/** Every fact at once, in the shape both consumers read. */
export function collectFacts(repoRoot) {
  const pkg = readPackageJson(repoRoot);
  return {
    version: pkg.version,
    node: readNodeSupport(repoRoot),
    subsystems: readSubsystems(repoRoot),
    mcpTools: countMcpTools(repoRoot),
    pools: readAgentPools(repoRoot),
    benchmarkRounds: countBenchmarkRounds(repoRoot),
    locales: readLocaleCatalogs(repoRoot),
    scripts: Object.keys(pkg.scripts ?? {}),
  };
}

/** True when a mapped subsystem directory is actually present on disk. */
export function subsystemExists(repoRoot, dir) {
  return existsSync(join(repoRoot, dir));
}
