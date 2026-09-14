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
 * This CLI snapshots the state roots into ONE dated directory under a
 * destination the operator points at an off-machine mount (NAS, synced
 * folder, external disk) and prunes old snapshots:
 *
 *   <dest>/atoma-state-<stamp>/
 *     store.db           — SQLite ONLINE BACKUP (WAL-safe; never a raw file copy)
 *     skills.tar.gz      — the learned recipe tree
 *     runs.tar.gz        — every persisted operator trace
 *     archive.tar.gz     — ~/.atoma/archive (pre/post-benchmark store archives)
 *     projects.tar.gz    — `<projects root>/orgs`: every org-scoped project run
 *                          (traces, run.log, declared artifacts, workspace with
 *                          its git base; `node_modules` excluded)
 *     supervisor.tar.gz  — analyst verdicts and mend records
 *     manifest.json      — what was captured, from where, how big, its SHA-256,
 *                          and what was skipped
 *
 * The two gated corpora (projects, supervisor) were missing until 2026-09-14:
 * the value audit of that day found `npm run backup` described as a state
 * snapshot while the org-scoped runs it needed to reconcile lived outside
 * every tier it captured. Their inclusion makes the manifest an INVENTORY,
 * not a completeness claim: the SQLite online backup is consistent with
 * itself, the tars are each consistent with themselves, and nothing makes the
 * set atomic across roots. Run it while no run, publication or analyst pass
 * mutates the roots, and read `captured`/`skipped` before calling a snapshot
 * complete.
 *
 * The destination is REQUIRED (no default): a default would inevitably be a
 * same-disk path that looks like a backup and protects nothing. A dest
 * inside the repository is refused for the same reason.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
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
import { DEFAULT_PROJECTS_ROOT } from '../projects/coordinator.js';
import { supervisorDirPath } from '../supervisor/paths.js';

export const SNAPSHOT_PREFIX = 'atoma-state-';
const DEFAULT_KEEP = 14;

/**
 * Directory names left out of the projects tar. A project run's workspace is
 * a delivered application, and its dependency tree is regenerable from the
 * lockfile it sits beside — at hundreds of megabytes per run it would dwarf
 * the evidence (traces, logs, git base) the tier exists to preserve. The
 * exclusion is recorded in the manifest so a reader never mistakes the tar
 * for the workspace itself.
 */
export const PROJECTS_TAR_EXCLUDES: readonly string[] = ['node_modules'];

export interface BackupOptions {
  readonly dest: string;
  readonly keep: number;
  /** State roots — overridable so tests never touch the real state. */
  readonly storeDb?: string;
  readonly skillsDir?: string;
  readonly runsDir?: string;
  readonly archiveDir?: string;
  /** The projects ROOT (the `orgs/` child is what gets captured). */
  readonly projectsRoot?: string;
  readonly supervisorDir?: string;
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

/** One directory tier as the manifest records it. */
export interface DirectoryTierManifest {
  readonly source: string;
  /** Top-level entries of the source — the historical field, kept. */
  readonly entries: number;
  /** Non-directory entries captured, recursively, after exclusions. */
  readonly files: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly excluded?: readonly string[];
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** tar the DIRECTORY as one entry-rooted archive; throws on failure. */
function tarDirectory(sourceDir: string, outFile: string, excludes: readonly string[]): void {
  const parent = dirname(resolve(sourceDir));
  const name = basename(resolve(sourceDir));
  const args = ['-czf', outFile];
  for (const pattern of excludes) args.push(`--exclude=${pattern}`);
  args.push('-C', parent, name);
  const res = spawnSync('tar', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60 * 1000,
  });
  if (res.status !== 0) {
    throw new Error(
      `tar failed for ${sourceDir}: ${res.stderr?.toString().slice(0, 400) || `exit ${res.status}`}`
    );
  }
}

/** Non-directory entries under `dir`, recursively, skipping excluded directory names. */
function countFiles(dir: string, excludes: readonly string[]): number {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (excludes.includes(entry.name)) continue;
      n += countFiles(join(dir, entry.name), excludes);
    } else {
      n += 1;
    }
  }
  return n;
}

/** Streamed SHA-256 — the tars can be large, a whole-file read is not the tool. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolveHash(hash.digest('hex')));
  });
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
    manifest['store'] = {
      source: resolve(storeDb),
      bytes: statSync(out).size,
      sha256: await sha256File(out),
    };
    captured.push('store.db');
    log(`✓ store: ${storeDb} → store.db (${statSync(out).size} bytes)`);
  } else {
    skipped.push(`store (${storeDb} missing)`);
    log(`⚠ store missing at ${storeDb} — skipped`);
  }

  // 2..6. The directory roots.
  const projectsRoot =
    opts.projectsRoot ?? process.env['ATOMA_PROJECTS_ROOT'] ?? DEFAULT_PROJECTS_ROOT;
  const dirs: Array<
    [label: string, source: string | undefined, out: string, excludes: readonly string[]]
  > = [
    ['skills', opts.skillsDir ?? skillsDirPath(), 'skills.tar.gz', []],
    ['runs', opts.runsDir ?? process.env['ATOMA_RUNS_DIR'] ?? './runs', 'runs.tar.gz', []],
    [
      'archive',
      // `homedir()`, like every other `~/.atoma` site (the MCP lease, the
      // build workspace, the projects root). `process.env['HOME']` is unset
      // on Windows, and the `?? ''` then resolved the archive tier to the
      // RELATIVE `.atoma/archive`, which does not exist — so the tier was
      // silently skipped under a line reading "backup complete".
      opts.archiveDir ?? join(homedir(), '.atoma', 'archive'),
      'archive.tar.gz',
      [],
    ],
    // The `orgs/` child, not the root: the default root is `~/.atoma`, which
    // also holds the build workspace, the MCP lease and the archive tier.
    // `projectRunHostLayout` puts every org-scoped run under `orgs/`.
    ['projects', join(resolve(projectsRoot), 'orgs'), 'projects.tar.gz', PROJECTS_TAR_EXCLUDES],
    ['supervisor', opts.supervisorDir ?? supervisorDirPath(), 'supervisor.tar.gz', []],
  ];
  for (const [label, source, outName, excludes] of dirs) {
    if (!source || !existsSync(source) || !statSync(source).isDirectory()) {
      skipped.push(`${label} (${source ?? 'unset'} missing)`);
      log(`⚠ ${label} missing at ${source ?? '(unset)'} — skipped`);
      continue;
    }
    const out = join(snapshotDir, outName);
    tarDirectory(source, out, excludes);
    const tier: DirectoryTierManifest = {
      source: resolve(source),
      entries: readdirSync(source).length,
      files: countFiles(source, excludes),
      bytes: statSync(out).size,
      sha256: await sha256File(out),
      ...(excludes.length > 0 ? { excluded: [...excludes] } : {}),
    };
    manifest[label] = tier;
    captured.push(outName);
    log(`✓ ${label}: ${source} → ${outName} (${tier.files} files, ${tier.bytes} bytes)`);
  }

  // The manifest names what is and is not in the snapshot, so a reader who
  // only has the destination can tell a partial capture from a complete one.
  manifest['captured'] = [...captured];
  manifest['skipped'] = [...skipped];
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

const USAGE =
  'usage: npm run backup -- --dest <dir> [--keep N]\n' +
  'Roots follow the running product: ATOMA_DB_PATH, ATOMA_SKILLS_DIR, ATOMA_RUNS_DIR,\n' +
  'ATOMA_PROJECTS_ROOT (its orgs/ child) and ATOMA_SUPERVISOR_DIR, with the same defaults.';

function main(): void {
  const argv = process.argv.slice(2);
  let dest = process.env['ATOMA_BACKUP_DIR'];
  let keep = DEFAULT_KEEP;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dest') dest = argv[++i];
    else if (a === '--keep') keep = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}\n${USAGE}`);
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
