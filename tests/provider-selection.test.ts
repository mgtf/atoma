import { describe, it, expect } from 'vitest';
import { referencedProviderNames, resolveBaseProviderKind } from '../src/run/providers.js';

describe('base provider selection — one rule for runner and curriculum', () => {
  it('defaults to Anthropic and recognises Ollama', () => {
    expect(resolveBaseProviderKind()).toBe('anthropic');
    expect(resolveBaseProviderKind('ANTHROPIC')).toBe('anthropic');
    expect(resolveBaseProviderKind('ollama')).toBe('ollama');
  });

  it('normalises both Claude subscription aliases', () => {
    expect(resolveBaseProviderKind('claude-cli')).toBe('claude-cli');
    expect(resolveBaseProviderKind('claude')).toBe('claude-cli');
  });

  it('rejects Codex as a base provider and names the safe tier-pin form', () => {
    expect(() => resolveBaseProviderKind('codex')).toThrow(/structurally refused at L1/);
    expect(() => resolveBaseProviderKind('codex')).toThrow(/ATOMA_MODEL_L3=codex:/);
  });

  it('rejects unknown values instead of silently billing Anthropic', () => {
    expect(() => resolveBaseProviderKind('claud')).toThrow(/unknown ATOMA_LLM provider "claud"/);
  });

  it('lists only configured cross-provider tier prefixes in tier order', () => {
    expect(
      referencedProviderNames({
        ATOMA_MODEL_L1: 'zai:glm-4.5-air',
        ATOMA_MODEL_L2: 'codex:gpt-5.6-sol',
        ATOMA_MODEL_L3: 'zai:glm-5',
      })
    ).toEqual(['zai', 'codex']);
    // Ollama model tags legitimately contain colons; an unknown prefix stays
    // a model id for the base provider.
    expect(referencedProviderNames({ ATOMA_MODEL_L1: 'qwen3:8b' })).toEqual([]);
  });
});
