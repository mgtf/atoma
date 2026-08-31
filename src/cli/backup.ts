/**
 * State backup — `npm run backup -- --dest <off-machine mount>`.
 *
 * Everything that makes this system cheap is EARNED STATE that no artefact
 * in the repository can regenerate: the trust counters in `atoma.db`, the
 * learned skill bodies with their compile provenance, and the run traces
 * cited as evidence for the rule system. All of it lives gitignored on one
 * machine, the archives sit on the same disk, and the 2026-08-14 review
 * measured the class already firing once (round 2's 19 traces destroyed by
 * an archive-ordering mistake). One disk failure loses months of burn-in.
 *
 * This CLI snapshots the four state roots into ONE dated directory under a
 * destination the operator points at an off-machine mount (NAS, synced
 * folder, external disk) and prunes old snapshots:
 *
 *   <dest>/atoma-state-<stamp>/
 *     store.db        — SQLite ONLINE BACKUP (WAL-safe; never a raw file copy)
 *     skills.tar.gz   — the learned recipe tree
 *     runs.tar.gz     — every persisted trace
 *     archive.tar.gz  — ~/.atoma/archive (pre/post-benchmark store archives)
 *     manifest.json   — what was captured, from where, and how big
 *
 * The destination is REQUIRED (no default): a default would inevitably be a
 * same-disk path that looks like a backup and protects nothing. A dest
 * inside the repository is refused for the same reason.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname, homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { skillsDirPath, storeDbPath } from '../core/stores.js';
import { snapshotSqliteStore } from '../core/sqliteBackup.js';

export const SNAPSHOT_PREFIX = 'atoma-state-';
const DEFAULT_KEEP = 14;

export interface BackupOptions {
  readonly dest: string;
  readonly keep: number;
  /** State roots — overridable so tests never touch the real state. */
  readonly storeDb?: string;
  readonly skillsDir?: string;
  readonly runsDir?: string;
  readonly archiveDir?: string;
  /** Refused-destination guard root (the repository). */
  readonly repoRoot?: string;
  readonly log?: (line: string) => void;
}

export interface BackupResult {
  readonly snapshotDir: string;
  readonly captured: string[];
  readonly skipped: string[];
  readonly pruned: string[];
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** tar the DIRECTORY as one entry-rooted archive; throws on failure. */
function tarDirectory(sourceDir: string, outFile: string): void {
  const parent = dirname(resolve(sourceDir));
  const name = basename(resolve(sourceDir));
  const res = spawnSync('tar', ['-czf', outFile, '-C', parent, name], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60 * 1000,
  });
  if (res.status !== 0) {
    throw new Error(
      `tar failed for ${sourceDir}: ${res.stderr?.toString().slice(0, 400) || `exit ${res.status}`}`
    );
  }
}

export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const dest = resolve(opts.dest);
  const repo = resolve(opts.repoRoot ?? process.cwd());
  if (insideRoot(repo, dest)) {
    throw new Error(
      `backup destination ${dest} is inside the repository — a same-tree "backup" is gitignored noise that protects nothing. Point --dest at an off-machine mount.`
    );
  }
  if (!Number.isSafeInteger(opts.keep) || opts.keep < 1) {
    throw new Error(`--keep must be a positive integer (got ${opts.keep})`);
  }
  mkdirSync(dest, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const snapshotDir = join(dest, `${SNAPSHOT_PREFIX}${stamp}`);
  mkdirSync(snapshotDir, { recursive: true });

  const captured: string[] = [];
  const skipped: string[] = [];
  const manifest: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    host: hostname(),
  };

  // 1. The store — ONLINE backup, never a raw copy: WAL pages of committed
  // transactions may not be in the main file yet, and a raw copy taken
  // mid-write is a plausible-looking corrupt database.
  const storeDb = opts.storeDb ?? storeDbPath();
  if (existsSync(storeDb)) {
    const out = join(snapshotDir, 'store.db');
    await snapshotSqliteStore(storeDb, out);
    manifest['store'] = { source: resolve(storeDb), bytes: statSync(out).size };
    captured.push('store.db');
    log(`✓ store: ${storeDb} → store.db (${statSync(out).size} bytes)`);
  } else {
    skipped.push(`store (${storeDb} missing)`);
    log(`⚠ store missing at ${storeDb} — skipped`);
  }

  // 2..4. The three directory roots.
  const dirs: Array<[label: string, source: string | undefined, out: string]> = [
    ['skills', opts.skillsDir ?? skillsDirPath(), 'skills.tar.gz'],
    ['runs', opts.runsDir ?? process.env['ATOMA_RUNS_DIR'] ?? './runs', 'runs.tar.gz'],
    [
      'archive',
      // `homedir()`, like every other `~/.atoma` site (the MCP lease, the
      // build workspace, the projects root). `process.env['HOME']` is unset
      // on Windows, and the `?? ''` then resolved the archive tier to the
      // RELATIVE `.atoma/archive`, which does not exist — so the tier was
      // silently skipped under a line reading "backup complete".
      opts.archiveDir ?? join(homedir(), '.atoma', 'archive'),
      'archive.tar.gz',
    ],
  ];
  for (const [label, source, outName] of dirs) {
    if (!source || !existsSync(source) || !statSync(source).isDirectory()) {
      skipped.push(`${label} (${source ?? 'unset'} missing)`);
      log(`⚠ ${label} missing at ${source ?? '(unset)'} — skipped`);
      continue;
    }
    const out = join(snapshotDir, outName);
    tarDirectory(source, out);
    manifest[label] = {
      source: resolve(source),
      entries: readdirSync(source).length,
      bytes: statSync(out).size,
    };
    captured.push(outName);
    log(`✓ ${label}: ${source} → ${outName} (${statSync(out).size} bytes)`);
  }

  writeFileSync(join(snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // Prune: keep the newest N snapshots. Name-sorted equals time-sorted
  // because the stamp is ISO-shaped; only OUR prefix is ever touched, so a
  // destination shared with other backups stays safe.
  const snapshots = readdirSync(dest)
    .filter((name) => name.startsWith(SNAPSHOT_PREFIX))
    .sort();
  const pruned: string[] = [];
  while (snapshots.length > opts.keep) {
    const victim = snapshots.shift()!;
    rmSync(join(dest, victim), { recursive: true, force: true });
    pruned.push(victim);
    log(`✂ pruned old snapshot ${victim}`);
  }

  log(
    `\n✓ backup complete: ${snapshotDir} (${captured.length} captured, ${skipped.length} skipped, ${pruned.length} pruned)`
  );
  return { snapshotDir, captured, skipped, pruned };
}

function main(): void {
  const argv = process.argv.slice(2);
  let dest = process.env['ATOMA_BACKUP_DIR'];
  let keep = DEFAULT_KEEP;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dest') dest = argv[++i];
    else if (a === '--keep') keep = Number(argv[++i]);
    else {
      console.error(`unknown argument: ${a}\nusage: npm run backup -- --dest <dir> [--keep N]`);
      process.exit(2);
    }
  }
  if (!dest) {
    console.error(
      'backup needs a destination: --dest <dir> or ATOMA_BACKUP_DIR.\n' +
        'Point it at an OFF-MACHINE mount (NAS, synced folder, external disk) — the whole\n' +
        'point is surviving this disk. Example:\n' +
        '  npm run backup -- --dest "$HOME/SyncedDrive/atoma-backups"'
    );
    process.exit(2);
  }
  runBackup({ dest, keep }).catch((err) => {
    console.error(`✖ backup failed: ${(err as Error).message}`);
    process.exit(1);
  });
}

// Import-safe entrypoint (the friction.ts lesson: an unconditional main()
// made a fresh checkout fail test collection).
if (process.argv[1] && /backup\.(ts|js)$/.test(process.argv[1])) {
  main();
}
