import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, openSync, closeSync, fsyncSync, writeFileSync, chownSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { launcherObjectId } from './names.js';
import { volumeJournalSchema, WORKSPACE_LEASE_MS, WORKSPACE_HARD_MS, type VolumeLease } from '../contracts/launcherVolumes.js';
import type { AsyncDockerRunner } from './docker.js';

const exec = promisify(execFile);
/** Operational journal only: the product store is never opened. */
export class WorkspaceVolumes {
  private readonly mutex: DatabaseSync;
  private readonly leases = new Map<string, VolumeLease>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly run: AsyncDockerRunner;
  private readonly journal: string;
  private poisoned = false;
  constructor(private readonly options: {
    stateRoot: string; workspaceRoot: string; uid: number; gid: number;
    runDocker?: AsyncDockerRunner; now?: () => number;
  }) {
    for (const directory of [options.stateRoot, options.workspaceRoot]) {
      if (!path.isAbsolute(directory) || directory === path.parse(directory).root || !lstatSync(directory).isDirectory()
        || realpathSync(directory) !== path.resolve(directory)) throw new Error('Launcher roots must be pre-created real directories');
    }
    if (this.contains(options.workspaceRoot, options.stateRoot) || this.contains(options.stateRoot, options.workspaceRoot)) throw new Error('Operational state must be outside workspaces');
    if ((lstatSync(options.stateRoot).mode & 0o077) !== 0) throw new Error('Launcher state directory must be private (0700)');
    // Hold a separate SQLite EXCLUSIVE transaction as an OS-released mutex.
    // The journal is committed independently, so SIGKILL does not roll it back.
    this.mutex = new DatabaseSync(path.join(options.stateRoot, 'lock.db'));
    try { this.mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
    catch (error) { this.mutex.close(); throw error; }
    this.journal = path.join(options.stateRoot, 'workspaces.json');
    this.run = options.runDocker ?? (async args => (await exec('docker', args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })).stdout);
    try {
      if (existsSync(this.journal)) {
        for (const row of volumeJournalSchema.parse(JSON.parse(readFileSync(this.journal, 'utf8'))).leases) {
          if (row.id !== launcherObjectId(row.ownerId) || row.volume !== this.volumeName(row.family, row.ownerId)) throw new Error('Invalid workspace journal identity');
          this.leases.set(this.key(row.family, row.ownerId), row);
        }
      }
    } catch (error) { this.mutex.close(); throw error; }
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private contains(parent: string, child: string): boolean { return child === parent || child.startsWith(parent + path.sep); }
  private key(family: VolumeLease['family'], ownerId: string): string { return `${family}:${ownerId}`; }
  private volumeName(family: VolumeLease['family'], ownerId: string): string { return `atoma-workspace-${family}-${launcherObjectId(ownerId)}`; }
  private assertWritable(): void { if (this.poisoned) throw new Error('Workspace journal write failed; restart required'); }
  private persist(): void {
    this.assertWritable();
    try {
      const temporary = `${this.journal}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ version: 1, leases: [...this.leases.values()] })); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, this.journal);
      if (process.platform !== 'win32') {
        const parent = openSync(this.options.stateRoot, 'r');
        try { fsyncSync(parent); } finally { closeSync(parent); }
      }
    } catch (error) { this.poisoned = true; throw error; }
  }
  get(family: VolumeLease['family'], ownerId: string): VolumeLease {
    this.assertWritable();
    const row = this.leases.get(this.key(family, ownerId));
    if (!row || row.phase !== 'ready') throw new Error('Workspace was not issued or is not ready');
    if (this.now() >= row.expiresAt || this.now() >= row.hardDeadline) throw new Error('Workspace lease expired');
    return { ...row };
  }
  async create(family: VolumeLease['family'], ownerId: string, relative?: string): Promise<VolumeLease> {
    this.assertWritable();
    const key = this.key(family, ownerId);
    if (this.leases.has(key)) throw new Error('Workspace already leased');
    const id = launcherObjectId(ownerId);
    const hostPath = path.resolve(this.options.workspaceRoot, relative ?? `previews/${id}`);
    if (!this.contains(this.options.workspaceRoot, hostPath) || hostPath === this.options.workspaceRoot || /[:,\n\r]/.test(hostPath)) throw new Error('Invalid workspace projection');
    if ([...this.leases.values()].some(row => this.contains(row.hostPath, hostPath) || this.contains(hostPath, row.hostPath))) throw new Error('Workspace is already in use');
    const now = this.now();
    const row: VolumeLease = { phase: 'reserved', family, ownerId, id, volume: this.volumeName(family, ownerId), hostPath,
      expiresAt: now + WORKSPACE_LEASE_MS, hardDeadline: now + WORKSPACE_HARD_MS };
    if (family === 'preview' && existsSync(hostPath)) throw new Error('Unowned preview directory already exists');
    this.leases.set(key, row);
    this.persist(); // Intent survives a crash BEFORE any engine side effect.
    const existing = await this.run(['volume', 'ls', '--filter', `name=^${row.volume}$`, '--format', '{{.Name}}']);
    if (existing.trim()) throw new Error('Workspace volume already exists without this lease');
    row.phase = 'creating';
    this.persist();
    // Reject symlinks before mkdir/chown, including intermediate components.
    let cursor = this.options.workspaceRoot;
    for (const component of path.relative(cursor, hostPath).split(path.sep)) {
      cursor = path.join(cursor, component);
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Workspace symlink refused');
      mkdirSync(cursor, { recursive: true, mode: 0o700 });
    }
    if (realpathSync(hostPath) !== hostPath) throw new Error('Workspace projection changed');
    chownSync(hostPath, this.options.uid, this.options.gid);
    await this.run(['volume', 'create', '--label', 'dev.atoma.owner=workspace', '--label', `dev.atoma.workspace=${id}`,
      '--driver', 'local', '--opt', 'type=none', '--opt', 'o=bind', '--opt', `device=${hostPath}`, row.volume]);
    row.phase = 'ready';
    this.persist();
    return { ...row };
  }
  expired(family: VolumeLease['family'], ownerId: string): boolean {
    const row = this.leases.get(this.key(family, ownerId));
    return !!row && (this.now() >= row.expiresAt || this.now() >= row.hardDeadline);
  }
  renew(family: VolumeLease['family'], ownerId: string): void {
    this.assertWritable();
    const row = this.leases.get(this.key(family, ownerId));
    if (!row) return;
    if (this.now() >= row.expiresAt || this.now() >= row.hardDeadline) throw new Error('Workspace lease expired');
    row.expiresAt = Math.min(row.hardDeadline, this.now() + WORKSPACE_LEASE_MS);
    this.persist();
  }
  /** Caller has stopped workloads and networks. Failed engine queries never authorize deletion. */
  release(family: VolumeLease['family'], ownerId: string): Promise<void> {
    this.assertWritable();
    const key = this.key(family, ownerId);
    const prior = this.pending.get(key);
    if (prior) return prior;
    const row = this.leases.get(key);
    if (!row) return Promise.resolve();
    const operation = Promise.resolve().then(async () => {
      if (row.phase === 'reserved') { this.leases.delete(key); this.persist(); return; }
      const users = await this.run(['ps', '-a', '--filter', `volume=${row.volume}`, '--format', '{{.ID}}']);
      if (users.trim()) throw new Error('Workspace still has containers');
      try { await this.run(['volume', 'rm', row.volume]); } catch { /* absence is proved below */ }
      const remaining = await this.run(['volume', 'ls', '--filter', `name=^${row.volume}$`, '--format', '{{.Name}}']);
      if (remaining.trim()) throw new Error('Workspace volume removal unconfirmed');
      // Run bytes are evidence: retention is W9. Only ephemeral preview copies die here.
      if (family === 'preview') {
        const expected = path.join(this.options.workspaceRoot, 'previews', row.id);
        if (row.hostPath !== expected || (existsSync(expected) && realpathSync(expected) !== expected)) throw new Error('Preview projection changed');
        rmSync(expected, { recursive: true, force: true });
      }
      this.leases.delete(key);
      this.persist();
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }
  /** Called under the service mutex before accepting clients; never adopts a predecessor's lease. */
  async recover(cleanup: (family: VolumeLease['family'], ownerId: string) => Promise<void>): Promise<number> {
    let count = 0;
    for (const row of [...this.leases.values()]) {
      if (row.phase === 'reserved') { await this.release(row.family, row.ownerId); count++; continue; }
      const users = (await this.run(['ps', '-a', '--filter', `volume=${row.volume}`, '--format', '{{.ID}}'])).trim().split(/\s+/).filter(Boolean);
      for (const container of users) {
        if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error('Invalid engine container identity');
        await this.run(['rm', '-f', container]);
      }
      await cleanup(row.family, row.ownerId);
      await this.release(row.family, row.ownerId);
      count++;
    }
    return count;
  }
  close(): void { this.mutex.close(); }
}
