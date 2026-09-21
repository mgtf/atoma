import { WorkspaceVolumes } from './volumes.js';
import { readdirSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { LauncherWorkers } from './workers.js';
import { z } from 'zod';
import { SocketLauncher } from './client.js';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { DockerLauncher, hostContainerUser } from './docker.js';
import { serveLauncher } from './service.js';
import { launcherHelloSchema, LAUNCHER_PROTOCOL_VERSION } from '../contracts/launcherRpc.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: launcher [--help | --reconcile]\nSeparate Linux launcher on ATOMA_LAUNCHER_SOCKET.\nRequired: ATOMA_LAUNCHER_PREVIEW_IMAGE (digest), ATOMA_LAUNCHER_WORKSPACE_ROOT, ATOMA_LAUNCHER_STATE_ROOT, ATOMA_LAUNCHER_WORKER_SOCKET_ROOT.\nOptional: ATOMA_LAUNCHER_WORKER_IMAGE, ATOMA_LAUNCHER_PREVIEW_USER.\nOperator workspace aliases: ATOMA_LAUNCHER_RUN_WORKSPACES; project workspaces are automatic.');
    return;
  }
  if (args.length === 1 && args[0] === '--reconcile') {
    const endpoint = process.env['ATOMA_LAUNCHER_SOCKET'];
    if (!endpoint || !path.isAbsolute(endpoint)) throw new Error('ATOMA_LAUNCHER_SOCKET must be absolute');
    const client = await SocketLauncher.connect(endpoint);
    try { console.log(`Removed ${await client.reconcileOrphans()} orphan objects`); }
    finally { client.close(); }
    return;
  }
  if (args.length) throw new Error('Unknown launcher argument; use --help');
  if (process.platform !== 'linux') throw new Error('The launcher service requires Linux');
  const socketPath = process.env['ATOMA_LAUNCHER_SOCKET'];
  const workspaceRoot = process.env['ATOMA_LAUNCHER_WORKSPACE_ROOT'];
  const previewImage = process.env['ATOMA_LAUNCHER_PREVIEW_IMAGE'];
  if (!socketPath || !path.isAbsolute(socketPath)) throw new Error('ATOMA_LAUNCHER_SOCKET must be absolute');
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot) || path.resolve(workspaceRoot) === '/') throw new Error('ATOMA_LAUNCHER_WORKSPACE_ROOT must be an absolute dedicated directory');
  if (!previewImage || !/@sha256:[a-f0-9]{64}$/.test(previewImage)) throw new Error('ATOMA_LAUNCHER_PREVIEW_IMAGE must be pinned by digest');
  const image = process.env['ATOMA_LAUNCHER_WORKER_IMAGE'] ?? 'atoma-worker:latest';
  const previewUser = process.env['ATOMA_LAUNCHER_PREVIEW_USER'] ?? hostContainerUser() ?? '10001:10001';
  if (!/^[1-9]\d*:\d+$/.test(previewUser)) throw new Error('ATOMA_LAUNCHER_PREVIEW_USER must be numeric non-root uid:gid');
  const [uid, gid] = previewUser.split(':').map(Number);
  if (process.getuid?.() !== 0 && (uid !== process.getuid?.() || gid !== process.getgid?.())) {
    throw new Error('A non-root launcher must use its own uid/gid for preview workspaces');
  }
  const hello = launcherHelloSchema.parse({
    version: LAUNCHER_PROTOCOL_VERSION, image, previewImage, previewRuntime: 'runsc',
    previewOwnership: { uid, gid },
  });
  // The socket directory is operator-owned. Never chmod a shared parent such
  // as /run or /tmp; the service checks its existing permissions before bind.
  const workspaceDirectory = lstatSync(workspaceRoot);
  if (!workspaceDirectory.isDirectory() || workspaceDirectory.isSymbolicLink()) {
    throw new Error('Launcher workspace root must be a pre-created directory, not a symlink');
  }
  const stateRoot = process.env['ATOMA_LAUNCHER_STATE_ROOT'];
  if (!stateRoot) throw new Error('ATOMA_LAUNCHER_STATE_ROOT is required');
  const volumes = new WorkspaceVolumes({ stateRoot, workspaceRoot, uid: uid!, gid: gid! });
  const launcher = new DockerLauncher({ image, previewImage, previewRuntime: 'runsc', previewUser, workspaceRoot, volumes,
    ...(process.getuid?.() === 0 ? { workspaceOwnership: hello.previewOwnership } : {}),
  });
  const workerRoot = process.env['ATOMA_LAUNCHER_WORKER_SOCKET_ROOT'];
  const workspaceConfig = process.env['ATOMA_LAUNCHER_RUN_WORKSPACES'];
  if (!workerRoot) throw new Error('ATOMA_LAUNCHER_WORKER_SOCKET_ROOT is required');
  const workers = new LauncherWorkers({
    launcher, image, socketRoot: workerRoot, user: previewUser, volumes, workspaceRoot,
    workspaces: workspaceConfig ? z.record(z.string(), z.string()).parse(JSON.parse(workspaceConfig)) : {},
    allowlist: (process.env['ATOMA_EGRESS_ALLOWLIST'] ?? '').split(',').map(s => s.trim()).filter(Boolean),
  });
  if (workers) process.prependListener('exit', () => workers.hardExit());
  // The SQLite mutex fences other launchers using this state directory.
  // Probe the endpoint before recovery, so a differently configured live
  // service is never mistaken for a predecessor.
  const endpointLive = await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection(socketPath);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
    probe.setTimeout(2000, () => { probe.destroy(); reject(new Error('Launcher endpoint probe timed out')); });
  });
  if (endpointLive) throw new Error('Launcher endpoint is already live');
  await workers.reconcileOrphans();
  await volumes.recover((family, ownerId) => launcher.reapDisconnectedOwner(family === 'worker' ? 'egress' : 'preview', ownerId));
  await launcher.reconcileOrphans();
  // Only UUID directories created by the worker rendezvous are eligible.
  for (const entry of readdirSync(workerRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.name)) rmSync(path.join(workerRoot, entry.name), { recursive: true, force: true });
  }
  try {
    const old = lstatSync(socketPath);
    if (!old.isSocket()) throw new Error('Launcher endpoint is not a socket');
    rmSync(socketPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const service = await serveLauncher({
    socketPath, launcher, hello, workers,
    leaseExpired: (family, ownerId) => volumes.expired(family === 'egress' ? 'worker' : 'preview', ownerId),
    renewLease: (family, ownerId) => volumes.renew(family === 'egress' ? 'worker' : 'preview', ownerId),
    disconnectOwner: (family, ownerId) => launcher.reapDisconnectedOwner(family, ownerId),
  });
  console.log('Launcher ready');
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Bound shutdown; the backend's synchronous exit registry remains the
    // last fallback if the engine does not finish asynchronous teardown.
    const deadline = setTimeout(() => process.exit(1), 15_000);
    void service.close().then(() => { clearTimeout(deadline); volumes.close(); process.exit(0); }, () => process.exit(1));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Launcher startup failed');
  process.exitCode = 1;
});
