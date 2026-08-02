import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { modelForTier, PIN_HAIKU, PIN_SONNET, FALLBACK_OPUS } from '../src/core/models.js';
import { resolveOllamaModel } from '../src/core/llmOllama.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom } from '../src/atoms/L3Atom.js';

/**
 * Provider-agnostic per-tier model selection. The unit of configuration is
 * the TIER — decreasing model power L3→L1 is the project's thesis — so the
 * env vars are named by tier (ATOMA_MODEL_L1/L2/L3) and accept ANY model id
 * the active provider serves, with the Anthropic pins as defaults.
 */
describe('modelForTier — provider-agnostic tier pins', () => {
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

  it('defaults to the Anthropic pins per tier', () => {
    expect(modelForTier(1)).toBe(PIN_HAIKU);
    expect(modelForTier(2)).toBe(PIN_SONNET);
    expect(modelForTier(3)).toBe(FALLBACK_OPUS);
  });

  it('one tier can be remapped WITHOUT touching the gradient below it', () => {
    process.env['ATOMA_MODEL_L3'] = 'sonnet'; // no-Opus-on-this-plan case
    expect(modelForTier(3)).toBe('sonnet');
    expect(modelForTier(2)).toBe(PIN_SONNET);
    expect(modelForTier(1)).toBe(PIN_HAIKU);
  });

  it('accepts arbitrary non-Anthropic ids — the vars are vendor-neutral', () => {
    process.env['ATOMA_MODEL_L1'] = 'qwen3:4b';
    process.env['ATOMA_MODEL_L2'] = 'glm-4.7';
    process.env['ATOMA_MODEL_L3'] = 'gpt-5.2';
    expect(modelForTier(1)).toBe('qwen3:4b');
    expect(modelForTier(2)).toBe('glm-4.7');
    expect(modelForTier(3)).toBe('gpt-5.2');
  });

  it('an explicit ATOMA_MODEL_L3 pins L3 and SKIPS the live Opus discovery', async () => {
    process.env['ATOMA_MODEL_L3'] = 'my-l3-model';
    const reg = new AtomRegistry(openDb(':memory:'));
    const t = reg.create(3, {
      description: 'l3',
      systemPrompt: 'l3',
      tools: [],
      params: {},
      createdBy: 'test',
    });
    // No Anthropic client passed — with the pin, fromType must not need one
    // AND must not fall back to FALLBACK_OPUS.
    const l3 = await L3Atom.fromType(t, reg, undefined);
    expect(l3.model).toBe('my-l3-model');
  });
});

describe('resolveOllamaModel — per-tier gradient on local models', () => {
  it('collapses Anthropic tier pins onto the default model (historical behaviour)', () => {
    expect(resolveOllamaModel(PIN_HAIKU, 'glm-5.1:cloud')).toBe('glm-5.1:cloud');
    expect(resolveOllamaModel(FALLBACK_OPUS, 'glm-5.1:cloud')).toBe('glm-5.1:cloud');
    expect(resolveOllamaModel('', 'glm-5.1:cloud')).toBe('glm-5.1:cloud');
  });

  it('honours an explicit non-claude model verbatim — real local tier gradients', () => {
    expect(resolveOllamaModel('qwen3:32b', 'glm-5.1:cloud')).toBe('qwen3:32b');
  });
});
