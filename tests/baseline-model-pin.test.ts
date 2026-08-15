import { afterEach, describe, expect, it } from 'vitest';
import { baselineModel, runFrontierBaseline } from '../src/run/baseline.js';
import { FALLBACK_OPUS, PIN_HAIKU, PIN_SONNET } from '../src/core/models.js';
import { makeCtx } from './helpers.js';
import type { Task } from '../src/core/types.js';

/**
 * The control arm's model is a VARIABLE of the experiment from round 9 on:
 * rounds 1-8 asked "does the tiered pipeline beat one agent on the same
 * frontier model", rounds 9-10 ask "does it beat one agent on a cheaper
 * model". Both questions need the pin to reach the actual completion call —
 * a pin that only changed a console banner would have produced two rounds of
 * Opus data labelled Sonnet and Haiku, which is exactly the class of defect
 * this benchmark exists to avoid. Hence a behavioural assertion on `req.model`
 * rather than a source grep.
 */
const ENV_KEYS = ['ATOMA_BASELINE_MODEL', 'ATOMA_MODEL_L3'] as const;
const saved = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

const task = (): Task => ({ description: 'count the characters in sample.txt' });

describe('baselineModel', () => {
  it('defaults to the top tier, so rounds 1-8 keep the meaning they were measured with', () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    expect(baselineModel()).toBe(FALLBACK_OPUS);
  });

  it('still follows ATOMA_MODEL_L3 when no control-arm pin is set — both arms move together', () => {
    setEnv('ATOMA_BASELINE_MODEL', undefined);
    setEnv('ATOMA_MODEL_L3', 'claude-sonnet-5');
    expect(baselineModel()).toBe(PIN_SONNET);
  });

  it('overrides the tier pin so the CONTROL arm alone changes model', () => {
    // The whole point: atoma keeps L3=opus while the control agent is Haiku.
    setEnv('ATOMA_MODEL_L3', FALLBACK_OPUS);
    setEnv('ATOMA_BASELINE_MODEL', PIN_HAIKU);
    expect(baselineModel()).toBe(PIN_HAIKU);
  });

  it('treats blank as unset rather than as a model id', () => {
    setEnv('ATOMA_MODEL_L3', undefined);
    setEnv('ATOMA_BASELINE_MODEL', '   ');
    expect(baselineModel()).toBe(FALLBACK_OPUS);
  });
});

describe('runFrontierBaseline', () => {
  it('sends the pinned control model to the completion call, not the tier-3 default', async () => {
    setEnv('ATOMA_MODEL_L3', FALLBACK_OPUS);
    setEnv('ATOMA_BASELINE_MODEL', PIN_SONNET);
    const ctx = makeCtx();
    ctx.llm.enqueueText('done: wrote wclite.js and re-ran every documented invocation');

    const result = await runFrontierBaseline(task(), ctx, []);

    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.model).toBe(PIN_SONNET);
    expect(result.producedBy?.tier).toBe(3);
  });

  it('sends tier 3 when nothing is pinned', async () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    const ctx = makeCtx();
    ctx.llm.enqueueText('done');

    await runFrontierBaseline(task(), ctx, []);

    expect(ctx.llm.calls[0]!.model).toBe(FALLBACK_OPUS);
  });
});
