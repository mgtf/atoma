#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentsPath = resolve(repoRoot, 'AGENTS.md');
const claudePath = resolve(repoRoot, 'CLAUDE.md');
const archivePath = resolve(repoRoot, 'docs/incidents/engineering-record-2026-08-14.md');

function fail(message) {
  process.stderr.write(`agent docs check failed: ${message}\n`);
  process.exit(1);
}

for (const path of [agentsPath, claudePath, archivePath]) {
  if (!existsSync(path)) fail(`missing ${relative(repoRoot, path)}`);
}

const agents = readFileSync(agentsPath, 'utf8');
const claude = readFileSync(claudePath, 'utf8');
const archive = readFileSync(archivePath, 'utf8');
const agentLines = agents.split('\n').length;

if (agentLines > 1500) fail(`AGENTS.md is ${agentLines} lines; budget is 1500`);
if (Buffer.byteLength(agents) > 100_000) {
  fail(`AGENTS.md is ${Buffer.byteLength(agents)} bytes; budget is 100000`);
}
if (archive.split('\n').length < 5000) {
  fail('the frozen record lost content (expected at least 5000 lines)');
}
if (!archive.includes('<!-- agents-archive: engineering-record-2026-08-14 -->')) {
  fail('the frozen record is missing its stable archive marker');
}

const requiredHeadings = [
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

const uncommentedClaude = claude.replace(/<!--[\s\S]*?-->/g, '').trim();
if (uncommentedClaude !== '@AGENTS.md') {
  fail('CLAUDE.md must contain exactly one active import: @AGENTS.md');
}

const proseOnly = agents
  .replace(/```[\s\S]*?```/g, '')
  .replace(/`[^`\n]*`/g, '');
const phantomImport = proseOnly.match(/(^|[\s(])@[A-Za-z0-9_./-]+/m);
if (phantomImport) {
  fail(`unquoted Claude import token in AGENTS.md: ${phantomImport[0].trim()}`);
}

const linkedMarkdown = new Set();
for (const match of agents.matchAll(/\]\(([^)]+\.md)(?:#[^)]+)?\)/g)) {
  const target = match[1];
  if (target.startsWith('http://') || target.startsWith('https://')) continue;
  const resolved = resolve(repoRoot, target);
  if (!resolved.startsWith(repoRoot + '/')) fail(`link escapes repository: ${target}`);
  if (!existsSync(resolved)) fail(`broken Markdown link: ${target}`);
  linkedMarkdown.add(relative(repoRoot, resolved));
}

const archiveRelative = relative(repoRoot, archivePath);
if (!linkedMarkdown.has(archiveRelative)) {
  fail(`routing map does not link ${archiveRelative}`);
}

process.stdout.write(
  `agent docs ok: ${agentLines} active lines, ${archive.split('\n').length} archived lines, ` +
    `${linkedMarkdown.size} linked Markdown files\n`
);
