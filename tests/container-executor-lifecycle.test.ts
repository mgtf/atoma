import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContainerToolExecutor,
  type ContainerSpawn,
} from '../src/tools/containerExecutor.js';
import { encodeMessage } from '../src/tools/containerProtocol.js';

function fakeWorker(pid: number): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcess;
  setImmediate(() => {
    child.stdout!.emit(
      'data',
      Buffer.from(
        encodeMessage({
          ready: true,
          root: '/workspace',
          tools: [
            {
              name: 'read_file',
              description: 'read',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        })
      )
    );
  });
  return child;
}

describe('ContainerToolExecutor lifecycle', () => {
  it('creates the workspace on the host BEFORE the engine is asked to mount it', async () => {
    // THE DEFECT THIS PINS, measured on a real project run (2026-09-02): a
    // bind-mount source that does not exist is created by the DAEMON, as root.
    // The worker then runs as the host user and finds `/workspace` owned by
    // root, mode 755 — every write refused, the L1 agent improvising in
    // `/tmp`, and a deliverable that never lands where delivery, publication
    // and the preview look for it. The operator path never saw it because its
    // workspace persists across runs; a project run gets a fresh path every
    // time.
    const root = mkdtempSync(join(tmpdir(), 'atoma-executor-'));
    const workspace = join(root, 'fresh', 'workspace');
    expect(existsSync(workspace)).toBe(false);

    let existedAtSpawn: boolean | null = null;
    const spawnFn = ((_command: string, args: readonly string[]) => {
      // What the ENGINE would see: the mount source, at the moment of the
      // spawn. If it is not a directory here, docker creates it as root.
      const mount = args.find((arg) => arg.endsWith(':/workspace')) ?? '';
      const source = mount.slice(0, -':/workspace'.length);
      existedAtSpawn = existsSync(source) && statSync(source).isDirectory();
      return fakeWorker(4242);
    }) as ContainerSpawn;
    const executor = new ContainerToolExecutor({
      workspaceHostPath: workspace,
      spawnFn,
      forwardWorkerLogs: false,
    });

    try {
      await executor.start();
      expect(existedAtSpawn).toBe(true);
    } finally {
      executor.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts a fresh worker after the previous container exits unexpectedly', async () => {
    const children: ChildProcess[] = [];
    const spawnFn = ((_command: string, _args: readonly string[]) => {
      const child = fakeWorker(1000 + children.length);
      children.push(child);
      return child;
    }) as ContainerSpawn;
    const executor = new ContainerToolExecutor({
      workspaceHostPath: '/tmp/workspace',
      spawnFn,
      forwardWorkerLogs: false,
    });

    await executor.start();
    expect(children).toHaveLength(1);
    children[0]!.emit('exit', 1);
    await executor.start();
    expect(children).toHaveLength(2);
    executor.stop();
  });
});
