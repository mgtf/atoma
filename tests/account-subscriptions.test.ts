import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountSubscriptionService,
  CodexSubscriptionCapacityError,
  MAX_PENDING_CODEX_LOGINS,
  type CodexProfileForRun,
} from '../src/auth/subscriptionProfiles.js';
import {
  AuthStore,
  type CompletedProviderIdentity,
  type Viewer,
} from '../src/auth/store.js';
import type {
  CodexAppServerSpawn,
  CodexAppServerSpawnInput,
} from '../src/auth/codexAppServer.js';
import { principalChatGptSelection } from '../src/contracts/runPayers.js';

interface FakeProcess {
  readonly child: ChildProcess;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
}

interface SpawnRecord {
  readonly input: CodexAppServerSpawnInput;
  readonly process: FakeProcess;
  readonly requests: Record<string, unknown>[];
  loginId: string | null;
}

function fakeProcess(onMessage: (message: Record<string, unknown>) => void): FakeProcess {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let input = '';
  const kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    queueMicrotask(() => emitter.emit('close', 0, null));
    return true;
  });
  Object.assign(emitter, { stdin, stdout, stderr, kill, pid: 4343 });
  stdin.on('data', (chunk: Buffer | string) => {
    input += chunk.toString();
    const lines = input.split('\n');
    input = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) onMessage(JSON.parse(line) as Record<string, unknown>);
    }
  });
  return {
    child: emitter as unknown as ChildProcess,
    stdin,
    stdout,
    stderr,
    kill,
  };
}

function send(process: FakeProcess, message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

class CodexHarness {
  readonly records: SpawnRecord[] = [];
  holdCancel = false;
  holdAccountRead = false;
  holdInitialize = false;

  readonly spawn: CodexAppServerSpawn = (input) => {
    const record = {} as SpawnRecord;
    const process = fakeProcess((message) => this.handle(record, message));
    Object.assign(record, { input, process, requests: [], loginId: null });
    this.records.push(record);
    return process.child;
  };

  complete(record: SpawnRecord, secret = 'refresh-token-secret'): void {
    if (!record.loginId) throw new Error('login did not start');
    const profile = record.input.env['CODEX_HOME'];
    if (!profile) throw new Error('missing CODEX_HOME');
    writeFileSync(path.join(profile, 'auth.json'), JSON.stringify({ token: secret }), {
      mode: 0o600,
    });
    if (process.platform !== 'win32') chmodSync(path.join(profile, 'auth.json'), 0o600);
    send(record.process, {
      method: 'account/login/completed',
      params: { loginId: record.loginId, success: true, error: null },
    });
  }

  respondAccountRead(record: SpawnRecord): void {
    const request = [...record.requests]
      .reverse()
      .find((candidate) => candidate['method'] === 'account/read');
    if (!request) throw new Error('account/read was not requested');
    send(record.process, {
      id: request['id'],
      result: { account: { type: 'chatgpt', email: 'private@example.com' } },
    });
  }

  private handle(record: SpawnRecord, message: Record<string, unknown>): void {
    record.requests.push(message);
    const method = message['method'];
    if (method === 'initialized') return;
    if (method === 'initialize') {
      if (this.holdInitialize) return;
      send(record.process, { id: message['id'], result: {} });
      return;
    }
    if (method === 'account/login/start') {
      record.loginId = randomUUID();
      send(record.process, {
        id: message['id'],
        result: {
          type: 'chatgptDeviceCode',
          loginId: record.loginId,
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-1234',
        },
      });
      return;
    }
    if (method === 'account/login/cancel' && this.holdCancel) return;
    if (method === 'account/read') {
      if (!this.holdAccountRead) this.respondAccountRead(record);
      return;
    }
    send(record.process, { id: message['id'], result: {} });
  }
}

let temporaryRoot: string;
let db: Database.Database;
let store: AuthStore;
let services: AccountSubscriptionService[];

beforeEach(() => {
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'atoma-subscriptions-'));
  db = new Database(path.join(temporaryRoot, 'store.db'));
  store = new AuthStore(db);
  services = [];
});

afterEach(() => {
  for (const service of services) service.close();
  db.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
});

function identity(subject: string): CompletedProviderIdentity {
  return {
    provider: 'github',
    subject,
    displayName: subject,
    email: null,
    emailVerified: false,
  };
}

function viewer(subject: string): Viewer {
  const outcome = store.completeLogin(identity(subject), null);
  if (!outcome) throw new Error('expected login to succeed');
  return outcome.viewer;
}

function service(harness: CodexHarness, requestTimeoutMs = 100): AccountSubscriptionService {
  const instance = new AccountSubscriptionService({
    auth: store,
    profilesRoot: path.join(temporaryRoot, 'profiles'),
    sourceEnv: { PATH: process.env['PATH'] },
    spawnFn: harness.spawn,
    requestTimeoutMs,
  });
  services.push(instance);
  return instance;
}

function createStoredProfile(
  profilesRoot: string,
  principalId: string,
  profileId = randomUUID()
): CodexProfileForRun {
  const principalRoot = path.join(profilesRoot, principalId);
  const providerRoot = path.join(principalRoot, 'codex');
  const homePath = path.join(providerRoot, profileId);
  mkdirSync(homePath, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    chmodSync(profilesRoot, 0o700);
    chmodSync(principalRoot, 0o700);
    chmodSync(providerRoot, 0o700);
    chmodSync(homePath, 0o700);
  }
  writeFileSync(path.join(homePath, 'auth.json'), '{"token":"old-secret"}', { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path.join(homePath, 'auth.json'), 0o600);
  return { profileId, homePath, profilesRoot };
}

describe('principal subscription receipts', () => {
  it('isolates principals and stores metadata without credential bytes', () => {
    const alice = viewer('alice');
    const bob = viewer('bob');
    const profileId = randomUUID();

    store.setPrincipalSubscription({ principalId: alice.principalId, provider: 'codex', profileId });

    expect(store.principalSubscription(alice.principalId, 'codex')).toMatchObject({ profileId });
    expect(store.principalSubscription(bob.principalId, 'codex')).toBeNull();
    expect(() =>
      store.setPrincipalSubscription({ principalId: bob.principalId, provider: 'codex', profileId })
    ).toThrow();
    const columns = db
      .prepare('PRAGMA table_info(auth_principal_subscriptions)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain('token');
    expect(columns.map((column) => column.name)).not.toContain('envelope');
  });

  it('deletes the receipt and personal Codex pins in one transaction', () => {
    const alice = viewer('alice');
    store.setPrincipalSubscription({
      principalId: alice.principalId,
      provider: 'codex',
      profileId: randomUUID(),
    });
    const selection = principalChatGptSelection('gpt-5.6-sol');
    store.setModelPins(alice.principalId, { l1: null, l2: selection, l3: selection });
    db.exec(`
      CREATE TRIGGER refuse_pin_clear
      BEFORE UPDATE ON auth_principal_model_pins
      BEGIN
        SELECT RAISE(ABORT, 'test rollback');
      END;
    `);

    expect(() => store.deletePrincipalSubscription(alice.principalId, 'codex')).toThrow();
    expect(store.principalSubscription(alice.principalId, 'codex')).not.toBeNull();
    expect(store.modelPins(alice.principalId)).toMatchObject({ l2: selection, l3: selection });

    db.exec('DROP TRIGGER refuse_pin_clear');
    expect(store.deletePrincipalSubscription(alice.principalId, 'codex')).not.toBeNull();
    expect(store.principalSubscription(alice.principalId, 'codex')).toBeNull();
    expect(store.modelPins(alice.principalId)).toEqual({ l1: null, l2: null, l3: null });

    // A stale pin can outlive an already-missing receipt after a partial old
    // deployment. Disconnect remains idempotent and still disarms that pin.
    store.setModelPins(alice.principalId, { l1: null, l2: selection, l3: null });
    expect(store.deletePrincipalSubscription(alice.principalId, 'codex')).toBeNull();
    expect(store.modelPins(alice.principalId).l2).toBeNull();
  });
});

describe('principal Codex profile platform boundary', () => {
  it('fails closed on Windows where POSIX mode bits cannot prove a private ACL', async () => {
    const alice = viewer('alice');
    const profilesRoot = path.join(temporaryRoot, 'windows-profiles');
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    if (!descriptor) throw new Error('process.platform descriptor is unavailable');
    let subscriptions!: AccountSubscriptionService;
    try {
      subscriptions = new AccountSubscriptionService({ auth: store, profilesRoot });
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
    services.push(subscriptions);

    expect(existsSync(profilesRoot)).toBe(false);
    await expect(
      subscriptions.startCodexLogin(alice.principalId, alice.orgId)
    ).rejects.toThrow('require verified POSIX permissions');
    expect(subscriptions.codexProfileForRun(alice.principalId)).toBeNull();
    await expect(subscriptions.status(alice.principalId)).resolves.toMatchObject({
      codex: { state: 'unavailable', reason: 'profile-permissions-unsupported' },
    });
  });
});

describe.skipIf(process.platform === 'win32')('principal Codex profile service', () => {
  it('connects one principal without exposing the credential, path or account email', async () => {
    const alice = viewer('alice');
    const bob = viewer('bob');
    const harness = new CodexHarness();
    const subscriptions = service(harness);
    const secret = 'refresh-token-must-not-leak';

    const attempt = await subscriptions.startCodexLogin(alice.principalId, alice.orgId);
    expect(attempt).toMatchObject({
      state: 'connecting',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    });
    harness.complete(harness.records[0]!, secret);
    await vi.waitFor(() => {
      expect(store.principalSubscription(alice.principalId, 'codex')).not.toBeNull();
    });

    const aliceProfile = subscriptions.codexProfileForRun(alice.principalId);
    expect(aliceProfile).not.toBeNull();
    expect(subscriptions.codexProfileForRun(bob.principalId)).toBeNull();
    const status = await subscriptions.status(alice.principalId);
    const repeatedStatus = await subscriptions.status(alice.principalId);
    const publicJson = JSON.stringify(status);
    expect(status.codex.state).toBe('connected');
    expect(repeatedStatus.codex.state).toBe('connected');
    // The login completion already verified this fresh receipt. Browser polls
    // do not start another app-server or force a token refresh.
    expect(harness.records).toHaveLength(1);
    expect(publicJson).not.toContain(secret);
    expect(publicJson).not.toContain(aliceProfile!.homePath);
    expect(publicJson).not.toContain('private@example.com');
    const storedJson = JSON.stringify(
      db.prepare('SELECT * FROM auth_principal_subscriptions').all()
    );
    expect(storedJson).not.toContain(secret);
    expect(readFileSync(path.join(aliceProfile!.homePath, 'auth.json'), 'utf8')).toContain(secret);
    if (process.platform !== 'win32') {
      expect(lstatSync(aliceProfile!.homePath).mode & 0o777).toBe(0o700);
      expect(lstatSync(path.join(aliceProfile!.homePath, 'auth.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('deduplicates concurrent starts for the same principal', async () => {
    const alice = viewer('alice');
    const harness = new CodexHarness();
    const subscriptions = service(harness);

    const [first, second] = await Promise.all([
      subscriptions.startCodexLogin(alice.principalId, alice.orgId),
      subscriptions.startCodexLogin(alice.principalId, alice.orgId),
    ]);

    expect(second).toEqual(first);
    expect(harness.records).toHaveLength(1);
    expect(
      harness.records[0]!.requests.filter((request) => request['method'] === 'account/login/start')
    ).toHaveLength(1);
  });

  it('does not let expiry delete a login whose completion is already being verified', async () => {
    vi.useFakeTimers();
    try {
      const alice = viewer('alice');
      const harness = new CodexHarness();
      harness.holdAccountRead = true;
      const subscriptions = new AccountSubscriptionService({
        auth: store,
        profilesRoot: path.join(temporaryRoot, 'profiles'),
        sourceEnv: { PATH: process.env['PATH'] },
        spawnFn: harness.spawn,
        requestTimeoutMs: 1_000,
        loginTtlMs: 50,
      });
      services.push(subscriptions);

      await subscriptions.startCodexLogin(alice.principalId, alice.orgId);
      const record = harness.records[0]!;
      harness.complete(record);
      expect(record.requests.some((request) => request['method'] === 'account/read')).toBe(true);

      // The provider has announced success and account verification is in
      // flight. Crossing the device-code TTL must not cancel or later remove
      // the generation that completion is about to make current.
      await vi.advanceTimersByTimeAsync(50);
      expect(
        record.requests.filter((request) => request['method'] === 'account/login/cancel')
      ).toHaveLength(0);

      harness.respondAccountRead(record);
      await vi.advanceTimersByTimeAsync(0);
      const receipt = store.principalSubscription(alice.principalId, 'codex');
      expect(receipt).not.toBeNull();
      expect(existsSync(path.join(record.input.env['CODEX_HOME']!, 'auth.json'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a completion arriving after expiry commit a receipt', async () => {
    vi.useFakeTimers();
    try {
      const alice = viewer('alice');
      const harness = new CodexHarness();
      harness.holdCancel = true;
      const subscriptions = new AccountSubscriptionService({
        auth: store,
        profilesRoot: path.join(temporaryRoot, 'profiles'),
        sourceEnv: { PATH: process.env['PATH'] },
        spawnFn: harness.spawn,
        requestTimeoutMs: 1_000,
        loginTtlMs: 50,
      });
      services.push(subscriptions);

      await subscriptions.startCodexLogin(alice.principalId, alice.orgId);
      const record = harness.records[0]!;
      await vi.advanceTimersByTimeAsync(50);
      const cancel = record.requests.find(
        (request) => request['method'] === 'account/login/cancel'
      );
      expect(cancel).toBeDefined();

      harness.complete(record);
      send(record.process, { id: cancel!['id'], result: {} });
      await vi.advanceTimersByTimeAsync(0);

      expect(store.principalSubscription(alice.principalId, 'codex')).toBeNull();
      const status = await subscriptions.status(alice.principalId, { verify: false });
      expect(status.codexAttempt).toMatchObject({
        state: 'error',
        reason: 'login-expired',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts an initialization in flight and removes its staging generation on close', async () => {
    const alice = viewer('alice');
    const harness = new CodexHarness();
    harness.holdInitialize = true;
    const subscriptions = service(harness, 1_000);

    const starting = subscriptions.startCodexLogin(alice.principalId, alice.orgId);
    await vi.waitFor(() => expect(harness.records).toHaveLength(1));
    const profilePath = harness.records[0]!.input.env['CODEX_HOME']!;
    expect(existsSync(profilePath)).toBe(true);

    subscriptions.close();

    await expect(starting).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(existsSync(profilePath)).toBe(false));
    expect(harness.records[0]!.process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('bounds every app-server check, lets a principal replace its failed slot and cleans attempts', async () => {
    const participants = Array.from({ length: MAX_PENDING_CODEX_LOGINS + 1 }, (_, index) =>
      viewer(`member-${index}`)
    );
    const observer = viewer('status-observer');
    const harness = new CodexHarness();
    const subscriptions = service(harness);
    const observerProfile = createStoredProfile(
      path.join(temporaryRoot, 'profiles'),
      observer.principalId
    );
    store.setPrincipalSubscription({
      principalId: observer.principalId,
      provider: 'codex',
      profileId: observerProfile.profileId,
    });
    store.markPrincipalSubscriptionVerified(
      observer.principalId,
      'codex',
      'reauth_required',
      observerProfile.profileId
    );
    for (const participant of participants.slice(0, MAX_PENDING_CODEX_LOGINS)) {
      await subscriptions.startCodexLogin(participant.principalId, participant.orgId);
    }
    const boundedStatus = await subscriptions.status(observer.principalId);
    expect(boundedStatus.codex.state).toBe('reauth_required');
    expect(harness.records).toHaveLength(MAX_PENDING_CODEX_LOGINS);
    const failed = harness.records[0]!;
    send(failed.process, {
      method: 'account/login/completed',
      params: { loginId: failed.loginId, success: false, error: 'provider detail' },
    });

    // Replacing one's own failed receipt frees that slot before capacity is
    // evaluated; the discarded device profile/process is already gone.
    await subscriptions.startCodexLogin(participants[0]!.principalId, participants[0]!.orgId);
    await expect(
      subscriptions.startCodexLogin(
        participants[MAX_PENDING_CODEX_LOGINS]!.principalId,
        participants[MAX_PENDING_CODEX_LOGINS]!.orgId
      )
    ).rejects.toBeInstanceOf(CodexSubscriptionCapacityError);
    expect(harness.records).toHaveLength(MAX_PENDING_CODEX_LOGINS + 1);

    subscriptions.close();
    for (const record of harness.records) {
      expect(record.process.kill).toHaveBeenCalled();
      await vi.waitFor(() => expect(existsSync(record.input.env['CODEX_HOME']!)).toBe(false));
    }
  });

  it('refuses a login while status verification already occupies every app-server slot', async () => {
    const harness = new CodexHarness();
    harness.holdAccountRead = true;
    const subscriptions = service(harness, 1_000);
    const profilesRoot = path.join(temporaryRoot, 'profiles');
    const observers = Array.from({ length: MAX_PENDING_CODEX_LOGINS }, (_, index) => {
      const participant = viewer(`status-${index}`);
      const profile = createStoredProfile(profilesRoot, participant.principalId);
      store.setPrincipalSubscription({
        principalId: participant.principalId,
        provider: 'codex',
        profileId: profile.profileId,
      });
      store.markPrincipalSubscriptionVerified(
        participant.principalId,
        'codex',
        'reauth_required',
        profile.profileId
      );
      return participant;
    });

    const checks = observers.map((participant) =>
      subscriptions.status(participant.principalId)
    );
    await vi.waitFor(() => expect(harness.records).toHaveLength(MAX_PENDING_CODEX_LOGINS));

    const ninth = viewer('status-capacity-login');
    await expect(
      subscriptions.startCodexLogin(ninth.principalId, ninth.orgId)
    ).rejects.toBeInstanceOf(CodexSubscriptionCapacityError);
    expect(harness.records).toHaveLength(MAX_PENDING_CODEX_LOGINS);

    for (const record of harness.records) harness.respondAccountRead(record);
    await expect(Promise.all(checks)).resolves.toHaveLength(MAX_PENDING_CODEX_LOGINS);
  });

  it('removes the previous credential generation after a successful replacement', async () => {
    const alice = viewer('alice');
    const harness = new CodexHarness();
    const subscriptions = service(harness);
    const profilesRoot = path.join(temporaryRoot, 'profiles');
    const previous = createStoredProfile(profilesRoot, alice.principalId);
    store.setPrincipalSubscription({
      principalId: alice.principalId,
      provider: 'codex',
      profileId: previous.profileId,
    });
    store.markPrincipalSubscriptionVerified(
      alice.principalId,
      'codex',
      'reauth_required',
      previous.profileId
    );

    await subscriptions.startCodexLogin(alice.principalId, alice.orgId);
    harness.complete(harness.records[0]!);
    await vi.waitFor(() => {
      expect(store.principalSubscription(alice.principalId, 'codex')?.profileId).not.toBe(
        previous.profileId
      );
    });

    await vi.waitFor(() => expect(existsSync(previous.homePath)).toBe(false));
  });

  it('reconciles only unreferenced UUID generations and never follows links', () => {
    const alice = viewer('alice');
    const bob = viewer('bob');
    const profilesRoot = path.join(temporaryRoot, 'profiles');
    const referenced = createStoredProfile(profilesRoot, alice.principalId);
    store.setPrincipalSubscription({
      principalId: alice.principalId,
      provider: 'codex',
      profileId: referenced.profileId,
    });
    const orphan = createStoredProfile(profilesRoot, alice.principalId);
    const providerRoot = path.dirname(orphan.homePath);
    const unknown = path.join(providerRoot, 'operator-note');
    mkdirSync(unknown);
    const outside = path.join(temporaryRoot, 'outside-reconcile');
    mkdirSync(outside);
    const marker = path.join(outside, 'keep.txt');
    writeFileSync(marker, 'keep');
    const linkedGeneration = path.join(providerRoot, randomUUID());
    symlinkSync(outside, linkedGeneration, 'dir');
    const bobOutside = path.join(temporaryRoot, 'bob-outside');
    mkdirSync(bobOutside);
    writeFileSync(path.join(bobOutside, 'keep.txt'), 'keep');
    symlinkSync(bobOutside, path.join(profilesRoot, bob.principalId), 'dir');

    const subscriptions = new AccountSubscriptionService({
      auth: store,
      profilesRoot,
      spawnFn: new CodexHarness().spawn,
    });
    services.push(subscriptions);

    expect(existsSync(referenced.homePath)).toBe(true);
    expect(existsSync(orphan.homePath)).toBe(false);
    expect(existsSync(unknown)).toBe(true);
    expect(existsSync(linkedGeneration)).toBe(false);
    expect(readFileSync(marker, 'utf8')).toBe('keep');
    expect(readFileSync(path.join(bobOutside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('revokes the receipt and pins synchronously before waiting for provider cancellation', async () => {
    const alice = viewer('alice');
    const harness = new CodexHarness();
    harness.holdCancel = true;
    const subscriptions = service(harness, 20);
    const profilesRoot = path.join(temporaryRoot, 'profiles');
    const previous = createStoredProfile(profilesRoot, alice.principalId);
    store.setPrincipalSubscription({
      principalId: alice.principalId,
      provider: 'codex',
      profileId: previous.profileId,
    });
    store.markPrincipalSubscriptionVerified(
      alice.principalId,
      'codex',
      'reauth_required',
      previous.profileId
    );
    const selection = principalChatGptSelection('gpt-5.6-sol');
    store.setModelPins(alice.principalId, { l1: null, l2: selection, l3: null });
    await subscriptions.startCodexLogin(alice.principalId, alice.orgId);

    const disconnecting = subscriptions.disconnectCodex(alice.principalId, alice.orgId);

    expect(store.principalSubscription(alice.principalId, 'codex')).toBeNull();
    expect(store.modelPins(alice.principalId).l2).toBeNull();
    await expect(disconnecting).resolves.toBe(true);
    expect(existsSync(previous.homePath)).toBe(false);
  });

  it('serializes stale status checks process-wide and never requests a token refresh', async () => {
    const alice = viewer('alice');
    const harness = new CodexHarness();
    harness.holdAccountRead = true;
    const profilesRoot = path.join(temporaryRoot, 'profiles');
    const profile = createStoredProfile(profilesRoot, alice.principalId);
    store.setPrincipalSubscription({
      principalId: alice.principalId,
      provider: 'codex',
      profileId: profile.profileId,
    });
    db.prepare(
      `UPDATE auth_principal_subscriptions
       SET last_verified_at = '2000-01-01T00:00:00.000Z'
       WHERE principal_id = ? AND provider = 'codex'`
    ).run(alice.principalId);
    const firstService = service(harness);
    const secondService = service(harness);

    const firstStatus = firstService.status(alice.principalId);
    await vi.waitFor(() => expect(harness.records).toHaveLength(1));
    expect(firstService.codexProfileForRun(alice.principalId)).toBeNull();
    await expect(
      firstService.status(alice.principalId, { verify: false })
    ).resolves.toMatchObject({ codex: { state: 'connected' } });
    expect(harness.records).toHaveLength(1);
    const secondStatus = secondService.status(alice.principalId);
    await Promise.resolve();
    expect(harness.records).toHaveLength(1);

    harness.respondAccountRead(harness.records[0]!);
    await expect(firstStatus).resolves.toMatchObject({ codex: { state: 'connected' } });
    expect(firstService.codexProfileForRun(alice.principalId)).not.toBeNull();
    await vi.waitFor(() => expect(harness.records).toHaveLength(2));
    const secondRecord = harness.records[1]!;
    const accountRead = secondRecord.requests.find(
      (request) => request['method'] === 'account/read'
    );
    expect(accountRead).toMatchObject({ params: { refreshToken: false } });
    harness.respondAccountRead(secondRecord);
    await expect(secondStatus).resolves.toMatchObject({ codex: { state: 'connected' } });
  });

  it('reports an unavailable Codex executable without exposing its process error', async () => {
    const alice = viewer('alice');
    const profilesRoot = path.join(temporaryRoot, 'profiles');
    const harness = new CodexHarness();
    const subscriptions = service(harness);
    const profile = createStoredProfile(profilesRoot, alice.principalId);
    store.setPrincipalSubscription({
      principalId: alice.principalId,
      provider: 'codex',
      profileId: profile.profileId,
    });
    db.prepare(
      `UPDATE auth_principal_subscriptions
       SET last_verified_at = '2000-01-01T00:00:00.000Z'
       WHERE principal_id = ? AND provider = 'codex'`
    ).run(alice.principalId);
    subscriptions.close();
    const missingCli = new AccountSubscriptionService({
      auth: store,
      profilesRoot,
      spawnFn: () => {
        const error = new Error('secret host path must not escape') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
    });
    services.push(missingCli);

    const status = await missingCli.status(alice.principalId);

    expect(status.codex).toMatchObject({
      state: 'unavailable',
      reason: 'codex-cli-unavailable',
    });
    expect(JSON.stringify(status)).not.toContain('secret host path');
  });

  it('does not resurrect a receipt deleted while account verification is in flight', async () => {
    const alice = viewer('alice');
    const harness = new CodexHarness();
    harness.holdAccountRead = true;
    const subscriptions = service(harness);
    const profile = createStoredProfile(path.join(temporaryRoot, 'profiles'), alice.principalId);
    store.setPrincipalSubscription({
      principalId: alice.principalId,
      provider: 'codex',
      profileId: profile.profileId,
    });
    db.prepare(
      `UPDATE auth_principal_subscriptions
       SET last_verified_at = '2000-01-01T00:00:00.000Z'
       WHERE principal_id = ? AND provider = 'codex'`
    ).run(alice.principalId);

    const checking = subscriptions.status(alice.principalId);
    await vi.waitFor(() => {
      expect(
        harness.records.some((record) =>
          record.requests.some((request) => request['method'] === 'account/read')
        )
      ).toBe(true);
    });
    store.deletePrincipalSubscription(alice.principalId, 'codex');
    const statusRecord = harness.records.find((record) =>
      record.requests.some((request) => request['method'] === 'account/read')
    )!;
    harness.respondAccountRead(statusRecord);

    await expect(checking).resolves.toMatchObject({
      codex: { state: 'disconnected', reason: null },
    });
    expect(store.principalSubscription(alice.principalId, 'codex')).toBeNull();
  });

  it('refuses an intermediate profile symlink without touching its target', async () => {
    const alice = viewer('alice');
    const harness = new CodexHarness();
    const subscriptions = service(harness);
    const profilesRoot = path.join(temporaryRoot, 'profiles');
    const outside = path.join(temporaryRoot, 'outside');
    mkdirSync(outside);
    const marker = path.join(outside, 'keep.txt');
    writeFileSync(marker, 'keep');
    const principalPath = path.join(profilesRoot, alice.principalId);
    symlinkSync(outside, principalPath, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(
      subscriptions.startCodexLogin(alice.principalId, alice.orgId)
    ).rejects.toThrow('not a private directory');
    expect(readFileSync(marker, 'utf8')).toBe('keep');
    expect(harness.records).toHaveLength(0);
    unlinkSync(principalPath);
  });
});

const posixIt = it.skipIf(process.platform === 'win32');

describe('principal Codex profile symlink cleanup', () => {
  posixIt('rejects a symlinked auth.json and preserves the external file', async () => {
    const alice = viewer('alice');
    const harness = new CodexHarness();
    const subscriptions = service(harness);
    await subscriptions.startCodexLogin(alice.principalId, alice.orgId);
    const record = harness.records[0]!;
    const profile = record.input.env['CODEX_HOME']!;
    const external = path.join(temporaryRoot, 'external-auth.json');
    writeFileSync(external, 'external-secret', { mode: 0o600 });
    symlinkSync(external, path.join(profile, 'auth.json'), 'file');
    send(record.process, {
      method: 'account/login/completed',
      params: { loginId: record.loginId, success: true, error: null },
    });

    await vi.waitFor(async () => {
      expect((await subscriptions.status(alice.principalId)).codex.state).toBe('error');
    });
    expect(store.principalSubscription(alice.principalId, 'codex')).toBeNull();
    expect(readFileSync(external, 'utf8')).toBe('external-secret');
  });
});
