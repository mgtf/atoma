import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyTierPins, modelForTier, selectorForTier } from '../src/core/models.js';
import { ModelSelectorError } from '../src/contracts/modelSelector.js';
import { ANTHROPIC_PINS, PIN_HAIKU, PIN_SONNET, FALLBACK_OPUS } from './tier-pins.js';
import { resolveOllamaModel } from '../src/core/llmOllama.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom } from '../src/atoms/L3Atom.js';

/**
 * Per-tier model selection. The unit of configuration is the TIER — decreasing
 * model power L3→L1 is the project's thesis — so the env vars are named by
 * tier (ATOMA_MODEL_L1/L2/L3), each holds one full `<mode>:<vendor>:<model>`
 * selector, and since 2026-09-07 all three are REQUIRED: there is no default.
 */
describe('modelForTier — three required selectors, no default', () => {
  const VARS = ['ATOMA_MODEL_L1', 'ATOMA_MODEL_L2', 'ATOMA_MODEL_L3'];
  let saved: (string | undefined)[];
  beforeEach(() => {
    saved = VARS.map((v) => process.env[v]);
    for (const v of VARS) delete process.env[v];
  });
  afterEach(() => {
    VARS.forEach((v, i) => {
      if (saved[i] === undefined) delete process.env[v];
      else process.env[v] = saved[i];
    });
  });

  it('returns each tier\'s selector verbatim', () => {
    Object.assign(process.env, ANTHROPIC_PINS);
    expect(modelForTier(1)).toBe(PIN_HAIKU);
    expect(modelForTier(2)).toBe(PIN_SONNET);
    expect(modelForTier(3)).toBe(FALLBACK_OPUS);
    expect(selectorForTier(1)).toEqual({
      mode: 'api',
      vendor: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('an unset tier is a configuration error naming the variable — never a silent default', () => {
    Object.assign(process.env, ANTHROPIC_PINS);
    delete process.env['ATOMA_MODEL_L3'];
    expect(() => modelForTier(3)).toThrow(ModelSelectorError);
    expect(() => modelForTier(3)).toThrow(/ATOMA_MODEL_L3 is not set.*there is no default/);
    // The other tiers are unaffected: the gradient is three independent pins.
    expect(modelForTier(1)).toBe(PIN_HAIKU);
  });

  it('refuses the pre-2026-09-07 spellings with the grammar in the message', () => {
    for (const legacy of ['claude-sonnet-5', 'zai:glm-4.5-air', 'claude-cli:sonnet', 'codex:gpt-5.6-sol', 'host-subscription:opus']) {
      process.env['ATOMA_MODEL_L2'] = legacy;
      expect(() => modelForTier(2)).toThrow(/ATOMA_MODEL_L2=.* is not a model selector|names mode/);
    }
    process.env['ATOMA_MODEL_L2'] = 'api:mistral:large';
    expect(() => modelForTier(2)).toThrow(/names vendor "mistral"/);
    process.env['ATOMA_MODEL_L2'] = 'sub:zai:glm-4.5';
    expect(() => modelForTier(2)).toThrow(/zai has no subscription/);
    process.env['ATOMA_MODEL_L2'] = 'api:zai:';
    expect(() => modelForTier(2)).toThrow(/names no model/);
  });

  it('one tier can be remapped WITHOUT touching the gradient below it', () => {
    Object.assign(process.env, ANTHROPIC_PINS, { ATOMA_MODEL_L3: 'sub:anthropic:sonnet' });
    expect(modelForTier(3)).toBe('sub:anthropic:sonnet');
    expect(modelForTier(2)).toBe(PIN_SONNET);
    expect(modelForTier(1)).toBe(PIN_HAIKU);
  });

  it('accepts every vendor the grammar names — the vars are vendor-neutral', () => {
    process.env['ATOMA_MODEL_L1'] = 'api:ollama:qwen3:4b';
    process.env['ATOMA_MODEL_L2'] = 'api:zai:glm-4.7';
    process.env['ATOMA_MODEL_L3'] = 'api:openai:gpt-5.6-sol';
    expect(modelForTier(1)).toBe('api:ollama:qwen3:4b');
    expect(selectorForTier(1).model).toBe('qwen3:4b');
    expect(modelForTier(2)).toBe('api:zai:glm-4.7');
    expect(modelForTier(3)).toBe('api:openai:gpt-5.6-sol');
  });

  it('accepts a Codex selector on L1 through the Atoma action loop', () => {
    Object.assign(process.env, ANTHROPIC_PINS, { ATOMA_MODEL_L1: 'sub:openai:gpt-5.4-mini' });
    expect(modelForTier(1)).toBe('sub:openai:gpt-5.4-mini');
    // By API, OpenAI hosts the tool loop and is admissible on L1.
    process.env['ATOMA_MODEL_L1'] = 'api:openai:gpt-5.4-mini';
    expect(modelForTier(1)).toBe('api:openai:gpt-5.4-mini');
  });

  it('reads a snapshot without touching process.env (T10)', () => {
    process.env['ATOMA_MODEL_L1'] = 'api:anthropic:ambient-haiku';
    expect(modelForTier(1, { ATOMA_MODEL_L1: 'api:zai:glm-4.5-air' })).toBe('api:zai:glm-4.5-air');
    expect(modelForTier(1)).toBe('api:anthropic:ambient-haiku');
    expect(() => modelForTier(1, {})).toThrow(/ATOMA_MODEL_L1 is not set/);
  });

  it('applyTierPins writes present pins and deletes omitted ones', () => {
    const target: NodeJS.ProcessEnv = { ATOMA_MODEL_L1: 'old', ATOMA_MODEL_L2: 'keep-until-deleted' };
    applyTierPins({ ATOMA_MODEL_L1: 'api:zai:glm-4.5-air' }, target);
    expect(target['ATOMA_MODEL_L1']).toBe('api:zai:glm-4.5-air');
    expect(target['ATOMA_MODEL_L2']).toBeUndefined();
    expect(target['ATOMA_MODEL_L3']).toBeUndefined();
  });

  it('L3.fromType takes ATOMA_MODEL_L3 as is — there is no live Opus discovery', () => {
    Object.assign(process.env, ANTHROPIC_PINS, { ATOMA_MODEL_L3: 'api:openai:gpt-5.6-sol' });
    const reg = new AtomRegistry(openDb(':memory:'));
    const t = reg.create(3, {
      description: 'l3',
      systemPrompt: 'l3',
      tools: [],
      params: {},
      createdBy: 'test',
    });
    const l3 = L3Atom.fromType(t, reg);
    expect(l3.model).toBe('api:openai:gpt-5.6-sol');
  });
});

describe('resolveOllamaModel — per-tier gradient on local models', () => {
  it('collapses Anthropic model ids onto the default model (historical behaviour)', () => {
    // The transport sees the BARE model id — the router strips the selector.
    expect(resolveOllamaModel('claude-haiku-4-5-20251001', 'glm-5.1:cloud')).toBe('glm-5.1:cloud');
    expect(resolveOllamaModel('claude-opus-5', 'glm-5.1:cloud')).toBe('glm-5.1:cloud');
    expect(resolveOllamaModel('', 'glm-5.1:cloud')).toBe('glm-5.1:cloud');
  });

  it('honours an explicit non-claude model verbatim — real local tier gradients', () => {
    expect(resolveOllamaModel('qwen3:32b', 'glm-5.1:cloud')).toBe('qwen3:32b');
  });
});
