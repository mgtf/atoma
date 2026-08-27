import { createHash, createSecretKey, type KeyObject } from 'node:crypto';
import {
  isValidSecretKeyId,
  secretEncryptionKeyFromText,
} from '../core/secretCrypto.js';

/**
 * THE OPERATOR'S SECRET-ENCRYPTION CONTEXT FOR STORED ORG KEYS.
 * ============================================================
 *
 * Organisation provider API keys live encrypted in the consolidated store
 * (`auth_org_provider_keys`). The key that unlocks them NEVER lives there:
 * it is host configuration, resolved ONCE per process from the operator's
 * environment, exactly the launch-time host-sourced-policy pattern of
 * `ATOMA_REQUIRE_ISOLATION` and the GitHub App token key.
 *
 * Absent dedicated variable falls back to `ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY`
 * (already required on a gated GitHub-App checkout) so org key management
 * is not a second operator secret. Production may still set the dedicated
 * variable to isolate the two wrapping keys. Absent both means org key
 * MANAGEMENT is unavailable (the routes say so); stored rows remain
 * undecryptable until the same key returns — which is why rotation policy
 * belongs to the operator, not this module.
 */

export const SECRET_ENCRYPTION_ENV = 'ATOMA_SECRET_ENCRYPTION_KEY' as const;
export const SECRET_ENCRYPTION_KEY_ID_ENV = 'ATOMA_SECRET_ENCRYPTION_KEY_ID' as const;

/** 32 secret bytes plus the stable id stamped into every envelope/AAD. */
export interface SecretEncryptionContext {
  readonly key: KeyObject;
  readonly keyId: string;
}

/**
 * Resolve the context from host env, or `null` when the operator has not
 * configured one. An explicitly given key id must match the id grammar;
 * the default id is derived from the key bytes so two deployments cannot
 * cross-decrypt by accident.
 */
export function resolveSecretEncryption(
  env: NodeJS.ProcessEnv
): SecretEncryptionContext | null {
  const raw =
    env[SECRET_ENCRYPTION_ENV]?.trim() ||
    env['ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY']?.trim();
  if (!raw) return null;
  const bytes = secretEncryptionKeyFromText(raw);
  const requestedKeyId =
    env[SECRET_ENCRYPTION_KEY_ID_ENV]?.trim() ||
    env['ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY_ID']?.trim();
  if (requestedKeyId !== undefined && !isValidSecretKeyId(requestedKeyId)) {
    throw new Error(`${SECRET_ENCRYPTION_KEY_ID_ENV} has an invalid value`);
  }
  const keyId =
    requestedKeyId && requestedKeyId.length > 0
      ? requestedKeyId
      : createHash('sha256').update(bytes).digest('base64url').slice(0, 16);
  return { key: createSecretKey(bytes), keyId };
}

/**
 * The consumer-owned ADDITIONAL AUTHENTICATED DATA sentence for one org
 * provider key. It binds an envelope to its organisation, provider AND
 * encryption key, so a row copied across orgs/providers — or re-encrypted
 * under another key generation — fails authentication instead of yielding
 * the wrong tenant's credential.
 */
export function providerKeyAad(input: {
  readonly orgId: string;
  readonly provider: string;
  readonly keyId: string;
}): string {
  const parts = [input.orgId, input.provider, input.keyId];
  if (
    parts.some((part) => !part || part.length > 255) ||
    [...parts.join('')].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 33 || code === 127;
    })
  ) {
    throw new Error('provider key binding has an invalid value');
  }
  return `atoma:llm-provider-key:v1:${parts.join(':')}`;
}
