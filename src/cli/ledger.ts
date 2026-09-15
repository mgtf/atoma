#!/usr/bin/env tsx
/**
 * atoma ledger CLI — inspect the append-only lifecycle ledger and check
 * the mutable stores against it.
 *
 *   npm run ledger -- tail [n] [--db p]   # last n events (default 20)
 *   npm run ledger -- check [--db p] [--skills-dir p]
 *
 * `check` recomputes per-entity success/failure counters from the ledger and
 * diffs them against the live stores. HONEST CAVEAT, printed with the report:
 * the comparison is only exact when the ledger has existed since the stores'
 * last reset — pre-ledger history is invisible to the projection, so entities
 * older than the ledger show as EXPECTED drift (store > ledger). The check's
 * real target is the impossible direction: a store counter BELOW the ledger's
 * projection, or entities mutating without any ledger trace — both mean a
 * write path bypassed the choke points.
 *
 * ONE HANDLE for the events and the atom counters, because they are now the
 * same file. That closes half of the ledger's old KNOWN LIMIT by
 * construction: you can no longer project one store's history against a
 * different store's counters, which is exactly how this command once reported
 * `IMPOSSIBLE  Helium: store 2 < ledger 6` for a week. The SKILL half of the
 * pairing is still conventional — bodies and counters live under
 * `--skills-dir` — so that flag still has to name the right tree.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { ledgerDbPath, projectCounters, readLedger } from '../core/ledger.js';
import { skillsDirPath } from '../core/stores.js';
import { SkillRegistry } from '../skills/registry.js';
import { parseCliArgs } from './args.js';


/**
 * Render a ledger entity for a human.
 *
 * Entities come in two shapes: a bare molecule NAME for type events, and
 * `<namespace>/<skill-id>` for skill events — where the namespace is an atom
 * id since T4. `ledger tail` is an audit stream a person reads, so the id half
 * is resolved back to the molecule name and the identity is shown alongside
 * only when it resolved, which is what tells the reader the two are different
 * things. An unresolvable key is printed as-is: an entity whose atom is gone
 * is exactly what the raw key should communicate.
 */
function renderEntity(entity: string, labels: Map<string, string>): string {
  const slash = entity.indexOf('/');
  if (slash === -1) return entity;
  const key = entity.slice(0, slash);
  const label = labels.get(key);
  return label ? `${label}${entity.slice(slash)}` : entity;
}

/** atom id → molecule name, read once from the open store. */
function displayNamesByAtomId(db: Database.Database): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const r of db.prepare('SELECT atom_id, name FROM atom_types').all() as {
      atom_id: string | null;
      name: string;
    }[]) {
      if (r.atom_id) out.set(r.atom_id, r.name);
    }
  } catch {
    /* unreadable store — every entity falls back to its raw key */
  }
  return out;
}

function main(): void {
  const { command, positional, flags } = parseCliArgs(process.argv);
  const cmd = command ?? 'tail';

  if (cmd !== 'tail' && cmd !== 'check') {
    console.log('usage: ledger tail [n] [--db path] | ledger check [--db path] [--skills-dir path]');
    process.exit(cmd === 'help' ? 0 : 1);
  }

  const dbPath = flags['db'] ?? ledgerDbPath();
  if (!existsSync(dbPath)) {
    console.log(`(no store at ${dbPath} — nothing to read)`);
    return;
  }
  const db = new Database(dbPath);
  const events = readLedger(db);

  if (cmd === 'tail') {
    const n = Number(positional[0]) > 0 ? Number(positional[0]) : 20;
    if (events.length === 0) {
      console.log(`(ledger empty in ${dbPath})`);
      return;
    }
    const labels = displayNamesByAtomId(db);
    for (const ev of events.slice(-n)) {
      const detail = ev.detail ? `  ${JSON.stringify(ev.detail)}` : '';
      console.log(
        `${ev.at}  ${ev.kind.padEnd(24)}  ${renderEntity(ev.entity, labels)}${detail}`
      );
    }
    console.log(`\n${events.length} event(s) total — ${dbPath}`);
    return;
  }

  const projected = projectCounters(events);
  console.log(`ledger: ${events.length} event(s) in ${dbPath}\n`);

  let impossible = 0;
  let expectedDrift = 0;

  // Atom types — the SAME file the events came from, so this half of the
  // comparison cannot be mispaired.
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
  console.log(`types checked: ${rows.length} (db: ${dbPath})`);
  db.close();

  // Skills (_meta.json) — still a separate store, so this pairing is still
  // the caller's responsibility.
  const skills = new SkillRegistry(skillsDirPath(flags['skills-dir']));
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

if (process.argv[1] && /ledger\.(ts|js)$/.test(process.argv[1])) {
  main();
}
