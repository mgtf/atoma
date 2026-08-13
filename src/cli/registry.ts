#!/usr/bin/env tsx
/**
 * atoma registry CLI — inspect persisted agent types and their usage history.
 *
 * Usage:
 *   tsx src/cli/registry.ts list [--tier 1|2|3] [--db path]
 *   tsx src/cli/registry.ts show <name>          [--db path]
 *   tsx src/cli/registry.ts top  [--tier 1|2|3] [--by success|failure|ratio] [--db path]
 *
 * Defaults: --db from ATOMA_DB_PATH env or ./atoma.db; --by success for `top`.
 */

import { cpSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { openDb } from '../registry/db.js';
import { legacyStoreNotice, skillsDirPath, storeDbPath } from '../core/stores.js';
import { parseCliArgs } from './args.js';
import { AtomRegistry, type AtomType } from '../registry/atomRegistry.js';
import type { Tier } from '../core/types.js';
import type { DB } from '../registry/db.js';
import {
  applyTaxonomyMigration,
  assertCurrentTaxonomy,
  planTaxonomyMigration,
} from '../registry/taxonomyMigration.js';
import { taxonomyForTier } from '../core/taxonomy.js';
import { elementForTool } from '../contracts/toolTaxonomy.js';
import {
  PREFILTER_CACHE_MAX_AGE_MS,
  PREFILTER_CACHE_MAX_ENTRIES,
  prefilterCacheClear,
  prefilterCacheStats,
} from '../atoms/prefilterCache.js';

interface Args {
  command:
    | 'list'
    | 'show'
    | 'top'
    | 'dedupe'
    | 'describe'
    | 'rebrand'
    | 'remove'
    | 'history'
    | 'rollback'
    | 'migrate-taxonomy'
    | 'cache'
    | 'help';
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const { command, positional, flags } = parseCliArgs(argv);
  if (command === null) return { command: 'help', positional, flags };
  if (!['list', 'show', 'top', 'dedupe', 'describe', 'rebrand', 'remove', 'history', 'rollback', 'migrate-taxonomy', 'cache', 'help'].includes(command)) {
    return { command: 'help', positional: [command, ...positional], flags };
  }
  return { command: command as Args['command'], positional, flags };
}

function dbPathFrom(flags: Record<string, string>): string {
  const p = storeDbPath(flags['db']);
  const notice = legacyStoreNotice(p);
  if (notice) console.error(notice);
  return p;
}

function tierFrom(flags: Record<string, string>): Tier | undefined {
  if (!flags['tier']) return undefined;
  const t = Number(flags['tier']);
  if (t !== 1 && t !== 2 && t !== 3) {
    console.error(`invalid --tier (got "${flags['tier']}", expected 1/2/3)`);
    process.exit(2);
  }
  return t;
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
    taxonomyForTier(t.tier).label,
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
  'rank',
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

/**
 * The prefilter decision cache — now a table in this store, so the `rm` that
 * a sibling JSON file offered needs a verb, and the hit rate that AGENTS.md's
 * PLAN TEMPLATING entry names as a revisit gate ("exceeds 25% across two
 * consecutive batches") becomes a query instead of a hand-parsed blob.
 */
function cmdCache(clear: boolean): void {
  if (clear) {
    console.log(`cleared ${prefilterCacheClear()} cached prefilter decision(s).`);
    return;
  }
  const s = prefilterCacheStats();
  if (s.entries === 0) {
    console.log('prefilter cache is empty.');
    return;
  }
  const pct = ((s.reused / s.entries) * 100).toFixed(1);
  console.log(`prefilter cache: ${s.entries}/${PREFILTER_CACHE_MAX_ENTRIES} entries`);
  console.log(`  reused        : ${s.reused} (${pct}% of entries ever read back)`);
  console.log(`  total hits    : ${s.hits}`);
  console.log(`  written       : ${(s.oldest ?? '').slice(0, 19)} .. ${(s.newest ?? '').slice(0, 19)}`);
  if (s.entries >= PREFILTER_CACHE_MAX_ENTRIES) {
    // The cap and the expiry are not independent: at the cap, entries are
    // evicted by age-of-write long before the 7-day expiry can fire, so the
    // effective retention is however long 500 entries take to accumulate.
    console.log(`  NOTE: at the cap — eviction, not the ${PREFILTER_CACHE_MAX_AGE_MS / 86_400_000}-day expiry, is what bounds retention.`);
  }
  console.log(`
  --clear empties it. The cache is disposable: correctness lives in the KEY.`);
}

function taxonomyBackup(db: DB, dbPath: string, skillsDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(homedir(), '.atoma', 'archive', `pre-taxonomy-v2-${stamp}`);
  mkdirSync(dir, { recursive: true });
  if (dbPath !== ':memory:') {
    db.pragma('wal_checkpoint(FULL)');
    copyFileSync(resolve(dbPath), join(dir, basename(dbPath)));
  }
  if (existsSync(skillsDir)) {
    cpSync(resolve(skillsDir), join(dir, 'skills'), { recursive: true });
  }
  return dir;
}

function cmdMigrateTaxonomy(
  db: DB,
  dbPath: string,
  skillsDir: string,
  apply: boolean
): void {
  const plan = planTaxonomyMigration(db, skillsDir);
  if (plan.alreadyCurrent) {
    console.log('registry taxonomy is already current (v2).');
    return;
  }

  console.log(
    `taxonomy migration: Element(tool) → Molecule(L1) → Cell(L2) → Tissue(L3)`
  );
  for (const rename of plan.renames) {
    console.log(`  tier ${rename.tier} #${rename.ordinal}: ${rename.from} → ${rename.to}`);
  }
  for (const move of plan.skillNamespaces) {
    console.log(`  skills: ${move.from}/ → ${move.to}/`);
  }
  console.log(
    `  ${plan.affectedTypes} live type(s) will receive migrated prompts/tool metadata and reset trust.`
  );

  if (!apply) {
    console.log('\ndry run only; re-run with --apply to create a backup and migrate.');
    return;
  }

  const backup = taxonomyBackup(db, dbPath, skillsDir);
  const result = applyTaxonomyMigration(db, skillsDir, plan);
  console.log(`\nbackup: ${backup}`);
  console.log(
    `migrated ${result.renamedTypes} type name(s), ${result.renamedSkillNamespaces} skill namespace(s); ` +
      `reset ${result.resetTypes} type trust record(s), cleared ${result.clearedPrefilterEntries} cached decision(s).`
  );
}

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

function cmdShow(registry: AtomRegistry, name: string, dbPath: string): void {
  const type = registry.getByName(name);
  if (!type) {
    console.error(`no agent type named "${name}" in ${dbPath}`);
    // The "did you mean the other DB?" hint is gone with the second DB: there
    // is one store now (src/core/stores.ts). `list` is the remaining answer.
    console.error(`  hint: run \`list\` to see what this store holds.`);
    process.exit(1);
  }
  console.log(
    `${type.name}  (${taxonomyForTier(type.tier).label}, tier ${type.tier}, ordinal ${type.ordinal}, v${type.version})`
  );
  console.log(`  description : ${type.description}`);
  console.log(`  created by  : ${type.createdBy}`);
  console.log(`  created at  : ${type.createdAt}`);
  console.log(`  successes   : ${type.successes}`);
  console.log(`  failures    : ${type.failures}`);
  console.log(
    `  elements    : ${
      type.tools
        .map((tool) => {
          const element = tool.element ?? elementForTool(tool.name);
          return element ? `${element.symbol}:${tool.name}` : tool.name;
        })
        .join(', ') || '(none)'
    }`
  );
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

function cmdDedupe(registry: AtomRegistry, apply: boolean, fuzzy: boolean): void {
  const groups = registry.findDuplicateGroups({ fuzzy });
  if (groups.length === 0) {
    console.log(
      `no ${fuzzy ? 'fuzzy-' : ''}duplicate groups found. Registry is clean.`
    );
    return;
  }
  console.log(
    `${groups.length} ${fuzzy ? 'fuzzy-' : ''}duplicate group(s) detected — names that ${
      fuzzy ? 'share a token set (word-order insensitive)' : 'normalize to the same key'
    }:\n`
  );
  for (const g of groups) {
    // Pick winner = most successes, tie-break by lowest ordinal (oldest).
    const sorted = [...g.types].sort(
      (a, b) => b.successes - a.successes || a.ordinal - b.ordinal
    );
    const winner = sorted[0]!;
    const losers = sorted.slice(1);
    console.log(`  [tier ${g.tier}] key="${g.key}"`);
    console.log(
      `    winner  : ${winner.name} (ord ${winner.ordinal}, v${winner.version}, ✓${winner.successes}/✗${winner.failures})`
    );
    for (const l of losers) {
      console.log(
        `    merge ← : ${l.name} (ord ${l.ordinal}, v${l.version}, ✓${l.successes}/✗${l.failures})`
      );
    }
    if (apply) {
      const refreshed = registry.mergeInto(
        winner.name,
        losers.map((l) => l.name)
      );
      console.log(
        `    ✓ merged — ${winner.name} now ✓${refreshed.successes}/✗${refreshed.failures}\n`
      );
    } else {
      console.log('');
    }
  }
  if (!apply) {
    console.log('DRY RUN. Rerun with --apply to perform the merge.');
    console.log(
      'Merging preserves counters (summed into the winner) and archives each loser\'s'
    );
    console.log(
      'history under the winner\'s (tier, ordinal) — the loser rows themselves are deleted.'
    );
  } else {
    console.log('done. Re-run `registry list` to verify.');
  }
}

function cmdRebrand(registry: AtomRegistry, name: string | null, all: boolean): void {
  if (all) {
    const names: string[] = [];
    for (const tier of [1, 2, 3] as const) {
      for (const t of registry.listByTier(tier)) names.push(t.name);
    }
    if (names.length === 0) {
      console.log('(registry is empty)');
      return;
    }
    let touched = 0;
    for (const n of names) {
      const { changed } = registry.rebrand(n, 'cli-rebrand');
      if (changed) {
        console.log(`  ✓ rebranded ${n}`);
        touched++;
      }
    }
    console.log(
      touched === 0
        ? 'no agents needed rebranding — all personas already match their names.'
        : `rebranded ${touched}/${names.length} agent(s). Re-run show <name> to verify.`
    );
    return;
  }
  if (!name) {
    console.error('usage: rebrand <name> | rebrand --all');
    process.exit(2);
  }
  const existing = registry.getByName(name);
  if (!existing) {
    console.error(`no agent type named "${name}"`);
    process.exit(1);
  }
  const before = existing.systemPrompt.split('\n')[0] ?? '';
  const { type, changed } = registry.rebrand(name, 'cli-rebrand');
  if (!changed) {
    console.log(`${name}: persona already matches name. No change.`);
    console.log(`  first line: ${before.slice(0, 100)}`);
    return;
  }
  const after = type.systemPrompt.split('\n')[0] ?? '';
  console.log(`${name} rebranded:`);
  console.log(`  before: ${before.slice(0, 100)}`);
  console.log(`  after : ${after.slice(0, 100)}`);
  console.log(`  version: v${existing.version} → v${type.version}`);
}

function cmdDescribe(registry: AtomRegistry, name: string, newDescription: string): void {
  const existing = registry.getByName(name);
  if (!existing) {
    console.error(`no agent type named "${name}"`);
    process.exit(1);
  }
  const before = existing.description;
  const after = registry.describe(name, newDescription, 'cli-describe');
  console.log(`${name} description updated:`);
  console.log(`  before: ${before}`);
  console.log(`  after : ${after.description}`);
  console.log(`  version: v${existing.version} → v${after.version}`);
}

/**
 * Permanently delete a type + its version history. Guarded: canonical
 * bootstrap agents and user-created tissues are refused without --force,
 * because deleting them breaks the next run's happy path (the bootstrap
 * would recreate them at zero trust) or orphans the whole registry
 * (removing the only L3). Dynamic-creation debris (createdBy = an atom
 * name) deletes without friction — that's the intended use.
 */
function cmdRemove(registry: AtomRegistry, name: string, force: boolean): void {
  const existing = registry.getByName(name);
  if (!existing) {
    console.error(`no agent type named "${name}"`);
    process.exit(1);
  }
  const isProtected =
    existing.createdBy.startsWith('bootstrap-canonical') || existing.createdBy === 'user';
  if (isProtected && !force) {
    console.error(
      `refusing to remove "${name}" (createdBy: ${existing.createdBy}) — it is a canonical/bootstrap agent.\n` +
        `  Removing it resets the happy path (recreated at zero trust on the next run). Pass --force if you really mean it.`
    );
    process.exit(2);
  }
  const removed = registry.remove(name)!;
  console.log(
    `removed ${removed.name} (tier ${removed.tier}, v${removed.version}, ` +
      `${removed.successes}✓/${removed.failures}✗, createdBy: ${removed.createdBy})`
  );
  console.log(`  description was: ${removed.description.slice(0, 100)}`);
}

function help(): void {
  console.log(`atoma registry CLI

  list [--tier 1|2|3]         — list registered agent types
  show <name>                 — detail of one type + version history
  top  [--tier 1|2|3]         — top 20 by successes (default)
       [--by success|failure|ratio]
  dedupe [--apply] [--fuzzy]  — detect and (optionally) merge semantic
                                duplicates. Default matches casing/punctuation
                                variants ("Minesweeper-WebGL" vs
                                "minesweeper_webgl"). --fuzzy also matches
                                word-order variants ("WebGLMinesweeper" vs
                                "MinesweeperWebGL") by sorting tokens.
  describe <name> <text>      — overwrite the short description of a type
                                (useful to heal "description drift" — e.g. a
                                patched type whose description still says
                                "Mario platformer" even though the system
                                prompt now targets Minesweeper). Wraps a
                                patch with descriptionReplace; the type
                                version is bumped and counters are reset.
  rebrand <name>              — align the "You are <Name>…" first line of
    | rebrand --all             the systemPrompt with the agent's actual
                                taxonomy name. Fixes legacy seeds that
                                hardcoded a persona ("You are Carbon…")
                                that then contaminated every branch. Use
                                --all to sweep the whole registry at once.
  remove <name> [--force]     — permanently delete a type + its version
                                history. For dynamic-creation debris
                                (mislabelled clone series). Canonical
                                bootstrap agents and user-created tissues
                                are refused without --force.
  history <name>              — archived versions of a type (prompt head,
                                tools, who/when/why), plus the live one.
  rollback <name> --to <v>    — restore an archived version's content as a
                                NEW live version (roll-forward: history
                                stays append-only, version keeps rising,
                                counters reset — the restored behaviour
                                re-earns trust). Prompt/tools/params are
                                restored exactly; description is not
                                versioned and is kept as-is.
  migrate-taxonomy [--apply]  — move a legacy registry from
                                Element(L1)/Molecule(L2)/Cell(L3) to
                                Element(tool)/Molecule(L1)/Cell(L2)/
                                Tissue(L3). Dry-run by default; --apply
                                backs up DB + skills before migration.
  cache [--clear]             — prefilter decision cache (a table in the
                                same store): size, how many entries were
                                ever read back, total hits. --clear empties
                                it; the cache is disposable, correctness
                                lives in the key.

Common flags:
  --db <path>          override ATOMA_DB_PATH (default: ./atoma.db)
  --skills-dir <path>  override ATOMA_SKILLS_DIR for taxonomy migration
`);
}

function cmdHistory(registry: AtomRegistry, name: string): void {
  const live = registry.getByName(name);
  if (!live) {
    console.error(`no agent type named "${name}"`);
    process.exit(1);
  }
  const rows = registry.listVersions(name);
  console.log(`${name} (tier ${live.tier}) — ${rows.length} archived version(s), live: v${live.version}\n`);
  for (const v of rows) {
    const head = v.systemPrompt.split('\n')[0]?.slice(0, 70) ?? '';
    console.log(
      `  v${v.version}  ${v.modifiedAt.slice(0, 19)}  by ${v.modifiedBy}` +
        (v.reason ? `\n      reason: ${v.reason.slice(0, 110)}` : '')
    );
    console.log(`      prompt: ${head}…  tools: ${v.tools.map((t) => t.name).join(', ') || '(none)'}`);
  }
  console.log(
    `  v${live.version}  (LIVE)  ✓${live.successes}/✗${live.failures}\n` +
      `      prompt: ${live.systemPrompt.split('\n')[0]?.slice(0, 70)}…\n\n` +
      `rollback with: registry rollback ${name} --to <version>`
  );
}

function cmdRollback(registry: AtomRegistry, name: string, toRaw: string | undefined): void {
  const to = Number(toRaw);
  if (!toRaw || !Number.isInteger(to) || to < 1) {
    console.error('usage: rollback <name> --to <version>   (see `history <name>` for versions)');
    process.exit(2);
  }
  const before = registry.getByName(name);
  if (!before) {
    console.error(`no agent type named "${name}"`);
    process.exit(1);
  }
  try {
    const after = registry.rollback(name, to);
    if (after.version === before.version) {
      console.log(`no-op: v${to} content is identical to the live v${before.version}; nothing changed.`);
      return;
    }
    console.log(
      `${name}: restored v${to} content as NEW live v${after.version} (was v${before.version}).\n` +
        `  counters reset ${before.successes}/${before.failures} → 0/0 — the restored type re-earns trust.\n` +
        `  description is not versioned and was kept as-is.`
    );
    if (/^bootstrap-/.test(after.createdBy)) {
      console.log(
        `  ⚠ ${name} is a canonical/bootstrap type: its seeder re-aligns the prompt on the\n` +
          `    next run and will patch this rollback away if the seed differs. Rollback is\n` +
          `    for dynamic types, or for pinning a canonical during a single diagnostic run.`
      );
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

function main(): void {
  const args = parseArgs(process.argv);
  if (args.command === 'help') {
    help();
    // Reached via an unknown/mistyped command? That's an ERROR, not a
    // request for help — scripts piping this CLI must not keep going on
    // a no-op that exited 0 (the silent-help failure the audit flagged).
    if (args.positional.length > 0) process.exit(1);
    return;
  }

  const dbPath = dbPathFrom(args.flags);
  const db = openDb(dbPath);
  const registry = new AtomRegistry(db);
  const mutatesRegistry =
    args.command === 'describe' ||
    args.command === 'rebrand' ||
    args.command === 'remove' ||
    args.command === 'rollback' ||
    (args.command === 'dedupe' && args.flags['apply'] === 'true');
  if (mutatesRegistry) assertCurrentTaxonomy(db);

  switch (args.command) {
    case 'list':
      return cmdList(registry, tierFrom(args.flags));
    case 'show': {
      const name = args.positional[0];
      if (!name) {
        console.error('usage: show <name>');
        process.exit(2);
      }
      return cmdShow(registry, name, dbPath);
    }
    case 'top':
      return cmdTop(registry, tierFrom(args.flags), args.flags['by'] ?? 'success');
    case 'dedupe':
      return cmdDedupe(
        registry,
        args.flags['apply'] === 'true',
        args.flags['fuzzy'] === 'true'
      );
    case 'describe': {
      const name = args.positional[0];
      const newDescription = args.positional.slice(1).join(' ');
      if (!name || !newDescription) {
        console.error('usage: describe <name> <new-description>');
        process.exit(2);
      }
      return cmdDescribe(registry, name, newDescription);
    }
    case 'rebrand':
      return cmdRebrand(
        registry,
        args.positional[0] ?? null,
        args.flags['all'] === 'true'
      );
    case 'remove': {
      const name = args.positional[0];
      if (!name) {
        console.error('usage: remove <name> [--force]');
        process.exit(2);
      }
      return cmdRemove(registry, name, args.flags['force'] === 'true');
    }
    case 'history': {
      const name = args.positional[0];
      if (!name) {
        console.error('usage: history <name>');
        process.exit(2);
      }
      return cmdHistory(registry, name);
    }
    case 'rollback': {
      const name = args.positional[0];
      if (!name) {
        console.error('usage: rollback <name> --to <version>');
        process.exit(2);
      }
      return cmdRollback(registry, name, args.flags['to']);
    }
    case 'migrate-taxonomy':
      return cmdMigrateTaxonomy(
        db,
        dbPath,
        skillsDirPath(args.flags['skills-dir']),
        args.flags['apply'] === 'true'
      );
    case 'cache':
      return cmdCache('clear' in args.flags);
  }
}

main();
