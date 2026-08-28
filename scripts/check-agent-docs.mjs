#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentsPath = resolve(repoRoot, 'AGENTS.md');
const claudePath = resolve(repoRoot, 'CLAUDE.md');
const archivePath = resolve(repoRoot, 'docs/incidents/engineering-record-2026-08-14.md');

// The root file is loaded into every session; subsystem files are loaded only
// when an agent opens that subtree. Both budgets exist to keep the split from
// quietly collapsing back into one always-loaded document.
const ROOT_LINE_BUDGET = 500;
const ROOT_BYTE_BUDGET = 60_000;
// 300 until 2026-08-23, when src/viz sat AT the cap while the next largest
// subsystem file was 175 lines: the limit had stopped shaping the split and
// started shaping SENTENCES, condensing new rules until they lost their
// reasons. A subsystem file is read only by an agent opening that subtree, so
// the pressure it needs is "one subsystem, one file", not a word count.
const SUBSYSTEM_LINE_BUDGET = 500;
// src/viz owns more surfaces than any other subtree (trace projection, the GPU
// client, the frozen MUI fallback, the gated HTTP surfaces, push, and the i18n
// catalog contract). Splitting it further would mean inventing sub-subsystems
// that no agent opens on its own, so it carries a named, explicit exception
// rather than a silently raised global budget.
const SUBSYSTEM_LINE_BUDGET_OVERRIDES = new Map([['src/viz/AGENTS.md', 600]]);

function fail(message) {
  process.stderr.write(`agent docs check failed: ${message}\n`);
  process.exit(1);
}

for (const path of [agentsPath, claudePath, archivePath]) {
  if (!existsSync(path)) fail(`missing ${relative(repoRoot, path)}`);
}

/** Every AGENTS.md under src/, at any depth. */
function findSubsystemDocs(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findSubsystemDocs(full));
    else if (entry.name === 'AGENTS.md') found.push(full);
  }
  return found;
}

const subsystemDocs = findSubsystemDocs(resolve(repoRoot, 'src')).sort();
if (subsystemDocs.length === 0) {
  fail('no subsystem AGENTS.md found under src/; the routing split is gone');
}

const agents = readFileSync(agentsPath, 'utf8');
const archive = readFileSync(archivePath, 'utf8');
const agentLines = agents.split('\n').length;

if (agentLines > ROOT_LINE_BUDGET) {
  fail(
    `AGENTS.md is ${agentLines} lines; budget is ${ROOT_LINE_BUDGET}. ` +
      'Subsystem rules belong in src/<subsystem>/AGENTS.md.',
  );
}
if (Buffer.byteLength(agents) > ROOT_BYTE_BUDGET) {
  fail(`AGENTS.md is ${Buffer.byteLength(agents)} bytes; budget is ${ROOT_BYTE_BUDGET}`);
}
if (archive.split('\n').length < 5000) {
  fail('the frozen record lost content (expected at least 5000 lines)');
}
if (!archive.includes('<!-- agents-archive: engineering-record-2026-08-14 -->')) {
  fail('the frozen record is missing its stable archive marker');
}

const requiredHeadings = [
  '## Subsystem map',
  '## Commands and workflow',
  '## Cost discipline',
  '## Architecture invariants',
  '## Skills lifecycle',
  '## Tools and runtime isolation',
  '## MCP stdio server',
  '## Testing and linting',
];
for (const heading of requiredHeadings) {
  if (!agents.includes(heading)) fail(`missing active section: ${heading}`);
}

/** Claude Code reads CLAUDE.md, Codex reads AGENTS.md; the import serves both. */
function checkImportMirror(agentsFile) {
  const mirror = resolve(dirname(agentsFile), 'CLAUDE.md');
  const shown = relative(repoRoot, mirror);
  if (!existsSync(mirror)) {
    fail(`${shown} is missing; every AGENTS.md needs its one-line Claude import`);
  }
  const active = readFileSync(mirror, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (active !== '@AGENTS.md') {
    fail(`${shown} must contain exactly one active import: @AGENTS.md`);
  }
}

/** An at-sign token outside code spans is a phantom import into every session. */
function checkNoPhantomImports(file, text) {
  const proseOnly = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const phantom = proseOnly.match(/(^|[\s(])@[A-Za-z0-9_./-]+/m);
  if (phantom) {
    fail(`unquoted Claude import token in ${relative(repoRoot, file)}: ${phantom[0].trim()}`);
  }
}

/** Links are resolved from the linking file, so depth mistakes fail here. */
function collectMarkdownLinks(file, text) {
  const targets = new Set();
  for (const match of text.matchAll(/\]\(([^)]+\.md)(?:#[^)]+)?\)/g)) {
    const target = match[1];
    if (target.startsWith('http://') || target.startsWith('https://')) continue;
    const resolved = resolve(dirname(file), target);
    const shown = relative(repoRoot, file);
    if (!resolved.startsWith(repoRoot + '/')) fail(`link escapes repository: ${target} (${shown})`);
    if (!existsSync(resolved)) fail(`broken Markdown link: ${target} (${shown})`);
    targets.add(relative(repoRoot, resolved));
  }
  return targets;
}

checkImportMirror(agentsPath);
checkNoPhantomImports(agentsPath, agents);
const rootLinks = collectMarkdownLinks(agentsPath, agents);

const archiveRelative = relative(repoRoot, archivePath);
if (!rootLinks.has(archiveRelative)) {
  fail(`AGENTS.md does not link ${archiveRelative}`);
}

let subsystemLines = 0;
for (const doc of subsystemDocs) {
  const shown = relative(repoRoot, doc);
  const text = readFileSync(doc, 'utf8');
  const lines = text.split('\n').length;
  subsystemLines += lines;
  const budget = SUBSYSTEM_LINE_BUDGET_OVERRIDES.get(shown) ?? SUBSYSTEM_LINE_BUDGET;
  if (lines > budget) {
    fail(`${shown} is ${lines} lines; budget is ${budget}`);
  }
  checkImportMirror(doc);
  checkNoPhantomImports(doc, text);
  const links = collectMarkdownLinks(doc, text);
  if (!links.has('AGENTS.md')) {
    fail(`${shown} must link back to the root contract as [\`AGENTS.md\`](../../AGENTS.md)`);
  }
  // An unreachable subsystem file is worse than no file: Codex only merges
  // root-down-to-cwd, so the root map is how a reader learns it exists.
  if (!rootLinks.has(shown)) {
    fail(`${shown} is not listed in the AGENTS.md subsystem map`);
  }
}

process.stdout.write(
  `agent docs ok: ${agentLines} root lines, ${subsystemDocs.length} subsystem files ` +
    `(${subsystemLines} lines), ${archive.split('\n').length} archived lines, ` +
    `${rootLinks.size} linked Markdown files\n`,
);
