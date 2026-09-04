import { randomUUID } from 'node:crypto';
import {
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  type Dirent,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  accountSubscriptionsResponseSchema,
  accountSubscriptionProfileIdSchema,
  codexDeviceUserCodeSchema,
  codexSubscriptionAttemptSchema,
  type AccountSubscriptionReason,
  type AccountSubscriptionStatus,
  type AccountSubscriptionsResponse,
  type CodexSubscriptionAttempt,
} from '../contracts/accountSubscriptions.js';
import { organisationIdSchema, principalIdSchema } from '../contracts/projects.js';
import type { AuthStore, PrincipalSubscriptionReceipt } from './store.js';
import {
  acquireCodexHomeLease,
  CodexAppServerCapacityError,
  CodexAppServerConnection,
  CodexAppServerUnavailableError,
  MAX_CODEX_APP_SERVER_PROCESSES,
  type CodexAppServerNotification,
  type CodexAppServerSpawn,
  tryAcquireCodexHomeLease,
} from './codexAppServer.js';

export const ACCOUNT_PROFILES_ROOT_ENV = 'ATOMA_ACCOUNT_PROFILES_ROOT';
export const DEFAULT_CODEX_LOGIN_TTL_MS = 10 * 60 * 1_000;
/** Each pending login owns one app-server process; keep the 4 GiB VPS bounded. */
export const MAX_PENDING_CODEX_LOGINS = MAX_CODEX_APP_SERVER_PROCESSES;
const MAX_CODEX_LOGIN_TTL_MS = 30 * 60 * 1_000;
const FAILED_ATTEMPT_TTL_MS = 60_000;
const CODEX_STATUS_FRESH_MS = 5 * 60 * 1_000;

export class CodexSubscriptionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSubscriptionConflictError';
  }
}

export class CodexSubscriptionCapacityError extends Error {
  constructor() {
    super(`too many pending Codex logins (limit ${MAX_PENDING_CODEX_LOGINS})`);
    this.name = 'CodexSubscriptionCapacityError';
  }
}

export class CodexSubscriptionUnavailableError extends Error {
  constructor(message = 'Codex CLI is unavailable') {
    super(message);
    this.name = 'CodexSubscriptionUnavailableError';
  }
}

interface PendingAttempt {
  readonly principalId: string;
  readonly orgId: string;
  readonly attemptId: string;
  readonly profileId: string;
  readonly profilePath: string;
  loginId: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAtMs: number;
  connection: CodexAppServerConnection | null;
  timer: ReturnType<typeof setTimeout>;
  unsubscribe: () => void;
  state: 'connecting' | 'completing' | 'expiring' | 'error';
  reason: AccountSubscriptionReason | null;
}

interface StartingAttempt {
  readonly principalId: string;
  readonly orgId: string;
  readonly attemptId: string;
  readonly profileId: string;
  readonly profilePath: string;
  readonly controller: AbortController;
  promise: Promise<CodexSubscriptionAttempt> | null;
}

export interface CodexProfileForRun {
  readonly profileId: string;
  readonly homePath: string;
  readonly profilesRoot: string;
}

export interface AccountSubscriptionServiceOptions {
  readonly auth: AuthStore;
  readonly profilesRoot?: string;
  readonly sourceEnv?: NodeJS.ProcessEnv;
  readonly spawnFn?: CodexAppServerSpawn;
  readonly requestTimeoutMs?: number;
  readonly loginTtlMs?: number;
  readonly now?: () => number;
  readonly onConnected?: (event: { principalId: string; orgId: string }) => void;
  readonly onDisconnected?: (event: { principalId: string; orgId: string }) => void;
}

export interface AccountSubscriptionStatusOptions {
  /** Set false while a run owns CODEX_HOME; returns local state without spawning Codex. */
  readonly verify?: boolean;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function ensurePrivateRoot(directory: string): string {
  if (path.parse(directory).root === directory) {
    throw new Error('account profiles root must not be a filesystem root');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('account profile path is not a private directory');
  }
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
  return realpathSync(directory);
}

function ensurePrivateSubdirectory(root: string, segments: readonly string[]): string {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('account profile path is not a private directory');
    }
    if (process.platform !== 'win32') chmodSync(current, 0o700);
  }
  return current;
}

function privateDirectory(directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (process.platform === 'win32' || (stat.mode & 0o777) === 0o700)
    );
  } catch {
    return false;
  }
}

function privateCredentialFile(filename: string): boolean {
  try {
    const stat = lstatSync(filename);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      (process.platform === 'win32' || (stat.mode & 0o777) === 0o600)
    );
  } catch {
    return false;
  }
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function safeVerificationUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Codex returned no verification URL');
  const url = new URL(value);
  if (
    url.origin !== 'https://auth.openai.com' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/codex/device'
  ) {
    throw new Error('Codex returned an unexpected verification origin');
  }
  return url.href;
}

function loginResult(value: unknown): {
  loginId: string;
  verificationUrl: string;
  userCode: string;
} {
  if (!value || typeof value !== 'object') throw new Error('Codex returned an invalid login result');
  const result = value as Record<string, unknown>;
  const loginId = accountSubscriptionProfileIdSchema.safeParse(result['loginId']);
  const userCode = codexDeviceUserCodeSchema.safeParse(result['userCode']);
  if (
    result['type'] !== 'chatgptDeviceCode' ||
    !loginId.success ||
    !userCode.success
  ) {
    throw new Error('Codex returned an invalid device-code login result');
  }
  return {
    loginId: loginId.data,
    verificationUrl: safeVerificationUrl(result['verificationUrl']),
    userCode: userCode.data,
  };
}

function accountIsChatGpt(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const account = (value as { account?: unknown }).account;
  return Boolean(account && typeof account === 'object' && (account as { type?: unknown }).type === 'chatgpt');
}

function completion(value: unknown): { success: boolean; loginId: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const params = value as { success?: unknown; loginId?: unknown };
  if (typeof params.success !== 'boolean') return null;
  return {
    success: params.success,
    loginId: typeof params.loginId === 'string' ? params.loginId : null,
  };
}

/**
 * Owns principal-scoped Codex login attempts and profile generations.
 * Pending device codes are memory-only; a restart merely asks the user to
 * start again. The consolidated auth store holds the current non-secret
 * generation receipt, while Codex alone reads/writes credential bytes.
 */
export class AccountSubscriptionService {
  private readonly auth: AuthStore;
  private readonly root: string;
  private readonly sourceEnv: NodeJS.ProcessEnv;
  private readonly spawnFn: CodexAppServerSpawn | undefined;
  private readonly requestTimeoutMs: number | undefined;
  private readonly loginTtlMs: number;
  private readonly now: () => number;
  private readonly onConnected: AccountSubscriptionServiceOptions['onConnected'];
  private readonly onDisconnected: AccountSubscriptionServiceOptions['onDisconnected'];
  private readonly profilesSupported: boolean;
  private readonly lifecycle = new AbortController();
  private readonly attempts = new Map<string, PendingAttempt>();
  private readonly starting = new Map<string, StartingAttempt>();
  private readonly statusChecks = new Map<string, Promise<AccountSubscriptionStatus>>();
  private closed = false;

  constructor(options: AccountSubscriptionServiceOptions) {
    this.auth = options.auth;
    const sourceEnv = options.sourceEnv ?? process.env;
    const requestedRoot = path.resolve(
      options.profilesRoot?.trim() ||
        sourceEnv[ACCOUNT_PROFILES_ROOT_ENV]?.trim() ||
        path.join(homedir(), '.atoma', 'account-profiles')
    );
    // Node's POSIX mode bits do not prove a private Windows ACL. Personal
    // credential profiles remain unavailable there until ACL validation is
    // implemented; accepting chmod's emulation would be fail-open.
    this.profilesSupported = process.platform !== 'win32';
    this.root = this.profilesSupported ? ensurePrivateRoot(requestedRoot) : requestedRoot;
    this.sourceEnv = { ...sourceEnv };
    this.spawnFn = options.spawnFn;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.loginTtlMs =
      options.loginTtlMs !== undefined &&
      Number.isFinite(options.loginTtlMs) &&
      options.loginTtlMs > 0
        ? Math.min(Math.trunc(options.loginTtlMs), MAX_CODEX_LOGIN_TTL_MS)
        : DEFAULT_CODEX_LOGIN_TTL_MS;
    this.now = options.now ?? Date.now;
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    if (this.profilesSupported) this.reconcileProfiles();
  }

  async status(
    principalIdInput: string,
    options: AccountSubscriptionStatusOptions = {}
  ): Promise<AccountSubscriptionsResponse> {
    const principalId = principalIdSchema.parse(principalIdInput);
    const attempt = this.attempts.get(principalId);
    const codex = await this.codexStatus(principalId, options.verify !== false);
    return accountSubscriptionsResponseSchema.parse({
      claude: {
        provider: 'claude',
        state: 'unavailable',
        connectedAt: null,
        lastVerifiedAt: null,
        reason: 'provider-approval-required',
      },
      codex,
      codexAttempt: attempt ? this.publicAttempt(attempt) : null,
    });
  }

  async startCodexLogin(principalIdInput: string, orgId: string): Promise<CodexSubscriptionAttempt> {
    if (this.closed) throw new CodexSubscriptionUnavailableError('subscription service is closed');
    if (!this.profilesSupported) {
      throw new CodexSubscriptionUnavailableError(
        'personal Codex profiles require verified POSIX permissions'
      );
    }
    const principalId = principalIdSchema.parse(principalIdInput);
    const parsedOrgId = organisationIdSchema.parse(orgId);
    const receipt = this.auth.principalSubscription(principalId, 'codex');
    if (receipt?.state === 'connected' && this.profileUsable(principalId, receipt)) {
      throw new CodexSubscriptionConflictError('the Codex subscription is already connected');
    }
    const starting = this.starting.get(principalId);
    if (starting?.promise) return starting.promise;
    const existing = this.attempts.get(principalId);
    if (existing && existing.state !== 'error') return this.publicAttempt(existing);
    if (existing) {
      this.attempts.delete(principalId);
      this.disposeAttempt(existing, true);
    }
    if (this.attempts.size + this.starting.size >= MAX_PENDING_CODEX_LOGINS) {
      throw new CodexSubscriptionCapacityError();
    }

    const profileId = randomUUID();
    const profilePath = this.profilePath(principalId, profileId);
    ensurePrivateSubdirectory(this.root, [principalId, 'codex', profileId]);
    const operation: StartingAttempt = {
      principalId,
      orgId: parsedOrgId,
      attemptId: randomUUID(),
      profileId,
      profilePath,
      controller: new AbortController(),
      promise: null,
    };
    this.starting.set(principalId, operation);
    const promise = this.beginCodexLogin(operation);
    operation.promise = promise;
    return promise;
  }

  private async beginCodexLogin(operation: StartingAttempt): Promise<CodexSubscriptionAttempt> {
    let connection: CodexAppServerConnection | null = null;
    try {
      connection = await this.open(operation.profilePath, operation.controller.signal);
      if (
        operation.controller.signal.aborted ||
        this.closed ||
        this.starting.get(operation.principalId)?.attemptId !== operation.attemptId
      ) {
        throw new CodexSubscriptionConflictError('the Codex login was cancelled');
      }
      let pending: PendingAttempt | null = null;
      let earlyCompletion: CodexAppServerNotification | null = null;
      const unsubscribe = connection.onNotification((notification) => {
        if (notification.method !== 'account/login/completed') return;
        if (pending) {
          void this.handleNotification(pending, notification);
        } else {
          earlyCompletion = notification;
        }
      });
      const started = loginResult(
        await connection.request('account/login/start', { type: 'chatgptDeviceCode' })
      );
      if (
        operation.controller.signal.aborted ||
        this.closed ||
        this.starting.get(operation.principalId)?.attemptId !== operation.attemptId
      ) {
        throw new CodexSubscriptionConflictError('the Codex login was cancelled');
      }
      const expiresAtMs = this.now() + this.loginTtlMs;
      const timer = setTimeout(() => {
        void this.expireAttempt(operation.principalId, operation.attemptId);
      }, this.loginTtlMs);
      timer.unref?.();
      pending = {
        principalId: operation.principalId,
        orgId: operation.orgId,
        attemptId: operation.attemptId,
        profileId: operation.profileId,
        profilePath: operation.profilePath,
        loginId: started.loginId,
        verificationUrl: started.verificationUrl,
        userCode: started.userCode,
        expiresAtMs,
        connection,
        timer,
        unsubscribe,
        state: 'connecting',
        reason: null,
      };
      this.attempts.set(operation.principalId, pending);
      if (earlyCompletion) void this.handleNotification(pending, earlyCompletion);
      return this.publicAttempt(pending);
    } catch (error) {
      if (connection) await connection.closeAndWait();
      await this.removeProfileWhenIdle(operation.principalId, operation.profileId);
      if (error instanceof CodexAppServerUnavailableError) {
        throw new CodexSubscriptionUnavailableError();
      }
      if (error instanceof CodexAppServerCapacityError) {
        throw new CodexSubscriptionCapacityError();
      }
      if (operation.controller.signal.aborted || this.closed) {
        throw new CodexSubscriptionConflictError('the Codex login was cancelled');
      }
      throw error;
    } finally {
      if (this.starting.get(operation.principalId)?.attemptId === operation.attemptId) {
        this.starting.delete(operation.principalId);
      }
    }
  }

  async cancelCodexLogin(principalIdInput: string): Promise<boolean> {
    const principalId = principalIdSchema.parse(principalIdInput);
    const starting = this.starting.get(principalId);
    if (starting) starting.controller.abort();
    const attempt = this.attempts.get(principalId);
    if (!attempt) return starting !== undefined;
    this.attempts.delete(principalId);
    clearTimeout(attempt.timer);
    attempt.unsubscribe();
    try {
      if (attempt.connection && attempt.loginId) {
        await attempt.connection.request('account/login/cancel', { loginId: attempt.loginId });
      }
    } catch {
      // Local cancellation still wins; the private staging profile is removed.
    } finally {
      const connection = attempt.connection;
      attempt.connection = null;
      if (connection) await connection.closeAndWait();
      await this.removeProfileWhenIdle(attempt.principalId, attempt.profileId);
    }
    return true;
  }

  async disconnectCodex(principalIdInput: string, orgId: string): Promise<boolean> {
    const principalId = principalIdSchema.parse(principalIdInput);
    const parsedOrgId = organisationIdSchema.parse(orgId);
    // Delete the receipt BEFORE awaiting the provider: new runs fail closed
    // from this point even if cancellation/app-server is slow or unavailable.
    const receipt = this.auth.deletePrincipalSubscription(principalId, 'codex');
    await this.cancelCodexLogin(principalId);
    if (!receipt) return false;
    const profilePath = this.profilePath(principalId, receipt.profileId);
    if (this.profileUsable(principalId, receipt)) {
      try {
        const connection = await this.open(profilePath);
        try {
          await connection.request('account/logout');
        } finally {
          await connection.closeAndWait();
        }
      } catch {
        // Disconnect is local authority. Removing the exact owned generation
        // is the fallback when an upgraded/missing CLI cannot perform logout.
      }
    }
    await this.removeProfileWhenIdle(principalId, receipt.profileId);
    try {
      this.onDisconnected?.({ principalId, orgId: parsedOrgId });
    } catch {
      // An observer cannot undo the local disconnect or leak its credential.
    }
    return true;
  }

  /** Synchronous launch-time resolver: no network and no fallback profile. */
  codexProfileForRun(principalIdInput: string): CodexProfileForRun | null {
    const principalId = principalIdSchema.parse(principalIdInput);
    if (!this.profilesSupported || this.statusChecks.has(principalId)) return null;
    const receipt = this.auth.principalSubscription(principalId, 'codex');
    if (!receipt || receipt.state !== 'connected' || !this.profileUsable(principalId, receipt)) {
      return null;
    }
    return {
      profileId: receipt.profileId,
      homePath: this.profilePath(principalId, receipt.profileId),
      profilesRoot: this.root,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifecycle.abort();
    for (const operation of this.starting.values()) operation.controller.abort();
    this.starting.clear();
    for (const attempt of this.attempts.values()) this.disposeAttempt(attempt, true);
    this.attempts.clear();
    this.statusChecks.clear();
  }

  private async codexStatus(
    principalId: string,
    verify: boolean
  ): Promise<AccountSubscriptionStatus> {
    if (!verify) return this.readCodexStatus(principalId, false);
    const existing = this.statusChecks.get(principalId);
    if (existing) return existing;
    const liveAttempts = [...this.attempts.values()].filter(
      (attempt) => attempt.connection !== null
    ).length;
    if (
      liveAttempts + this.starting.size + this.statusChecks.size >=
      MAX_PENDING_CODEX_LOGINS
    ) {
      // Status verification is advisory; never exceed the same app-server
      // process budget that protects device login on the 4 GiB deployment.
      return this.readCodexStatus(principalId, false);
    }
    const check = this.readCodexStatus(principalId, true);
    this.statusChecks.set(principalId, check);
    try {
      return await check;
    } finally {
      if (this.statusChecks.get(principalId) === check) this.statusChecks.delete(principalId);
    }
  }

  private async readCodexStatus(
    principalId: string,
    verify: boolean
  ): Promise<AccountSubscriptionStatus> {
    const receipt = this.auth.principalSubscription(principalId, 'codex');
    const attempt = this.attempts.get(principalId);
    if (!this.profilesSupported) {
      return receipt
        ? this.receiptStatus(receipt, 'unavailable', 'profile-permissions-unsupported')
        : {
            provider: 'codex',
            state: 'unavailable',
            connectedAt: null,
            lastVerifiedAt: null,
            reason: 'profile-permissions-unsupported',
          };
    }
    if (!receipt) {
      if (attempt) {
        return {
          provider: 'codex',
          state: attempt.state === 'error' ? 'error' : 'connecting',
          connectedAt: null,
          lastVerifiedAt: null,
          reason: attempt.reason,
        };
      }
      return {
        provider: 'codex',
        state: 'disconnected',
        connectedAt: null,
        lastVerifiedAt: null,
        reason: null,
      };
    }
    if (!this.profileUsable(principalId, receipt)) {
      const marked = this.auth.markPrincipalSubscriptionVerified(
        principalId,
        'codex',
        'reauth_required',
        receipt.profileId
      );
      return marked
        ? this.receiptStatus(marked, 'reauth_required', 'authentication-required')
        : this.disconnectedStatus();
    }
    if (!verify) return this.currentReceiptStatus(receipt);
    const lastVerifiedMs =
      receipt.lastVerifiedAt === null ? Number.NaN : Date.parse(receipt.lastVerifiedAt);
    const verificationAgeMs = this.now() - lastVerifiedMs;
    if (
      receipt.state === 'connected' &&
      Number.isFinite(verificationAgeMs) &&
      verificationAgeMs >= 0 &&
      verificationAgeMs < CODEX_STATUS_FRESH_MS
    ) {
      return this.receiptStatus(receipt, 'connected', null);
    }
    try {
      const connection = await this.open(this.profilePath(principalId, receipt.profileId));
      let account: unknown;
      try {
        // Status is observational. Browser polling must not rotate provider
        // credentials; actual Codex use remains responsible for any refresh.
        account = await connection.request('account/read', { refreshToken: false });
      } finally {
        await connection.closeAndWait();
      }
      const current = this.auth.principalSubscription(principalId, 'codex');
      if (!current || current.profileId !== receipt.profileId) {
        return this.currentReceiptStatus(current);
      }
      if (!accountIsChatGpt(account)) {
        const marked = this.auth.markPrincipalSubscriptionVerified(
          principalId,
          'codex',
          'reauth_required',
          receipt.profileId
        );
        return marked
          ? this.receiptStatus(marked, 'reauth_required', 'authentication-required')
          : this.disconnectedStatus();
      }
      const marked = this.auth.markPrincipalSubscriptionVerified(
        principalId,
        'codex',
        'connected',
        receipt.profileId
      );
      return marked
        ? this.receiptStatus(marked, 'connected', null)
        : this.disconnectedStatus();
    } catch (error) {
      const current = this.auth.principalSubscription(principalId, 'codex');
      if (!current || current.profileId !== receipt.profileId) {
        return this.currentReceiptStatus(current);
      }
      if (error instanceof CodexAppServerUnavailableError) {
        return this.receiptStatus(receipt, 'unavailable', 'codex-cli-unavailable');
      }
      if (error instanceof CodexAppServerCapacityError) {
        return this.currentReceiptStatus(receipt);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT|not found|cannot find/i.test(message)) {
        return this.receiptStatus(receipt, 'unavailable', 'codex-cli-unavailable');
      }
      return this.receiptStatus(receipt, 'error', 'login-failed');
    }
  }

  private receiptStatus(
    receipt: PrincipalSubscriptionReceipt,
    state: AccountSubscriptionStatus['state'],
    reason: AccountSubscriptionReason | null
  ): AccountSubscriptionStatus {
    return {
      provider: 'codex',
      state,
      connectedAt: receipt.connectedAt,
      lastVerifiedAt: receipt.lastVerifiedAt,
      reason,
    };
  }

  private disconnectedStatus(): AccountSubscriptionStatus {
    return {
      provider: 'codex',
      state: 'disconnected',
      connectedAt: null,
      lastVerifiedAt: null,
      reason: null,
    };
  }

  private currentReceiptStatus(
    receipt: PrincipalSubscriptionReceipt | null
  ): AccountSubscriptionStatus {
    if (!receipt) return this.disconnectedStatus();
    return receipt.state === 'connected'
      ? this.receiptStatus(receipt, 'connected', null)
      : this.receiptStatus(receipt, 'reauth_required', 'authentication-required');
  }

  private async handleNotification(
    attempt: PendingAttempt,
    notification: CodexAppServerNotification
  ): Promise<void> {
    if (notification.method !== 'account/login/completed') return;
    const result = completion(notification.params);
    if (!result || result.loginId !== attempt.loginId) return;
    if (this.attempts.get(attempt.principalId)?.attemptId !== attempt.attemptId) return;
    if (attempt.state !== 'connecting') return;
    if (!result.success) {
      this.failAttempt(attempt, 'login-failed');
      return;
    }
    attempt.state = 'completing';
    try {
      if (!attempt.connection) throw new Error('Codex login connection was closed');
      const account = await attempt.connection.request('account/read', { refreshToken: false });
      if (
        this.attempts.get(attempt.principalId)?.attemptId !== attempt.attemptId ||
        attempt.state !== 'completing'
      ) {
        return;
      }
      if (!accountIsChatGpt(account) || !this.secureCredentialFile(attempt)) {
        this.failAttempt(attempt, 'authentication-required');
        return;
      }
      const previous = this.auth.principalSubscription(attempt.principalId, 'codex');
      const connection = attempt.connection;
      if (!connection) throw new Error('Codex login connection was closed');
      attempt.connection = null;
      await connection.closeAndWait();
      if (
        this.attempts.get(attempt.principalId)?.attemptId !== attempt.attemptId ||
        attempt.state !== 'completing'
      ) {
        return;
      }
      this.auth.setPrincipalSubscription({
        principalId: attempt.principalId,
        provider: 'codex',
        profileId: attempt.profileId,
      });
      this.attempts.delete(attempt.principalId);
      clearTimeout(attempt.timer);
      attempt.unsubscribe();
      if (previous && previous.profileId !== attempt.profileId) {
        await this.removeProfileWhenIdle(attempt.principalId, previous.profileId);
      }
      try {
        this.onConnected?.({ principalId: attempt.principalId, orgId: attempt.orgId });
      } catch {
        // An observer cannot roll back a completed provider-owned login.
      }
    } catch {
      if (this.attempts.get(attempt.principalId)?.attemptId === attempt.attemptId) {
        this.failAttempt(attempt, 'login-failed');
      }
    }
  }

  private failAttempt(attempt: PendingAttempt, reason: AccountSubscriptionReason): void {
    clearTimeout(attempt.timer);
    attempt.unsubscribe();
    const connection = attempt.connection;
    attempt.connection = null;
    this.scheduleProfileRemoval(attempt.principalId, attempt.profileId, connection);
    // A failed device code must not linger in memory for the life of the
    // service. Keep only a short, non-sensitive status receipt for the UI.
    attempt.loginId = null;
    attempt.verificationUrl = null;
    attempt.userCode = null;
    attempt.state = 'error';
    attempt.reason = reason;
    attempt.expiresAtMs = this.now() + FAILED_ATTEMPT_TTL_MS;
    attempt.timer = setTimeout(() => {
      if (this.attempts.get(attempt.principalId)?.attemptId === attempt.attemptId) {
        this.attempts.delete(attempt.principalId);
      }
    }, FAILED_ATTEMPT_TTL_MS);
    attempt.timer.unref?.();
  }

  private async expireAttempt(principalId: string, attemptId: string): Promise<void> {
    const attempt = this.attempts.get(principalId);
    if (!attempt || attempt.attemptId !== attemptId || attempt.state !== 'connecting') return;
    // Claim expiry synchronously, before the provider cancellation yields.
    // A completion that already reached `completing` wins; one arriving after
    // this point observes `expiring` and cannot commit a receipt that expiry
    // would subsequently delete.
    attempt.state = 'expiring';
    try {
      if (attempt.connection && attempt.loginId) {
        await attempt.connection.request('account/login/cancel', { loginId: attempt.loginId });
      }
    } catch {
      // Expiry is authoritative locally.
    }
    if (
      this.attempts.get(principalId)?.attemptId !== attemptId ||
      attempt.state !== 'expiring'
    ) {
      return;
    }
    this.failAttempt(attempt, 'login-expired');
  }

  private publicAttempt(attempt: PendingAttempt): CodexSubscriptionAttempt {
    const connecting = attempt.state !== 'error';
    return codexSubscriptionAttemptSchema.parse({
      attemptId: attempt.attemptId,
      state: connecting ? 'connecting' : 'error',
      verificationUrl: connecting ? attempt.verificationUrl : null,
      userCode: connecting ? attempt.userCode : null,
      expiresAt: iso(attempt.expiresAtMs),
      reason: attempt.reason,
    });
  }

  private profilePath(principalIdInput: string, profileIdInput: string): string {
    const principalId = principalIdSchema.parse(principalIdInput);
    const profileId = accountSubscriptionProfileIdSchema.parse(profileIdInput);
    const candidate = path.resolve(this.root, principalId, 'codex', profileId);
    const prefix = `${this.root}${path.sep}`;
    if (!candidate.startsWith(prefix)) throw new Error('account profile escaped its root');
    return candidate;
  }

  private profileUsable(principalId: string, receipt: PrincipalSubscriptionReceipt): boolean {
    if (receipt.principalId !== principalId || receipt.provider !== 'codex') return false;
    const profilePath = this.profilePath(principalId, receipt.profileId);
    return (
      this.profileDirectoriesUsable(principalId, receipt.profileId) &&
      privateCredentialFile(path.join(profilePath, 'auth.json'))
    );
  }

  private removeProfile(principalId: string, profileId: string): void {
    if (!this.profilesSupported) return;
    const target = this.profilePath(principalId, profileId);
    const principalPath = path.join(this.root, principalId);
    const providerPath = path.join(principalPath, 'codex');
    try {
      // Never traverse a replaced parent link during cleanup. Leaving an
      // unreachable staging generation is safer than deleting outside root.
      if (!privateDirectory(this.root)) return;
      if (!privateDirectory(principalPath) || !privateDirectory(providerPath)) return;
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        unlinkSync(target);
        return;
      }
      // Exact UUID-derived path, with every parent checked; never a glob.
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Cleanup remains fail-closed and never follows an unsafe substitute.
    }
  }

  private async removeProfileWhenIdle(principalId: string, profileId: string): Promise<void> {
    if (!this.profilesSupported) return;
    const profilePath = this.profilePath(principalId, profileId);
    const release = await acquireCodexHomeLease(profilePath);
    try {
      this.removeProfile(principalId, profileId);
    } finally {
      release();
    }
  }

  private scheduleProfileRemoval(
    principalId: string,
    profileId: string,
    connection: CodexAppServerConnection | null
  ): void {
    void (async () => {
      if (connection) await connection.closeAndWait();
      await this.removeProfileWhenIdle(principalId, profileId);
    })().catch(() => {
      // Failing closed leaves an unreferenced UUID for startup reconciliation.
    });
  }

  private disposeAttempt(attempt: PendingAttempt, removeProfile: boolean): void {
    clearTimeout(attempt.timer);
    attempt.unsubscribe();
    const connection = attempt.connection;
    attempt.connection = null;
    if (removeProfile) {
      this.scheduleProfileRemoval(attempt.principalId, attempt.profileId, connection);
    } else {
      connection?.close();
    }
  }

  private secureCredentialFile(attempt: PendingAttempt): boolean {
    const authPath = path.join(attempt.profilePath, 'auth.json');
    let descriptor: number | null = null;
    try {
      if (!this.profileDirectoriesUsable(attempt.principalId, attempt.profileId)) return false;
      descriptor = openSync(
        authPath,
        constants.O_RDONLY |
          constants.O_NONBLOCK |
          (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
      );
      const before = fstatSync(descriptor);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return false;
      if (process.platform !== 'win32') fchmodSync(descriptor, 0o600);
      const after = fstatSync(descriptor);
      return (
        after.isFile() &&
        after.nlink === 1 &&
        (process.platform === 'win32' || (after.mode & 0o777) === 0o600)
      );
    } catch {
      return false;
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }

  private profileDirectoriesUsable(principalId: string, profileId: string): boolean {
    if (!this.profilesSupported) return false;
    const principalPath = path.join(this.root, principalId);
    const providerPath = path.join(principalPath, 'codex');
    const profilePath = this.profilePath(principalId, profileId);
    try {
      return (
        privateDirectory(this.root) &&
        privateDirectory(principalPath) &&
        privateDirectory(providerPath) &&
        privateDirectory(profilePath) &&
        pathInside(realpathSync(this.root), realpathSync(profilePath))
      );
    } catch {
      return false;
    }
  }

  /**
   * A crash can leave a UUID generation before its receipt is committed.
   * Reconciliation is deliberately narrow: unknown names and every referenced
   * generation survive, and unsafe parent links stop traversal altogether.
   */
  private reconcileProfiles(): void {
    const referenced = new Map<string, Set<string>>();
    try {
      for (const principal of this.auth.listPrincipals()) {
        const receipt = this.auth.principalSubscription(principal.principalId, 'codex');
        if (!receipt) continue;
        const profiles = referenced.get(principal.principalId) ?? new Set<string>();
        profiles.add(receipt.profileId);
        referenced.set(principal.principalId, profiles);
      }
    } catch {
      // If the store cannot prove the complete reference set, preserve every
      // credential generation. Partial knowledge must never authorize deletion.
      return;
    }

    let principalEntries: Dirent[];
    try {
      if (!privateDirectory(this.root)) return;
      principalEntries = readdirSync(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const principalEntry of principalEntries) {
      const principal = principalIdSchema.safeParse(principalEntry.name);
      if (!principal.success || !principalEntry.isDirectory() || principalEntry.isSymbolicLink()) {
        continue;
      }
      const principalPath = path.join(this.root, principal.data);
      const providerPath = path.join(principalPath, 'codex');
      if (!privateDirectory(principalPath) || !privateDirectory(providerPath)) continue;
      let generations: Dirent[];
      try {
        generations = readdirSync(providerPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const generation of generations) {
        const profileId = accountSubscriptionProfileIdSchema.safeParse(generation.name);
        if (!profileId.success) continue;
        if (referenced.get(principal.data)?.has(profileId.data)) continue;
        if (generation.isSymbolicLink() || !generation.isDirectory()) {
          // No legitimate provider child can own a non-directory generation.
          // Remove the exact entry without asking the lease path resolver to
          // follow it or letting an unsafe orphan prevent server startup.
          this.removeProfile(principal.data, profileId.data);
          continue;
        }
        const release = tryAcquireCodexHomeLease(
          this.profilePath(principal.data, profileId.data)
        );
        if (!release) continue;
        try {
          this.removeProfile(principal.data, profileId.data);
        } finally {
          release();
        }
      }
    }
  }

  private open(profilePath: string, signal?: AbortSignal): Promise<CodexAppServerConnection> {
    return CodexAppServerConnection.open({
      profilePath,
      profilesRoot: this.root,
      sourceEnv: this.sourceEnv,
      ...(this.spawnFn ? { spawnFn: this.spawnFn } : {}),
      ...(this.requestTimeoutMs ? { requestTimeoutMs: this.requestTimeoutMs } : {}),
      signal: signal ?? this.lifecycle.signal,
    });
  }
}
