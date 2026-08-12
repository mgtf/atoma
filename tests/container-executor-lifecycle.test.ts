import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
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
