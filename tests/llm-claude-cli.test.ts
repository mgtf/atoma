import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  resolveCliModel,
  jsonSchemaToZodShape,
  cliEffortFor,
  cliThinkingFor,
  subscriptionTransportEnv,
} from '../src/core/llmClaudeCli.js';
import { PIN_HAIKU, PIN_SONNET, FALLBACK_OPUS } from './tier-pins.js';
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

  it('tier-agnostic per-tier selection flows through as req.model (aliases pass verbatim)', () => {
    // ATOMA_MODEL_L3=sonnet (models.ts) makes L3 calls arrive with
    // req.model='sonnet' — the alias passes straight through: this is the
    // no-Opus-on-this-plan escape hatch, and the L1/L2 gradient below it
    // is untouched because those tiers carry their own models.
    expect(resolveCliModel('sonnet')).toBe('sonnet');
    expect(resolveCliModel(PIN_HAIKU)).toBe('haiku');
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

describe('cliThinkingFor — API-parity thinking gate for the haiku tier', () => {
  let envBefore: string | undefined;
  beforeEach(() => {
    envBefore = process.env['ATOMA_CLAUDE_MODEL'];
    delete process.env['ATOMA_CLAUDE_MODEL'];
  });
  afterEach(() => {
    if (envBefore === undefined) delete process.env['ATOMA_CLAUDE_MODEL'];
    else process.env['ATOMA_CLAUDE_MODEL'] = envBefore;
  });
  const base = { systemPrompt: 's', userContent: 'u' };

  it('disables thinking for haiku-tier calls (prefilters/validators never think on the API)', () => {
    expect(cliThinkingFor({ ...base, model: PIN_HAIKU })).toEqual({ type: 'disabled' });
  });

  it('leaves sonnet/opus on the CLI adaptive default — same as the API default', () => {
    expect(cliThinkingFor({ ...base, model: PIN_SONNET })).toBeUndefined();
    expect(cliThinkingFor({ ...base, model: FALLBACK_OPUS })).toBeUndefined();
  });

  it('gates on the RESOLVED alias so an ATOMA_CLAUDE_MODEL override keeps its own semantics', () => {
    process.env['ATOMA_CLAUDE_MODEL'] = 'sonnet';
    expect(cliThinkingFor({ ...base, model: PIN_HAIKU })).toBeUndefined();
    process.env['ATOMA_CLAUDE_MODEL'] = 'haiku';
    expect(cliThinkingFor({ ...base, model: FALLBACK_OPUS })).toEqual({ type: 'disabled' });
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

describe('the subscription transport authenticates from its login session alone', () => {
  /**
   * 2026-08-28, D9. Dropping a stale ANTHROPIC_API_KEY used to be tidiness —
   * one variable, so the CLI's own OAuth login authenticates the subprocess.
   * Since a tier may now be pinned to this transport while OTHER tiers bill
   * real keys, it is load-bearing for the payer guarantee: any inherited
   * variable that could re-credential or redirect this subprocess would
   * silently move the payer of a tier the journal has already named.
   */
  it('strips every ANTHROPIC_* variable and both cloud-gateway switches', () => {
    const env = subscriptionTransportEnv({
      PATH: '/bin',
      HOME: '/home/op',
      ANTHROPIC_API_KEY: 'stale',
      ANTHROPIC_AUTH_TOKEN: 'bearer',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_MODEL: 'something',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
    });
    expect(Object.keys(env).filter((key) => key.startsWith('ANTHROPIC_'))).toEqual([]);
    expect(env['CLAUDE_CODE_USE_BEDROCK']).toBeUndefined();
    expect(env['CLAUDE_CODE_USE_VERTEX']).toBeUndefined();
    // Everything the subprocess still needs is untouched.
    expect(env['PATH']).toBe('/bin');
    expect(env['HOME']).toBe('/home/op');
  });

  it('does not mutate the environment it was handed', () => {
    const source = { ANTHROPIC_API_KEY: 'stale', PATH: '/bin' };
    subscriptionTransportEnv(source);
    expect(source.ANTHROPIC_API_KEY).toBe('stale');
  });
});
