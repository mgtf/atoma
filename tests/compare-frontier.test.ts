import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupCompareRound,
  envFor,
  prepareCompareRound,
  snapshotSqliteStore,
  type CompareRoundState,
} from '../burnin/compare-frontier.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-compare-frontier-'));
  roots.push(root);
  return root;
}

function openWalFixture(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE mature_state (value TEXT NOT NULL)');
  // Put the schema in the main file, then leave the evidence row only in the
  // live WAL. A raw copy of `path` loses this row while SQLite backup keeps it.
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.prepare('INSERT INTO mature_state(value) VALUES (?)').run('from-live-wal');
  return db;
}

describe('snapshotSqliteStore', () => {
  it('captures committed WAL pages without checkpointing or mutating the source', async () => {
    const root = tempRoot();
    const source = join(root, 'production.db');
    const destination = join(root, 'snapshot', 'store.db');
    const writer = openWalFixture(source);
    try {
      expect(existsSync(source + '-wal')).toBe(true);
      await snapshotSqliteStore(source, destination);

      const snapshot = new Database(destination);
      try {
        expect(
          snapshot.prepare('SELECT value FROM mature_state').pluck().all()
        ).toEqual(['from-live-wal']);
        snapshot.prepare('INSERT INTO mature_state(value) VALUES (?)').run('snapshot-only');
      } finally {
        snapshot.close();
      }

      expect(writer.prepare('SELECT value FROM mature_state').pluck().all()).toEqual([
        'from-live-wal',
      ]);
    } finally {
      writer.close();
    }
  });
});

describe('prepareCompareRound', () => {
  it('gives every pair an empty baseline and an isolated mature treatment snapshot', async () => {
    const root = tempRoot();
    const sourceDb = join(root, 'production', 'atoma.db');
    const sourceSkills = join(root, 'production', 'skills');
    const scratchRoot = join(root, 'scratch');
    const writer = openWalFixture(sourceDb);
    mkdirSync(join(sourceSkills, 'Water', 'verify-cli'), { recursive: true });
    const sourceSkill = join(sourceSkills, 'Water', 'verify-cli', 'SKILL.md');
    writeFileSync(sourceSkill, 'mature recipe\n', 'utf8');
    // Stale fixed-name scratch from an older implementation must never become
    // either arm's starting state.
    mkdirSync(scratchRoot, { recursive: true });
    writeFileSync(join(scratchRoot, 'baseline-store.db'), 'stale', 'utf8');

    let first: CompareRoundState | undefined;
    let second: CompareRoundState | undefined;
    try {
      first = await prepareCompareRound({ scratchRoot, sourceDb, sourceSkills });

      expect(dirname(first.roundDir)).toBe(scratchRoot);
      expect(existsSync(first.baselineDb)).toBe(false);
      expect(readdirSync(first.baselineSkills)).toEqual([]);
      expect(readFileSync(join(first.treatmentSkills, 'Water', 'verify-cli', 'SKILL.md'), 'utf8'))
        .toBe('mature recipe\n');

      const treatment = new Database(first.treatmentDb);
      try {
        expect(treatment.prepare('SELECT value FROM mature_state').pluck().all()).toEqual([
          'from-live-wal',
        ]);
        treatment.prepare('UPDATE mature_state SET value = ?').run('treatment-mutated');
      } finally {
        treatment.close();
      }
      writeFileSync(
        join(first.treatmentSkills, 'Water', 'verify-cli', 'SKILL.md'),
        'treatment-mutated\n',
        'utf8'
      );

      expect(writer.prepare('SELECT value FROM mature_state').pluck().get()).toBe(
        'from-live-wal'
      );
      expect(readFileSync(sourceSkill, 'utf8')).toBe('mature recipe\n');

      second = await prepareCompareRound({ scratchRoot, sourceDb, sourceSkills });
      expect(second.roundDir).not.toBe(first.roundDir);
      expect(existsSync(second.baselineDb)).toBe(false);
      expect(readdirSync(second.baselineSkills)).toEqual([]);
      const secondTreatment = new Database(second.treatmentDb, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(secondTreatment.prepare('SELECT value FROM mature_state').pluck().get()).toBe(
          'from-live-wal'
        );
      } finally {
        secondTreatment.close();
      }

      expect(envFor('baseline', first, {})).toMatchObject({
        ATOMA_DB_PATH: first.baselineDb,
        ATOMA_SKILLS_DIR: first.baselineSkills,
        ATOMA_LEDGER_DB: first.baselineDb,
        ATOMA_LEDGER_PATH: '',
        ATOMA_PREFILTER_CACHE: '0',
      });
      expect(envFor('atoma', first, { ZAI_API_KEY: 'configured-for-test' })).toMatchObject({
        ATOMA_DB_PATH: first.treatmentDb,
        ATOMA_SKILLS_DIR: first.treatmentSkills,
        ATOMA_LEDGER_DB: first.treatmentDb,
        ATOMA_LEDGER_PATH: '',
        ATOMA_PREFILTER_CACHE: first.treatmentDb,
        ZAI_API_KEY: 'configured-for-test',
      });
    } finally {
      if (first) cleanupCompareRound(first);
      if (second) cleanupCompareRound(second);
      writer.close();
    }

    expect(existsSync(first?.roundDir ?? '')).toBe(false);
    expect(existsSync(second?.roundDir ?? '')).toBe(false);
    expect(readFileSync(join(scratchRoot, 'baseline-store.db'), 'utf8')).toBe('stale');
    expect(readFileSync(sourceSkill, 'utf8')).toBe('mature recipe\n');
  });

  it('removes its reserved directory when snapshot preparation fails', async () => {
    const root = tempRoot();
    const scratchRoot = join(root, 'scratch');

    await expect(
      prepareCompareRound({
        scratchRoot,
        sourceDb: join(root, 'missing.db'),
        sourceSkills: join(root, 'missing-skills'),
      })
    ).rejects.toThrow(/source store/i);

    expect(readdirSync(scratchRoot)).toEqual([]);
  });
});
