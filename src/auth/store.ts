import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  EMPTY_TIER_MODEL_PINS,
  accountTierModelPinsSchema,
  tierModelPinsSchema,
  type TierModelPins,
} from '../contracts/tierModels.js';
import {
  accountSubscriptionProfileIdSchema,
  accountSubscriptionProviderSchema,
  type AccountSubscriptionProvider,
} from '../contracts/accountSubscriptions.js';
import { principalIdSchema } from '../contracts/projects.js';
import {
  isAccountTierSelection,
  isValidTierModelSelection,
} from '../core/providerCatalog.js';
import {
  decryptBoundSecret,
  encryptBoundSecret,
} from '../core/secretCrypto.js';
import { openStoreHandle, storeDbPath } from '../core/stores.js';
import { MCP_OAUTH_DDL, McpOAuthStore } from './mcpOAuthStore.js';
import type { AvatarMime } from './avatar.js';
import type { SecretEncryptionContext } from './secretEncryption.js';
import { providerKeyAad } from './secretEncryption.js';
import {
  hasControlCharacters,
  isSessionToken,
  MAX_LOGOUT_SESSION_CANDIDATES,
} from './values.js';

/** Display names are bounded like the provider claim they usually come from. */
const MAX_DISPLAY_NAME_LENGTH = 120;

/** Provider API keys are bounded like the tokens they are (GitHub caps at 16 KiB). */
const MAX_PROVIDER_KEY_CHARS = 16_384;

export type ProviderKeyProvider = 'anthropic' | 'openai' | 'zai' | 'ollama';

export const PROVIDER_KEY_PROVIDERS: readonly ProviderKeyProvider[] = [
  'anthropic',
  'openai',
  'zai',
  'ollama',
];

/** What GET /api/org/provider-keys may reveal: presence, never bytes. */
export interface OrgProviderKeyStatus {
  readonly provider: ProviderKeyProvider;
  readonly configuredAt: string;
}

/** Non-secret receipt pointing at one provider-owned credential generation. */
export interface PrincipalSubscriptionReceipt {
  readonly principalId: string;
  readonly provider: AccountSubscriptionProvider;
  readonly profileId: string;
  readonly state: 'connected' | 'reauth_required';
  readonly connectedAt: string;
  readonly lastVerifiedAt: string | null;
  readonly updatedAt: string;
}

/**
 * A stored ORG default that is no longer selectable reads as `null` (inherit)
 * rather than throwing — a retired model id must never break the account page
 * or a run launch. Validation happens on WRITE; this read-side degrade is the
 * tolerance for choices retired AFTER they were stored.
 */
function allowedStoredSelection(value: string | null): string | null {
  if (value === null) return null;
  return isValidTierModelSelection(value) ? value : null;
}

/**
 * The ACCOUNT level's read-side, which also admits the host-subscription
 * sentinel.
 *
 * THE DEGRADE MUST NOT BECOME THE RETIREMENT LEVER for the subscription.
 * Whether the sentinel is honourable is decided at RUN LAUNCH, per run, by
 * re-asking the platform-admin flag and the deployment's declaration — so a
 * withdrawn declaration must reach the requester as a loud refusal naming the
 * tier, never as a quiet downgrade to a billed credential (design 2026-08-28,
 * D5). Reading it back as `null` here would BE that downgrade, silently
 * changing who pays: the defect class finding 2.2 closed on 2026-08-27.
 */
function allowedPrincipalSelection(value: string | null, tier: 1 | 2 | 3): string | null {
  if (value === null) return null;
  return isAccountTierSelection(value, tier) ? value : null;
}

/**
 * AUTH IDENTITY SUBSTRATE — principals, linked provider identities, the
 * organisations, memberships and sessions.
 * ====================================================================
 *
 * This is the Phase-6/A2 groundwork of docs/saas-architecture.md, built to
 * that document's rules rather than to OAuth symmetry:
 *
 * - LINK ON `(provider, provider_subject)`, NEVER ON EMAIL (R11). Email is
 *   snapshotted at link time as a display attribute and can never join two
 *   principals. An admitted login on an unknown pair CREATES a principal;
 *   there is no merge path in this store.
 * - SURROGATE IDS (T4 discipline): `principal_id`/`org_id` are UUIDs, the
 *   same shape and the same rationale as `core/atomId.ts` — no table, path
 *   or future ledger event keys on a provider subject, a display name or an
 *   email.
 * - ORGANISATION ADMISSION: a login without an invitation creates a personal
 *   organisation owned by the new principal. A login carrying an invitation
 *   joins the one organisation named by that bearer. Existing principals may
 *   therefore join more than one organisation without ever re-linking by
 *   email or changing an existing membership's role.
 * - PLATFORM SCOPE, deliberately (R6): these tables partition nothing per
 *   tenant YET — they are the instance's own control-plane state, which is
 *   why they live in the one consolidated store rather than a new file.
 * - SESSIONS ARE OPAQUE SERVER-STATE, not JWTs: the cookie carries a random
 *   token, the store keeps only its SHA-256, and revocation is a DELETE.
 *   This matches the viz server's framework-free, node:http shape.
 *
 * The gate that CONSUMES this store is opt-in (`ATOMA_VIZ_AUTH`); without
 * it no table is created and the developer path is untouched — the same
 * launch-time, host-sourced-policy pattern as `ATOMA_REQUIRE_ISOLATION`.
 */

export const AUTH_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS auth_principals (
  principal_id TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('human','service','system')),
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_identities (
  provider         TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  principal_id     TEXT NOT NULL REFERENCES auth_principals(principal_id),
  email            TEXT,
  email_verified   INTEGER NOT NULL DEFAULT 0,
  linked_at        TEXT NOT NULL,
  PRIMARY KEY (provider, provider_subject)
);
CREATE TABLE IF NOT EXISTS auth_organisations (
  org_id     TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_memberships (
  org_id       TEXT NOT NULL REFERENCES auth_organisations(org_id),
  principal_id TEXT NOT NULL REFERENCES auth_principals(principal_id),
  role         TEXT NOT NULL CHECK (role IN ('org:owner','org:admin','org:member','org:viewer')),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (org_id, principal_id)
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash   TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES auth_principals(principal_id),
  org_id       TEXT NOT NULL REFERENCES auth_organisations(org_id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_api_tokens (
  token_id     TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL REFERENCES auth_principals(principal_id),
  org_id       TEXT NOT NULL REFERENCES auth_organisations(org_id),
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE TABLE IF NOT EXISTS auth_invitations (
  token_hash  TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES auth_organisations(org_id),
  role        TEXT NOT NULL CHECK (role IN ('org:owner','org:admin','org:member','org:viewer')),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS auth_oauth_states (
  state           TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  code_verifier   TEXT NOT NULL,
  invitation_hash TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_platform_admins (
  principal_id TEXT PRIMARY KEY REFERENCES auth_principals(principal_id),
  granted_at   TEXT NOT NULL,
  granted_by   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_avatars (
  principal_id TEXT PRIMARY KEY REFERENCES auth_principals(principal_id),
  mime         TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp','image/gif')),
  bytes        BLOB NOT NULL,
  source_url   TEXT,
  etag         TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_principal_model_pins (
  principal_id TEXT PRIMARY KEY REFERENCES auth_principals(principal_id),
  model_l1     TEXT,
  model_l2     TEXT,
  model_l3     TEXT,
  updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_principal_subscriptions (
  principal_id     TEXT NOT NULL REFERENCES auth_principals(principal_id),
  provider         TEXT NOT NULL CHECK (provider IN ('claude','codex')),
  profile_id       TEXT NOT NULL UNIQUE,
  state            TEXT NOT NULL CHECK (state IN ('connected','reauth_required')),
  connected_at     TEXT NOT NULL,
  last_verified_at TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (principal_id, provider)
);
CREATE TABLE IF NOT EXISTS auth_org_tier_models (
  org_id     TEXT PRIMARY KEY REFERENCES auth_organisations(org_id),
  model_l1   TEXT,
  model_l2   TEXT,
  model_l3   TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_org_provider_keys (
  org_id       TEXT NOT NULL REFERENCES auth_organisations(org_id),
  provider     TEXT NOT NULL CHECK (provider IN ('anthropic','openai','zai','ollama')),
  envelope     TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (org_id, provider)
);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS auth_invitations_expires_idx ON auth_invitations(expires_at);
CREATE INDEX IF NOT EXISTS auth_oauth_states_expires_idx ON auth_oauth_states(expires_at);
`;

/**
 * This index cannot live in AUTH_TABLES_DDL yet: on a pre-release store whose
 * auth_invitations table predates org_id, CREATE INDEX would run before the
 * convergence migration and fail on the missing column. Apply it only after
 * the table shape has been checked/rebuilt.
 */
const AUTH_POST_MIGRATION_DDL = `
CREATE INDEX IF NOT EXISTS auth_invitations_org_expires_idx
  ON auth_invitations(org_id, expires_at);
`;

export type PrincipalKind = 'human' | 'service' | 'system';

/** Org roles in ascending privilege. `org:viewer` reads runs and cost but
 *  never triggers execution — T9: read of cost is not read of code. */
export type OrgRole = 'org:owner' | 'org:admin' | 'org:member' | 'org:viewer';

export const ORG_ROLES: readonly OrgRole[] = ['org:viewer', 'org:member', 'org:admin', 'org:owner'];

/** Bound pending login transactions so unauthenticated starts cannot grow the DB forever. */
export const MAX_ACTIVE_OAUTH_STATES = 500;

/** A typed capacity error lets the HTTP boundary map pressure to 429. */
export class TooManyPendingOauthStatesError extends Error {
  constructor(limit = MAX_ACTIVE_OAUTH_STATES) {
    super(`Too many pending OAuth states (limit ${limit})`);
    this.name = 'TooManyPendingOauthStatesError';
  }
}

/** What the authenticated principal currently is, resolved per request. */
export interface Viewer {
  principalId: string;
  displayName: string;
  kind: PrincipalKind;
  orgId: string;
  orgName: string;
  role: OrgRole;
  /**
   * Instance-wide operator flag, NEVER derived from OAuth claims: it is
   * granted only through the operator CLI (`auth grant-admin`) against the
   * store on disk. Emails are display attributes — a provider-supplied email
   * must not mint platform power.
   */
  platformAdmin: boolean;
  /**
   * Whether `displayName` still comes from the provider or was chosen by the
   * viewer. The account UI needs the difference: it labels an imported name
   * as imported, and a user-owned name is never re-synchronised on login.
   */
  displayNameSource: DisplayNameSource;
}

interface ApiTokenRow {
  token_id: string;
  token_hash: string;
  principal_id: string;
  org_id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ApiTokenRecord {
  tokenId: string;
  orgId: string;
  orgName: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface LoginOutcome {
  viewer: Viewer;
  /** True when this login created the principal (vs returning an existing one). */
  createdPrincipal: boolean;
  /**
   * True when this login FOUNDED an organisation — a first login carrying no
   * invitation. The platform's growth signal, and the one thing a caller
   * cannot infer from the viewer alone (an owner of a long-standing org and
   * the founder of a brand-new one look identical there).
   */
  createdOrganisation: boolean;
  /**
   * True when this login INSERTED a membership into an organisation that
   * already existed — i.e. an invitation admitted someone. Distinct from
   * `createdOrganisation` (a founder joins nothing) and from merely
   * consuming an invitation whose membership was already present.
   */
  joinedOrganisation: boolean;
}

export interface CompletedProviderIdentity {
  provider: string;
  subject: string;
  displayName: string;
  email: string | null;
  emailVerified: boolean;
}

interface PrincipalRow {
  principal_id: string;
  kind: PrincipalKind;
  display_name: string;
  created_at: string;
  /** 'provider' until the viewer renames the account, then 'user'. */
  display_name_source: DisplayNameSource;
}

export type DisplayNameSource = 'provider' | 'user';

interface SessionRow {
  token_hash: string;
  principal_id: string;
  org_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
}

interface MembershipRow {
  org_id: string;
  principal_id: string;
  role: OrgRole;
  created_at: string;
}

interface InvitationRow {
  token_hash: string;
  org_id: string;
  role: OrgRole;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface InvitationRecord {
  tokenHash: string;
  orgId: string;
  orgName: string;
  role: OrgRole;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface OrganisationMember {
  principalId: string;
  displayName: string;
  role: OrgRole;
  joinedAt: string;
  /** Instance-wide operator flag, shown as a chip beside the member. */
  platformAdmin: boolean;
  /** Content hash of the stored avatar, or null when there is none. */
  avatarEtag: string | null;
}

export interface OrganisationMembership {
  orgId: string;
  orgName: string;
  role: OrgRole;
  createdAt: string;
}

export interface OrganisationRecord {
  orgId: string;
  name: string;
  createdAt: string;
}

interface OrganisationRow {
  org_id: string;
  name: string;
  created_at: string;
}

interface InvitationWithOrganisationRow extends InvitationRow {
  org_name: string;
}

/** Name retained only for convergence from the pre-release bootstrap flow. */
const PRIMARY_ORG_NAME = 'Primary';

const PERSONAL_ORG_SUFFIX = "'s organisation";

const AUTH_TABLE_NAMES = [
  'auth_principals',
  'auth_identities',
  'auth_organisations',
  'auth_memberships',
  'auth_sessions',
  'auth_invitations',
  'auth_oauth_states',
  'auth_org_tier_models',
  'auth_org_provider_keys',
  'auth_principal_subscriptions',
] as const;

interface AuthStoreOptions {
  initialize?: boolean;
  closeOnClose?: boolean;
}

/**
 * Auth timestamps are machine-written through `Date#toISOString`. Requiring a
 * byte-identical parse round-trip prevents SQLite corruption such as
 * `not-a-date` (or a normalized impossible date) from turning an expiry check
 * into `NaN`, whose comparisons would otherwise fail open.
 */
function storedInstantMs(value: string): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  try {
    return new Date(parsed).toISOString() === value ? parsed : null;
  } catch {
    return null;
  }
}

function liveWindow(createdAt: string, expiresAt: string, nowMs: number): boolean {
  const createdMs = storedInstantMs(createdAt);
  const expiresMs = storedInstantMs(expiresAt);
  return (
    createdMs !== null &&
    expiresMs !== null &&
    createdMs <= nowMs &&
    expiresMs > nowMs &&
    expiresMs > createdMs
  );
}

function invalidInstantSql(column: string): string {
  return `strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NULL
    OR strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) <> ${column}`;
}

const STALE_SESSION_SQL = `
  ${invalidInstantSql('created_at')}
  OR ${invalidInstantSql('expires_at')}
  OR ${invalidInstantSql('last_seen_at')}
  OR created_at > ?
  OR expires_at <= ?
  OR expires_at <= created_at
  OR last_seen_at < created_at
  OR last_seen_at > ?`;

const STALE_INVITATION_SQL = `
  ${invalidInstantSql('created_at')}
  OR ${invalidInstantSql('expires_at')}
  OR (consumed_at IS NOT NULL AND (${invalidInstantSql('consumed_at')}))
  OR created_at > ?
  OR expires_at <= ?
  OR expires_at <= created_at
  OR (consumed_at IS NOT NULL AND (consumed_at < created_at OR consumed_at > ?))`;

const STALE_OAUTH_STATE_SQL = `
  ${invalidInstantSql('created_at')}
  OR ${invalidInstantSql('expires_at')}
  OR created_at > ?
  OR expires_at <= ?
  OR expires_at <= created_at`;

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name)
  );
}

/**
 * Converge the only pre-release auth shape that reached local worktrees:
 * invitations existed before they named an organisation. The supported
 * single-org state gives those rows exactly one honest target. A fresh
 * bootstrap with invitations but no organisation gets a pending Primary org;
 * completeLogin still requires its first membership to be an owner, preserving
 * the old first-owner safety rule until one of those bearers is consumed.
 *
 * More than one organisation plus unscoped invitations is not a state the old
 * product could create. Refuse it rather than guessing across a tenant
 * boundary. The whole rebuild is BEGIN IMMEDIATE and rechecks its precondition,
 * so two processes opening the same pre-release DB converge rather than race.
 */
function migrateInvitationOrganisationScope(db: Database.Database): void {
  if (tableColumns(db, 'auth_invitations').has('org_id')) return;

  const migrate = db.transaction((): void => {
    if (tableColumns(db, 'auth_invitations').has('org_id')) return;

    const staging = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_invitations_next'")
      .get();
    if (staging) {
      throw new Error('authentication invitation migration has an unexpected staging table');
    }

    const invitationCount = db
      .prepare('SELECT COUNT(*) AS count FROM auth_invitations')
      .get() as { count: number };
    const organisations = db
      .prepare('SELECT * FROM auth_organisations ORDER BY created_at ASC, org_id ASC')
      .all() as OrganisationRow[];

    let targetOrgId: string | null = null;
    if (invitationCount.count > 0) {
      if (organisations.length > 1) {
        throw new Error(
          'cannot migrate unscoped authentication invitations across multiple organisations'
        );
      }
      if (organisations.length === 1) {
        targetOrgId = organisations[0]!.org_id;
      } else {
        const impossibleMemberships = db
          .prepare('SELECT COUNT(*) AS count FROM auth_memberships')
          .get() as { count: number };
        if (impossibleMemberships.count > 0) {
          throw new Error('cannot migrate invitations: memberships exist without an organisation');
        }
        targetOrgId = randomUUID();
        db.prepare(
          'INSERT INTO auth_organisations (org_id, name, created_at) VALUES (?, ?, ?)'
        ).run(targetOrgId, PRIMARY_ORG_NAME, new Date().toISOString());
      }
    }

    db.exec(`
      CREATE TABLE auth_invitations_next (
        token_hash  TEXT PRIMARY KEY,
        org_id      TEXT NOT NULL REFERENCES auth_organisations(org_id),
        role        TEXT NOT NULL CHECK (role IN ('org:owner','org:admin','org:member','org:viewer')),
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        consumed_at TEXT
      )
    `);
    if (targetOrgId) {
      db.prepare(
        `INSERT INTO auth_invitations_next
           (token_hash, org_id, role, created_at, expires_at, consumed_at)
         SELECT token_hash, ?, role, created_at, expires_at, consumed_at
         FROM auth_invitations`
      ).run(targetOrgId);
    }
    db.exec(`
      DROP TABLE auth_invitations;
      ALTER TABLE auth_invitations_next RENAME TO auth_invitations;
      CREATE INDEX auth_invitations_expires_idx ON auth_invitations(expires_at);
    `);

    const violations = db.prepare('PRAGMA foreign_key_check(auth_invitations)').all();
    if (violations.length > 0) {
      throw new Error('authentication invitation migration violated a foreign key');
    }
  });
  migrate.immediate();
}

function personalOrganisationName(displayName: string): string {
  const normalized = displayName.trim() || 'Personal';
  const maxBaseLength = 255 - PERSONAL_ORG_SUFFIX.length;
  return `${normalized.slice(0, maxBaseLength)}${PERSONAL_ORG_SUFFIX}`;
}

export class AuthStore {
  readonly mcpOAuth: McpOAuthStore;
  private readonly db: Database.Database;
  private readonly closeOnClose: boolean;

  constructor(db: Database.Database, options: AuthStoreOptions = {}) {
    this.db = db;
    this.mcpOAuth = new McpOAuthStore(db);
    this.closeOnClose = options.closeOnClose ?? false;
    this.db.pragma('foreign_keys = ON');
    if (options.initialize === false) return;
    this.db.exec(AUTH_TABLES_DDL);
    this.db.exec(MCP_OAUTH_DDL);

    // The auth substrate was initially developed with no invitation column.
    // CREATE TABLE IF NOT EXISTS cannot upgrade that local pre-release shape,
    // so keep the additive migration beside the schema it completes.
    const oauthStateColumns = this.db
      .prepare('PRAGMA table_info(auth_oauth_states)')
      .all() as Array<{ name: string }>;
    if (!oauthStateColumns.some((column) => column.name === 'invitation_hash')) {
      this.db.exec('ALTER TABLE auth_oauth_states ADD COLUMN invitation_hash TEXT');
    }

    // Who OWNS the display name. Provider logins re-synchronise it on every
    // login (see completeLogin); once a viewer renames the account the
    // provider must stop overwriting that choice, or the rename silently
    // reverts at the next sign-in. Additive column, same guarded shape as the
    // invitation_hash repair above.
    const principalColumns = this.db
      .prepare('PRAGMA table_info(auth_principals)')
      .all() as Array<{ name: string }>;
    if (!principalColumns.some((column) => column.name === 'display_name_source')) {
      this.db.exec(
        `ALTER TABLE auth_principals
           ADD COLUMN display_name_source TEXT NOT NULL DEFAULT 'provider'`
      );
    }
    migrateInvitationOrganisationScope(this.db);
    this.db.exec(AUTH_POST_MIGRATION_DDL);
  }

  /** Open (creating if needed) the auth tables in the instance store. */
  static open(path?: string): AuthStore {
    return new AuthStore(openStoreHandle(path ?? storeDbPath(), AUTH_TABLES_DDL));
  }

  /**
   * Open an already-initialized auth schema without DDL or migrations. `null`
   * means the product DB has no auth state at all; a partial auth schema is
   * corruption and is refused rather than being hidden or repaired by `list`.
   */
  static openReadOnly(path: string): AuthStore | null {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    let handedOff = false;
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'auth_*'")
        .all() as Array<{ name: string }>;
      if (rows.length === 0) return null;
      const present = new Set(rows.map((row) => row.name));
      const missing = AUTH_TABLE_NAMES.filter((name) => !present.has(name));
      if (missing.length > 0) {
        throw new Error(`authentication schema is incomplete (missing ${missing.join(', ')})`);
      }
      const missingColumns = [
        ...(!tableColumns(db, 'auth_invitations').has('org_id')
          ? ['auth_invitations.org_id']
          : []),
        ...(!tableColumns(db, 'auth_oauth_states').has('invitation_hash')
          ? ['auth_oauth_states.invitation_hash']
          : []),
      ];
      if (missingColumns.length > 0) {
        throw new Error(
          `authentication schema requires a writable upgrade (missing ${missingColumns.join(', ')})`
        );
      }
      const store = new AuthStore(db, { initialize: false, closeOnClose: true });
      handedOff = true;
      return store;
    } finally {
      if (!handedOff) db.close();
    }
  }

  /**
   * Record a completed provider login and return the viewer it produced.
   *
   * - Known `(provider, subject)` → the EXISTING principal, whatever email
   *   the provider shows this time. Email never re-links (R11). A valid
   *   invitation adds a membership in its target organisation; without one,
   *   the oldest deterministic membership becomes active.
   * - Unknown pair + valid invitation → create the principal in that exact
   *   organisation with the invitation's role.
   * - Unknown pair + no invitation → create a personal organisation and an
   *   owner membership. Supplying an invalid/expired invitation NEVER falls
   *   back to this open-signup path.
   * - The display name follows the provider's latest snapshot only when the
   *   provider actually sent one; an absent name keeps the previous value.
   *
   * The invitation argument is already a SHA-256 hash. The clear token never
   * enters provider callbacks or this method.
  */
  completeLogin(input: CompletedProviderIdentity, invitationHash: string | null): LoginOutcome | null {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const run = this.db.transaction((): LoginOutcome | null => {
      const principal = this.db
        .prepare('SELECT * FROM auth_principals WHERE principal_id = (SELECT principal_id FROM auth_identities WHERE provider = ? AND provider_subject = ?)')
        .get(input.provider, input.subject) as PrincipalRow | undefined;

      const invitation = invitationHash
        ? this.db
            .prepare(
              `SELECT i.*, o.name AS org_name
               FROM auth_invitations i
               JOIN auth_organisations o ON o.org_id = i.org_id
               WHERE i.token_hash = ? AND i.consumed_at IS NULL`
            )
            .get(invitationHash) as InvitationWithOrganisationRow | undefined
        : undefined;

      // Presence and validity are deliberately separate from absence. A
      // stale invitation URL must not silently become an unrelated personal
      // signup, nor log a known user into whichever organisation sorts first.
      if (
        invitationHash !== null &&
        (!invitation || !liveWindow(invitation.created_at, invitation.expires_at, nowMs))
      ) {
        return null;
      }

      const orgHasOwner = (orgId: string): boolean => Boolean(
        this.db
          .prepare(
            `SELECT 1 FROM auth_memberships
             WHERE org_id = ? AND role = 'org:owner'
             LIMIT 1`
          )
          .get(orgId)
      );

      const consumeInvitation = (): boolean => {
        if (!invitation || !invitationHash) return true;
        return this.db
          .prepare(
            'UPDATE auth_invitations SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL'
          )
          .run(now, invitationHash).changes === 1;
      };

      if (principal) {
        let membership: MembershipRow | undefined;
        let org: OrganisationRow | undefined;
        // Set only when a membership row is actually INSERTED below. An
        // invitation re-used by someone who is already a member consumes the
        // token without admitting anybody, and must not read as an admission.
        let joinedOrganisation = false;

        if (invitation) {
          membership = this.db
            .prepare('SELECT * FROM auth_memberships WHERE principal_id = ? AND org_id = ?')
            .get(principal.principal_id, invitation.org_id) as MembershipRow | undefined;

          // A pre-release bootstrap migration can materialise its pending org
          // before the owner invitation is used. Preserve the former invariant:
          // the first membership there must still be an owner.
          if (!orgHasOwner(invitation.org_id)) {
            if (membership || invitation.role !== 'org:owner') return null;
          }

          if (!membership) {
            this.db
              .prepare(
                'INSERT INTO auth_memberships (org_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)'
              )
              .run(invitation.org_id, principal.principal_id, invitation.role, now);
            membership = {
              org_id: invitation.org_id,
              principal_id: principal.principal_id,
              role: invitation.role,
              created_at: now,
            };
            joinedOrganisation = true;
          }
          org = {
            org_id: invitation.org_id,
            name: invitation.org_name,
            created_at: '',
          };
          if (!consumeInvitation()) {
            // A throw, NEVER `return null`: better-sqlite3 COMMITS a
            // transaction that returns — this branch would otherwise commit
            // the membership above while reporting a failed login.
            // Unreachable today (the invitation is re-read unconsumed inside
            // this same immediate transaction), which is exactly why it must
            // fail loudly and atomically if that invariant ever breaks.
            throw new Error('invitation disappeared mid-login transaction');
          }
        } else {
          membership = this.db
            .prepare(
              `SELECT * FROM auth_memberships
               WHERE principal_id = ?
               ORDER BY created_at ASC, org_id ASC
               LIMIT 1`
            )
            .get(principal.principal_id) as MembershipRow | undefined;
          if (membership) {
            org = this.db
              .prepare('SELECT * FROM auth_organisations WHERE org_id = ?')
              .get(membership.org_id) as OrganisationRow | undefined;
          }
        }

        if (!membership) return null;
        if (!org) return null;

        // Provider re-synchronisation, GUARDED: a name the viewer chose in
        // Settings outranks whatever the provider reports. Without this check
        // the rename survives exactly until the next login and then vanishes,
        // with nothing in the UI to explain it.
        if (
          principal.display_name_source !== 'user' &&
          input.displayName.trim().length > 0 &&
          input.displayName !== principal.display_name
        ) {
          this.db
            .prepare('UPDATE auth_principals SET display_name = ? WHERE principal_id = ?')
            .run(input.displayName, principal.principal_id);
          principal.display_name = input.displayName;
        }
        this.db
          .prepare(
            `UPDATE auth_identities
             SET email = COALESCE(?, email),
                 email_verified = CASE WHEN ? IS NULL THEN email_verified ELSE ? END
             WHERE provider = ? AND provider_subject = ?`
          )
          .run(input.email, input.email, input.emailVerified ? 1 : 0, input.provider, input.subject);
        return {
          viewer: {
            principalId: principal.principal_id,
            displayName: principal.display_name,
            kind: principal.kind,
            orgId: membership.org_id,
            orgName: org.name,
            role: membership.role,
            platformAdmin: this.isPlatformAdmin(principal.principal_id),
            displayNameSource: principal.display_name_source,
          },
          createdPrincipal: false,
          // A returning principal never founds an organisation: the personal
          // org is created on the FIRST login only.
          createdOrganisation: false,
          joinedOrganisation,
        };
      }

      const principalId = randomUUID();
      let orgId: string;
      let orgName: string;
      let role: OrgRole;

      if (invitation) {
        if (!orgHasOwner(invitation.org_id) && invitation.role !== 'org:owner') return null;
        orgId = invitation.org_id;
        orgName = invitation.org_name;
        role = invitation.role;
      } else {
        orgId = randomUUID();
        orgName = personalOrganisationName(input.displayName);
        role = 'org:owner';
      }

      this.db
        .prepare('INSERT INTO auth_principals (principal_id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
        .run(principalId, 'human', input.displayName, now);
      this.db
        .prepare(
          `INSERT INTO auth_identities (provider, provider_subject, principal_id, email, email_verified, linked_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(input.provider, input.subject, principalId, input.email, input.emailVerified ? 1 : 0, now);

      if (!invitation) {
        this.db
          .prepare('INSERT INTO auth_organisations (org_id, name, created_at) VALUES (?, ?, ?)')
          .run(orgId, orgName, now);
      }
      this.db
        .prepare('INSERT INTO auth_memberships (org_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)')
        .run(orgId, principalId, role, now);
      if (!consumeInvitation()) {
        // Same rule as above: a return would COMMIT the freshly inserted
        // principal, identity and membership while reporting a failed login.
        throw new Error('invitation disappeared mid-login transaction');
      }

      return {
        viewer: {
          principalId,
          displayName: input.displayName,
          kind: 'human',
          orgId,
          orgName,
          role,
          // A brand-new principal can never already hold the operator flag.
          platformAdmin: false,
          displayNameSource: 'provider',
        },
        createdPrincipal: true,
        // The two are exclusive by construction: the organisation INSERT
        // above runs exactly when there is no invitation, and an invitation
        // is exactly what admits this principal into someone else's org.
        createdOrganisation: !invitation,
        joinedOrganisation: Boolean(invitation),
      };
    });
    return run.immediate();
  }

  // ------------------------------------------------------------ invitations

  /**
   * Create a single-use admission invitation. The returned record and the DB
   * expose only SHA-256; callers retain and deliver the clear token themselves.
   */
  createInvitation(input: {
    orgId: string;
    token: string;
    role: OrgRole;
    ttlMs: number;
  }): InvitationRecord {
    const tokenHash = sha256Hex(input.token);
    const now = new Date();
    const run = this.db.transaction((): InvitationRecord => {
      const organisation = this.db
        .prepare('SELECT * FROM auth_organisations WHERE org_id = ?')
        .get(input.orgId) as OrganisationRow | undefined;
      if (!organisation) throw new Error(`unknown organisation: ${input.orgId}`);

      const record: InvitationRecord = {
        tokenHash,
        orgId: organisation.org_id,
        orgName: organisation.name,
        role: input.role,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
        consumedAt: null,
      };
      this.db
        .prepare(`DELETE FROM auth_invitations WHERE ${STALE_INVITATION_SQL}`)
        .run(record.createdAt, record.createdAt, record.createdAt);
      this.db
        .prepare(
          `INSERT INTO auth_invitations
             (token_hash, org_id, role, created_at, expires_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, NULL)`
        )
        .run(
          record.tokenHash,
          record.orgId,
          record.role,
          record.createdAt,
          record.expiresAt
        );
      return record;
    });
    return run.immediate();
  }

  /** Operator-facing invitation inventory; clear bearer tokens never appear. */
  listInvitations(): InvitationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT i.*, o.name AS org_name
         FROM auth_invitations i
         JOIN auth_organisations o ON o.org_id = i.org_id
         ORDER BY i.created_at ASC, i.token_hash ASC`
      )
      .all() as InvitationWithOrganisationRow[];
    return rows.map((row) => ({
      tokenHash: row.token_hash,
      orgId: row.org_id,
      orgName: row.org_name,
      role: row.role,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    }));
  }

  // ---------------------------------------------------------------- sessions

  /**
   * Mint a session token. The CLEAR token crosses the wire exactly once
   * (into the cookie); only its SHA-256 is persisted, so a leaked store
   * backup cannot be replayed as a login.
   */
  createSession(input: { principalId: string; orgId: string; token: string; ttlMs: number }): void {
    const now = new Date();
    const expires = new Date(now.getTime() + input.ttlMs);
    this.db
      .prepare(
        `INSERT INTO auth_sessions (token_hash, principal_id, org_id, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(sha256Hex(input.token), input.principalId, input.orgId, now.toISOString(), expires.toISOString(), now.toISOString());
  }

  /** Resolve a bearer token to its viewer, or null when unknown/expired. */
  resolveSession(token: string): Viewer | null {
    const row = this.db
      .prepare('SELECT * FROM auth_sessions WHERE token_hash = ?')
      .get(sha256Hex(token)) as SessionRow | undefined;
    if (!row) return null;
    const now = new Date();
    const nowMs = now.getTime();
    const createdMs = storedInstantMs(row.created_at);
    const expiresMs = storedInstantMs(row.expires_at);
    const lastSeenMs = storedInstantMs(row.last_seen_at);
    if (
      createdMs === null ||
      expiresMs === null ||
      lastSeenMs === null ||
      createdMs > nowMs ||
      expiresMs <= nowMs ||
      expiresMs <= createdMs ||
      lastSeenMs < createdMs ||
      lastSeenMs > nowMs
    ) {
      this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(row.token_hash);
      return null;
    }
    // Touch at most once a minute: the viz polls /api/* every second while a
    // run is live, and one UPDATE per minute is the honest frequency for a
    // "last seen" column.
    if (nowMs - lastSeenMs > 60_000) {
      this.db
        .prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?')
        .run(now.toISOString(), row.token_hash);
    }
    const principal = this.db
      .prepare('SELECT * FROM auth_principals WHERE principal_id = ?')
      .get(row.principal_id) as PrincipalRow | undefined;
    const membership = this.db
      .prepare('SELECT * FROM auth_memberships WHERE principal_id = ? AND org_id = ?')
      .get(row.principal_id, row.org_id) as MembershipRow | undefined;
    const org = this.db
      .prepare('SELECT name FROM auth_organisations WHERE org_id = ?')
      .get(row.org_id) as { name: string } | undefined;
    if (!principal || !membership || !org) return null;
    return {
      principalId: principal.principal_id,
      displayName: principal.display_name,
      kind: principal.kind,
      orgId: row.org_id,
      orgName: org.name,
      role: membership.role,
      platformAdmin: this.isPlatformAdmin(principal.principal_id),
      displayNameSource: principal.display_name_source,
    };
  }

  /* ───────────────────────────── API tokens ───────────────────────────── */

  /**
   * Mint a bearer for the MCP. The plaintext is returned ONCE and never
   * stored: the row keeps its hash, the principal, the ONE organisation the
   * token acts in, a label, and the timestamps a person revokes by. A token
   * is a session that does not expire on its own — so it is revocable, listed
   * to its owner, and journaled at both ends by the caller.
   */
  createApiToken(input: { principalId: string; orgId: string; label: string }): {
    tokenId: string;
    token: string;
    createdAt: string;
  } {
    const membership = this.db
      .prepare('SELECT role FROM auth_memberships WHERE principal_id = ? AND org_id = ?')
      .get(input.principalId, input.orgId) as { role: OrgRole } | undefined;
    if (!membership) throw new Error('the principal is not a member of that organisation');
    const label = input.label.replace(/\s+/g, ' ').trim().slice(0, 80) || 'MCP token';
    const token = `atoma_${randomBytes(32).toString('base64url')}`;
    const tokenId = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO auth_api_tokens (token_id, token_hash, principal_id, org_id, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(tokenId, sha256Hex(token), input.principalId, input.orgId, label, createdAt);
    return { tokenId, token, createdAt };
  }

  /**
   * The viewer a bearer stands for, or null. Same shape and same freshness as
   * a session: the role and the platform-admin flag are read NOW, so a
   * demotion or a revoked flag applies on the next call, never on the next
   * login.
   */
  resolveApiToken(token: string): (Viewer & { tokenId: string }) | null {
    if (typeof token !== 'string' || !token.startsWith('atoma_') || token.length > 200) return null;
    const row = this.db
      .prepare('SELECT * FROM auth_api_tokens WHERE token_hash = ? AND revoked_at IS NULL')
      .get(sha256Hex(token)) as ApiTokenRow | undefined;
    if (!row || !this.mcpOAuth.accessCurrent(row.token_id)) return null;
    const now = new Date();
    const lastUsedMs = row.last_used_at ? storedInstantMs(row.last_used_at) : null;
    if (lastUsedMs === null || now.getTime() - lastUsedMs > 60_000) {
      this.db.prepare('UPDATE auth_api_tokens SET last_used_at = ? WHERE token_id = ?').run(now.toISOString(), row.token_id);
    }
    const principal = this.db
      .prepare('SELECT * FROM auth_principals WHERE principal_id = ?')
      .get(row.principal_id) as PrincipalRow | undefined;
    const membership = this.db
      .prepare('SELECT * FROM auth_memberships WHERE principal_id = ? AND org_id = ?')
      .get(row.principal_id, row.org_id) as MembershipRow | undefined;
    const org = this.db
      .prepare('SELECT name FROM auth_organisations WHERE org_id = ?')
      .get(row.org_id) as { name: string } | undefined;
    if (!principal || !membership || !org) return null;
    return {
      tokenId: row.token_id,
      principalId: principal.principal_id,
      displayName: principal.display_name,
      kind: principal.kind,
      orgId: row.org_id,
      orgName: org.name,
      role: membership.role,
      platformAdmin: this.isPlatformAdmin(principal.principal_id),
      displayNameSource: principal.display_name_source,
    };
  }

  /** A principal's own tokens, secret-free: what Settings and the CLI list. */
  listApiTokens(principalId: string): ApiTokenRecord[] {
    const rows = this.db
      .prepare(
        `SELECT t.token_id, t.org_id, o.name AS org_name, t.label, t.created_at, t.last_used_at, t.revoked_at
         FROM auth_api_tokens t JOIN auth_organisations o ON o.org_id = t.org_id
         WHERE t.principal_id = ? ORDER BY t.created_at DESC`
      )
      .all(principalId) as Array<Omit<ApiTokenRow, 'token_hash' | 'principal_id'> & { org_name: string }>;
    return rows.map((row) => ({
      tokenId: row.token_id,
      orgId: row.org_id,
      orgName: row.org_name,
      label: row.label,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    }));
  }

  /** Revoke one of the principal's OWN tokens; a foreign id is a no-op, never a 404 oracle. */
  revokeApiToken(principalId: string, tokenId: string): boolean {
    const result = this.db
      .prepare('UPDATE auth_api_tokens SET revoked_at = ? WHERE token_id = ? AND principal_id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), tokenId, principalId);
    return result.changes > 0;
  }

  /**
   * PLATFORM ADMIN — instance-wide operator flag.
   *
   * Granted and revoked ONLY through the operator CLI against the store on
   * disk, never from anything a login flow supplies: OAuth emails are display
   * attributes (GitHub's is not even a verified-email assertion), so an email
   * must never mint platform power. The flag rides the Viewer on every
   * request; what it unlocks is decided at the HTTP boundary.
   */
  isPlatformAdmin(principalId: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM auth_platform_admins WHERE principal_id = ?')
      .get(principalId) !== undefined;
  }

  /**
   * Resolve an operator-supplied reference to exactly one principal: a
   * principal id first, else a unique match on an identity email. Zero or
   * several matches are refusals — the CLI must never guess an identity.
   */
  resolvePrincipalRef(ref: string): { principalId: string; displayName: string } {
    const trimmed = ref.trim();
    if (!trimmed) throw new Error('a principal id or identity email is required');
    const byId = this.db
      .prepare('SELECT principal_id, display_name FROM auth_principals WHERE principal_id = ?')
      .get(trimmed) as { principal_id: string; display_name: string } | undefined;
    if (byId) return { principalId: byId.principal_id, displayName: byId.display_name };
    const byEmail = this.db
      .prepare(
        `SELECT DISTINCT p.principal_id, p.display_name
         FROM auth_identities i
         JOIN auth_principals p ON p.principal_id = i.principal_id
         WHERE i.email = ?`
      )
      .all(trimmed) as Array<{ principal_id: string; display_name: string }>;
    if (byEmail.length === 1) {
      return { principalId: byEmail[0]!.principal_id, displayName: byEmail[0]!.display_name };
    }
    if (byEmail.length > 1) {
      throw new Error(`email ${trimmed} matches ${byEmail.length} principals; use the principal id`);
    }
    throw new Error(`no principal matches ${trimmed}`);
  }

  grantPlatformAdmin(ref: string): { principalId: string; displayName: string; already: boolean } {
    const principal = this.resolvePrincipalRef(ref);
    const changed = this.db
      .prepare(
        `INSERT INTO auth_platform_admins (principal_id, granted_at, granted_by)
         VALUES (?, ?, 'cli')
         ON CONFLICT(principal_id) DO NOTHING`
      )
      .run(principal.principalId, new Date().toISOString()).changes;
    return { ...principal, already: changed === 0 };
  }

  revokePlatformAdmin(ref: string): { principalId: string; displayName: string; already: boolean } {
    const principal = this.resolvePrincipalRef(ref);
    const changed = this.db
      .prepare('DELETE FROM auth_platform_admins WHERE principal_id = ?')
      .run(principal.principalId).changes;
    return { ...principal, already: changed === 0 };
  }

  listPlatformAdmins(): Array<{ principalId: string; displayName: string; grantedAt: string }> {
    // Read-only opens (CLI `list`) may see a store written before the table
    // existed; DDL cannot run there, and "no admins yet" is the honest read.
    const present = this.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_platform_admins'`)
      .get();
    if (!present) return [];
    return (
      this.db
        .prepare(
          `SELECT a.principal_id, a.granted_at, p.display_name
           FROM auth_platform_admins a
           JOIN auth_principals p ON p.principal_id = a.principal_id
           ORDER BY a.granted_at ASC`
        )
        .all() as Array<{ principal_id: string; granted_at: string; display_name: string }>
    ).map((row) => ({
      principalId: row.principal_id,
      displayName: row.display_name,
      grantedAt: row.granted_at,
    }));
  }

  /**
   * Change the active organisation of exactly one opaque session.
   *
   * Membership is checked in the same immediate transaction as the UPDATE;
   * an organisation id supplied by the browser can never grant access, and a
   * second session owned by the same principal remains untouched.
   */
  setSessionOrganisation(token: string, orgId: string): Viewer | null {
    const tokenHash = sha256Hex(token);
    const run = this.db.transaction((): Viewer | null => {
      const current = this.resolveSession(token);
      if (!current) return null;
      const target = this.db
        .prepare(
          `SELECT m.*, o.name AS org_name
           FROM auth_memberships m
           JOIN auth_organisations o ON o.org_id = m.org_id
           WHERE m.principal_id = ? AND m.org_id = ?`
        )
        .get(current.principalId, orgId) as (MembershipRow & { org_name: string }) | undefined;
      if (!target) return null;
      const changed = this.db
        .prepare(
          'UPDATE auth_sessions SET org_id = ? WHERE token_hash = ? AND principal_id = ?'
        )
        .run(target.org_id, tokenHash, current.principalId);
      if (changed.changes !== 1) return null;
      return {
        ...current,
        orgId: target.org_id,
        orgName: target.org_name,
        role: target.role,
      };
    });
    return run.immediate();
  }

  revokeSession(token: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256Hex(token));
  }

  /** Revoke one bounded, canonical logout batch with a single SQLite DELETE. */
  revokeSessions(tokens: readonly string[]): number {
    if (
      tokens.length > MAX_LOGOUT_SESSION_CANDIDATES ||
      tokens.some((token) => !isSessionToken(token))
    ) {
      throw new Error(
        `session revocation batch must contain at most ${MAX_LOGOUT_SESSION_CANDIDATES} canonical tokens`
      );
    }
    if (tokens.length === 0) return 0;
    const hashes = [...new Set(tokens)].map(sha256Hex);
    const placeholders = hashes.map(() => '?').join(', ');
    return this.db
      .prepare(`DELETE FROM auth_sessions WHERE token_hash IN (${placeholders})`)
      .run(...hashes).changes;
  }

  /** Drop expired sessions, invitations and states. Idempotent. */
  sweep(): { sessions: number; invitations: number; states: number } {
    const now = new Date().toISOString();
    const run = this.db.transaction(() => {
      this.mcpOAuth.sweep();
      const sessions = this.db
        .prepare(`DELETE FROM auth_sessions WHERE ${STALE_SESSION_SQL}`)
        .run(now, now, now).changes;
      const invitations = this.db
        .prepare(`DELETE FROM auth_invitations WHERE ${STALE_INVITATION_SQL}`)
        .run(now, now, now).changes;
      const states = this.db
        .prepare(`DELETE FROM auth_oauth_states WHERE ${STALE_OAUTH_STATE_SQL}`)
        .run(now, now).changes;
      return { sessions, invitations, states };
    });
    return run.immediate();
  }

  // ------------------------------------------------------------- oauth state

  /** Persist one authorization transaction (state + PKCE + optional invite hash). */
  createOauthState(input: {
    state: string;
    provider: string;
    codeVerifier: string;
    invitationHash: string | null;
    ttlMs: number;
  }): void {
    const now = new Date();
    const nowIso = now.toISOString();
    const run = this.db.transaction((): void => {
      this.db
        .prepare(`DELETE FROM auth_oauth_states WHERE ${STALE_OAUTH_STATE_SQL}`)
        .run(nowIso, nowIso);
      const active = this.db
        .prepare('SELECT COUNT(*) AS count FROM auth_oauth_states')
        .get() as { count: number };
      if (active.count >= MAX_ACTIVE_OAUTH_STATES) {
        throw new TooManyPendingOauthStatesError();
      }
      this.db
        .prepare(
          `INSERT INTO auth_oauth_states
             (state, provider, code_verifier, invitation_hash, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.state,
          input.provider,
          input.codeVerifier,
          input.invitationHash,
          nowIso,
          new Date(now.getTime() + input.ttlMs).toISOString()
        );
    });
    run.immediate();
  }

  /**
   * Consume a state: returns and DELETES the row in one statement, so a
   * replayed callback cannot reuse it even under concurrent requests.
   */
  consumeOauthState(state: string): { provider: string; codeVerifier: string; invitationHash: string | null } | null {
    const run = this.db.transaction((): { provider: string; codeVerifier: string; invitationHash: string | null } | null => {
      const row = this.db
        .prepare('SELECT * FROM auth_oauth_states WHERE state = ?')
        .get(state) as {
          provider: string;
          code_verifier: string;
          invitation_hash: string | null;
          created_at: string;
          expires_at: string;
        } | undefined;
      if (!row) return null;
      this.db.prepare('DELETE FROM auth_oauth_states WHERE state = ?').run(state);
      if (!liveWindow(row.created_at, row.expires_at, Date.now())) return null;
      return {
        provider: row.provider,
        codeVerifier: row.code_verifier,
        invitationHash: row.invitation_hash,
      };
    });
    return run.immediate();
  }

  // ------------------------------------------------------------------ reads

  /** Stable operator/client catalogue of organisations. */
  listOrganisations(): OrganisationRecord[] {
    return (this.db
      .prepare('SELECT * FROM auth_organisations ORDER BY created_at ASC, org_id ASC')
      .all() as OrganisationRow[]).map((organisation) => ({
      orgId: organisation.org_id,
      name: organisation.name,
      createdAt: organisation.created_at,
    }));
  }

  /**
   * Organisations with their members.
   *
   * With no argument this is the platform-admin inventory (gate on
   * `platformAdmin`). With `orgId` it is the SAME projection narrowed to one
   * organisation, which is what a member's own org card needs — one SQL shape
   * for both readers rather than a near-duplicate query that can drift.
   *
   * Members carry the operator flag and whether they have an avatar; they do
   * NOT carry emails. Provider emails are display attributes and GitHub's is
   * not a verified-email assertion, so they are not org-directory data.
   */
  listOrganisationsWithMembers(orgId?: string): Array<{
    orgId: string;
    name: string;
    createdAt: string;
    members: OrganisationMember[];
  }> {
    const members = this.db
      .prepare(
        `SELECT m.org_id, m.principal_id, m.role, m.created_at, p.display_name,
                a.etag AS avatar_etag,
                CASE WHEN pa.principal_id IS NULL THEN 0 ELSE 1 END AS platform_admin
         FROM auth_memberships m
         JOIN auth_principals p ON p.principal_id = m.principal_id
         LEFT JOIN auth_avatars a ON a.principal_id = m.principal_id
         LEFT JOIN auth_platform_admins pa ON pa.principal_id = m.principal_id
         WHERE (? IS NULL OR m.org_id = ?)
         ORDER BY m.org_id ASC, m.created_at ASC, m.principal_id ASC`
      )
      .all(orgId ?? null, orgId ?? null) as Array<{
        org_id: string;
        principal_id: string;
        role: OrgRole;
        created_at: string;
        display_name: string;
        avatar_etag: string | null;
        platform_admin: number;
      }>;
    const byOrg = new Map<string, OrganisationMember[]>();
    for (const member of members) {
      const list = byOrg.get(member.org_id) ?? [];
      list.push({
        principalId: member.principal_id,
        displayName: member.display_name,
        role: member.role,
        joinedAt: member.created_at,
        platformAdmin: member.platform_admin === 1,
        avatarEtag: member.avatar_etag,
      });
      byOrg.set(member.org_id, list);
    }
    return this.listOrganisations()
      .filter((organisation) => orgId === undefined || organisation.orgId === orgId)
      .map((organisation) => ({
        ...organisation,
        members: byOrg.get(organisation.orgId) ?? [],
      }));
  }

  /** One organisation with its members, or null when it does not exist. */
  getOrganisationWithMembers(orgId: string): {
    orgId: string;
    name: string;
    createdAt: string;
    members: OrganisationMember[];
  } | null {
    return this.listOrganisationsWithMembers(orgId)[0] ?? null;
  }

  /** Live (unconsumed, unexpired) invitations an organisation still holds. */
  countLiveInvitations(orgId: string): number {
    const nowMs = Date.now();
    const rows = this.db
      .prepare(
        `SELECT created_at, expires_at FROM auth_invitations
         WHERE org_id = ? AND consumed_at IS NULL`
      )
      .all(orgId) as Array<{ created_at: string; expires_at: string }>;
    return rows.filter((row) => liveWindow(row.created_at, row.expires_at, nowMs)).length;
  }

  /** True when both principals share at least one organisation. */
  sharesOrganisation(principalId: string, otherPrincipalId: string): boolean {
    if (principalId === otherPrincipalId) return true;
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM auth_memberships a
           JOIN auth_memberships b ON b.org_id = a.org_id
           WHERE a.principal_id = ? AND b.principal_id = ?
           LIMIT 1`
        )
        .get(principalId, otherPrincipalId)
    );
  }

  // -------------------------------------------------------- account self-care

  /**
   * Rename the account. Sets `display_name_source = 'user'`, which is what
   * stops the next provider login from overwriting the choice (see the guard
   * in `completeLogin`).
   */
  setDisplayName(principalId: string, name: string): string {
    const normalized = name.trim();
    if (normalized.length === 0 || normalized.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new Error('a display name must be 1 to 120 characters');
    }
    if (hasControlCharacters(normalized)) {
      throw new Error('a display name must not contain control characters');
    }
    const changed = this.db
      .prepare(
        `UPDATE auth_principals
         SET display_name = ?, display_name_source = 'user'
         WHERE principal_id = ?`
      )
      .run(normalized, principalId);
    if (changed.changes !== 1) throw new Error('unknown principal');
    return normalized;
  }

  /**
   * Store the downloaded provider picture. `sourceUrl` is remembered so a
   * later login only re-downloads when the provider actually changed it, and
   * `etag` (a content hash) drives both cache validation and the URL the
   * client uses, so a new picture busts the browser cache.
   */
  saveAvatar(input: {
    principalId: string;
    mime: AvatarMime;
    bytes: Buffer;
    sourceUrl: string | null;
  }): string {
    const etag = createHash('sha256').update(input.bytes).digest('hex');
    this.db
      .prepare(
        `INSERT INTO auth_avatars (principal_id, mime, bytes, source_url, etag, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(principal_id) DO UPDATE SET
           mime = excluded.mime,
           bytes = excluded.bytes,
           source_url = excluded.source_url,
           etag = excluded.etag,
           updated_at = excluded.updated_at`
      )
      .run(
        input.principalId,
        input.mime,
        input.bytes,
        input.sourceUrl,
        etag,
        new Date().toISOString()
      );
    return etag;
  }

  readAvatar(principalId: string): { mime: AvatarMime; bytes: Buffer; etag: string } | null {
    const row = this.db
      .prepare('SELECT mime, bytes, etag FROM auth_avatars WHERE principal_id = ?')
      .get(principalId) as { mime: AvatarMime; bytes: Buffer; etag: string } | undefined;
    return row ? { mime: row.mime, bytes: row.bytes, etag: row.etag } : null;
  }

  /** Metadata only — no BLOB read. Used to decide whether to re-download. */
  avatarMeta(principalId: string): { etag: string; sourceUrl: string | null } | null {
    const row = this.db
      .prepare('SELECT etag, source_url FROM auth_avatars WHERE principal_id = ?')
      .get(principalId) as { etag: string; source_url: string | null } | undefined;
    return row ? { etag: row.etag, sourceUrl: row.source_url } : null;
  }

  /**
   * The viewer's per-tier model pins. A row whose stored value is no longer an
   * allowed choice reads as `null` (operator default) rather than throwing: a
   * retired model id must degrade to the default, never break the account
   * page or a run launch.
   */
  modelPins(principalId: string): TierModelPins {
    const row = this.db
      .prepare(
        'SELECT model_l1, model_l2, model_l3 FROM auth_principal_model_pins WHERE principal_id = ?'
      )
      .get(principalId) as
      | { model_l1: string | null; model_l2: string | null; model_l3: string | null }
      | undefined;
    if (!row) return { ...EMPTY_TIER_MODEL_PINS };
    const parsed = accountTierModelPinsSchema.safeParse({
      l1: allowedPrincipalSelection(row.model_l1, 1),
      l2: allowedPrincipalSelection(row.model_l2, 2),
      l3: allowedPrincipalSelection(row.model_l3, 3),
    });
    return parsed.success ? parsed.data : { ...EMPTY_TIER_MODEL_PINS };
  }

  /**
   * SHAPE, not authority. This accepts the host-subscription sentinel because
   * the account level's value space admits it; whether THIS principal may name
   * it is the route's question, and whether a run may honour it is asked
   * again, per run, by the coordinator.
   */
  setModelPins(principalId: string, pins: unknown): TierModelPins {
    const parsed = accountTierModelPinsSchema.parse(pins);
    this.db
      .prepare(
        `INSERT INTO auth_principal_model_pins
           (principal_id, model_l1, model_l2, model_l3, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(principal_id) DO UPDATE SET
           model_l1 = excluded.model_l1,
           model_l2 = excluded.model_l2,
           model_l3 = excluded.model_l3,
           updated_at = excluded.updated_at`
      )
      .run(principalId, parsed.l1, parsed.l2, parsed.l3, new Date().toISOString());
    return parsed;
  }

  /**
   * PERSONAL SUBSCRIPTION RECEIPTS — pointers, never credentials.
   *
   * The provider CLI owns the credential bytes under a private host path.
   * SQLite records only which opaque generation is current so replacing a
   * profile is atomic and a run can bind to the exact generation selected at
   * launch. No email, plan, device code, token or path is stored here.
   */
  principalSubscription(
    principalIdInput: string,
    providerInput: AccountSubscriptionProvider
  ): PrincipalSubscriptionReceipt | null {
    const principalId = principalIdSchema.parse(principalIdInput);
    const provider = accountSubscriptionProviderSchema.parse(providerInput);
    const row = this.db
      .prepare(
        `SELECT principal_id, provider, profile_id, state, connected_at,
                last_verified_at, updated_at
         FROM auth_principal_subscriptions
         WHERE principal_id = ? AND provider = ?`
      )
      .get(principalId, provider) as
      | {
          principal_id: string;
          provider: AccountSubscriptionProvider;
          profile_id: string;
          state: 'connected' | 'reauth_required';
          connected_at: string;
          last_verified_at: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    const profileId = accountSubscriptionProfileIdSchema.parse(row.profile_id);
    if (
      row.principal_id !== principalId ||
      row.provider !== provider ||
      storedInstantMs(row.connected_at) === null ||
      storedInstantMs(row.updated_at) === null ||
      (row.last_verified_at !== null && storedInstantMs(row.last_verified_at) === null)
    ) {
      throw new Error('stored principal subscription receipt is invalid');
    }
    return {
      principalId,
      provider,
      profileId,
      state: row.state,
      connectedAt: row.connected_at,
      lastVerifiedAt: row.last_verified_at,
      updatedAt: row.updated_at,
    };
  }

  setPrincipalSubscription(input: {
    readonly principalId: string;
    readonly provider: AccountSubscriptionProvider;
    readonly profileId: string;
  }): PrincipalSubscriptionReceipt {
    const principalId = principalIdSchema.parse(input.principalId);
    const provider = accountSubscriptionProviderSchema.parse(input.provider);
    const profileId = accountSubscriptionProfileIdSchema.parse(input.profileId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO auth_principal_subscriptions
           (principal_id, provider, profile_id, state, connected_at, last_verified_at, updated_at)
         VALUES (?, ?, ?, 'connected', ?, ?, ?)
         ON CONFLICT(principal_id, provider) DO UPDATE SET
           profile_id = excluded.profile_id,
           state = 'connected',
           connected_at = excluded.connected_at,
           last_verified_at = excluded.last_verified_at,
           updated_at = excluded.updated_at`
      )
      .run(principalId, provider, profileId, now, now, now);
    const receipt = this.principalSubscription(principalId, provider);
    if (!receipt) throw new Error('principal subscription receipt was not stored');
    return receipt;
  }

  markPrincipalSubscriptionVerified(
    principalIdInput: string,
    providerInput: AccountSubscriptionProvider,
    state: 'connected' | 'reauth_required',
    expectedProfileIdInput: string
  ): PrincipalSubscriptionReceipt | null {
    const principalId = principalIdSchema.parse(principalIdInput);
    const provider = accountSubscriptionProviderSchema.parse(providerInput);
    const expectedProfileId = accountSubscriptionProfileIdSchema.parse(expectedProfileIdInput);
    if (state !== 'connected' && state !== 'reauth_required') {
      throw new Error('invalid principal subscription state');
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE auth_principal_subscriptions
         SET state = ?, last_verified_at = ?, updated_at = ?
         WHERE principal_id = ? AND provider = ? AND profile_id = ?`
      )
      .run(state, now, now, principalId, provider, expectedProfileId);
    return this.principalSubscription(principalId, provider);
  }

  deletePrincipalSubscription(
    principalIdInput: string,
    providerInput: AccountSubscriptionProvider
  ): PrincipalSubscriptionReceipt | null {
    const principalId = principalIdSchema.parse(principalIdInput);
    const provider = accountSubscriptionProviderSchema.parse(providerInput);
    const remove = this.db.transaction((): PrincipalSubscriptionReceipt | null => {
      const receipt = this.principalSubscription(principalId, provider);
      if (receipt) {
        this.db
          .prepare(
            'DELETE FROM auth_principal_subscriptions WHERE principal_id = ? AND provider = ?'
          )
          .run(principalId, provider);
      }
      if (provider === 'codex') {
        // Every `own:openai:` selector this principal stored, whatever the model.
        const prefix = 'own:openai:%';
        this.db
          .prepare(
            `UPDATE auth_principal_model_pins
             SET model_l1 = CASE WHEN model_l1 LIKE ? THEN NULL ELSE model_l1 END,
                 model_l2 = CASE WHEN model_l2 LIKE ? THEN NULL ELSE model_l2 END,
                 model_l3 = CASE WHEN model_l3 LIKE ? THEN NULL ELSE model_l3 END,
                 updated_at = ?
             WHERE principal_id = ?`
          )
          .run(prefix, prefix, prefix, new Date().toISOString(), principalId);
      }
      return receipt;
    });
    return remove.immediate();
  }

  /**
   * ORG TIER DEFAULTS — what members without their own pin inherit.
   *
   * Read fail-open and written validated: a stored selection the catalogue no
   * longer offers degrades to `null` exactly like an account pin, so a
   * retired model can never block run launch. Written only through
   * `roleAtLeast('org:admin')` HTTP paths; this store verifies SHAPE, the
   * route verifies AUTHORITY.
   */
  orgTierModels(orgId: string): TierModelPins {
    const row = this.db
      .prepare(
        'SELECT model_l1, model_l2, model_l3 FROM auth_org_tier_models WHERE org_id = ?'
      )
      .get(orgId) as
      | { model_l1: string | null; model_l2: string | null; model_l3: string | null }
      | undefined;
    if (!row) return { ...EMPTY_TIER_MODEL_PINS };
    const parsed = tierModelPinsSchema.safeParse({
      l1: allowedStoredSelection(row.model_l1),
      l2: allowedStoredSelection(row.model_l2),
      l3: allowedStoredSelection(row.model_l3),
    });
    return parsed.success ? parsed.data : { ...EMPTY_TIER_MODEL_PINS };
  }

  setOrgTierModels(orgId: string, pins: unknown): TierModelPins {
    const organisation = this.db
      .prepare('SELECT 1 FROM auth_organisations WHERE org_id = ?')
      .get(orgId);
    if (!organisation) throw new Error('organisation not found');
    const parsed = tierModelPinsSchema.parse(pins);
    this.db
      .prepare(
        `INSERT INTO auth_org_tier_models
           (org_id, model_l1, model_l2, model_l3, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET
           model_l1 = excluded.model_l1,
           model_l2 = excluded.model_l2,
           model_l3 = excluded.model_l3,
           updated_at = excluded.updated_at`
      )
      .run(orgId, parsed.l1, parsed.l2, parsed.l3, new Date().toISOString());
    return parsed;
  }

  /** Every organisation a principal may activate, in deterministic order. */
  listOrganisationsForPrincipal(principalId: string): OrganisationMembership[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, o.name AS org_name
         FROM auth_memberships m
         JOIN auth_organisations o ON o.org_id = m.org_id
         WHERE m.principal_id = ?
         ORDER BY m.created_at ASC, m.org_id ASC`
      )
      .all(principalId) as Array<MembershipRow & { org_name: string }>;
    return rows.map((membership) => ({
      orgId: membership.org_id,
      orgName: membership.org_name,
      role: membership.role,
      createdAt: membership.created_at,
    }));
  }

  /** Operator view (`atoma auth list`): every principal with its links. */
  listPrincipals(): Array<{
    principalId: string;
    kind: PrincipalKind;
    displayName: string;
    createdAt: string;
    memberships: OrganisationMembership[];
    /** Compatibility projection of the first deterministic membership. */
    orgName: string | null;
    /** Compatibility projection of the first deterministic membership. */
    role: OrgRole | null;
    identities: Array<{ provider: string; subject: string; email: string | null; linkedAt: string }>;
  }> {
    const principals = this.db
      .prepare('SELECT * FROM auth_principals ORDER BY created_at ASC')
      .all() as PrincipalRow[];
    const identities = this.db
      .prepare('SELECT * FROM auth_identities ORDER BY linked_at ASC')
      .all() as Array<{ provider: string; provider_subject: string; principal_id: string; email: string | null; linked_at: string }>;
    return principals.map((p) => {
      const memberships = this.listOrganisationsForPrincipal(p.principal_id);
      const firstMembership = memberships[0];
      return {
        principalId: p.principal_id,
        kind: p.kind,
        displayName: p.display_name,
        createdAt: p.created_at,
        memberships,
        orgName: firstMembership?.orgName ?? null,
        role: firstMembership?.role ?? null,
        identities: identities
          .filter((i) => i.principal_id === p.principal_id)
          .map((i) => ({ provider: i.provider, subject: i.provider_subject, email: i.email, linkedAt: i.linked_at })),
      };
    });
  }

  /**
   * ORG PROVIDER KEYS — BYO-key credentials at rest.
   *
   * Written and read through the shared AES-256-GCM mechanics; the envelope
   * is authenticated against (org, provider, key generation) via the AAD
   * builder, so a row copied to another org/provider never decrypts. The
   * plaintext exists only inside the call that injects it into a run
   * child's environment; this store hands back envelopes only.
   *
   * `decryption` injected: the HTTP/CLI boundary resolves it once per
   * process from operator env (`resolveSecretEncryption`); without it the
   * store still persists rows but cannot hand anyone a usable key, which is
   * exactly the degraded mode an unconfigured deployment should have.
   */
  setOrgProviderKey(input: {
    readonly orgId: string;
    readonly provider: ProviderKeyProvider;
    /** Plaintext credential; must survive one printable-ASCII round-trip like any API key. */
    readonly plaintext: string;
    readonly encryption: SecretEncryptionContext;
  }): void {
    const trimmed = input.plaintext.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > MAX_PROVIDER_KEY_CHARS ||
      [...trimmed].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 33 || code === 127;
      })
    ) {
      throw new Error('provider key has an invalid format');
    }
    const envelope = encryptBoundSecret({
      plaintext: trimmed,
      key: input.encryption.key,
      keyId: input.encryption.keyId,
      aad: providerKeyAad({
        orgId: input.orgId,
        provider: input.provider,
        keyId: input.encryption.keyId,
      }),
    });
    this.db
      .prepare(
        `INSERT INTO auth_org_provider_keys (org_id, provider, envelope, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(org_id, provider) DO UPDATE SET
           envelope = excluded.envelope,
           updated_at = excluded.updated_at`
      )
      .run(
        input.orgId,
        input.provider,
        JSON.stringify(envelope),
        new Date().toISOString()
      );
  }

  deleteOrgProviderKey(orgId: string, provider: ProviderKeyProvider): boolean {
    return (
      this.db
        .prepare('DELETE FROM auth_org_provider_keys WHERE org_id = ? AND provider = ?')
        .run(orgId, provider).changes > 0
    );
  }

  listOrgProviderKeys(orgId: string): OrgProviderKeyStatus[] {
    const rows = this.db
      .prepare('SELECT provider, updated_at FROM auth_org_provider_keys WHERE org_id = ?')
      .all(orgId) as Array<{ provider: ProviderKeyProvider; updated_at: string }>;
    // Envelope bytes are NEVER listed; presence + timestamp only.
    return rows.map((row) => ({
      provider: row.provider,
      configuredAt: row.updated_at,
    }));
  }

  /**
   * Resolve one provider's usable credential for THIS org, or null when the
   * org has none or no decryption context exists (fail-open into the run).
   * Ciphertext tampering surfaces as a stderr warning + null: one corrupt
   * row must not fail the run that merely PREFERRED this provider.
   */
  decryptOrgProviderKey(
    orgId: string,
    provider: ProviderKeyProvider,
    decryption: SecretEncryptionContext | null
  ): string | null {
    if (!decryption) return null;
    const row = this.db
      .prepare(
        'SELECT envelope FROM auth_org_provider_keys WHERE org_id = ? AND provider = ?'
      )
      .get(orgId, provider) as { envelope: string } | undefined;
    if (!row) return null;
    try {
      const plaintext = decryptBoundSecret({
        envelope: JSON.parse(row.envelope) as unknown,
        key: decryption.key,
        keyId: decryption.keyId,
        aad: providerKeyAad({ orgId, provider, keyId: decryption.keyId }),
      });
      return plaintext.length > 0 ? plaintext : null;
    } catch (error) {
      process.stderr.write(
        `[atoma auth] org ${orgId} provider key for ${provider} could not be decrypted; ` +
          'run falls back without it. Was ATOMA_SECRET_ENCRYPTION_KEY rotated? ' +
          `${String(error)}\n`
      );
      return null;
    }
  }

  close(): void {
    // Normal stores belong to openStoreHandle's cache; only the explicit
    // read-only operator handle is owned by this instance.
    if (this.closeOnClose) this.db.close();
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
