import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSecretKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
import {
  chatGptSubscriptionModel,
  hostSubscriptionAlias,
  principalChatGptSubscriptionModel,
  selectionsMixCodexOwners,
} from '../src/contracts/runPayers.js';
import { transportOf, parseModelSelector } from '../src/contracts/modelSelector.js';
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
  HOST_SUBSCRIPTION_FAMILY,
  CHATGPT_SUBSCRIPTION_FAMILY,
  PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY,
  HOST_SUBSCRIPTION_FAMILIES,
  isAccountTierSelection,
  llmProviderIds,
  isValidTierModelSelection,
  orgHasBilledProviderKey,
  orgProviderIsReady,
  tierModelSelectionLabel,
} from '../src/core/providerCatalog.js';
import { providerIsUnlocked } from '../src/viz/client-gl/OrgModelsForm.js';
import type { VizLlmCatalogEntry } from '../src/viz/client/types.js';

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

describe('the subscriptions are neighbours, not catalogue members', () => {
  // Design 2026-08-28, D4. Three mechanisms read LLM_PROVIDER_CATALOG as
  // "things that may hold a key", and a subscription entry would break each
  // differently — `orgProviderIsReady` would report it always-ready to every
  // viewer, `resolveOrgProviderKeys` would need a widened ProviderKeyProvider
  // mirrored by a SQL CHECK, and `injectOrgProviderKeys` iterates the same
  // array.
  it('stays out of the catalogue that decides what may hold a key', () => {
    const ids: string[] = [...llmProviderIds()];
    expect(ids).toEqual(['anthropic', 'openai', 'zai', 'ollama']);
    for (const family of [HOST_SUBSCRIPTION_FAMILY, CHATGPT_SUBSCRIPTION_FAMILY, PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY]) {
      expect(ids).not.toContain(String(family.id));
      expect(LLM_PROVIDER_CATALOG.map((entry) => entry.selectorPrefix)).not.toContain(family.selectorPrefix);
    }
  });

  it('is storable at the ACCOUNT level and nowhere else', () => {
    // The org space is `api:` only: a payer-bearing default inherited by every
    // member is the thing this design refuses.
    expect(isValidTierModelSelection('sub:anthropic:opus')).toBe(false);
    expect(isAccountTierSelection('sub:anthropic:opus')).toBe(true);
    expect(isAccountTierSelection('sub:openai:gpt-5.6-sol', 2)).toBe(true);
    expect(isAccountTierSelection('sub:openai:gpt-5.6-sol', 1)).toBe(true);
    // The pre-2026-09-07 spellings are not selectors at all.
    expect(isAccountTierSelection('claude-cli:opus')).toBe(false);
    expect(isAccountTierSelection('host-subscription:opus')).toBe(false);
    expect(isAccountTierSelection('api:anthropic:claude-opus-5')).toBe(true);
  });

  it('names a family, never a dated generation', () => {
    // The transport serves opus/sonnet/haiku and reports the alias back, so a
    // version number here would be a promise it cannot keep (Q2).
    expect(HOST_SUBSCRIPTION_FAMILY.models.map((model) => model.id)).toEqual([
      'opus',
      'sonnet',
      'haiku',
    ]);
    expect(tierModelSelectionLabel('sub:anthropic:opus')).toBe(
      'Claude (host subscription) — Opus'
    );
    expect(hostSubscriptionAlias('sub:anthropic:sonnet')).toBe('sonnet');
    expect(hostSubscriptionAlias('sub:anthropic:gpt')).toBeNull();
    expect(hostSubscriptionAlias('api:anthropic:claude-opus-5')).toBeNull();
  });

  it('offers ChatGPT as a distinct supervisor-only subscription family', () => {
    expect(HOST_SUBSCRIPTION_FAMILIES.map((family) => family.id)).toEqual([
      'sub:anthropic',
      'sub:openai',
    ]);
    expect(CHATGPT_SUBSCRIPTION_FAMILY.models.every((model) => model.tiers?.includes(2))).toBe(true);
    expect(CHATGPT_SUBSCRIPTION_FAMILY.models.every((model) => model.tiers?.includes(3))).toBe(true);
    expect(chatGptSubscriptionModel('sub:openai:gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(transportOf(parseModelSelector('sub:openai:gpt-5.6-terra'))).toBe('codex-cli');
    expect(tierModelSelectionLabel('sub:openai:gpt-5.6-sol')).toBe(
      'ChatGPT (host subscription) — GPT-5.6 Sol'
    );
    const family = CHATGPT_SUBSCRIPTION_FAMILY as unknown as VizLlmCatalogEntry;
    expect(
      providerIsUnlocked(family, new Set(), {
        billedKeyReady: false,
        ollamaAvailable: false,
        hostSubscriptions: [{ family }],
      })
    ).toBe(true);
    expect(
      providerIsUnlocked(family, new Set(), {
        billedKeyReady: true,
        ollamaAvailable: true,
        hostSubscriptions: [{ family, reason: 'undeclared' }],
      })
    ).toBe(false);
  });

  it("keeps a requester's ChatGPT subscription distinct from the host payer", () => {
    expect(PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY.models.every((model) =>
      model.tiers?.includes(2)
    )).toBe(true);
    expect(PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY.models.every((model) =>
      model.tiers?.includes(3)
    )).toBe(true);
    expect(isAccountTierSelection('own:openai:gpt-5.6-sol', 2)).toBe(true);
    expect(isAccountTierSelection('own:openai:gpt-5.6-sol', 1)).toBe(true);
    expect(principalChatGptSubscriptionModel('own:openai:gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(transportOf(parseModelSelector('own:openai:gpt-5.6-sol'))).toBe('codex-cli');
    expect(tierModelSelectionLabel('own:openai:gpt-5.6-sol')).toBe(
      'ChatGPT (your subscription) — GPT-5.6 Sol'
    );
    expect(selectionsMixCodexOwners(['sub:openai:gpt-5.6-sol', 'own:openai:gpt-5.6-terra'])).toBe(true);
    expect(selectionsMixCodexOwners(['sub:anthropic:sonnet', 'own:openai:gpt-5.6-terra'])).toBe(false);
  });
});

describe('provider catalogue', () => {
  it('exposes exactly the API vendors, each with the selector prefix the picker prepends', () => {
    expect(llmProviderIds()).toEqual(['anthropic', 'openai', 'zai', 'ollama']);
    for (const provider of LLM_PROVIDER_CATALOG) {
      expect(provider.models.length).toBeGreaterThan(0);
      expect(provider.selectorPrefix).toBe(`api:${provider.id}`);
    }
    const anthropic = LLM_PROVIDER_CATALOG.find((provider) => provider.id === 'anthropic')!;
    expect(anthropic.models.map((model) => model.id)).toContain('claude-opus-5');
    // OpenAI by API hosts the tool loop, so its models carry no tier restriction.
    const openai = LLM_PROVIDER_CATALOG.find((provider) => provider.id === 'openai')!;
    expect(openai.credentialEnvVar).toBe('OPENAI_API_KEY');
    expect(openai.models.every((model) => model.tiers === undefined)).toBe(true);
  });

  it('validates full api: selectors and nothing else', () => {
    expect(isValidTierModelSelection('api:anthropic:claude-haiku-4-5-20251001')).toBe(true);
    expect(isValidTierModelSelection('api:anthropic:claude-sonnet-5')).toBe(true);
    expect(isValidTierModelSelection('api:openai:gpt-5.4-mini')).toBe(true);
    expect(isValidTierModelSelection('api:ollama:qwen3:8b')).toBe(true);
    // Bare ids and the old `vendor:model` spelling are not selectors.
    expect(isValidTierModelSelection('claude-haiku-4-5-20251001')).toBe(false);
    expect(isValidTierModelSelection('anthropic:claude-sonnet-5')).toBe(false);
    expect(isValidTierModelSelection('claude-cli:whatever')).toBe(false);
    expect(isValidTierModelSelection('codex:gpt-5')).toBe(false);
    expect(isValidTierModelSelection('api:anthropic:not-a-model')).toBe(false);
    expect(isValidTierModelSelection('totally-unknown-model')).toBe(false);
    expect(tierModelSelectionLabel('api:zai:glm-4.5-air')).toContain('GLM');
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
