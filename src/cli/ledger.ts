#!/usr/bin/env tsx
/**
 * atoma ledger CLI — inspect the append-only lifecycle ledger and check
 * the mutable stores against it.
 *
 *   npm run ledger -- tail [n]          # last n events (default 20)
 *   npm run ledger -- check [--db p] [--skills-dir p]
 *
 * `check` recomputes per-entity success/failure counters from the ledger
 * and diffs them against the live stores (SQLite atom_types + skills
 * _meta.json). HONEST CAVEAT, printed with the report: the comparison is
 * only exact when the ledger has existed since the stores' last reset —
 * pre-ledger history is invisible to the projection, so entities older
 * than the ledger show as EXPECTED drift (store > ledger). The check's
 * real target is the impossible direction: a store counter BELOW the
 * ledger's projection, or entities mutating without any ledger trace —
 * both mean a write path bypassed the choke points.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { ledgerPath, projectCounters, readLedger } from '../core/ledger.js';
import { SkillRegistry } from '../skills/registry.js';

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'tail';
  if (cmd === 'tail') {
    const n = Number(argv[1]) > 0 ? Number(argv[1]) : 20;
    const events = readLedger();
    if (events.length === 0) {
      console.log(`(ledger empty or missing at ${ledgerPath()})`);
      return;
    }
    for (const ev of events.slice(-n)) {
      const detail = ev.detail ? `  ${JSON.stringify(ev.detail)}` : '';
      console.log(`${ev.at}  ${ev.kind.padEnd(24)}  ${ev.entity}${detail}`);
    }
    console.log(`\n${events.length} event(s) total — ${ledgerPath()}`);
    return;
  }
  if (cmd !== 'check') {
    console.log('usage: ledger tail [n] | ledger check [--db path] [--skills-dir path]');
    process.exit(cmd === 'help' ? 0 : 1);
  }

  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const events = readLedger();
  const projected = projectCounters(events);
  console.log(`ledger: ${events.length} event(s) at ${ledgerPath()}\n`);

  let impossible = 0;
  let expectedDrift = 0;

  // Atom types (SQLite).
  const dbPath = flag('db') ?? process.env['ATOMA_DB_PATH'] ?? (existsSync('./atoma-build.db') ? './atoma-build.db' : './atoma.db');
  if (existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare('SELECT name, successes, failures FROM atom_types')
      .all() as { name: string; successes: number; failures: number }[];
    for (const r of rows) {
      const p = projected.get(r.name) ?? { successes: 0, failures: 0 };
      if (r.successes < p.successes || r.failures < p.failures) {
        impossible++;
        console.log(
          `✗ IMPOSSIBLE  type ${r.name}: store ${r.successes}✓/${r.failures}✗ < ledger ${p.successes}✓/${p.failures}✗ — a write path bypassed recordSuccess/recordFailure or the store was hand-edited`
        );
      } else if (r.successes > p.successes || r.failures > p.failures) {
        expectedDrift++;
      }
    }
    db.close();
    console.log(`types checked: ${rows.length} (db: ${dbPath})`);
  } else {
    console.log(`(no registry db at ${dbPath} — types skipped)`);
  }

  // Skills (_meta.json).
  const skills = new SkillRegistry(flag('skills-dir') ?? process.env['ATOMA_SKILLS_DIR'] ?? './skills');
  let skillCount = 0;
  for (const ns of skills.listNamespaces()) {
    for (const sk of skills.loadFor(ns)) {
      skillCount++;
      const entity = `${ns}/${sk.id}`;
      const p = projected.get(entity) ?? { successes: 0, failures: 0 };
      if (sk.successes < p.successes || sk.failures < p.failures) {
        impossible++;
        console.log(
          `✗ IMPOSSIBLE  skill ${entity}: store ${sk.successes}✓/${sk.failures}✗ < ledger ${p.successes}✓/${p.failures}✗`
        );
      } else if (sk.successes > p.successes || sk.failures > p.failures) {
        expectedDrift++;
      }
    }
  }
  console.log(`skills checked: ${skillCount} (dir: ${skills.rootDir})`);

  console.log('');
  if (impossible > 0) {
    console.log(`✗ ${impossible} IMPOSSIBLE counter(s) — investigate the write paths above.`);
    process.exit(1);
  }
  console.log(
    `✓ no impossible counters. ${expectedDrift} entit(y/ies) with store > ledger — expected when the entity predates the ledger; exact from the next full reset onward.`
  );
}

main();
