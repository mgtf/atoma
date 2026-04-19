import { describe, it, expect } from 'vitest';
import {
  extractJson,
  repairTruncatedJson,
  verdictSchema,
  isEffectivelyEmptyMods,
} from '../src/atoms/json.js';

describe('extractJson', () => {
  it('parses a plain JSON object', () => {
    expect(extractJson('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('parses JSON inside a ```json fenced block', () => {
    const text = 'Here you go:\n```json\n{"a":1}\n```\nthanks';
    expect(extractJson(text)).toEqual({ a: 1 });
  });

  it('extracts an object surrounded by prose', () => {
    const text = 'preamble {"k":"v"} postamble';
    expect(extractJson(text)).toEqual({ k: 'v' });
  });

  it('repairs a response truncated inside a string value', () => {
    const truncated = '{"output":"this got cut off in the middle of a stri';
    const parsed = extractJson(truncated) as { output: string };
    expect(parsed.output.startsWith('this got cut off')).toBe(true);
  });

  it('repairs a response truncated inside a nested object', () => {
    const truncated = '{"a":1,"b":{"c":"x","d":"y';
    const parsed = extractJson(truncated) as { a: number; b: { c: string; d: string } };
    expect(parsed.a).toBe(1);
    expect(parsed.b.c).toBe('x');
    expect(parsed.b.d.startsWith('y')).toBe(true);
  });

  it('repairs a truncated array of objects', () => {
    const truncated = '[{"id":1},{"id":2},{"id":3,"name":"partia';
    const parsed = extractJson(truncated) as Array<{ id: number; name?: string }>;
    expect(parsed.length).toBe(3);
    expect(parsed[2]?.id).toBe(3);
  });

  it('throws a useful ValidationError when there is no JSON at all', () => {
    expect(() => extractJson('no json here, sorry')).toThrow(/no JSON found/);
  });
});

describe('repairTruncatedJson', () => {
  it('returns null when JSON is already balanced', () => {
    expect(repairTruncatedJson('{"a":1}')).toBeNull();
  });

  it('closes an unterminated string and one object', () => {
    expect(repairTruncatedJson('{"a":"hello')).toBe('{"a":"hello"}');
  });

  it('handles escaped quotes correctly', () => {
    const repaired = repairTruncatedJson('{"a":"he said \\"hi');
    expect(repaired).toBe('{"a":"he said \\"hi"}');
    expect(JSON.parse(repaired!)).toEqual({ a: 'he said "hi' });
  });

  it('strips a trailing comma when repairing', () => {
    expect(repairTruncatedJson('{"a":1,')).toBe('{"a":1}');
  });
});

describe('verdictSchema', () => {
  it('accepts an approved verdict', () => {
    expect(verdictSchema.safeParse({ approved: true, reasoning: 'ok' }).success).toBe(true);
  });

  it('accepts a rejected ephemeral verdict with empty modifications (pure retry)', () => {
    const res = verdictSchema.safeParse({
      approved: false,
      reasoning: 'transient flake',
      modifications: {},
      scope: 'ephemeral',
    });
    expect(res.success).toBe(true);
  });

  it('rejects a patch verdict with empty modifications', () => {
    const res = verdictSchema.safeParse({
      approved: false,
      reasoning: 'diagnostic only, no prescription',
      modifications: {},
      scope: 'patch',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.includes('modifications'))).toBe(true);
    }
  });

  it('rejects a branch verdict with only nullish/empty fields in modifications', () => {
    const res = verdictSchema.safeParse({
      approved: false,
      reasoning: 'needs a variant',
      modifications: { addTools: [], removeTools: [], additionalContext: '' },
      scope: 'branch',
      branchName: 'NewThing',
    });
    expect(res.success).toBe(false);
  });

  it('accepts a patch verdict with at least one concrete field', () => {
    const res = verdictSchema.safeParse({
      approved: false,
      reasoning: 'tighten output discipline',
      modifications: { systemPromptAppend: 'Be concise.' },
      scope: 'patch',
    });
    expect(res.success).toBe(true);
  });
});

describe('isEffectivelyEmptyMods', () => {
  it('detects empty / undefined / whitespace-equivalent fields', () => {
    expect(isEffectivelyEmptyMods(undefined)).toBe(true);
    expect(isEffectivelyEmptyMods({})).toBe(true);
    expect(isEffectivelyEmptyMods({ addTools: [], removeTools: [] })).toBe(true);
    expect(isEffectivelyEmptyMods({ additionalContext: '' })).toBe(true);
    expect(isEffectivelyEmptyMods({ params: {} })).toBe(true);
  });

  it('flags as non-empty when any field carries content', () => {
    expect(isEffectivelyEmptyMods({ systemPromptAppend: 'x' })).toBe(false);
    expect(isEffectivelyEmptyMods({ params: { temperature: 0.1 } })).toBe(false);
    expect(isEffectivelyEmptyMods({ removeTools: ['foo'] })).toBe(false);
  });
});
