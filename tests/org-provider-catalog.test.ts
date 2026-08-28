import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSecretKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
import {
  decryptBoundSecret,
  encryptBoundSecret,
  isValidSecretKeyId,
  parseEncryptedSecretEnvelope,
  parseEncryptionKeyBytes,
  secretEncryptionKeyFromText,
} from '../src/core/secretCrypto.js';
import {
  LLM_PROVIDER_CATALOG,
  llmProviderIds,
  isValidTierModelSelection,
  orgHasBilledProviderKey,
  orgProviderIsReady,
  tierModelSelectionLabel,
} from '../src/core/providerCatalog.js';

describe('shared secret envelope', () => {
  const key = createSecretKey(Buffer.alloc(32, 9));
  const aad = 'atoma:test:v1:org-1:zai:key-1';

  it('round-trips a bound envelope', () => {
    const envelope = encryptBoundSecret({
      plaintext: 'sk-live-provider-key',
      key,
      keyId: 'key-1',
      aad,
    });
    expect(envelope).toMatchObject({ version: 1, algorithm: 'A256GCM', keyId: 'key-1' });
    expect(JSON.stringify(envelope)).not.toContain('sk-live-provider-key');
    const plaintext = decryptBoundSecret({ envelope, key, keyId: 'key-1', aad });
    expect(plaintext).toBe('sk-live-provider-key');
  });

  it('fails authentication under different AAD, key or id', () => {
    const envelope = encryptBoundSecret({
      plaintext: 'secret',
      key,
      keyId: 'key-1',
      aad,
    });
    expect(() =>
      decryptBoundSecret({ envelope, key, keyId: 'key-1', aad: 'atoma:test:v1:org-2:zai:key-1' })
    ).toThrow(/authentication failed/);
    expect(() =>
      decryptBoundSecret({
        envelope,
        key,
        keyId: 'key-2',
        aad,
      })
    ).toThrow(/binding|authentication failed|invalid shape/);
  });

  it('refuses extra members and unknown versions on parse', () => {
    const envelope = encryptBoundSecret({ plaintext: 's', key, keyId: 'k', aad });
    expect(() =>
      parseEncryptedSecretEnvelope({ ...envelope, kind: 'access' }, ['version'])
    ).toThrow(/invalid shape/);
    expect(() => parseEncryptedSecretEnvelope({ ...envelope, version: 2 }, ['version'])).toThrow(
      /unsupported version/
    );
  });
});

describe('operator encryption-key parsing', () => {
  it('keeps the strict GitHub spellings bit-for-bit', () => {
    const hex = Buffer.alloc(32, 3).toString('hex');
    expect(parseEncryptionKeyBytes(hex).length).toBe(32);
    const b64 = Buffer.alloc(32, 5).toString('base64url');
    expect(parseEncryptionKeyBytes(`base64url:${b64}`).length).toBe(32);
    expect(() => parseEncryptionKeyBytes('too-short')).toThrow(/64 hex characters/);
  });

  it('hashes long passphrases for the org-key variable', () => {
    const derived = secretEncryptionKeyFromText('a sufficiently long operator passphrase!!');
    expect(derived.length).toBe(32);
    expect(() => secretEncryptionKeyFromText('short')).toThrow(/32 bytes/);
    expect(isValidSecretKeyId('key-2026-08')).toBe(true);
    expect(isValidSecretKeyId('../escape')).toBe(false);
  });

  it('says out loud, where an operator sets it, what the passphrase form costs', () => {
    // 2026-08-27, finding 3.4. The passphrase form is a bare SHA-256 with no
    // stretching — a deliberate trade so a small deployment is not pushed into
    // inventing a weak "random" string, argued in `secretCrypto.ts`. What was
    // missing is the disclosure at the place the operator actually chooses:
    // a dictionary passphrase plus a copy of the SQLite file unwraps every
    // organisation's provider keys. Grep-level on purpose — the defect was an
    // absence of prose, and nothing behavioural can observe prose.
    const example = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
    // Sliced from the section heading, so the disclosure has to sit WITH the
    // variable rather than anywhere in the file.
    const section = example.slice(example.indexOf('Organisation BYO provider keys'));
    expect(section).toMatch(/plain SHA-256 of the text, with no stretching/);
    expect(section).toMatch(/dictionary against a memorable one/);
    // And it points at the form that does not have the weakness.
    expect(section).toMatch(/openssl rand -hex 32/);
    expect(section).toContain('ATOMA_SECRET_ENCRYPTION_KEY');
  });
});

describe('provider catalogue', () => {
  it('exposes exactly the credential-honouring providers', () => {
    expect(llmProviderIds()).toEqual(['anthropic', 'zai', 'ollama']);
    for (const provider of LLM_PROVIDER_CATALOG) {
      expect(provider.models.length).toBeGreaterThan(0);
      if (provider.suggestive) continue;
      // Non-suggestive providers list their built-in pins somewhere.
    }
    const anthropic = LLM_PROVIDER_CATALOG.find((provider) => provider.id === 'anthropic')!;
    expect(anthropic.models.map((model) => model.id)).toContain('claude-opus-5');
  });

  it('validates bare historical ids and full selectors symmetrically', () => {
    expect(isValidTierModelSelection('claude-haiku-4-5-20251001')).toBe(true);
    expect(isValidTierModelSelection('anthropic:claude-sonnet-5')).toBe(true);
    expect(isValidTierModelSelection('ollama:qwen3:8b')).toBe(true);
    expect(isValidTierModelSelection('claude-cli:whatever')).toBe(false);
    expect(isValidTierModelSelection('codex:gpt-5')).toBe(false);
    expect(isValidTierModelSelection('anthropic:not-a-model')).toBe(false);
    expect(isValidTierModelSelection('totally-unknown-model')).toBe(false);
    expect(tierModelSelectionLabel('zai:glm-4.5-air')).toContain('GLM');
  });

  it('unlocks billed providers only with a stored key, and Ollama always', () => {
    const none = new Set<string>();
    const zai = new Set(['zai']);
    const ollama = LLM_PROVIDER_CATALOG.find((provider) => provider.id === 'ollama')!;
    const anthropic = LLM_PROVIDER_CATALOG.find((provider) => provider.id === 'anthropic')!;
    expect(orgProviderIsReady(ollama, none)).toBe(true);
    expect(orgProviderIsReady(anthropic, none)).toBe(false);
    expect(orgProviderIsReady(anthropic, zai)).toBe(false);
    expect(orgHasBilledProviderKey(none)).toBe(false);
    expect(orgHasBilledProviderKey(zai)).toBe(true);
  });
});
