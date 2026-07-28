import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { resolveCliModel, jsonSchemaToZodShape, cliEffortFor } from '../src/core/llmClaudeCli.js';
import { PIN_HAIKU, PIN_SONNET, FALLBACK_OPUS } from '../src/core/models.js';
import type { LlmCompletionRequest } from '../src/core/types.js';

describe('resolveCliModel — tier pins → Claude Code aliases', () => {
  let envBefore: string | undefined;
  beforeEach(() => {
    envBefore = process.env['ATOMA_CLAUDE_MODEL'];
    delete process.env['ATOMA_CLAUDE_MODEL'];
  });
  afterEach(() => {
    if (envBefore === undefined) delete process.env['ATOMA_CLAUDE_MODEL'];
    else process.env['ATOMA_CLAUDE_MODEL'] = envBefore;
  });

  it('maps the three tier pins to stable CLI aliases', () => {
    expect(resolveCliModel(PIN_HAIKU)).toBe('haiku');
    expect(resolveCliModel(PIN_SONNET)).toBe('sonnet');
    expect(resolveCliModel(FALLBACK_OPUS)).toBe('opus');
    expect(resolveCliModel('claude-opus-5')).toBe('opus');
  });

  it('passes through unrecognised ids and honours the ATOMA_CLAUDE_MODEL override', () => {
    expect(resolveCliModel('some-custom-model')).toBe('some-custom-model');
    process.env['ATOMA_CLAUDE_MODEL'] = 'sonnet';
    expect(resolveCliModel(FALLBACK_OPUS)).toBe('sonnet');
  });
});

describe('cliEffortFor — the one generation lever the CLI transport has', () => {
  const base = { systemPrompt: 's', userContent: 'u' };

  it('passes a caller-pinned effort through on an effort-capable model', () => {
    const req: LlmCompletionRequest = {
      ...base,
      model: PIN_SONNET,
      params: { effort: 'medium' },
    };
    expect(cliEffortFor(req)).toBe('medium');
  });

  it('returns undefined when the caller did not pin effort (validators/prefilters)', () => {
    const req: LlmCompletionRequest = { ...base, model: PIN_SONNET, params: { maxTokens: 4000 } };
    expect(cliEffortFor(req)).toBeUndefined();
  });

  it('gates on the declared tier pin — Haiku rejects the param', () => {
    const req: LlmCompletionRequest = {
      ...base,
      model: PIN_HAIKU,
      params: { effort: 'medium' },
    };
    expect(cliEffortFor(req)).toBeUndefined();
  });
});

describe('jsonSchemaToZodShape — builtin tool schema conversion', () => {
  it('converts the run_shell-style schema (string + array-of-string, partial required)', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Program to invoke' },
        args: { type: 'array', items: { type: 'string' } },
      },
      required: ['command'],
    });
    expect(shape['command']!.safeParse('node').success).toBe(true);
    expect(shape['command']!.safeParse(undefined).success).toBe(false); // required
    expect(shape['args']!.safeParse(['a', 'b']).success).toBe(true);
    expect(shape['args']!.safeParse(undefined).success).toBe(true); // optional
    // Full-object round trip through z.object, as MCP registerTool does.
    const obj = z.object(shape);
    expect(obj.safeParse({ command: 'node', args: ['x.js'] }).success).toBe(true);
    expect(obj.safeParse({ args: ['x.js'] }).success).toBe(false);
  });

  it('degrades unknown types to permissive schemas instead of crashing', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        weird: { type: 'null' },
        nested: { type: 'object' },
        num: { type: 'integer' },
        flag: { type: 'boolean' },
      },
      required: [],
    });
    expect(shape['weird']!.safeParse('anything').success).toBe(true);
    expect(shape['nested']!.safeParse({ a: 1 }).success).toBe(true);
    expect(shape['num']!.safeParse(3).success).toBe(true);
    expect(shape['num']!.safeParse(3.5).success).toBe(false);
    expect(shape['flag']!.safeParse(true).success).toBe(true);
  });

  it('handles a schema with no properties (empty shape)', () => {
    expect(jsonSchemaToZodShape({ type: 'object' })).toEqual({});
  });
});
