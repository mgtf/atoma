import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireCodexHomeLease,
  CodexAppServerCapacityError,
  CodexAppServerConnection,
  CodexAppServerUnavailableError,
  codexAppServerArgs,
  codexHomeLeaseDatabasePath,
  codexProfileEnvironment,
  MAX_CODEX_APP_SERVER_PROCESSES,
  tryAcquireCodexHomeLease,
  type CodexAppServerSpawn,
} from '../src/auth/codexAppServer.js';
import {
  codexLeaseWrapperNodeArgs,
  MAX_PERSONAL_CODEX_PROCESSES,
  PERSONAL_CODEX_PROFILE_ROOT_ENV,
  tryAcquirePersonalCodexProcessSlot,
} from '../src/core/codexHomeLease.js';

interface FakeProcess {
  readonly child: ChildProcess;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly close: () => void;
}

const profileRoots: string[] = [];

afterEach(() => {
  for (const root of profileRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function testProfile(label = 'profile'): string {
  const root = mkdtempSync(path.join(tmpdir(), 'atoma-codex-profile-'));
  profileRoots.push(root);
  const profile = path.join(root, label);
  mkdirSync(profile, { recursive: true });
  return profile;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForBlockedProfile(profile: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const release = tryAcquireCodexHomeLease(profile);
    if (!release) return;
    release();
    await delay(25);
  }
  throw new Error('wrapper did not acquire the profile lease');
}

async function waitForAvailableProfile(profile: string): Promise<() => void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const release = tryAcquireCodexHomeLease(profile);
    if (release) return release;
    await delay(25);
  }
  throw new Error('wrapper did not release the profile lease');
}

async function waitForFullCapacity(profilesRoot: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const release = tryAcquirePersonalCodexProcessSlot(profilesRoot);
    if (!release) return;
    release();
    await delay(25);
  }
  throw new Error('wrapper did not reserve a process seat');
}

function fakeCodexExecutable(binRoot: string, source: string): void {
  const target = path.join(binRoot, 'codex');
  writeFileSync(target, `#!/usr/bin/env node\n${source}\n`, 'utf8');
  chmodSync(target, 0o755);
}

function fakeProcess(
  onMessage: (message: Record<string, unknown>, process: FakeProcess) => void,
  closeOnKill = true
): FakeProcess {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let input = '';
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    emitter.emit('close', 0, null);
  };
  const kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    if (closeOnKill) queueMicrotask(close);
    return true;
  });
  Object.assign(emitter, { stdin, stdout, stderr, kill, pid: 4242 });
  const process: FakeProcess = {
    child: emitter as unknown as ChildProcess,
    stdin,
    stdout,
    stderr,
    kill,
    close,
  };
  stdin.on('data', (chunk: Buffer | string) => {
    input += chunk.toString();
    const lines = input.split('\n');
    input = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      onMessage(JSON.parse(line) as Record<string, unknown>, process);
    }
  });
  return process;
}

function send(process: FakeProcess, message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function openedProcess(options: {
  readonly onMessage?: (message: Record<string, unknown>, process: FakeProcess) => void;
  readonly requestTimeoutMs?: number;
  readonly closeOnKill?: boolean;
  readonly profilePath?: string;
} = {}): Promise<{
  connection: CodexAppServerConnection;
  process: FakeProcess;
  messages: Record<string, unknown>[];
}> {
  const messages: Record<string, unknown>[] = [];
  const process = fakeProcess((message, current) => {
    messages.push(message);
    if (message['method'] === 'initialize') {
      send(current, { id: message['id'], result: {} });
      return;
    }
    options.onMessage?.(message, current);
  }, options.closeOnKill ?? true);
  const connection = await CodexAppServerConnection.open({
    profilePath: options.profilePath ?? testProfile(),
    sourceEnv: {},
    spawnFn: () => process.child,
    requestTimeoutMs: options.requestTimeoutMs ?? 100,
  });
  return { connection, process, messages };
}

describe('Codex app-server transport', () => {
  it('serializes owners of the same normalized CODEX_HOME and permits different homes', async () => {
    const profile = testProfile();
    const equivalent = path.join(profile, '..', path.basename(profile));
    const other = testProfile();
    const firstRelease = await acquireCodexHomeLease(equivalent);
    let secondAcquired = false;
    const second = acquireCodexHomeLease(profile).then((release) => {
      secondAcquired = true;
      return release;
    });
    const otherRelease = await acquireCodexHomeLease(other);

    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    otherRelease();
    firstRelease();
    const secondRelease = await second;
    expect(secondAcquired).toBe(true);
    secondRelease();
  });

  it('removes an aborted CODEX_HOME waiter without blocking the next owner', async () => {
    const profile = testProfile();
    const firstRelease = await acquireCodexHomeLease(profile);
    const controller = new AbortController();
    const cancelled = acquireCodexHomeLease(profile, controller.signal);
    controller.abort();

    await expect(cancelled).rejects.toThrow('profile access was cancelled');
    firstRelease();
    const finalRelease = await acquireCodexHomeLease(profile);
    finalRelease();
  });

  it('keeps the stable SQLite lease after profile deletion and recovers it after a crash', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'atoma-codex-lease-'));
    const profile = path.join(root, 'profile');
    mkdirSync(profile);
    const databasePath = codexHomeLeaseDatabasePath(profile);
    const holder = spawn(
      process.execPath,
      [
        '-e',
        [
          "const Database = require('better-sqlite3')",
          'const db = new Database(process.argv[1], { timeout: 0 })',
          "db.exec('BEGIN IMMEDIATE')",
          "process.stdout.write('locked\\n')",
          'process.stdin.resume()',
          "process.stdin.on('end', () => { db.exec('ROLLBACK'); db.close() })",
        ].join(';'),
        databasePath,
      ],
      { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] }
    );
    try {
      await once(holder.stdout, 'data');
      expect(tryAcquireCodexHomeLease(profile)).toBeNull();

      rmSync(profile, { recursive: true, force: true });
      expect(tryAcquireCodexHomeLease(profile)).toBeNull();

      const crashed = once(holder, 'close');
      holder.kill('SIGKILL');
      await crashed;
      const release = await acquireCodexHomeLease(profile);
      release();
    } finally {
      if (holder.exitCode === null) holder.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists the eight-process ceiling in SQLite instead of process memory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'atoma-codex-capacity-'));
    const releases: Array<() => void> = [];
    try {
      for (let index = 0; index < MAX_PERSONAL_CODEX_PROCESSES; index++) {
        const release = tryAcquirePersonalCodexProcessSlot(root);
        expect(release).not.toBeNull();
        releases.push(release!);
      }
      expect(tryAcquirePersonalCodexProcessSlot(root)).toBeNull();

      releases.shift()?.();
      const replacement = tryAcquirePersonalCodexProcessSlot(root);
      expect(replacement).not.toBeNull();
      replacement?.();
    } finally {
      for (const release of releases) release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'runs the real source wrapper and maps a missing Codex executable',
    async () => {
      const profile = testProfile();
      const profilesRoot = path.dirname(profile);
      const emptyBin = path.join(profilesRoot, 'empty-bin');
      mkdirSync(emptyBin);

      await expect(
        CodexAppServerConnection.open({
          profilePath: profile,
          profilesRoot,
          sourceEnv: { PATH: emptyBin },
          requestTimeoutMs: 5_000,
        })
      ).rejects.toBeInstanceOf(CodexAppServerUnavailableError);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'keeps the lease and global seat after the Atoma parent crashes',
    async () => {
      const profile = testProfile();
      const profilesRoot = path.dirname(profile);
      const binRoot = path.join(profilesRoot, 'bin');
      mkdirSync(binRoot);
      fakeCodexExecutable(
        binRoot,
        [
          "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50))",
          'setInterval(() => undefined, 1000)',
        ].join(';')
      );
      const wrapperArgs = codexLeaseWrapperNodeArgs([]);
      const heldSlots: Array<() => void> = [];
      for (let index = 1; index < MAX_PERSONAL_CODEX_PROCESSES; index++) {
        const release = tryAcquirePersonalCodexProcessSlot(profilesRoot);
        if (!release) throw new Error('test could not reserve a capacity seat');
        heldSlots.push(release);
      }
      const env = {
        ...process.env,
        PATH: `${binRoot}${path.delimiter}${process.env['PATH'] ?? ''}`,
        CODEX_HOME: profile,
        [PERSONAL_CODEX_PROFILE_ROOT_ENV]: profilesRoot,
      };
      const parent = spawn(
        process.execPath,
        [
          '-e',
          [
            "const { spawn } = require('node:child_process')",
            'const child = spawn(process.execPath, JSON.parse(process.argv[1]), {',
            '  cwd: process.argv[2], env: JSON.parse(process.argv[3]),',
            "  detached: true, stdio: 'ignore'",
            '})',
            'child.unref()',
            "process.stdout.write(String(child.pid) + '\\n')",
            'setInterval(() => undefined, 1000)',
          ].join('\n'),
          JSON.stringify(wrapperArgs),
          profile,
          JSON.stringify(env),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let wrapperPid = 0;
      try {
        const [pidChunk] = (await once(parent.stdout, 'data')) as [Buffer];
        wrapperPid = Number.parseInt(pidChunk.toString().trim(), 10);
        expect(wrapperPid).toBeGreaterThan(0);
        await waitForBlockedProfile(profile);
        await waitForFullCapacity(profilesRoot);
        expect(tryAcquirePersonalCodexProcessSlot(profilesRoot)).toBeNull();

        const parentClosed = once(parent, 'close');
        parent.kill('SIGKILL');
        await parentClosed;
        expect(tryAcquireCodexHomeLease(profile)).toBeNull();
        expect(tryAcquirePersonalCodexProcessSlot(profilesRoot)).toBeNull();

        process.kill(wrapperPid, 'SIGTERM');
        const release = await waitForAvailableProfile(profile);
        release();
        const releasedSeat = tryAcquirePersonalCodexProcessSlot(profilesRoot);
        expect(releasedSeat).not.toBeNull();
        releasedSeat?.();
        wrapperPid = 0;
      } finally {
        for (const release of heldSlots) release();
        if (parent.exitCode === null) parent.kill('SIGKILL');
        if (wrapperPid > 0) {
          try {
            process.kill(wrapperPid, 'SIGTERM');
          } catch {
            // It already exited.
          }
        }
      }
    }
  );

  it('holds the CODEX_HOME lease for the lifetime of an app-server connection', async () => {
    const profile = testProfile();
    const first = await openedProcess({ closeOnKill: false, profilePath: profile });
    let secondSpawned = false;
    const secondProcess = fakeProcess((message, current) => {
      if (message['method'] === 'initialize') {
        send(current, { id: message['id'], result: {} });
      }
    });
    const secondOpening = CodexAppServerConnection.open({
      profilePath: profile,
      sourceEnv: {},
      spawnFn: () => {
        secondSpawned = true;
        return secondProcess.child;
      },
      requestTimeoutMs: 100,
    });

    await Promise.resolve();
    expect(secondSpawned).toBe(false);
    first.connection.close();
    await Promise.resolve();
    expect(secondSpawned).toBe(false);
    first.process.close();
    const second = await secondOpening;
    expect(secondSpawned).toBe(true);
    second.close();
  });

  it('counts closing children against the hard app-server process ceiling until reap', async () => {
    const opened: Array<{ connection: CodexAppServerConnection; process: FakeProcess }> = [];
    const capacityRoot = testProfile('capacity');
    for (let index = 0; index < MAX_CODEX_APP_SERVER_PROCESSES; index++) {
      const profilePath = path.join(capacityRoot, String(index));
      mkdirSync(profilePath);
      const process = fakeProcess((message, current) => {
        if (message['method'] === 'initialize') {
          send(current, { id: message['id'], result: {} });
        }
      }, false);
      const connection = await CodexAppServerConnection.open({
        profilePath,
        sourceEnv: {},
        spawnFn: () => process.child,
        requestTimeoutMs: 100,
      });
      opened.push({ connection, process });
    }
    for (const entry of opened) entry.connection.close();

    let ninthSpawned = false;
    await expect(
      CodexAppServerConnection.open({
        profilePath: path.join(capacityRoot, 'ninth'),
        sourceEnv: {},
        spawnFn: () => {
          ninthSpawned = true;
          return fakeProcess(() => undefined).child;
        },
      })
    ).rejects.toBeInstanceOf(CodexAppServerCapacityError);
    expect(ninthSpawned).toBe(false);

    for (const entry of opened) entry.process.close();
    await Promise.all(opened.map((entry) => entry.connection.closeAndWait()));
  });

  it('fails closed if the file credential-store setting is unsupported', () => {
    expect(codexAppServerArgs()).toEqual([
      'app-server',
      '--strict-config',
      '-c',
      'cli_auth_credentials_store="file"',
    ]);
  });

  it('uses the generated stable handshake shape and omits absent params', async () => {
    const { connection, messages } = await openedProcess({
      onMessage: (message, current) => {
        send(current, { id: message['id'], result: {} });
      },
    });

    await connection.request('account/logout');

    expect(messages[0]).toMatchObject({
      method: 'initialize',
      params: {
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    });
    expect(messages[1]).toEqual({ method: 'initialized' });
    expect(messages[2]).toEqual(expect.objectContaining({ method: 'account/logout' }));
    expect(messages[2]).not.toHaveProperty('params');
    connection.close();
  });

  it('builds an exact principal environment without host provider credentials or HOME', () => {
    const profile = '/srv/atoma/account-profiles/principal/codex/generation';
    const env = codexProfileEnvironment(
      {
        PATH: '/usr/bin',
        HOME: '/home/atoma',
        USERPROFILE: 'C:\\Users\\atoma',
        OPENAI_API_KEY: 'sk-secret',
        CODEX_API_KEY: 'codex-secret',
        CODEX_HOME: '/host/codex',
        ANTHROPIC_API_KEY: 'anthropic-secret',
        NODE_OPTIONS: '--require malicious.js',
        HTTPS_PROXY: 'https://proxy.example',
      },
      profile,
      '/srv/atoma/account-profiles'
    );

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: profile,
      USERPROFILE: profile,
      CODEX_HOME: profile,
      CODEX_SQLITE_HOME: profile,
      [PERSONAL_CODEX_PROFILE_ROOT_ENV]: '/srv/atoma/account-profiles',
      HTTPS_PROXY: 'https://proxy.example',
    });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('CODEX_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
  });

  it('never exposes provider RPC errors or stderr contents', async () => {
    const marker = 'sk-provider-secret';
    const { connection } = await openedProcess({
      onMessage: (message, current) => {
        current.stderr.write(`diagnostic ${marker}`);
        send(current, { id: message['id'], error: { message: `failed with ${marker}` } });
      },
    });

    const error = await connection.request('account/read').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('codex request failed');
    expect((error as Error).message).not.toContain(marker);
    connection.close();
  });

  it('rejects primitive JSON without throwing from the stream callback', async () => {
    const { connection, process } = await openedProcess();
    const pending = connection.request('account/read');
    process.stdout.write('null\n');

    await expect(pending).rejects.toThrow('invalid protocol message');
    expect(process.kill).toHaveBeenCalled();
  });

  it('accepts a batch larger than the line ceiling when each JSONL line is bounded', async () => {
    const { connection, process } = await openedProcess();
    let notifications = 0;
    connection.onNotification(() => {
      notifications += 1;
    });
    const line = `${JSON.stringify({ method: 'test/event', params: { text: 'x'.repeat(256) } })}\n`;
    const count = 4_100;
    expect(Buffer.byteLength(line.repeat(count))).toBeGreaterThan(1024 * 1024);

    process.stdout.write(line.repeat(count));

    expect(notifications).toBe(count);
    expect(process.kill).not.toHaveBeenCalled();
    connection.close();
  });

  it('closes and reaps a wedged process when a request times out', async () => {
    const { connection, process } = await openedProcess({ requestTimeoutMs: 10 });

    await expect(connection.request('account/read')).rejects.toThrow('timed out');
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('aborts an initialization in flight and cleans up the child', async () => {
    let sawInitialize!: () => void;
    const initializeReceived = new Promise<void>((resolve) => {
      sawInitialize = resolve;
    });
    const process = fakeProcess((message) => {
      if (message['method'] === 'initialize') sawInitialize();
    });
    const controller = new AbortController();
    const opening = CodexAppServerConnection.open({
      profilePath: testProfile(),
      sourceEnv: {},
      spawnFn: (() => process.child) satisfies CodexAppServerSpawn,
      requestTimeoutMs: 1_000,
      signal: controller.signal,
    });

    await initializeReceived;
    controller.abort();

    await expect(opening).rejects.toThrow('initialization failed');
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
