#!/usr/bin/env node
/**
 * Keeps the outward-facing numbers honest, two different ways.
 *
 * GENERATE what is tabular: one marker-delimited block in README.md, rewritten
 * from the checkout by `--apply`. ASSERT what is prose: the sentences that
 * carry the same numbers are checked, never rewritten. That split is the whole
 * design. A generator that edits prose would either flatten the README's voice
 * or, worse, silently "correct" a claim whose surrounding argument no longer
 * holds — and the claim's argument is the part a machine cannot see. So the
 * machine owns a table and reports on the prose; a human owns the sentence.
 *
 * `--apply` writes the block and STILL fails on prose drift, deliberately: a
 * CI auto-fix must never be able to make a wrong sentence look reviewed.
 *
 * Usage:
 *   node scripts/readme-facts.mjs            # check (docs:check, CI)
 *   node scripts/readme-facts.mjs --apply    # rewrite the generated block
 *
 * Exported for tests/readme-facts.test.ts; the CLI runs only when this file is
 * the entry module, so importing it has no side effects.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collectFacts, collectNpmRunCommands, englishNumber } from './repo-facts.mjs';

export const BEGIN = '<!-- atoma:facts:begin -->';
export const END = '<!-- atoma:facts:end -->';

/** `a || b` inside a Markdown table cell needs its pipes escaped. */
function cell(text) {
  return text.replace(/\|/g, '\\|');
}

/**
 * The generated block. Every row must be derivable from a tracked artefact —
 * `repo-facts.mjs` is where that rule is enforced, and its KNOWN_NARRATIVE list
 * says which README numbers are deliberately absent from this table.
 */
export function renderFactsBlock(facts) {
  const { molecules, cells, tissues } = facts.pools;
  const rows = [
    ['Version', `\`${facts.version}\``],
    ['Node', `${facts.node.display} (\`.nvmrc\` ${facts.node.nvmrc}, \`engines\` ${cell(facts.node.engines)})`],
    ['Subsystems under their own contract', `${facts.subsystems.length}`],
    ['MCP tools', `${facts.mcpTools}`],
    ['Curated agent names', `${molecules} molecules · ${cells} cells · ${tissues} tissues`],
    ['Controlled benchmark rounds', `${facts.benchmarkRounds} (\`benchmark/RESULT.md\` + \`ROUND<n>.md\`)`],
    ['Interface locales', `${facts.locales.total} catalogs — 1 source, ${facts.locales.targets} translated`],
  ];
  return [
    BEGIN,
    '<!-- Generated from this checkout by `npm run docs:facts -- --apply`. Do not edit by hand. -->',
    '',
    '| Read out of this checkout | |',
    '| --- | --- |',
    ...rows.map(([label, value]) => `| ${label} | ${value} |`),
    '',
    END,
  ].join('\n');
}

/** Replaces the block between the markers. Missing markers are a hard error. */
export function replaceFactsBlock(markdown, rendered) {
  const start = markdown.indexOf(BEGIN);
  const end = markdown.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md is missing the ${BEGIN} … ${END} markers`);
  }
  return markdown.slice(0, start) + rendered + markdown.slice(end + END.length);
}

/**
 * The prose claims, checked against the same facts. Each entry states where the
 * number really lives, because the failure message is the whole product here:
 * whoever hits it is being told which sentence to rewrite and why.
 */
export function proseFailures({ readme, agents, facts }) {
  const failures = [];
  const spelled = englishNumber(facts.mcpTools);

  const toolSentence = /\*\*([A-Za-z]+) tools\.\*\*/.exec(readme);
  if (!toolSentence) {
    failures.push('README.md no longer contains the "**<spelled-number> tools.**" sentence that states the MCP surface');
  } else if (toolSentence[1].toLowerCase() !== spelled) {
    failures.push(
      `README.md says "${toolSentence[1]} tools" but src/mcp/server.ts registers ${facts.mcpTools} (${spelled})`,
    );
  }

  const roundSentence = /\*\*([A-Za-z]+) controlled rounds/.exec(readme);
  if (!roundSentence) {
    failures.push('README.md no longer contains the "**<spelled-number> controlled rounds" sentence');
  } else if (roundSentence[1].toLowerCase() !== englishNumber(facts.benchmarkRounds)) {
    failures.push(
      `README.md says "${roundSentence[1]} controlled rounds" but benchmark/ holds ${facts.benchmarkRounds}`,
    );
  }

  // Both README mentions of a supported Node version print the pinned minor.
  // Any other `<major>.<minor>+` token is a version claim that drifted away
  // from .nvmrc — the file that actually decides what contributors run.
  const pinned = `${facts.node.nvmrc.split('.').slice(0, 2).join('.')}+`;
  for (const token of new Set([...readme.matchAll(/\d+\.\d+\+/g)].map((m) => m[0]))) {
    if (token !== pinned) failures.push(`README.md claims Node ${token}; .nvmrc pins ${facts.node.nvmrc} (${pinned})`);
  }

  // AGENTS.md is loaded into every agent session, so a stale count there is a
  // wrong instruction, not just a wrong document.
  const pools = `${facts.pools.molecules} molecules, ${facts.pools.cells} cells, and ${facts.pools.tissues} tissues`;
  if (!agents.includes(pools)) {
    failures.push(`AGENTS.md does not state the curated pools as "${pools}" (counted in src/registry/taxonomies/)`);
  }
  if (!agents.includes(`The ${facts.mcpTools} \`atoma_*\` MCP tools`)) {
    failures.push(`AGENTS.md does not state the MCP surface as ${facts.mcpTools} atoma_* tools`);
  }

  // A command a reader is told to type must exist. AGENTS.md forbids
  // advertising a path the package does not ship.
  const known = new Set(facts.scripts);
  for (const cited of collectNpmRunCommands(readme)) {
    if (!known.has(cited)) failures.push(`README.md tells the reader to run \`npm run ${cited}\`, which package.json does not define`);
  }

  return failures;
}

export function run(repoRoot, { apply }) {
  const readmePath = resolve(repoRoot, 'README.md');
  const facts = collectFacts(repoRoot);
  const original = readFileSync(readmePath, 'utf8');
  const updated = replaceFactsBlock(original, renderFactsBlock(facts));
  const problems = [];

  if (updated !== original) {
    if (apply) writeFileSync(readmePath, updated);
    else problems.push('the generated README block is stale; run `npm run docs:facts -- --apply`');
  }
  problems.push(...proseFailures({ readme: apply ? updated : original, agents: readFileSync(resolve(repoRoot, 'AGENTS.md'), 'utf8'), facts }));

  return { facts, problems, wrote: apply && updated !== original };
}

/* c8 ignore start — CLI wrapper; the behaviour above is what tests exercise. */
if (import.meta.url === pathToFileURL(argv[1] ?? '').href) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const apply = argv.includes('--apply');
  let result;
  try {
    result = run(repoRoot, { apply });
  } catch (error) {
    stderr.write(`readme facts failed: ${error.message}\n`);
    exit(1);
  }
  for (const problem of result.problems) stderr.write(`readme facts failed: ${problem}\n`);
  if (result.problems.length > 0) exit(1);
  stdout.write(
    `readme facts ok: ${result.wrote ? 'block rewritten, ' : ''}` +
      `${result.facts.mcpTools} MCP tools, ${result.facts.subsystems.length} subsystems, Node ${result.facts.node.display}\n`,
  );
}
/* c8 ignore stop */
