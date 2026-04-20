import { describe, it, expect } from 'vitest';
import {
  extractJson,
  findAllJsonObjects,
  parseVerdict,
  parsePlanTolerant,
  parseWith,
  repairTruncatedJson,
  repairPrematureClose,
  resultPayloadSchema,
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

  it('strict verdictSchema still rejects a negative verdict missing scope', () => {
    // verdictSchema itself stays strict — tolerance lives in parseVerdict,
    // which is what runtime code calls. This test guards against anyone
    // accidentally weakening the schema and masking real bugs.
    const res = verdictSchema.safeParse({
      approved: false,
      reasoning: 'grid is wrong',
    });
    expect(res.success).toBe(false);
  });

  it('parseVerdict tolerates a Haiku response that omits scope + modifications', () => {
    // Exact shape from the build-app run that used to crash with
    // "expected: 'ephemeral' | 'branch' | 'patch', received: undefined".
    const text = JSON.stringify({
      approved: false,
      reasoning:
        'WebGL shader math is incorrect; grid coords mismatch with mouse events',
    });
    const v = parseVerdict(text);
    expect(v.approved).toBe(false);
    if (!v.approved) {
      expect(v.scope).toBe('ephemeral');
      expect(v.modifications).toEqual({});
      expect(typeof v.reasoning).toBe('string');
    }
  });

  it('parseVerdict still preserves a well-formed negative verdict verbatim', () => {
    const text = JSON.stringify({
      approved: false,
      reasoning: 'tighten prompt',
      scope: 'patch',
      modifications: { systemPromptAppend: 'Be concise.' },
    });
    const v = parseVerdict(text);
    expect(v.approved).toBe(false);
    if (!v.approved) {
      expect(v.scope).toBe('patch');
      expect(v.modifications).toEqual({ systemPromptAppend: 'Be concise.' });
    }
  });

  it('recovers a verdict with a stray premature closing brace (Haiku regression)', () => {
    // Observed in the 23:03:03 build run — the LLM emitted a `}` before
    // `"scope"`, prematurely closing the outer object. `JSON.parse` fails
    // at the comma after the stray close; our repair keeps the comma,
    // drops the bracket, and recovers the flat object.
    const raw = `{
      "approved": false,
      "reasoning": "Plan is structurally sound and targets correct tier (L1 executor). However, VISIBLE-DELIVERABLES checklist reveals critical gaps."
      },
      "scope": "ephemeral"
    }`;
    const v = parseVerdict(raw);
    expect(v.approved).toBe(false);
    if (!v.approved) {
      expect(v.scope).toBe('ephemeral');
      expect(v.reasoning).toMatch(/structurally sound/);
    }
  });

  it('still rejects a patch/branch verdict that forgot both scope and mods', () => {
    // The coercion defaults missing scope to "ephemeral", so a negative
    // verdict with NO scope is never promoted to a mutating retry. The
    // test below simulates Haiku explicitly asking for a patch without
    // supplying mods — the strict superRefine still bites.
    const res = verdictSchema.safeParse({
      approved: false,
      reasoning: 'bad plan',
      scope: 'patch',
      // modifications missing → coerced to {} → superRefine rejects
    });
    expect(res.success).toBe(false);
  });
});

describe('parsePlanTolerant', () => {
  const canonical = {
    reasoning: 'because',
    proposedAction: 'write index.html',
    expectedOutput: 'live URL',
  };

  it('parses the canonical single plan object', () => {
    expect(parsePlanTolerant(JSON.stringify(canonical))).toEqual(canonical);
  });

  it('unwraps a [strategy, plan] array (L2 non-fallback shape leaking into fallback)', () => {
    // Observed in build-app runs after Sucrose escalation: even in
    // fallback mode the LLM keeps emitting its usual strategy-array
    // because its non-fallback system prompt primed it for that shape.
    const strategy = { strategy: 'reuse', target: 'Fluorine', reasoning: 'pf' };
    const wrapped = JSON.stringify([strategy, canonical]);
    expect(parsePlanTolerant(wrapped)).toEqual(canonical);
  });

  it('unwraps a single-element [plan] array', () => {
    expect(parsePlanTolerant(JSON.stringify([canonical]))).toEqual(canonical);
  });

  it('surfaces a ValidationError on non-plan shapes', () => {
    expect(() => parsePlanTolerant('{"foo": 1}')).toThrow(/schema validation failed/);
  });

  it('tolerates JSON inside a ```json fence', () => {
    const fenced = '```json\n' + JSON.stringify(canonical) + '\n```';
    expect(parsePlanTolerant(fenced)).toEqual(canonical);
  });
});

describe('findAllJsonObjects', () => {
  it('returns every top-level balanced {…} / […]', () => {
    const text = 'preamble {"a":1} interlude {"b":2} coda [1,2,3] tail';
    expect(findAllJsonObjects(text)).toEqual(['{"a":1}', '{"b":2}', '[1,2,3]']);
  });

  it('honours braces inside JSON strings (no false positives)', () => {
    const text = '{"reasoning":"contains } and { in string"} ok';
    expect(findAllJsonObjects(text)).toEqual([
      '{"reasoning":"contains } and { in string"}',
    ]);
  });

  it('skips unbalanced openers gracefully', () => {
    const text = 'trailing { no close here';
    expect(findAllJsonObjects(text)).toEqual([]);
  });
});

describe('parseWith — candidate fallback for multi-object responses', () => {
  it('picks the LAST balanced object that schema-validates when the first extract fails', () => {
    // Mimics the Tetris-run crash: narrative with an embedded pseudo-JSON
    // `{ score, level, state }` block, then the real payload at the end.
    const text = `Here is my summary:

**State shape**: { score, level, lines, state }
    - score: number
    - state: 'playing' or 'gameover'

And the required response:

{"output": {"url": "http://localhost:8000/"}, "summary": "built"}`;
    const parsed = parseWith(resultPayloadSchema, text);
    expect((parsed.output as { url: string }).url).toBe(
      'http://localhost:8000/'
    );
    expect(parsed.summary).toBe('built');
  });

  it('still returns the strict extract when it already validates', () => {
    const text = '{"output":"x","summary":"ok"}';
    expect(parseWith(resultPayloadSchema, text)).toEqual({
      output: 'x',
      summary: 'ok',
    });
  });

  it('throws a ValidationError when NO candidate validates', () => {
    // Either the original extractJson error or the schema-validation
    // error surfaces — both are ValidationError instances and both
    // carry a helpful diagnostic excerpt.
    const text = 'prose only, no real JSON here {not valid}';
    expect(() => parseWith(resultPayloadSchema, text)).toThrow(
      /(schema validation failed|JSON parse failed)/
    );
  });
});

describe('repairPrematureClose', () => {
  it('returns null when the JSON is already balanced', () => {
    expect(repairPrematureClose('{"a":1,"b":2}')).toBeNull();
    expect(repairPrematureClose('[1,2,3]')).toBeNull();
  });

  it('strips a stray outer `}` and keeps the trailing comma as a field separator', () => {
    const raw = `{
      "approved": false,
      "reasoning": "bad"
      },
      "scope": "ephemeral"
    }`;
    const repaired = repairPrematureClose(raw);
    expect(repaired).not.toBeNull();
    const parsed = JSON.parse(repaired!);
    expect(parsed).toEqual({ approved: false, reasoning: 'bad', scope: 'ephemeral' });
  });

  it('preserves nested objects inside strings (no false positives)', () => {
    const raw = '{"reasoning":"contains }, inside","scope":"ephemeral"}';
    // Valid JSON — nothing should be repaired.
    expect(repairPrematureClose(raw)).toBeNull();
  });

  it('handles multiple stray closes in sequence', () => {
    const raw = `{
      "a": 1},
      "b": 2},
      "c": 3
    }`;
    const repaired = repairPrematureClose(raw);
    expect(repaired).not.toBeNull();
    expect(JSON.parse(repaired!)).toEqual({ a: 1, b: 2, c: 3 });
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
