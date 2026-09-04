import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  acquireLocalCodexHomeLease,
  CODEX_LEASE_WRAPPER_CAPACITY_EXIT_CODE,
  CODEX_LEASE_WRAPPER_UNAVAILABLE_EXIT_CODE,
  codexLeaseWrapperNodeArgs,
  MAX_PERSONAL_CODEX_PROCESSES,
  PERSONAL_CODEX_PROFILE_ROOT_ENV,
} from '../core/codexHomeLease.js';
export {
  acquireCodexHomeLease,
  codexHomeLeaseDatabasePath,
  tryAcquireCodexHomeLease,
} from '../core/codexHomeLease.js';

const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_PENDING_REQUESTS = 32;
export const MAX_CODEX_APP_SERVER_PROCESSES = MAX_PERSONAL_CODEX_PROCESSES;
let activeCodexAppServers = 0;

function cancelledProfileAccess(): Error {
  return new Error('Codex profile access was cancelled');
}

export class CodexAppServerCapacityError extends Error {
  constructor() {
    super('Codex app-server capacity is exhausted');
    this.name = 'CodexAppServerCapacityError';
  }
}

function reserveCodexAppServer(): (() => void) | null {
  if (activeCodexAppServers >= MAX_CODEX_APP_SERVER_PROCESSES) return null;
  activeCodexAppServers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeCodexAppServers--;
  };
}

export interface CodexAppServerSpawnInput {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export type CodexAppServerSpawn = (input: CodexAppServerSpawnInput) => ChildProcess;

export interface CodexAppServerNotification {
  readonly method: string;
  readonly params?: unknown;
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Stable, non-sensitive process failure used by the account service. */
export class CodexAppServerUnavailableError extends Error {
  constructor() {
    super('Codex CLI is unavailable');
    this.name = 'CodexAppServerUnavailableError';
  }
}

/**
 * Exact environment for a principal's Codex profile.
 *
 * The host may carry provider keys for other tiers. None enters app-server:
 * CODEX_HOME is the only credential source and is bound to one principal by
 * the caller. Proxy/certificate settings remain because authentication runs
 * on a remote server and private deployments may need them.
 */
export function codexProfileEnvironment(
  source: NodeJS.ProcessEnv,
  profilePath: string,
  profilesRoot?: string
): NodeJS.ProcessEnv {
  const forwarded = [
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
  ] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of forwarded) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  // Never let Codex fall back to the service account's home. CODEX_HOME is
  // authoritative, while HOME/USERPROFILE cover helper libraries that do not
  // understand Codex's override.
  env['HOME'] = profilePath;
  env['USERPROFILE'] = profilePath;
  env['CODEX_HOME'] = profilePath;
  env['CODEX_SQLITE_HOME'] = profilePath;
  if (profilesRoot) env[PERSONAL_CODEX_PROFILE_ROOT_ENV] = profilesRoot;
  return env;
}

export function codexAppServerArgs(): string[] {
  return [
    'app-server',
    // Refuse an unknown credential-store setting instead of falling back to
    // the service account's keyring and crossing principal boundaries.
    '--strict-config',
    // Headless services cannot rely on an OS keyring. The private CODEX_HOME
    // is already the security boundary and this makes persistence explicit.
    '-c',
    'cli_auth_credentials_store="file"',
  ];
}

function defaultSpawn(input: CodexAppServerSpawnInput): ChildProcess {
  return spawn(process.execPath, codexLeaseWrapperNodeArgs(input.args), {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
}

function processFailure(error: unknown): Error {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === 'ENOENT'
    ? new CodexAppServerUnavailableError()
    : new Error('codex app-server process failed');
}

function requestTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return Math.min(Math.trunc(value), MAX_REQUEST_TIMEOUT_MS);
}

function validMethod(method: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_/-]{0,127}$/.test(method);
}

/** Minimal JSONL/JSON-RPC client for the stable Codex account methods. */
export class CodexAppServerConnection {
  private readonly child: ChildProcess;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(notification: CodexAppServerNotification) => void>();
  private readonly stdoutDecoder = new StringDecoder('utf8');
  private nextId = 1;
  private stdoutBuffer = '';
  private closed = false;
  private removeAbortListener: (() => void) | null = null;
  private releaseHomeLease: (() => void) | null;
  private releaseProcessSlot: (() => void) | null;
  private readonly closedPromise: Promise<void>;
  private resolveClosed: (() => void) | null = null;

  private constructor(input: {
    profilePath: string;
    profilesRoot?: string;
    sourceEnv: NodeJS.ProcessEnv;
    spawnFn: CodexAppServerSpawn;
    requestTimeoutMs: number;
    releaseHomeLease: () => void;
    releaseProcessSlot: () => void;
    signal?: AbortSignal;
  }) {
    this.requestTimeoutMs = input.requestTimeoutMs;
    this.releaseHomeLease = input.releaseHomeLease;
    this.releaseProcessSlot = input.releaseProcessSlot;
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.child = input.spawnFn({
      args: codexAppServerArgs(),
      env: codexProfileEnvironment(input.sourceEnv, input.profilePath, input.profilesRoot),
      cwd: input.profilePath,
    });
    this.child.stdout?.on('data', (chunk: Buffer | string) => {
      this.consumeStdout(chunk);
    });
    this.child.stdout?.on('error', () => {
      this.terminate(new Error('codex app-server stdout failed'));
    });
    // Drain diagnostics so a noisy child cannot block, but never retain or
    // forward them: provider stderr may contain tokens, account ids or URLs.
    this.child.stderr?.on('data', () => undefined);
    this.child.stderr?.on('error', () => {
      this.terminate(new Error('codex app-server stderr failed'));
    });
    this.child.stdin?.on('error', () => {
      this.terminate(new Error('codex app-server stdin failed'));
    });
    this.child.on('error', (error) => this.terminate(processFailure(error)));
    this.child.on('close', (code) => {
      this.closed = true;
      this.removeAbortListener?.();
      this.removeAbortListener = null;
      this.stdoutBuffer = '';
      this.listeners.clear();
      this.failAll(
        code === CODEX_LEASE_WRAPPER_UNAVAILABLE_EXIT_CODE
          ? new CodexAppServerUnavailableError()
          : code === CODEX_LEASE_WRAPPER_CAPACITY_EXIT_CODE
            ? new CodexAppServerCapacityError()
            : new Error('codex app-server closed')
      );
      this.resolveClosed?.();
      this.resolveClosed = null;
      this.releaseLease();
      this.releaseSlot();
    });
    if (input.signal) {
      const onAbort = (): void => {
        this.terminate(new Error('codex app-server request was cancelled'));
      };
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener('abort', onAbort, { once: true });
        this.removeAbortListener = () => input.signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  static async open(input: {
    readonly profilePath: string;
    readonly profilesRoot?: string;
    readonly sourceEnv?: NodeJS.ProcessEnv;
    readonly spawnFn?: CodexAppServerSpawn;
    readonly requestTimeoutMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<CodexAppServerConnection> {
    let connection: CodexAppServerConnection | null = null;
    let releaseHomeLease: (() => void) | null = await acquireLocalCodexHomeLease(
      input.profilePath,
      input.signal
    );
    let releaseProcessSlot: (() => void) | null = null;
    try {
      if (input.signal?.aborted) throw cancelledProfileAccess();
      if (!input.spawnFn && !input.profilesRoot) {
        throw new Error('personal Codex profile root is required');
      }
      releaseProcessSlot = reserveCodexAppServer();
      if (!releaseProcessSlot) throw new CodexAppServerCapacityError();
      connection = new CodexAppServerConnection({
        profilePath: input.profilePath,
        ...(input.profilesRoot ? { profilesRoot: input.profilesRoot } : {}),
        sourceEnv: input.sourceEnv ?? process.env,
        spawnFn: input.spawnFn ?? defaultSpawn,
        requestTimeoutMs: requestTimeout(input.requestTimeoutMs),
        releaseHomeLease,
        releaseProcessSlot,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      releaseHomeLease = null;
      releaseProcessSlot = null;
      await connection.request('initialize', {
        clientInfo: { name: 'atoma', title: 'Atoma', version: '1' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      connection.notify('initialized');
      return connection;
    } catch (error) {
      if (connection) await connection.closeAndWait();
      releaseHomeLease?.();
      releaseProcessSlot?.();
      if (error instanceof CodexAppServerCapacityError) throw error;
      if (error instanceof CodexAppServerUnavailableError) throw error;
      const spawnFailure = processFailure(error);
      if (spawnFailure instanceof CodexAppServerUnavailableError) throw spawnFailure;
      throw new Error('codex app-server initialization failed');
    }
  }

  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('codex app-server is closed'));
    if (!validMethod(method)) return Promise.reject(new Error('invalid codex app-server method'));
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error('too many pending codex app-server requests'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server ${method} timed out`));
        this.close();
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('codex app-server request could not be sent'));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    if (!validMethod(method)) throw new Error('invalid codex app-server method');
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin?.end();
    } catch {
      // The process may already have closed its input.
    }
    this.kill('SIGTERM');
    this.removeAbortListener?.();
    this.removeAbortListener = null;
    this.stdoutBuffer = '';
    this.listeners.clear();
    this.failAll(new Error('codex app-server was closed'));
  }

  async closeAndWait(): Promise<void> {
    this.close();
    await this.closedPromise;
  }

  private releaseLease(): void {
    this.releaseHomeLease?.();
    this.releaseHomeLease = null;
  }

  private releaseSlot(): void {
    this.releaseProcessSlot?.();
    this.releaseProcessSlot = null;
  }

  private kill(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch {
      // Already reaped.
    }
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child.stdin?.writable) throw new Error('codex app-server stdin is unavailable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consumeStdout(chunk: Buffer | string): void {
    if (this.closed) return;
    this.stdoutBuffer +=
      typeof chunk === 'string' ? chunk : this.stdoutDecoder.write(chunk);
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
        this.terminate(new Error('codex app-server produced an oversized protocol line'));
        return;
      }
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        this.terminate(new Error('codex app-server produced invalid JSON'));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.terminate(new Error('codex app-server produced an invalid protocol message'));
        return;
      }
      const message = parsed as Record<string, unknown>;
      const rawId = message['id'];
      const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? rawId : null;
      if (id !== null) {
        const pending = this.pending.get(id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        const rpcError = message['error'];
        if (rpcError && typeof rpcError === 'object') {
          // Provider errors are deliberately not surfaced; they can contain
          // account identifiers, URLs or credentials.
          pending.reject(new Error('codex request failed'));
        } else {
          pending.resolve(message['result']);
        }
        continue;
      }
      const method = message['method'];
      if (typeof method !== 'string') continue;
      const notification: CodexAppServerNotification = {
        method,
        ...(message['params'] === undefined ? {} : { params: message['params'] }),
      };
      for (const listener of this.listeners) {
        try {
          listener(notification);
        } catch {
          this.listeners.delete(listener);
        }
      }
    }
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_PROTOCOL_LINE_BYTES) {
      this.terminate(new Error('codex app-server produced an oversized protocol line'));
    }
  }

  private terminate(error: Error): void {
    this.failAll(error);
    this.close();
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
