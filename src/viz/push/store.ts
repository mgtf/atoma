import type Database from 'better-sqlite3';
import { openStoreHandle, storeDbPath } from '../../core/stores.js';
import { asPushLocale, type PushLocale } from './routes.js';
import { fromBase64Url, generateVapidKeys, type VapidKeys } from './webpush.js';

/**
 * WEB PUSH STATE — one more table group on the ONE product store, joined via
 * `openStoreHandle` exactly like the projects and GitHub groups.
 *
 * `push_vapid_keys` is a single-row identity: the keypair is generated once
 * on first use and persisted, because rotating it silently would orphan every
 * browser subscription (`applicationServerKey` is pinned at subscribe time).
 * `push_subscriptions` rows are principal-scoped self-service: a browser can
 * only add or remove its own endpoints through the gated /api/push routes,
 * and a 404/410 from the push service prunes the row.
 */
export const PUSH_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS push_vapid_keys (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  -- The subscriber's language, captured at subscribe time. The server cannot
  -- infer it later: a push is generated with no request to read a header off.
  locale TEXT NOT NULL DEFAULT 'en',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_principal
  ON push_subscriptions(principal_id);
`;

const MAX_ENDPOINT_LENGTH = 2_048;
/** Browsers rarely hold more than a handful; bound abuse, keep the newest. */
export const MAX_SUBSCRIPTIONS_PER_PRINCIPAL = 10;

export interface PushSubscriptionRecord {
  readonly principalId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  /** Defaults to `en` when the browser sends nothing recognisable. */
  readonly locale?: string;
}

/** What the notifier reads back: locale resolved, never undefined. */
export interface StoredPushSubscription {
  readonly principalId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly locale: PushLocale;
}

interface SubscriptionRow {
  principal_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  locale: string | null;
}

function validateSubscription(input: PushSubscriptionRecord): void {
  if (!input.principalId) throw new Error('a subscription requires a principal');
  if (input.endpoint.length === 0 || input.endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw new Error('push endpoint length is out of bounds');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new Error('push endpoint is not a valid URL');
  }
  if (endpoint.protocol !== 'https:') throw new Error('push endpoints must be HTTPS');
  const p256dh = fromBase64Url(input.p256dh);
  if (p256dh.length !== 65 || p256dh[0] !== 0x04) {
    throw new Error('subscription p256dh must be a 65-byte uncompressed P-256 point');
  }
  if (fromBase64Url(input.auth).length !== 16) {
    throw new Error('subscription auth secret must be 16 bytes');
  }
}

export class PushStore {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static open(path?: string): PushStore {
    const db = openStoreHandle(path ?? storeDbPath(), PUSH_TABLES_DDL);
    // Additive column migration, the AuthStore pattern: `CREATE TABLE IF NOT
    // EXISTS` will not add `locale` to a table an earlier build created.
    const columns = db.prepare('PRAGMA table_info(push_subscriptions)').all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'locale')) {
      db.exec("ALTER TABLE push_subscriptions ADD COLUMN locale TEXT NOT NULL DEFAULT 'en'");
    }
    return new PushStore(db);
  }

  /**
   * The instance keypair, generated and persisted on first read. INSERT OR
   * IGNORE then re-read: two processes racing the first boot converge on one
   * keypair instead of each keeping its own in memory.
   */
  vapidKeys(): VapidKeys {
    const read = () =>
      this.db
        .prepare('SELECT public_key, private_key FROM push_vapid_keys WHERE id = 1')
        .get() as { public_key: string; private_key: string } | undefined;
    let row = read();
    if (!row) {
      const generated = generateVapidKeys();
      this.db
        .prepare(
          'INSERT OR IGNORE INTO push_vapid_keys (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)'
        )
        .run(generated.publicKey, generated.privateKey, new Date().toISOString());
      row = read();
      if (!row) throw new Error('failed to persist the VAPID keypair');
    }
    return { publicKey: row.public_key, privateKey: row.private_key };
  }

  /** Upsert by endpoint; ownership follows the latest authenticated saver. */
  saveSubscription(input: PushSubscriptionRecord): void {
    validateSubscription(input);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, principal_id, p256dh, auth, locale, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           principal_id = excluded.principal_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           locale = excluded.locale,
           updated_at = excluded.updated_at`
      )
      .run(
        input.endpoint,
        input.principalId,
        input.p256dh,
        input.auth,
        asPushLocale(input.locale),
        now,
        now
      );
    this.db
      .prepare(
        `DELETE FROM push_subscriptions
         WHERE principal_id = ? AND endpoint NOT IN (
           SELECT endpoint FROM push_subscriptions
           WHERE principal_id = ?
           ORDER BY updated_at DESC, endpoint DESC
           LIMIT ?
         )`
      )
      .run(input.principalId, input.principalId, MAX_SUBSCRIPTIONS_PER_PRINCIPAL);
  }

  /** Self-service removal: a principal can only delete its own row. */
  deleteSubscription(principalId: string, endpoint: string): boolean {
    const result = this.db
      .prepare('DELETE FROM push_subscriptions WHERE principal_id = ? AND endpoint = ?')
      .run(principalId, endpoint);
    return result.changes > 0;
  }

  /** Prune an endpoint the push service reported gone (404/410). */
  dropEndpoint(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  listForPrincipal(principalId: string): StoredPushSubscription[] {
    const rows = this.db
      .prepare(
        'SELECT principal_id, endpoint, p256dh, auth, locale FROM push_subscriptions WHERE principal_id = ? ORDER BY updated_at DESC, endpoint DESC'
      )
      .all(principalId) as SubscriptionRow[];
    return rows.map((row) => ({
      principalId: row.principal_id,
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
      locale: asPushLocale(row.locale),
    }));
  }
}
