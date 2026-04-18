#!/usr/bin/env tsx
/**
 * atoma registry CLI — inspect persisted atom types and their usage history.
 *
 * Usage:
 *   tsx src/cli/registry.ts list [--tier 1|2|3] [--db path]
 *   tsx src/cli/registry.ts show <name>          [--db path]
 *   tsx src/cli/registry.ts top  [--tier 1|2|3] [--by success|failure|ratio] [--db path]
 *
 * Defaults: --db from ATOMA_DB_PATH env or ./atoma.db; --by success for `top`.
 */

import { openDb } from '../registry/db.js';
import { AtomRegistry, type AtomType } from '../registry/atomRegistry.js';
import type { Tier } from '../core/types.js';

interface Args {
  command: 'list' | 'show' | 'top' | 'help';
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const rest = argv.slice(2);
  if (rest.length === 0) return { command: 'help', positional: [], flags: {} };
  const cmd = rest[0] as Args['command'];
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 1; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(token);
    }
  }
  if (!['list', 'show', 'top', 'help'].includes(cmd)) {
    return { command: 'help', positional: [cmd, ...positional], flags };
  }
  return { command: cmd, positional, flags };
}

function dbPathFrom(flags: Record<string, string>): string {
  return flags['db'] ?? process.env['ATOMA_DB_PATH'] ?? './atoma.db';
}

function tierFrom(flags: Record<string, string>): Tier | undefined {
  if (!flags['tier']) return undefined;
  const t = Number(flags['tier']);
  if (t !== 1 && t !== 2 && t !== 3) {
    console.error(`invalid --tier (got "${flags['tier']}", expected 1/2/3)`);
    process.exit(2);
  }
  return t as Tier;
}

function padCell(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function renderTable(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, col) => Math.max(...all.map((r) => r[col]!.length)));
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const lines = [
    headers.map((h, i) => padCell(h, widths[i]!)).join('  '),
    sep,
    ...rows.map((r) => r.map((c, i) => padCell(c, widths[i]!)).join('  ')),
  ];
  return lines.join('\n');
}

function formatType(t: AtomType): string[] {
  return [
    String(t.tier),
    t.name,
    String(t.ordinal),
    `v${t.version}`,
    String(t.successes),
    String(t.failures),
    t.successes + t.failures === 0
      ? '—'
      : ((t.successes / (t.successes + t.failures)) * 100).toFixed(0) + '%',
    t.createdBy,
    t.createdAt.slice(0, 19),
    t.description.length > 60 ? t.description.slice(0, 57) + '...' : t.description,
  ];
}

const tableHeaders = [
  'tier',
  'name',
  'ord',
  'v',
  'succ',
  'fail',
  'ratio',
  'created_by',
  'created_at',
  'description',
];

function cmdList(registry: AtomRegistry, tier: Tier | undefined): void {
  const tiers: Tier[] = tier ? [tier] : [1, 2, 3];
  const rows: string[][] = [];
  for (const t of tiers) rows.push(...registry.listByTier(t).map(formatType));
  if (rows.length === 0) {
    console.log('(registry is empty for the requested tier)');
    return;
  }
  console.log(renderTable(tableHeaders, rows));
}

function cmdShow(registry: AtomRegistry, name: string): void {
  const type = registry.getByName(name);
  if (!type) {
    console.error(`no atom type named "${name}"`);
    process.exit(1);
  }
  console.log(`${type.name}  (tier ${type.tier}, ordinal ${type.ordinal}, v${type.version})`);
  console.log(`  description : ${type.description}`);
  console.log(`  created by  : ${type.createdBy}`);
  console.log(`  created at  : ${type.createdAt}`);
  console.log(`  successes   : ${type.successes}`);
  console.log(`  failures    : ${type.failures}`);
  console.log(`  tools       : ${type.tools.map((x) => x.name).join(', ') || '(none)'}`);
  console.log(`  params      : ${JSON.stringify(type.params)}`);
  console.log(`  system_prompt:`);
  for (const line of type.systemPrompt.split('\n')) console.log(`    ${line}`);

  const versions = registry.versionsOf(type.name);
  if (versions.length > 0) {
    console.log(`\n  version history (older → current):`);
    console.log(`    v1 → current is v${type.version}`);
    for (const v of versions) {
      console.log(`    v${v.version} @ ${v.modifiedAt}  ${v.reason ? `— ${v.reason}` : ''}`);
    }
  }
}

function cmdTop(
  registry: AtomRegistry,
  tier: Tier | undefined,
  by: string
): void {
  const tiers: Tier[] = tier ? [tier] : [1, 2, 3];
  const all: AtomType[] = tiers.flatMap((t) => registry.listByTier(t));
  const sorted = [...all].sort((a, b) => {
    if (by === 'failure') return b.failures - a.failures;
    if (by === 'ratio') {
      const ra = a.successes / Math.max(1, a.successes + a.failures);
      const rb = b.successes / Math.max(1, b.successes + b.failures);
      return rb - ra;
    }
    return b.successes - a.successes;
  });
  if (sorted.length === 0) {
    console.log('(registry is empty)');
    return;
  }
  console.log(renderTable(tableHeaders, sorted.slice(0, 20).map(formatType)));
}

function help(): void {
  console.log(`atoma registry CLI

  list [--tier 1|2|3]         — list registered atom types
  show <name>                 — detail of one type + version history
  top  [--tier 1|2|3]         — top 20 by successes (default)
       [--by success|failure|ratio]

Common flags:
  --db <path>   override ATOMA_DB_PATH (default: ./atoma.db)
`);
}

function main(): void {
  const args = parseArgs(process.argv);
  if (args.command === 'help') return help();

  const dbPath = dbPathFrom(args.flags);
  const registry = new AtomRegistry(openDb(dbPath));

  switch (args.command) {
    case 'list':
      return cmdList(registry, tierFrom(args.flags));
    case 'show': {
      const name = args.positional[0];
      if (!name) {
        console.error('usage: show <name>');
        process.exit(2);
      }
      return cmdShow(registry, name);
    }
    case 'top':
      return cmdTop(registry, tierFrom(args.flags), args.flags['by'] ?? 'success');
  }
}

main();
