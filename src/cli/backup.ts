/**
 * State backup — `npm run backup -- --dest <off-machine mount>`.
 *
 * Everything that makes this system cheap is EARNED STATE that no artefact
 * in the repository can regenerate: the atom AND skill trust counters in
 * `atoma.db` (skill trust moved there from `_meta.json` on 2026-09-18), the
 * learned skill bodies, and the run traces
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
 *     workspaces.tar.gz  — launcher projects/ projection, when configured (layout v2)
 *     manifest.json      — what was captured, from where, how big, its SHA-256,
 *                          what was EXPECTED AND MISSING, which tiers this
 *                          deployment declares it does not have, and which
 *                          host-held key the copied store still needs
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
import Database from 'better-sqlite3';
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
import { SECRET_ENCRYPTION_ENV } from '../auth/secretEncryption.js';
import { skillsDirPath, storeDbPath } from '../core/stores.js';
import { snapshotSqliteStore } from '../core/sqliteBackup.js';
import { DEFAULT_PROJECTS_ROOT } from '../projects/coordinator.js';
import { supervisorDirPath } from '../supervisor/paths.js';

export const SNAPSHOT_PREFIX = 'atoma-state-';
const DEFAULT_KEEP = 14;

/** Every tier a snapshot can carry, in manifest order. */
export const BACKUP_TIERS = [
  'store',
  'skills',
  'runs',
  'archive',
  'projects',
  'supervisor',
  'workspaces',
] as const;
export type BackupTier = (typeof BACKUP_TIERS)[number];
/** The directory tiers. `store` is captured through the online backup. */
type DirectoryTier = Exclude<BackupTier, 'store'>;

export const OPTIONAL_TIERS_ENV = 'ATOMA_BACKUP_OPTIONAL_TIERS' as const;

/**
 * WHICH TIERS THIS DEPLOYMENT ACTUALLY HAS.
 *
 * A tier absent from a host is either a shape fact or a loss, and only the
 * deployment knows which. `~/.atoma/archive` holds pre/post-benchmark store
 * archives and never exists on a server that runs no benchmarks; a missing
 * `skills/` on that same server is months of earned state gone. The snapshot
 * recorded both as `skipped`, and the restore drill required all six tiers —
 * so every production snapshot reported `incomplete` and exited 2, and the
 * only way to make it pass would have been to stop reading skips at all,
 * which is precisely the silence the 2026-09-14 archive-tier incident was
 * about.
 *
 * So the deployment DECLARES its absences and everything else stays
 * mandatory. Default: nothing is optional — the developer machine this drill
 * was calibrated on, and the fail-closed answer for a host that has declared
 * nothing yet.
 */
export function parseOptionalTiers(
  raw: string | readonly string[] | undefined
): DirectoryTier[] {
  const items = (typeof raw === 'string' ? raw.split(',') : (raw ?? []))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const out: DirectoryTier[] = [];
  for (const item of items) {
    if (item === 'store') {
      throw new Error(
        `${OPTIONAL_TIERS_ENV}: the store tier cannot be optional — a snapshot without it has nothing to restore.`
      );
    }
    if (!(BACKUP_TIERS as readonly string[]).includes(item)) {
      throw new Error(
        `${OPTIONAL_TIERS_ENV}: unknown tier ${item} (known: ${BACKUP_TIERS.filter((t) => t !== 'store').join(', ')})`
      );
    }
    if (!out.includes(item as DirectoryTier)) out.push(item as DirectoryTier);
  }
  return out;
}

/**
 * WHAT THIS SNAPSHOT CANNOT RESTORE ON ITS OWN.
 *
 * Organisation provider keys sit encrypted in the store, and the key that
 * unlocks them is host configuration resolved from the operator's environment
 * (`src/auth/secretEncryption.ts`). It is deliberately absent here: a backup
 * carrying both the ciphertext and its key would be one copied file away from
 * being the plaintext. So the manifest NAMES the dependency and counts the
 * rows it bites, letting a reader tell whether it matters for this snapshot.
 *
 * Naming it is not proving it. Recovering those rows means retrieving that
 * key separately and decrypting under control — an exercise this snapshot
 * neither performs nor attests. Key ROTATION is a third thing again, and is
 * not this function's subject.
 */
function secretDependency(snapshotStore: string): Record<string, unknown> {
  let encryptedOrgProviderKeys: number | null = null;
  let db: Database.Database | null = null;
  try {
    db = new Database(snapshotStore, { readonly: true, fileMustExist: true });
    const present = db
      .prepare(
        `SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='auth_org_provider_keys'`
      )
      .get() as { n: number };
    encryptedOrgProviderKeys =
      present.n > 0
        ? (db.prepare('SELECT count(*) AS n FROM auth_org_provider_keys').get() as { n: number }).n
        : 0;
  } catch {
    // The count is a courtesy. The DEPENDENCY is the load-bearing part and is
    // stated whether or not the copied store can be read from here.
    encryptedOrgProviderKeys = null;
  } finally {
    db?.close();
  }
  return {
    note:
      'store.db carries organisation provider keys encrypted at rest. The key that unlocks them is ' +
      'host configuration and is NOT in this snapshot, by design: restoring the store without it ' +
      'leaves those rows undecryptable. Proving recovery means retrieving that key separately and ' +
      'decrypting under control — this snapshot does not do that and does not prove it.',
    keyEnvVars: [SECRET_ENCRYPTION_ENV, 'ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY'],
    keyMaterialIncluded: false,
    encryptedOrgProviderKeys,
  };
}

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
  /** Shared launcher root; its projects/ projection contains retained run bytes. */
  readonly workspaceRoot?: string;
  /**
   * Tiers this deployment does not have. Absent here, a missing tier is a
   * loss. Defaults to `ATOMA_BACKUP_OPTIONAL_TIERS`, then to nothing.
   */
  readonly optionalTiers?: readonly string[];
  /** Refused-destination guard root (the repository). */
  readonly repoRoot?: string;
  readonly log?: (line: string) => void;
}

export interface BackupResult {
  readonly snapshotDir: string;
  readonly captured: string[];
  /** Tiers that were EXPECTED and are not in the snapshot. Each one is a loss. */
  readonly skipped: string[];
  /** Tiers this deployment declared it does not have. Not a loss. */
  readonly notApplicable: string[];
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
    // COPYFILE_DISABLE: macOS bsdtar stores extended attributes as AppleDouble
    // sidecars — an empty `skills/` carrying `com.apple.provenance` yields a
    // top-level `._skills` member. `tar -tzf` HIDES those entries by merging
    // them back, so the archive looks clean on the machine that wrote it, while
    // any other reader sees them: `scripts/restore-drill.py` refuses `._skills`
    // as an entry outside the tier root and the whole snapshot fails to
    // restore. A backup that cannot be restored is not a backup (2026-09-22).
    env: { ...process.env, COPYFILE_DISABLE: '1' },
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

  const optional = parseOptionalTiers(opts.optionalTiers ?? process.env[OPTIONAL_TIERS_ENV]);
  const workspaceRoot = opts.workspaceRoot ?? process.env['ATOMA_LAUNCHER_WORKSPACE_ROOT'];
  if (optional.includes('workspaces')) throw new Error('workspaces cannot be optional; omit the launcher root only on a legacy layout');
  const captured: string[] = [];
  const skipped: string[] = [];
  const notApplicable: string[] = [];
  const manifest: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    host: hostname(),
    ...(workspaceRoot ? { layoutVersion: 2 } : {}),
  };

  // 1..5. The directory roots FIRST, the store LAST (W4, 2026-09-18). Skill
  // trust is rows in the store while skill bodies are files in the skills
  // tier, and nothing makes the two captures simultaneous. Every file+row
  // mutation in `SkillRegistry` writes its file before its row (a body, then
  // its zeroed counters on promotion; a folder removal, then its row
  // deletion), so a snapshot whose rows are never OLDER than its bodies can
  // only pair a body with the state it had before its row moved — the crash
  // states the registry already tolerates. The reverse order could pair a
  // freshly compiled script body with the llm recipe's earned counters: a
  // never-executed script armed for the no-validator dispatch, the exact
  // state `promoteToScript`'s crash ordering exists to rule out.
  const projectsRoot =
    opts.projectsRoot ?? process.env['ATOMA_PROJECTS_ROOT'] ?? DEFAULT_PROJECTS_ROOT;
  const dirs: Array<
    [label: DirectoryTier, source: string | undefined, out: string, excludes: readonly string[]]
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
  if (workspaceRoot) dirs.push(['workspaces', join(resolve(workspaceRoot), 'projects'), 'workspaces.tar.gz', PROJECTS_TAR_EXCLUDES]);
  for (const [label, source, outName, excludes] of dirs) {
    if (!source || !existsSync(source) || !statSync(source).isDirectory()) {
      const where = source ?? 'unset';
      if (optional.includes(label)) {
        notApplicable.push(`${label} (${where} — declared not applicable)`);
        log(`· ${label} not applicable to this deployment (${where})`);
      } else {
        skipped.push(`${label} (${where} missing)`);
        log(`⚠ ${label} missing at ${where} — skipped`);
      }
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

  // 6. The store — ONLINE backup, never a raw copy: WAL pages of committed
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

  // The manifest names what is and is not in the snapshot, so a reader who
  // only has the destination can tell a partial capture from a complete one.
  manifest['captured'] = [...captured];
  manifest['skipped'] = [...skipped];
  manifest['notApplicable'] = [...notApplicable];
  // The DECLARATION, machine-readable, is what the restore drill reads to
  // decide which absences it may forgive. The human lists above say what
  // happened; this says what the deployment said would happen.
  manifest['optionalTiers'] = [...optional];
  manifest['secrets'] = secretDependency(join(snapshotDir, 'store.db'));
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

  // A summary line that says "complete" over a missing tier is the exact
  // failure the archive-tier incident recorded, so the word is earned here or
  // it is not printed.
  const shape = notApplicable.length > 0 ? `, ${notApplicable.length} not applicable` : '';
  if (skipped.length > 0) {
    log(
      `\n⚠ backup INCOMPLETE: ${snapshotDir} (${captured.length} captured, ` +
        `${skipped.length} EXPECTED AND MISSING${shape}, ${pruned.length} pruned)\n` +
        `  missing: ${skipped.join('; ')}\n` +
        `  A tier this deployment does not have belongs in ${OPTIONAL_TIERS_ENV}. Anything left ` +
        `here is state that was expected and is not in the snapshot.`
    );
  } else {
    log(
      `\n✓ backup complete: ${snapshotDir} (${captured.length} captured${shape}, ${pruned.length} pruned)`
    );
  }
  return { snapshotDir, captured, skipped, notApplicable, pruned };
}

const USAGE =
  'usage: npm run backup -- --dest <dir> [--keep N]\n' +
  'Roots follow the running product: ATOMA_DB_PATH, ATOMA_SKILLS_DIR, ATOMA_RUNS_DIR,\n' +
  'ATOMA_PROJECTS_ROOT (its orgs/ child) and ATOMA_SUPERVISOR_DIR, with the same defaults.\n' +
  'ATOMA_LAUNCHER_WORKSPACE_ROOT adds its mandatory projects/ projection (layout v2).\n' +
  'ATOMA_BACKUP_OPTIONAL_TIERS names the tiers this deployment does not have (e.g. "archive"\n' +
  'on a server that runs no benchmarks). Every tier left out of it is mandatory: missing, it\n' +
  'is reported as a loss and the restore drill fails.';

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
