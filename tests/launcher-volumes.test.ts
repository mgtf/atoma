import { DockerLauncher } from '../src/launcher/docker.js';
import { workerRunArgs } from '../src/launcher/workerProfile.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceVolumes } from '../src/launcher/volumes.js';
import { projectWorkspaceRelative, WORKSPACE_LEASE_MS, type VolumeLease } from '../src/contracts/launcherVolumes.js';
import { projectRunHostLayout } from '../src/projects/coordinator.js';

it('derives the same project projection on the coordinator and launcher', () => {
  const identity = { orgId: 'org-id', projectId: 'project-id', runId: 'run-id' };
  const root = join(tmpdir(), 'workspaces');
  expect(projectRunHostLayout('/product', identity.orgId, identity.projectId, identity.runId, root).workspacePath)
    .toBe(join(root, projectWorkspaceRelative(identity)));
  expect(() => projectWorkspaceRelative({ ...identity, orgId: '../other' })).toThrow();
});

describe.skipIf(process.platform === 'win32')('durable launcher volume ownership', () => {
  let root: string;
  let stateRoot: string;
  let workspaceRoot: string;
  let volumes: WorkspaceVolumes | undefined;
  let child: ChildProcess | undefined;
  let clock: number;
  let engineNames: Set<string>;
  let calls: string[][];
  let unavailable: boolean;
  let attached: string;
  const options = () => ({
    stateRoot, workspaceRoot, uid: process.getuid!(), gid: process.getgid!(), now: () => clock,
    runDocker: async (args: string[]) => {
      calls.push(args);
      if (unavailable) throw new Error('engine unavailable');
      if (args[0] === 'volume' && args[1] === 'create') engineNames.add(args.at(-1)!);
      if (args[0] === 'volume' && args[1] === 'rm') engineNames.delete(args[2]!);
      if (args[0] === 'volume' && args[1] === 'ls') {
        const name = args[args.indexOf('--filter') + 1]!.slice('name=^'.length, -1);
        return engineNames.has(name) ? name : '';
      }
      if (args[0] === 'ps') return attached;
      if (args[0] === 'rm') attached = '';
      return '';
    },
  });
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-volume-')));
    stateRoot = join(root, 'state'); workspaceRoot = join(root, 'workspaces');
    mkdirSync(stateRoot, { mode: 0o700 }); mkdirSync(workspaceRoot);
    clock = 100; engineNames = new Set(); calls = []; unavailable = false; attached = '';
  });
  afterEach(async () => {
    volumes?.close(); volumes = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
      child.kill('SIGKILL'); await exited;
    }
    child = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a named volume, retains run bytes and deletes only preview copies', async () => {
    volumes = new WorkspaceVolumes(options());
    const run = await volumes.create('worker', 'run', 'runs/run');
    writeFileSync(join(run.hostPath, 'result.txt'), 'evidence');
    expect(calls.find(args => args[1] === 'create')).toContain(`device=${run.hostPath}`);
    const preview = await volumes.create('preview', 'preview');
    await volumes.release('worker', 'run');
    await volumes.release('preview', 'preview');
    expect(readFileSync(join(run.hostPath, 'result.txt'), 'utf8')).toBe('evidence');
    expect(existsSync(preview.hostPath)).toBe(false);
    expect(engineNames.size).toBe(0);
  });

  it('mounts issued volume identities in both production profiles', async () => {
    volumes = new WorkspaceVolumes(options());
    const launcher = new DockerLauncher({ image: 'worker-image', volumes, runDocker: options().runDocker });
    const workspace = await launcher.createWorkspace('preview');
    await launcher.startUnit({ kind: 'preview-app', ownerId: 'preview', workspace: { ownerId: 'preview', id: workspace.id }, entry: 'index.js' }, [
      { family: 'preview', kind: 'internal', ownerId: 'preview', name: launcher.networkName({ family: 'preview', kind: 'internal', ownerId: 'preview' }) },
    ]);
    expect(calls.find(args => args[0] === 'run')).toContain(`type=volume,src=${workspace.volume},dst=/workspace,volume-nocopy`);
    const args = workerRunArgs({ image: 'worker-image', workspaceHostPath: '/not-mount-authority', workspaceVolume: workspace.volume });
    expect(args).toContain(`type=volume,src=${workspace.volume},dst=/workspace,volume-nocopy`);
    expect(args).not.toContain('/not-mount-authority:/workspace');
  });

  it('never releases a lease while container removal is unconfirmed', async () => {
    volumes = new WorkspaceVolumes(options());
    const row = await volumes.create('worker', 'run', 'runs/run');
    attached = 'abcdef012345';
    await expect(volumes.release('worker', 'run')).rejects.toThrow('still has containers');
    expect(engineNames.has(row.volume)).toBe(true);
    unavailable = true;
    await expect(volumes.release('worker', 'run')).rejects.toThrow('engine unavailable');
    unavailable = false; attached = '';
    await volumes.release('worker', 'run');
  });

  it('does not adopt or remove an existing volume without a creation intent', async () => {
    volumes = new WorkspaceVolumes(options());
    const row = await volumes.create('worker', 'run', 'runs/run');
    await volumes.release('worker', 'run');
    engineNames.add(row.volume);
    await expect(volumes.create('worker', 'run', 'runs/run')).rejects.toThrow('already exists');
    await volumes.release('worker', 'run');
    expect(engineNames.has(row.volume)).toBe(true);
  });

  it('renews a lease without extending its hard deadline and refuses resurrection', async () => {
    volumes = new WorkspaceVolumes(options());
    const row = await volumes.create('worker', 'run', 'runs/run');
    clock += 1000;
    volumes.renew('worker', 'run');
    expect(volumes.get('worker', 'run').hardDeadline).toBe(row.hardDeadline);
    clock += WORKSPACE_LEASE_MS;
    expect(() => volumes!.renew('worker', 'run')).toThrow('expired');
  });

  it('fences a second process and replays a SIGKILL journal before deleting the volume', async () => {
    child = fork(fileURLToPath(new URL('./fixtures/launcher-volume-owner.mjs', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, ATOMA_TEST_STATE: stateRoot, ATOMA_TEST_WORKSPACES: workspaceRoot },
    });
    const row = await new Promise<VolumeLease>((resolve, reject) => {
      child!.once('message', (message: { row: VolumeLease }) => resolve(message.row));
      child!.once('error', reject); child!.once('exit', () => reject(new Error('fixture exited before issuing a volume')));
    });
    expect(() => new WorkspaceVolumes(options())).toThrow();
    const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
    child.kill('SIGKILL'); await exited;
    engineNames.add(row.volume); attached = 'abcdef012345';
    volumes = new WorkspaceVolumes(options());
    await volumes.recover(async () => { calls.push(['cleanup-networks']); });
    expect(calls.findIndex(args => args[0] === 'rm')).toBeLessThan(calls.findIndex(args => args[0] === 'cleanup-networks'));
    expect(calls.findIndex(args => args[0] === 'cleanup-networks')).toBeLessThan(calls.findIndex(args => args[0] === 'volume' && args[1] === 'rm'));
    expect(readFileSync(join(row.hostPath, 'evidence.txt'), 'utf8')).toBe('retain this run');
    expect(JSON.parse(readFileSync(join(stateRoot, 'workspaces.json'), 'utf8'))).toEqual({ version: 1, leases: [] });
  });
});
