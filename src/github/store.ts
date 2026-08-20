import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { openStoreHandle, storeDbPath } from '../core/stores.js';
import { canonicalGitHubId } from './config.js';
import {
  parseEncryptedGitHubToken,
  serializeEncryptedGitHubToken,
  type EncryptedGitHubToken,
} from './crypto.js';

export const MAX_ACTIVE_GITHUB_CONNECT_STATES = 500;
export const GITHUB_CONNECT_STATE_TTL_MAX_MS = 30 * 60 * 1_000;

export const GITHUB_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS github_connect_states (
  state_hash   TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES auth_principals(principal_id),
  org_id       TEXT NOT NULL REFERENCES auth_organisations(org_id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS github_connect_states_expires_idx
  ON github_connect_states(expires_at);

CREATE TABLE IF NOT EXISTS github_user_authorizations (
  principal_id       TEXT PRIMARY KEY REFERENCES auth_principals(principal_id),
  github_subject     TEXT NOT NULL,
  access_envelope    TEXT NOT NULL,
  access_expires_at  TEXT NOT NULL,
  refresh_envelope   TEXT,
  refresh_expires_at TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK ((refresh_envelope IS NULL) = (refresh_expires_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS github_user_authorizations_subject_idx
  ON github_user_authorizations(github_subject);

CREATE TABLE IF NOT EXISTS github_installations (
  installation_id           TEXT PRIMARY KEY,
  org_id                    TEXT NOT NULL REFERENCES auth_organisations(org_id),
  account_id                TEXT NOT NULL,
  account_login             TEXT NOT NULL,
  target_type               TEXT NOT NULL CHECK (target_type IN ('User','Organization')),
  status                    TEXT NOT NULL CHECK (status IN ('active','suspended','deleted')),
  repository_selection      TEXT NOT NULL CHECK (repository_selection IN ('all','selected')),
  permissions_json          TEXT NOT NULL,
  connected_by_principal_id TEXT NOT NULL REFERENCES auth_principals(principal_id),
  connected_at              TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS github_installations_org_idx
  ON github_installations(org_id, status);

CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id    TEXT PRIMARY KEY,
  event          TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  received_at    TEXT NOT NULL,
  processed_at   TEXT NOT NULL
);
`;

export type GitHubInstallationStatus = 'active' | 'suspended' | 'deleted';
export type GitHubInstallationTargetType = 'User' | 'Organization';
export type GitHubRepositorySelection = 'all' | 'selected';
export type GitHubPermissionLevel = 'read' | 'write';

export interface GitHubConnectStateRecord {
  readonly principalId: string;
  readonly orgId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface GitHubUserAuthorization {
  readonly principalId: string;
  readonly githubSubject: string;
  readonly accessToken: EncryptedGitHubToken;
  readonly accessExpiresAt: string;
  readonly refreshToken: EncryptedGitHubToken | null;
  readonly refreshExpiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GitHubInstallation {
  readonly installationId: string;
  readonly orgId: string;
  readonly accountId: string;
  readonly accountLogin: string;
  readonly targetType: GitHubInstallationTargetType;
  readonly status: GitHubInstallationStatus;
  readonly repositorySelection: GitHubRepositorySelection;
  readonly permissions: Readonly<Record<string, GitHubPermissionLevel>>;
  readonly connectedByPrincipalId: string;
  readonly connectedAt: string;
  readonly updatedAt: string;
}

export interface LinkGitHubInstallationInput {
  readonly installationId: string;
  readonly orgId: string;
  readonly accountId: string;
  readonly accountLogin: string;
  readonly targetType: GitHubInstallationTargetType;
  readonly repositorySelection: GitHubRepositorySelection;
  readonly permissions: Readonly<Record<string, GitHubPermissionLevel>>;
  readonly connectedByPrincipalId: string;
  readonly now?: Date | number;
}

export type GitHubWebhookMutation =
  | { readonly kind: 'transition'; readonly installationId: string; readonly status: GitHubInstallationStatus }
  | { readonly kind: 'touch'; readonly installationId: string };

export interface GitHubWebhookDeliveryResult {
  readonly duplicate: boolean;
  readonly applied: boolean;
}

interface ConnectStateRow {
  state_hash: string;
  principal_id: string;
  org_id: string;
  created_at: string;
  expires_at: string;
}

interface UserAuthorizationRow {
  principal_id: string;
  github_subject: string;
  access_envelope: string;
  access_expires_at: string;
  refresh_envelope: string | null;
  refresh_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface InstallationRow {
  installation_id: string;
  org_id: string;
  account_id: string;
  account_login: string;
  target_type: GitHubInstallationTargetType;
  status: GitHubInstallationStatus;
  repository_selection: GitHubRepositorySelection;
  permissions_json: string;
  connected_by_principal_id: string;
  connected_at: string;
  updated_at: string;
}

interface DeliveryRow {
  delivery_id: string;
  event: string;
  payload_sha256: string;
}

export class TooManyPendingGitHubConnectStatesError extends Error {
  constructor(limit = MAX_ACTIVE_GITHUB_CONNECT_STATES) {
    super(`Too many pending GitHub connect states (limit ${limit})`);
    this.name = 'TooManyPendingGitHubConnectStatesError';
  }
}

export class GitHubInstallationCrossOrgError extends Error {
  readonly installationId: string;

  constructor(installationId: string) {
    super('GitHub installation is already linked to another organisation');
    this.name = 'GitHubInstallationCrossOrgError';
    this.installationId = installationId;
  }
}

export class GitHubWebhookDeliveryCollisionError extends Error {
  readonly deliveryId: string;

  constructor(deliveryId: string) {
    super('GitHub webhook delivery id was reused with different content');
    this.name = 'GitHubWebhookDeliveryCollisionError';
    this.deliveryId = deliveryId;
  }
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedIdentifier(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(`${label} must be a canonical UUID`);
  }
  return value;
}

function timestamp(value: Date | number | undefined, label = 'timestamp'): string {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  return date.toISOString();
}

function storedTimestamp(value: string, label: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`stored ${label} is invalid`);
  }
  return value;
}

export function isGitHubConnectState(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

function connectState(value: string): string {
  if (!isGitHubConnectState(value)) {
    throw new Error('GitHub connect state has an invalid format');
  }
  return value;
}

function accountLogin(value: string): string {
  const hasControl = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (!value || value.length > 100 || hasControl) {
    throw new Error('GitHub account login has an invalid value');
  }
  return value;
}

function normalizePermissions(
  permissions: Readonly<Record<string, GitHubPermissionLevel>>
): Readonly<Record<string, GitHubPermissionLevel>> {
  const entries = Object.entries(permissions);
  if (entries.length > 100) throw new Error('GitHub installation has too many permissions');
  const normalized: Record<string, GitHubPermissionLevel> = {};
  for (const [name, level] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-z][a-z0-9_]{0,99}$/.test(name) || (level !== 'read' && level !== 'write')) {
      throw new Error('GitHub installation permissions have an invalid value');
    }
    normalized[name] = level;
  }
  return Object.freeze(normalized);
}

function parsePermissions(value: string): Readonly<Record<string, GitHubPermissionLevel>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('stored GitHub installation permissions are invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('stored GitHub installation permissions are invalid');
  }
  return normalizePermissions(parsed as Record<string, GitHubPermissionLevel>);
}

function mapAuthorization(row: UserAuthorizationRow): GitHubUserAuthorization {
  const accessToken = parseEncryptedGitHubToken(row.access_envelope);
  if (accessToken.kind !== 'access') throw new Error('stored GitHub access token has the wrong kind');
  const refreshToken = row.refresh_envelope === null
    ? null
    : parseEncryptedGitHubToken(row.refresh_envelope);
  if (refreshToken !== null && refreshToken.kind !== 'refresh') {
    throw new Error('stored GitHub refresh token has the wrong kind');
  }
  if ((refreshToken === null) !== (row.refresh_expires_at === null)) {
    throw new Error('stored GitHub refresh token is incomplete');
  }
  return Object.freeze({
    principalId: boundedIdentifier(row.principal_id, 'principal id'),
    githubSubject: canonicalGitHubId(row.github_subject, 'GitHub subject'),
    accessToken,
    accessExpiresAt: storedTimestamp(row.access_expires_at, 'GitHub access expiry'),
    refreshToken,
    refreshExpiresAt: row.refresh_expires_at === null
      ? null
      : storedTimestamp(row.refresh_expires_at, 'GitHub refresh expiry'),
    createdAt: storedTimestamp(row.created_at, 'GitHub authorization creation'),
    updatedAt: storedTimestamp(row.updated_at, 'GitHub authorization update'),
  });
}

function mapInstallation(row: InstallationRow): GitHubInstallation {
  return Object.freeze({
    installationId: canonicalGitHubId(row.installation_id, 'GitHub installation id'),
    orgId: boundedIdentifier(row.org_id, 'organisation id'),
    accountId: canonicalGitHubId(row.account_id, 'GitHub account id'),
    accountLogin: accountLogin(row.account_login),
    targetType: row.target_type,
    status: row.status,
    repositorySelection: row.repository_selection,
    permissions: parsePermissions(row.permissions_json),
    connectedByPrincipalId: boundedIdentifier(row.connected_by_principal_id, 'principal id'),
    connectedAt: storedTimestamp(row.connected_at, 'GitHub installation connection'),
    updatedAt: storedTimestamp(row.updated_at, 'GitHub installation update'),
  });
}

export function newGitHubConnectState(random: (size: number) => Buffer = randomBytes): string {
  const bytes = random(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    throw new Error('GitHub connect state source must return exactly 32 bytes');
  }
  return bytes.toString('base64url');
}

export class GitHubStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.pragma('foreign_keys = ON');
    this.db.exec(GITHUB_TABLES_DDL);
  }

  static open(path?: string): GitHubStore {
    return new GitHubStore(openStoreHandle(path ?? storeDbPath(), GITHUB_TABLES_DDL));
  }

  createConnectState(input: {
    readonly state: string;
    readonly principalId: string;
    readonly orgId: string;
    readonly ttlMs: number;
    readonly now?: Date | number;
  }): GitHubConnectStateRecord {
    const state = connectState(input.state);
    const principalId = boundedIdentifier(input.principalId, 'principal id');
    const orgId = boundedIdentifier(input.orgId, 'organisation id');
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > GITHUB_CONNECT_STATE_TTL_MAX_MS) {
      throw new Error(`GitHub connect state ttl must be between 1 and ${GITHUB_CONNECT_STATE_TTL_MAX_MS} milliseconds`);
    }
    const nowMs = input.now instanceof Date ? input.now.getTime() : input.now ?? Date.now();
    const createdAt = timestamp(nowMs);
    const expiresAt = timestamp(nowMs + input.ttlMs, 'GitHub connect state expiry');
    const create = this.db.transaction(() => {
      const membership = this.db.prepare(
        'SELECT 1 FROM auth_memberships WHERE org_id = ? AND principal_id = ?'
      ).get(orgId, principalId);
      if (!membership) throw new Error('GitHub connector is not a member of the organisation');
      this.db.prepare('DELETE FROM github_connect_states WHERE expires_at <= ?').run(createdAt);
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM github_connect_states').get() as { count: number };
      if (count.count >= MAX_ACTIVE_GITHUB_CONNECT_STATES) {
        throw new TooManyPendingGitHubConnectStatesError();
      }
      this.db.prepare(
        `INSERT INTO github_connect_states
           (state_hash, principal_id, org_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(sha256Hex(state), principalId, orgId, createdAt, expiresAt);
    });
    create.immediate();
    return Object.freeze({ principalId, orgId, createdAt, expiresAt });
  }

  /** Consume even on principal/org mismatch so a leaked state cannot be probed repeatedly. */
  consumeConnectState(input: {
    readonly state: string;
    readonly principalId: string;
    readonly orgId: string;
    readonly now?: Date | number;
  }): GitHubConnectStateRecord | null {
    const stateHash = sha256Hex(connectState(input.state));
    const principalId = boundedIdentifier(input.principalId, 'principal id');
    const orgId = boundedIdentifier(input.orgId, 'organisation id');
    const now = timestamp(input.now);
    const consume = this.db.transaction((): GitHubConnectStateRecord | null => {
      const row = this.db.prepare('SELECT * FROM github_connect_states WHERE state_hash = ?')
        .get(stateHash) as ConnectStateRow | undefined;
      if (!row) return null;
      this.db.prepare('DELETE FROM github_connect_states WHERE state_hash = ?').run(stateHash);
      if (row.principal_id !== principalId || row.org_id !== orgId || row.expires_at <= now) return null;
      return Object.freeze({
        principalId: boundedIdentifier(row.principal_id, 'principal id'),
        orgId: boundedIdentifier(row.org_id, 'organisation id'),
        createdAt: storedTimestamp(row.created_at, 'GitHub connect state creation'),
        expiresAt: storedTimestamp(row.expires_at, 'GitHub connect state expiry'),
      });
    });
    return consume.immediate();
  }

  /** Existence + expiry only — used to route a callback without consuming it. */
  hasPendingConnectState(state: string, now?: Date | number): boolean {
    const row = this.db.prepare(
      'SELECT expires_at FROM github_connect_states WHERE state_hash = ?'
    ).get(sha256Hex(connectState(state))) as { expires_at: string } | undefined;
    return !!row && row.expires_at > timestamp(now);
  }

  saveUserAuthorization(input: {
    readonly principalId: string;
    readonly githubSubject: string;
    readonly accessToken: EncryptedGitHubToken;
    readonly accessExpiresAt: Date | number;
    readonly refreshToken?: EncryptedGitHubToken | null;
    readonly refreshExpiresAt?: Date | number | null;
    readonly now?: Date | number;
  }): GitHubUserAuthorization {
    const principalId = boundedIdentifier(input.principalId, 'principal id');
    const githubSubject = canonicalGitHubId(input.githubSubject, 'GitHub subject');
    const accessToken = parseEncryptedGitHubToken(input.accessToken);
    if (accessToken.kind !== 'access') throw new Error('GitHub access token envelope has the wrong kind');
    const refreshToken = input.refreshToken ?? null;
    const refreshExpiresInput = input.refreshExpiresAt ?? null;
    if ((refreshToken === null) !== (refreshExpiresInput === null)) {
      throw new Error('GitHub refresh token and expiry must be supplied together');
    }
    const parsedRefresh = refreshToken === null ? null : parseEncryptedGitHubToken(refreshToken);
    if (parsedRefresh !== null && parsedRefresh.kind !== 'refresh') {
      throw new Error('GitHub refresh token envelope has the wrong kind');
    }
    const now = timestamp(input.now);
    const accessExpiresAt = timestamp(input.accessExpiresAt, 'GitHub access expiry');
    if (accessExpiresAt <= now) throw new Error('GitHub access token is already expired');
    const refreshExpiresAt = refreshExpiresInput === null
      ? null
      : timestamp(refreshExpiresInput, 'GitHub refresh expiry');
    if (refreshExpiresAt !== null && refreshExpiresAt <= now) {
      throw new Error('GitHub refresh token is already expired');
    }
    const accessEnvelope = serializeEncryptedGitHubToken(accessToken);
    const refreshEnvelope = parsedRefresh === null ? null : serializeEncryptedGitHubToken(parsedRefresh);
    this.db.prepare(
      `INSERT INTO github_user_authorizations
         (principal_id, github_subject, access_envelope, access_expires_at,
          refresh_envelope, refresh_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(principal_id) DO UPDATE SET
         github_subject = excluded.github_subject,
         access_envelope = excluded.access_envelope,
         access_expires_at = excluded.access_expires_at,
         refresh_envelope = excluded.refresh_envelope,
         refresh_expires_at = excluded.refresh_expires_at,
         updated_at = excluded.updated_at`
    ).run(
      principalId,
      githubSubject,
      accessEnvelope,
      accessExpiresAt,
      refreshEnvelope,
      refreshExpiresAt,
      now,
      now
    );
    const authorization = this.getUserAuthorization(principalId);
    if (!authorization) throw new Error('GitHub user authorization write was not persisted');
    return authorization;
  }

  getUserAuthorization(principalId: string): GitHubUserAuthorization | null {
    const row = this.db.prepare('SELECT * FROM github_user_authorizations WHERE principal_id = ?')
      .get(boundedIdentifier(principalId, 'principal id')) as UserAuthorizationRow | undefined;
    return row ? mapAuthorization(row) : null;
  }

  deleteUserAuthorization(principalId: string): boolean {
    return this.db.prepare('DELETE FROM github_user_authorizations WHERE principal_id = ?')
      .run(boundedIdentifier(principalId, 'principal id')).changes > 0;
  }

  linkInstallation(input: LinkGitHubInstallationInput): GitHubInstallation {
    const installationId = canonicalGitHubId(input.installationId, 'GitHub installation id');
    const orgId = boundedIdentifier(input.orgId, 'organisation id');
    const accountId = canonicalGitHubId(input.accountId, 'GitHub account id');
    const login = accountLogin(input.accountLogin);
    const principalId = boundedIdentifier(input.connectedByPrincipalId, 'principal id');
    if (input.targetType !== 'User' && input.targetType !== 'Organization') {
      throw new Error('GitHub installation target type is invalid');
    }
    if (input.repositorySelection !== 'all' && input.repositorySelection !== 'selected') {
      throw new Error('GitHub repository selection is invalid');
    }
    const permissions = JSON.stringify(normalizePermissions(input.permissions));
    const now = timestamp(input.now);
    const link = this.db.transaction(() => {
      const membership = this.db.prepare(
        'SELECT 1 FROM auth_memberships WHERE org_id = ? AND principal_id = ?'
      ).get(orgId, principalId);
      if (!membership) throw new Error('GitHub installation connector is not a member of the organisation');
      const existing = this.db.prepare(
        'SELECT org_id, account_id, target_type FROM github_installations WHERE installation_id = ?'
      ).get(installationId) as {
        org_id: string;
        account_id: string;
        target_type: GitHubInstallationTargetType;
      } | undefined;
      if (existing && existing.org_id !== orgId) {
        throw new GitHubInstallationCrossOrgError(installationId);
      }
      if (existing && (existing.account_id !== accountId || existing.target_type !== input.targetType)) {
        throw new Error('GitHub installation identity changed unexpectedly');
      }
      this.db.prepare(
        `INSERT INTO github_installations
           (installation_id, org_id, account_id, account_login, target_type,
            status, repository_selection, permissions_json,
            connected_by_principal_id, connected_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id) DO UPDATE SET
           account_id = excluded.account_id,
           account_login = excluded.account_login,
           target_type = excluded.target_type,
           status = 'active',
           repository_selection = excluded.repository_selection,
           permissions_json = excluded.permissions_json,
           connected_by_principal_id = excluded.connected_by_principal_id,
           updated_at = excluded.updated_at`
      ).run(
        installationId,
        orgId,
        accountId,
        login,
        input.targetType,
        input.repositorySelection,
        permissions,
        principalId,
        now,
        now
      );
    });
    link.immediate();
    const installation = this.getInstallation(installationId);
    if (!installation) throw new Error('GitHub installation write was not persisted');
    return installation;
  }

  getInstallation(installationId: string): GitHubInstallation | null {
    const row = this.db.prepare('SELECT * FROM github_installations WHERE installation_id = ?')
      .get(canonicalGitHubId(installationId, 'GitHub installation id')) as InstallationRow | undefined;
    return row ? mapInstallation(row) : null;
  }

  listInstallations(orgId: string): readonly GitHubInstallation[] {
    const rows = this.db.prepare(
      'SELECT * FROM github_installations WHERE org_id = ? ORDER BY connected_at, installation_id'
    ).all(boundedIdentifier(orgId, 'organisation id')) as InstallationRow[];
    return Object.freeze(rows.map(mapInstallation));
  }

  transitionInstallation(
    installationId: string,
    status: GitHubInstallationStatus,
    now?: Date | number
  ): boolean {
    const id = canonicalGitHubId(installationId, 'GitHub installation id');
    if (status !== 'active' && status !== 'suspended' && status !== 'deleted') {
      throw new Error('GitHub installation status is invalid');
    }
    const terminalGuard = status === 'deleted' ? '' : " AND status <> 'deleted'";
    return this.db.prepare(
      `UPDATE github_installations SET status = ?, updated_at = ? WHERE installation_id = ?${terminalGuard}`
    ).run(status, timestamp(now), id).changes > 0;
  }

  touchInstallation(installationId: string, now?: Date | number): boolean {
    return this.db.prepare(
      'UPDATE github_installations SET updated_at = ? WHERE installation_id = ?'
    ).run(timestamp(now), canonicalGitHubId(installationId, 'GitHub installation id')).changes > 0;
  }

  /** Insert delivery and mutate installation in one immediate transaction. */
  recordWebhookDelivery(input: {
    readonly deliveryId: string;
    readonly event: string;
    readonly payloadSha256: string;
    readonly mutation?: GitHubWebhookMutation;
    readonly receivedAt?: Date | number;
  }): GitHubWebhookDeliveryResult {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.deliveryId)) {
      throw new Error('GitHub webhook delivery id has an invalid format');
    }
    if (!/^[a-z][a-z0-9_]{0,99}$/.test(input.event)) {
      throw new Error('GitHub webhook event has an invalid format');
    }
    if (!/^[0-9a-f]{64}$/.test(input.payloadSha256)) {
      throw new Error('GitHub webhook payload digest has an invalid format');
    }
    const receivedAt = timestamp(input.receivedAt);
    const record = this.db.transaction((): GitHubWebhookDeliveryResult => {
      const prior = this.db.prepare(
        'SELECT delivery_id, event, payload_sha256 FROM github_webhook_deliveries WHERE delivery_id = ?'
      ).get(input.deliveryId) as DeliveryRow | undefined;
      if (prior) {
        if (prior.event !== input.event || prior.payload_sha256 !== input.payloadSha256) {
          throw new GitHubWebhookDeliveryCollisionError(input.deliveryId);
        }
        return Object.freeze({ duplicate: true, applied: false });
      }
      this.db.prepare(
        `INSERT INTO github_webhook_deliveries
           (delivery_id, event, payload_sha256, received_at, processed_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(input.deliveryId, input.event, input.payloadSha256, receivedAt, receivedAt);

      let applied = false;
      if (input.mutation) {
        const installationId = canonicalGitHubId(
          input.mutation.installationId,
          'GitHub installation id'
        );
        if (input.mutation.kind === 'touch') {
          applied = this.db.prepare(
            'UPDATE github_installations SET updated_at = ? WHERE installation_id = ?'
          ).run(receivedAt, installationId).changes > 0;
        } else {
          const terminalGuard = input.mutation.status === 'deleted'
            ? ''
            : " AND status <> 'deleted'";
          applied = this.db.prepare(
            `UPDATE github_installations SET status = ?, updated_at = ? WHERE installation_id = ?${terminalGuard}`
          ).run(input.mutation.status, receivedAt, installationId).changes > 0;
        }
      }
      return Object.freeze({ duplicate: false, applied });
    });
    return record.immediate();
  }
}
