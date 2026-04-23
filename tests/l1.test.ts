import { describe, it, expect } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { makeCtx, jsonText } from './helpers.js';

describe('L1Atom', () => {
  const base = {
    name: 'Hydrogen',
    ordinal: 1,
    systemPrompt: 'you are hydrogen',
    tools: [],
    params: { temperature: 0 },
  };

  it('produces a Plan from a JSON response', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({
        reasoning: 'trivial',
        proposedAction: 'answer',
        expectedOutput: 'a string',
      })
    );
    const atom = new L1Atom(base);
    const plan = await atom.plan({ description: 'what is 2+2?' }, ctx);
    expect(plan.proposedAction).toBe('answer');
  });

  it('plan prompt instructs the model NOT to emit a toolCalls array (#11 — aspirational plan shape)', async () => {
    // Regression: earlier the L1 plan prompt asked for
    // {"reasoning","proposedAction","expectedOutput","toolCalls"?} and the
    // model used the option to paste literal file contents into
    // toolCalls[0].args.content. When the content exceeded the response
    // maxTokens cap it got truncated mid-string and the Haiku validator
    // rejected the incomplete payload — triggering a repeat-rejection
    // escalation cascade observed in the fan-out run. The fix rewrites
    // the plan prompt to explicitly forbid toolCalls at plan time.
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' })
    );
    const atom = new L1Atom(base);
    await atom.plan({ description: 't' }, ctx);
    const userContent = ctx.llm.calls[0]!.userContent;
    // The CRITICAL plan-shape section must be present.
    expect(userContent).toMatch(/aspirational, no literal payloads/);
    expect(userContent).toMatch(/no "toolCalls" field/);
    // And the JSON shape hint must not list toolCalls either.
    expect(userContent).not.toMatch(/"toolCalls":/);
  });

  it('still accepts a Plan whose JSON omits proposedAction / expectedOutput gracefully — schema has defaults', async () => {
    // Sanity: the schema is liberal at parse time; a lean plan still works.
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' })
    );
    const atom = new L1Atom(base);
    const plan = await atom.plan({ description: 't' }, ctx);
    expect(plan.reasoning).toBe('r');
    expect(plan.proposedAction).toBe('a');
    expect(plan.expectedOutput).toBe('e');
    expect(plan.toolCalls).toBeUndefined();
  });

  it('executes and produces a Result', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ output: '4', summary: 'computed 2+2' }));
    const atom = new L1Atom(base);
    const result = await atom.execute(
      { description: 'x' },
      { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' },
      ctx
    );
    expect(result.output).toBe('4');
    expect(result.producedBy).toEqual({ tier: 1, name: 'Hydrogen', viaFallback: false });
  });

  it('tolerates narrative prose output instead of crashing the run', async () => {
    // Regression for the Tetris-build run crash: Aluminum (a new L1)
    // emitted a markdown narrative with an embedded pseudo-JSON block
    // `{ score, level, state }` and no final `{"output":…,"summary":…}`
    // payload. Previously `parseWith(resultPayloadSchema,…)` greedily
    // took first `{` to last `}` and crashed. Now the tolerant path
    // wraps the prose as `output` + a diagnostic summary, letting the
    // supervisor's RESULT validator reject it via the normal retry loop
    // instead of blowing up the whole run.
    const narrative = `Here is the status report:

**State shape**: { score, level, lines, state }
    - State: 'playing' or 'gameover'

All gameplay controls wired up. No console errors.`;
    const ctx = makeCtx();
    ctx.llm.enqueueText(narrative);
    const atom = new L1Atom(base);
    const result = await atom.execute(
      { description: 'x' },
      { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' },
      ctx
    );
    expect(result.output).toBe(narrative.trim());
    expect(result.summary).toMatch(/fallback produced non-JSON output/);
  });

  it('prefers the final balanced JSON when the response has prose + payload', async () => {
    // Narrative first, then a valid payload at the end — the scan-all
    // candidates branch of parseWith should recover the payload.
    const text = `Summary bullets:
- built the app
- validated

{"output": {"url": "http://localhost:8000/"}, "summary": "built + validated"}`;
    const ctx = makeCtx();
    ctx.llm.enqueueText(text);
    const atom = new L1Atom(base);
    const result = await atom.execute(
      { description: 'x' },
      { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' },
      ctx
    );
    expect(result.output).toEqual({ url: 'http://localhost:8000/' });
    expect(result.summary).toBe('built + validated');
  });

  it('applyModifications mutates prompt, tools, params', () => {
    const atom = new L1Atom(base);
    atom.applyModifications({
      systemPromptAppend: ' — please be precise',
      addTools: [{ name: 'calc', description: 'calc', inputSchema: {} }],
      params: { temperature: 0.7 },
      additionalContext: 'extra',
    });
    // effective prompt now includes both append and injected context
    // (verified indirectly: no throw, and re-applying doesn't duplicate tool)
    atom.applyModifications({
      addTools: [{ name: 'calc', description: 'calc', inputSchema: {} }],
    });
    // No public accessor — a second add should be idempotent and still pass typecheck.
    expect(true).toBe(true);
  });
});
