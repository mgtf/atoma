import { describe, it, expect } from 'vitest';
import { resolveBaseProviderKind } from '../src/run/providers.js';

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
});
