import { WORKSPACE_LEASE_MS, WORKSPACE_HEARTBEAT_MS } from '../contracts/launcherVolumes.js';
import type { WorkerLauncher } from '../contracts/launcherWorker.js';
import { createServer, type Socket } from 'node:net';
import { chmodSync, lstatSync } from 'node:fs';
import path from 'node:path';
import type { ContainerLauncher, LauncherFamily, LauncherNetworkHandle, LauncherUnitHandle } from '../contracts/launcher.js';
import {
  LAUNCHER_FRAME_BYTES, launcherRequestSchema, launcherResults,
  type LauncherHello, type LauncherRequest,
} from '../contracts/launcherRpc.js';
import { launcherObjectId } from './names.js';
import { isIsolatedGatewayUnsupported } from './docker.js';

/** One private local socket, no TCP listener and no bearer secrets. */
export async function serveLauncher(options: {
  socketPath: string;
  launcher: ContainerLauncher;
  hello: LauncherHello;
  renewLease?(family: LauncherFamily, ownerId: string): void;
  leaseExpired?(family: LauncherFamily, ownerId: string): boolean;
  workers?: WorkerLauncher & { reconcileOrphans(): Promise<number>; stopOwner(ownerId: string): Promise<void> };
  disconnectOwner(family: LauncherFamily, ownerId: string): Promise<void>;
}): Promise<{ close(): Promise<void> }> {
  const { launcher, hello, socketPath } = options;
  if (!path.isAbsolute(socketPath)) throw new Error('Launcher socket must be absolute');
  if (process.platform !== 'win32') {
    const parent = lstatSync(path.dirname(socketPath));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o007) !== 0) {
      throw new Error('Launcher socket directory must be private to its owner/group');
    }
  }
  // Never unlink an existing endpoint: it may be a live launcher.
  const owners = new Map<string, Socket>();
  const clients = new Set<Socket>();
  let reconciling = false;
  const cleanups = new Set<Promise<void>>();
  const retries = new Set<() => Promise<void>>();
  const retryTimer = setInterval(() => { for (const retry of retries) void retry().catch(() => undefined); }, WORKSPACE_HEARTBEAT_MS);
  retryTimer.unref();
  const server = createServer((socket) => {
    if (clients.size + cleanups.size >= 32) { socket.destroy(); return; }
    clients.add(socket);
    let lastHeartbeat = Date.now();
    const expiry = setInterval(() => {
      if (Date.now() - lastHeartbeat >= WORKSPACE_LEASE_MS || [...held.values()].some(state => options.leaseExpired?.(state.family, state.ownerId))) socket.destroy();
    }, WORKSPACE_HEARTBEAT_MS);
    expiry.unref();
    const held = new Map<string, { family: LauncherFamily; ownerId: string; workspace: boolean; armed: boolean }>();
    const workers = new Map<string, string>();
    let buffer = Buffer.alloc(0);
    let pending = 0;
    let greeted = false;
    let chain = Promise.resolve();
    const claim = (family: LauncherFamily, ownerId: string) => {
      if (reconciling) throw new Error('Launcher reconciliation in progress');
      const key = `${family}:${ownerId}`;
      const existing = owners.get(key);
      if (existing && existing !== socket) throw new Error('Owner belongs to another connection');
      options.renewLease?.(family, ownerId);
      owners.set(key, socket);
      let state = held.get(key);
      if (!state) {
        if (held.size >= 256) { owners.delete(key); throw new Error('Too many owners on one connection'); }
        state = { family, ownerId, workspace: false, armed: false };
        held.set(key, state);
      }
      return state;
    };
    const release = (family: LauncherFamily, ownerId: string) => {
      if (reconciling) throw new Error('Launcher reconciliation in progress');
      const key = `${family}:${ownerId}`;
      const state = held.get(key);
      if (state && !state.workspace && !state.armed) { held.delete(key); owners.delete(key); }
    };
    const network = (handle: LauncherNetworkHandle): LauncherNetworkHandle => {
      claim(handle.family, handle.ownerId);
      // Handles are references, never permission to pass an arbitrary engine name.
      if (handle.name !== launcher.networkName(handle)) throw new Error('Invalid network handle');
      return handle;
    };
    const unit = (handle: LauncherUnitHandle): LauncherUnitHandle => {
      claim(handle.kind === 'egress-proxy' ? 'egress' : 'preview', handle.ownerId);
      if (handle.name !== launcher.unitName(handle.kind, handle.ownerId)) throw new Error('Invalid unit handle');
      return handle;
    };
    const dispatch = async (request: LauncherRequest): Promise<unknown> => {
      if (request.op === 'hello') { greeted = true; return hello; }
      if (!greeted) throw new Error('Handshake required');
      if (request.op !== 'startWorker' && request.op !== 'stopWorker') {
        const ownerId = 'ownerId' in request ? request.ownerId
          : 'spec' in request ? request.spec.ownerId : 'handle' in request ? request.handle.ownerId : undefined;
        if (ownerId && [...workers.values()].includes(ownerId)) throw new Error('Worker owns this lifecycle');
      }
      switch (request.op) {
        case 'heartbeat':
          for (const state of held.values()) options.renewLease?.(state.family, state.ownerId);
          lastHeartbeat = Date.now();
          return null;
        case 'startWorker': {
          if (!options.workers) throw new Error('Worker service not configured');
          if (held.has(`egress:${request.spec.ownerId}`)) throw new Error('Owner already claimed');
          claim('egress', request.spec.ownerId).armed = true;
          const handle = await options.workers.startWorker(request.spec);
          workers.set(handle.id, handle.ownerId);
          return handle;
        }
        case 'stopWorker': {
          const ownerId = workers.get(request.id);
          if (!ownerId || !options.workers) throw new Error('Worker not issued to this connection');
          await options.workers.stopWorker(request.id);
          workers.delete(request.id);
          claim('egress', ownerId).armed = false;
          release('egress', ownerId);
          return null;
        }
        case 'purgeOwner':
          claim(request.family, request.ownerId);
          await launcher.purgeOwner(request.family, request.ownerId);
          return null;
        case 'armHardExitCleanup':
          claim(request.family, request.ownerId).armed = true;
          await launcher.armHardExitCleanup(request.family, request.ownerId);
          return null;
        case 'disarmHardExitCleanup':
          claim(request.family, request.ownerId).armed = false;
          await launcher.disarmHardExitCleanup(request.family, request.ownerId);
          release(request.family, request.ownerId);
          return null;
        case 'createNetwork':
          claim(request.spec.family, request.spec.ownerId);
          return launcher.createNetwork(request.spec);
        case 'removeNetwork': return launcher.removeNetwork(network(request.handle));
        case 'removeNetworkBefore': return launcher.removeNetworkBefore(network(request.handle), request.deadlineMs);
        case 'startUnit': {
          const { spec } = request;
          const family = spec.kind === 'egress-proxy' ? 'egress' : 'preview';
          claim(family, spec.ownerId);
          for (const handle of request.networks) {
            if (handle.family !== family || handle.ownerId !== spec.ownerId) throw new Error('Foreign network');
            network(handle);
          }
          const kinds = request.networks.map((handle) => handle.kind);
          const expected = spec.kind === 'preview-app' ? ['internal']
            : spec.kind === 'preview-ingress' ? ['uplink', 'internal'] : ['internal', 'uplink'];
          if (kinds.join(',') !== expected.join(',')) throw new Error('Invalid profile topology');
          if (spec.kind === 'preview-app') {
            if (spec.workspace.ownerId !== spec.ownerId || spec.workspace.id !== launcherObjectId(spec.ownerId)) throw new Error('Foreign workspace');
            if (!held.get(`preview:${spec.ownerId}`)?.workspace) throw new Error('Workspace was not issued here');
            if (spec.entry.startsWith('-') || spec.entry.includes(String.fromCharCode(0)) || !/^[^\\:]+\.(?:js|mjs|cjs)$/.test(spec.entry)
              || path.posix.isAbsolute(spec.entry) || spec.entry.split('/').some((part) => !part || part === '.' || part === '..')) {
              throw new Error('Invalid entry');
            }
          }
          return launcher.startUnit(spec, request.networks);
        }
        case 'awaitUnitReady': await launcher.awaitUnitReady(unit(request.handle), request.timeoutMs); return null;
        case 'stopUnit': await launcher.stopUnit(unit(request.handle), request.reason); return null;
        case 'createWorkspace':
          claim('preview', request.ownerId).workspace = true;
          return launcher.createWorkspace(request.ownerId);
        case 'removeWorkspace': {
          const { ownerId, id } = request.handle;
          claim('preview', ownerId);
          if (id !== launcherObjectId(ownerId)) throw new Error('Invalid workspace handle');
          // Drop hostPath: the backend alone derives the path to remove.
          await launcher.removeWorkspace({ ownerId, id });
          claim('preview', ownerId).workspace = false;
          release('preview', ownerId);
          return null;
        }
        case 'reconcileOrphans':
          if (owners.size || reconciling) throw new Error('Launcher has active owners');
          reconciling = true;
          try { return (await options.workers?.reconcileOrphans() ?? 0) + await launcher.reconcileOrphans(); }
          finally { reconciling = false; }
        case 'listUnits': {
          const units = await launcher.listUnits(request.kind);
          return units.flatMap((row) => {
            const family = row.kind === 'egress-proxy' ? 'egress' : 'preview';
            const owner = [...held.values()].find((candidate) => candidate.family === family
              && row.name === launcher.unitName(row.kind, candidate.ownerId));
            return owner ? [{ ...row, ownerId: owner.ownerId }] : [];
          });
        }
      }
    };
    const respond = (value: unknown) => {
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      if (bytes.length > LAUNCHER_FRAME_BYTES) { socket.destroy(); return; }
      if (!socket.destroyed) socket.write(bytes);
    };
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > LAUNCHER_FRAME_BYTES) { socket.destroy(); return; }
      for (;;) {
        const end = buffer.indexOf(10);
        if (end < 0) break;
        const line = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 1);
        if (++pending > 64) { socket.destroy(); return; }
        chain = chain.then(async () => {
          if (socket.destroyed) return;
          let request: LauncherRequest;
          try { request = launcherRequestSchema.parse(JSON.parse(line)); }
          catch { respond({ ok: false, code: 'invalid-request' }); return; }
          try {
            const result = await dispatch(request);
            respond({ ok: true, result: launcherResults[request.op].parse(result) });
          } catch (error) {
            respond({ ok: false, code: isIsolatedGatewayUnsupported(error) ? 'isolated-gateway-unsupported' : 'operation-failed' });
          }
        }).finally(() => { pending -= 1; });
      }
    });
    socket.on('close', () => {
      clearInterval(expiry);
      clients.delete(socket);
      // Finish the current engine operation before reaping: a create that
      // completes after cleanup would resurrect the disconnected owner's unit.
      let retrying = false;
      const reap = async () => {
        if (retrying) return;
        retrying = true;
        try { await chain;
          const failedWorkers = new Set<string>();
          for (const [id, ownerId] of workers) {
            try { await options.workers?.stopWorker(id); }
            catch { failedWorkers.add(ownerId); }
          }
          for (const [key, state] of held) {
            if (owners.get(key) !== socket) continue;
            if (failedWorkers.has(state.ownerId)) continue; // retain ownership; never reap networks before confirmed worker removal
            try {
              if (state.family === 'egress') await options.workers?.stopOwner(state.ownerId);
              await options.disconnectOwner(state.family, state.ownerId);
              if (state.workspace) await launcher.removeWorkspace({ ownerId: state.ownerId, id: launcherObjectId(state.ownerId) });
              owners.delete(key);
            } catch { /* Retain ownership for the periodic cleanup retry. */ }
          }
          if (![...held.keys()].some(key => owners.get(key) === socket)) retries.delete(reap);
        } finally { retrying = false; }
      };
      retries.add(reap);
      const cleanup = reap().finally(() => { cleanups.delete(cleanup); });
      cleanups.add(cleanup);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      try {
        if (process.platform !== 'win32') chmodSync(socketPath, 0o660);
        server.removeListener('error', reject);
        resolve();
      } catch (error) { server.close(); reject(error instanceof Error ? error : new Error('Launcher bind failed')); }
    });
  });
  return {
    close: async () => {
      clearInterval(retryTimer);
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const client of clients) client.destroy();
      await closed;
      await Promise.all(cleanups);
      for (const retry of retries) await retry();
    },
  };
}
