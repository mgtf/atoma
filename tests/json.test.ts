import { describe, it, expect } from 'vitest';
import {
  extractJson,
  extractJsonEx,
  findAllJsonObjects,
  parsePayloadTolerant,
  parseTwoJson,
  parseVerdict,
  parsePlanTolerant,
  parsePlanWithFallback,
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

/**
 * Regression suite for the NESTED-FENCE evidence-destruction bug.
 *
 * The fence regex is non-greedy, so it stops at the first closing ``` — and
 * an L1 obeying the GROUND-TRUTH evidence contract pastes shell output into
 * `summary`, which routinely contains a nested ```bash block. The capture
 * then ended mid-string, `repairTruncatedJson` closed it into something
 * schema-VALID BUT AMPUTATED, and `parseWith` returned that lossy object
 * without ever reaching the candidate scan that would have recovered the
 * intact payload.
 *
 * Measured on run 2026-07-25T22-10-42: a 162-char summary reached the
 * validator as 39 chars with the `## Usage` proof gone; the validator
 * (correctly) rejected it as "cut off mid-sentence", costing a full extra
 * supervise cycle. The same bug silently truncated a phase-1 summary from
 * 2620 recoverable chars to 308, so the next phase ran blind.
 */
describe('nested ``` fence inside a JSON string (evidence-destruction regression)', () => {
  const summary =
    'Documented rev-cli.\n== GROUND TRUTH ==\n```bash\n$ node index.js racecar\nReversed: racecar\nPalindrome: yes\n```\n## Usage section present with 3 verified invocations.';
  const envelope = { output: 'README.md written', summary };
  const fenced = '```json\n' + JSON.stringify(envelope) + '\n```';

  it('extractJson recovers the FULL payload despite the nested fence', () => {
    expect(extractJson(fenced)).toEqual(envelope);
  });

  it('recovers it WITHOUT resorting to a lossy repair', () => {
    const out = extractJsonEx(fenced);
    expect(out.repaired).toBe(false);
    expect((out.value as typeof envelope).summary).toBe(summary);
  });

  it('parsePayloadTolerant preserves the whole evidence block (162 chars, not 39)', () => {
    const parsed = parsePayloadTolerant(fenced);
    expect(String(parsed.summary)).toBe(summary);
    expect(String(parsed.summary)).toContain('## Usage');
    expect(String(parsed.summary).length).toBe(summary.length);
  });

  it('parseWith keeps the intact payload for the result schema', () => {
    const parsed = parseWith(resultPayloadSchema, fenced);
    expect(parsed.summary).toBe(summary);
  });

  it('survives MULTIPLE nested fences in the same string', () => {
    const multi = {
      output: 'ok',
      summary: 'a\n```bash\nx\n```\nb\n```json\n{"not":"the payload"}\n```\nc',
    };
    expect(extractJson('```json\n' + JSON.stringify(multi) + '\n```')).toEqual(multi);
  });

  it('parseTwoJson survives a nested fence in the first payload', () => {
    const strategy = { strategy: 'reuse', target: 'Ammonia', reasoning: 'run: ```bash\nls\n```' };
    const plan = { reasoning: 'r', subtasks: [{ description: 'd' }] };
    const text =
      '```json\n' + JSON.stringify(strategy) + '\n```\n```json\n' + JSON.stringify(plan) + '\n```';
    const [a, b] = parseTwoJson(text);
    expect(a).toEqual(strategy);
    expect(b).toEqual(plan);
  });

  it('parseTwoJson splits a FUSED one-element strategy+plan array (live Opus emission)', () => {
    // Observed 2026-08-08 (app-guest-counter): Opus answered the two-payload
    // request with a VALID one-element array whose single object carried both
    // the strategy discriminators AND the plan fields — a complete, correct
    // response that crashed the parse as "missing second JSON".
    const fused = [
      {
        strategy: 'reuse',
        target: 'Leukocyte',
        reasoning: 'coupled artefacts, sequential build',
        subtasks: [{ description: 'phase 1' }, { description: 'phase 2' }],
        aggregation: { mode: 'sequential' },
        expectedOutput: 'a working guestbook app',
      },
    ];
    const [a, b] = parseTwoJson(JSON.stringify(fused));
    expect(a).toEqual({ strategy: 'reuse', target: 'Leukocyte', reasoning: 'coupled artefacts, sequential build' });
    expect(b).toEqual({
      reasoning: 'coupled artefacts, sequential build',
      subtasks: [{ description: 'phase 1' }, { description: 'phase 2' }],
      aggregation: { mode: 'sequential' },
      expectedOutput: 'a working guestbook app',
    });
    // A strategy-only single element (no subtasks) is NOT split — the
    // truncation paths keep their placeholder semantics.
    const strategyOnly = JSON.stringify([{ strategy: 'reuse', target: 'X', reasoning: 'r' }]);
    expect(() => parseTwoJson(strategyOnly)).toThrow();
  });

  it('still honours a well-formed fence with no nesting (no behaviour change)', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonEx('```json\n{"a":1}\n```').repaired).toBe(false);
  });

  it('a genuinely truncated payload still parses via repair, and is flagged', () => {
    // No closing fence at all — the max_tokens cutoff case the repair exists for.
    const out = extractJsonEx('{"output":"x","summary":"unterminated');
    expect(out.repaired).toBe(true);
    expect((out.value as { output: string }).output).toBe('x');
  });

  it('does NOT hijack the "prefer the LAST candidate" semantics', () => {
    // Guard against the regression this fix nearly introduced: trying the
    // first BALANCED object up front made a short example envelope shown in
    // prose win over the real payload that follows. The balanced-object
    // recovery must therefore run only where the old code would have gone to
    // a lossy repair — never ahead of the slice path.
    const text =
      'Example of the shape: {"output":"e","summary":"s"} — and here is the real result:\n' +
      '{"output":"the real deliverable","summary":"the actual evidence block"}';
    const parsed = parseWith(resultPayloadSchema, text);
    expect(parsed.output).toBe('the real deliverable');
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
  // Single-action shape — coerced by planSchema.preprocess into a FanOutPlan with
  // a single degenerate subtask. Helper builds the expected post-coercion shape.
  const singleActionInput = {
    reasoning: 'because',
    proposedAction: 'write index.html',
    expectedOutput: 'live URL',
  };
  const expectedCoerced = {
    reasoning: 'because',
    proposedAction: 'write index.html',
    expectedOutput: 'live URL',
    subtasks: [{ description: 'write index.html' }],
    aggregation: { mode: 'concat' },
  };

  it('coerces a single-action plan object into a single-subtask fan-out plan', () => {
    expect(parsePlanTolerant(JSON.stringify(singleActionInput))).toEqual(expectedCoerced);
  });

  it('unwraps a [strategy, plan] array (L2 non-fallback shape leaking into fallback)', () => {
    const strategy = { strategy: 'reuse', target: 'Fluorine', reasoning: 'pf' };
    const wrapped = JSON.stringify([strategy, singleActionInput]);
    expect(parsePlanTolerant(wrapped)).toEqual(expectedCoerced);
  });

  it('unwraps a single-element [plan] array', () => {
    expect(parsePlanTolerant(JSON.stringify([singleActionInput]))).toEqual(expectedCoerced);
  });

  it('surfaces a ValidationError on non-plan shapes', () => {
    expect(() => parsePlanTolerant('{"foo": 1}')).toThrow(/schema validation failed/);
  });

  it('tolerates JSON inside a ```json fence', () => {
    const fenced = '```json\n' + JSON.stringify(singleActionInput) + '\n```';
    expect(parsePlanTolerant(fenced)).toEqual(expectedCoerced);
  });

  it('unwraps a {plan: {...}} wrapper (observed in fallback regressions)', () => {
    const wrapped = JSON.stringify({ plan: singleActionInput });
    expect(parsePlanTolerant(wrapped)).toEqual(expectedCoerced);
  });

  it('unwraps a {strategy, plan} combined envelope', () => {
    const envelope = JSON.stringify({
      strategy: { strategy: 'reuse', target: 'Water', reasoning: 'pf' },
      plan: singleActionInput,
    });
    expect(parsePlanTolerant(envelope)).toEqual(expectedCoerced);
  });

  it('picks the plan-shaped candidate from a narrative with multiple JSON objects', () => {
    const text = `Decided to delegate.

{"strategy": "reuse", "target": "Water"}

And here is the actual plan:

${JSON.stringify(singleActionInput)}`;
    expect(parsePlanTolerant(text)).toEqual(expectedCoerced);
  });

  it('passes a fan-out plan through without coercion (subtasks preserved)', () => {
    const fanout = {
      reasoning: 'decompose',
      subtasks: [
        { description: 'write layout' },
        { description: 'write logic' },
      ],
      aggregation: { mode: 'llm-synthesize', instruction: 'merge into index.html' },
      expectedOutput: 'working app',
    };
    expect(parsePlanTolerant(JSON.stringify(fanout))).toEqual(fanout);
  });
});

describe('parsePlanWithFallback', () => {
  const canonicalInput = {
    reasoning: 'r',
    proposedAction: 'a',
    expectedOutput: 'e',
  };
  const canonicalExpected = {
    reasoning: 'r',
    proposedAction: 'a',
    expectedOutput: 'e',
    subtasks: [{ description: 'a' }],
    aggregation: { mode: 'concat' },
  };
  const fb = {
    reasoning: 'SYN',
    proposedAction: 'SYN',
    expectedOutput: 'SYN',
  };
  // Fallback is ALSO coerced through the schema — callers can pass a
  // single-action shape and the returned Plan will have subtasks + aggregation.
  const fbCoerced = {
    reasoning: 'SYN',
    proposedAction: 'SYN',
    expectedOutput: 'SYN',
    subtasks: [{ description: 'SYN' }],
    aggregation: { mode: 'concat' },
  };

  it('returns the coerced parsed plan when parsing succeeds', () => {
    expect(parsePlanWithFallback(JSON.stringify(canonicalInput), fb)).toEqual(
      canonicalExpected
    );
  });

  it('returns the coerced fallback when LLM emits a strategy-only object', () => {
    const strategyOnly = JSON.stringify({ strategy: 'reuse', target: 'Aluminum' });
    expect(parsePlanWithFallback(strategyOnly, fb)).toEqual(fbCoerced);
  });

  it('returns the coerced fallback on completely malformed responses', () => {
    expect(parsePlanWithFallback('this is not JSON at all', fb)).toEqual(fbCoerced);
    expect(parsePlanWithFallback('', fb)).toEqual(fbCoerced);
    expect(parsePlanWithFallback('{incomplete: no quotes}', fb)).toEqual(fbCoerced);
  });

  it('returns the coerced fallback when LLM emits a result envelope by mistake', () => {
    const resultShape = JSON.stringify({ output: 'done', summary: 'ok' });
    expect(parsePlanWithFallback(resultShape, fb)).toEqual(fbCoerced);
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
