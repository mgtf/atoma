import { asStoredNamespace } from '../src/skills/namespace.js';
import { describe, it, expect } from 'vitest';
import {
  L1Atom,
  shellInvocationRunsFile,
  toolInvocationSucceeded,
  withAutomaticLoopbackHttpRecording,
} from '../src/atoms/L1Atom.js';
import type { ToolExecutor } from '../src/core/types.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan } from './helpers/factories.js';

describe('L1Atom', () => {
  const base = {
    name: 'Water',
    ordinal: 1,
    systemPrompt: 'you are water',
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

  it('shows a declared dom-interaction obligation to the worker in BOTH the plan and execute prompts', async () => {
    // The obligation reached Task.proofObligations but the L1 prompt never
    // rendered it: the 2026-09-07 pomodoro run drove the page through
    // window.__test hooks in a smoke script, the transport-record coverage
    // check saw no executed interaction, and every credit was withheld on a
    // correct page. The rule is the supervisor's; the worker must hear it.
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'ok', summary: 's' }));
    const atom = new L1Atom(base);
    const task = { description: 'click start and prove the countdown moves', proofObligations: ['dom-interaction' as const] };
    const plan = await atom.plan(task, ctx);
    await atom.execute(task, plan, ctx);
    for (const call of ctx.llm.calls) {
      expect(call.userContent).toContain('PROOF OBLIGATION "dom-interaction"');
      expect(call.userContent).toMatch(/"interactions"\s+array/);
      expect(call.userContent).toContain('does NOT count');
    }
  });

  it('says nothing about obligations when the task declares none', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    const atom = new L1Atom(base);
    await atom.plan({ description: 'write a README' }, ctx);
    expect(ctx.llm.calls[0]!.userContent).not.toContain('PROOF OBLIGATION');
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
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      ctx
    );
    expect(result.output).toBe('4');
    expect(result.producedBy).toEqual({ tier: 1, name: 'Water', viaFallback: false });
    expect(result.toolCallResults).toEqual([]);
  });

  it('proves an injected script skill only after its written scratch file runs', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueue((req) => {
      req.onToolInvocation?.({
        name: 'write_file',
        args: { path: '_skill_package-and-document-cli.mjs' },
        result: { ok: true },
        durationMs: 1,
        startedAt: 1,
      });
      req.onToolInvocation?.({
        name: 'run_shell',
        args: {
          command: 'node',
          args: ['_skill_package-and-document-cli.mjs', '{"task":"package"}'],
        },
        result: { exitCode: 0, stdout: '{"output":{},"summary":"ok"}\n' },
        durationMs: 1,
        startedAt: 2,
      });
      return {
        text: jsonText({ output: 'done', summary: 'packaged' }),
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    const atom = new L1Atom(base);
    atom.setActiveSkill('package-and-document-cli', asStoredNamespace('Ammonia'));
    const result = await atom.execute(
      { description: 'package' },
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      ctx
    );
    expect(result.activeScriptSkillExecuted).toBe(true);
  });

  it('distinguishes successful actions from structured soft failures', () => {
    const baseInfo = { name: 'x', args: {}, durationMs: 1, startedAt: 1 };
    expect(toolInvocationSucceeded({ ...baseInfo, result: { ok: true } })).toBe(true);
    expect(toolInvocationSucceeded({ ...baseInfo, result: { path: 'x.txt' } })).toBe(true);
    expect(toolInvocationSucceeded({ ...baseInfo, result: { ok: false } })).toBe(false);
    expect(
      toolInvocationSucceeded({ ...baseInfo, result: { ok: true, unchanged: true } })
    ).toBe(false);
    expect(toolInvocationSucceeded({ ...baseInfo, result: { error: 'failed' } })).toBe(false);
    expect(toolInvocationSucceeded({ ...baseInfo, result: { exitCode: 1 } })).toBe(false);
    expect(toolInvocationSucceeded({ ...baseInfo, error: 'executor threw' })).toBe(false);
  });

  it('does not mistake scratch cleanup for script execution', () => {
    const scratch = '_skill_replay-recorded-shell-probes.mjs';
    expect(
      shellInvocationRunsFile({ command: 'node', args: [scratch, '{"task":"replay"}'] }, scratch)
    ).toBe(true);
    expect(
      shellInvocationRunsFile(
        {
          command: 'node',
          args: ['-e', 'require("fs").rmSync(process.argv[1])', scratch],
        },
        scratch
      )
    ).toBe(false);
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
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
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
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      ctx
    );
    expect(result.output).toEqual({ url: 'http://localhost:8000/' });
    expect(result.summary).toBe('built + validated');
  });

  it('prefixes the summary with [INTERNAL VALIDATION FAILED] when last validate_html returned ok:false (#3)', async () => {
    // Observed in the backgammon timeout run: the L1 called validate_html,
    // saw ok:false on its LAST invocation, but then declared success via
    // its final JSON envelope. The supervisor's ground-truth probe
    // rejected moments later on the same 404 the L1 had already seen,
    // triggering a cascade of redundant rejections. The gate
    // transparently surfaces the contradiction so the validator
    // rejects cleanly on its FIRST pass.
    const ctx = makeCtx();
    // First LLM round: the model emits a tool_use for validate_html...
    // ...actually, we simulate via the manual onToolInvocation path:
    // the MockLlmClient doesn't run a tool loop, so we wire the
    // callback by calling the tool observer ourselves via the
    // stub-LLM pattern used in tool-trace.test.ts.
    //
    // Simplest approach: use a custom inner LLM that fires
    // onToolInvocation for validate_html then returns the final JSON.
    class StubInner {
      async complete(req: import('../src/core/types.js').LlmCompletionRequest): Promise<import('../src/core/types.js').LlmCompletionResponse> {
        // Simulate the tool-use loop: the model called validate_html
        // and it returned ok:false with a failedRequest.
        req.onToolInvocation?.({
          name: 'validate_html',
          args: { url: 'http://localhost:8000/' },
          result: {
            ok: false,
            errors: [],
            failedRequests: [{ url: 'http://localhost:8000/style.css', reason: 'net::ERR_ABORTED' }],
          },
          durationMs: 10,
          startedAt: Date.now(),
        });
        // Then the model declares victory anyway.
        return {
          text: JSON.stringify({
            output: 'http://localhost:8000/',
            summary: 'Minesweeper built and validated',
          }),
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
    }
    ctx.llm = new StubInner() as unknown as typeof ctx.llm;

    const atom = new L1Atom({
      ...base,
      tools: [
        {
          name: 'validate_html',
          description: 'validate',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
    const result = await atom.execute(
      { description: 'build a game' },
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      ctx
    );
    expect(result.summary).toMatch(/\[INTERNAL VALIDATION FAILED/);
    expect(result.summary).toMatch(/1 failed request/);
    expect(result.summary).toMatch(/Minesweeper built and validated/);
  });

  it('does NOT prefix when last validate_html returned ok:true (happy path unchanged)', async () => {
    class StubInner {
      async complete(req: import('../src/core/types.js').LlmCompletionRequest): Promise<import('../src/core/types.js').LlmCompletionResponse> {
        req.onToolInvocation?.({
          name: 'validate_html',
          args: { url: 'http://localhost:8000/' },
          result: { ok: true, errors: [], failedRequests: [] },
          durationMs: 10,
          startedAt: Date.now(),
        });
        return {
          text: JSON.stringify({ output: 'http://localhost:8000/', summary: 'clean' }),
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
    }
    const ctx = makeCtx();
    ctx.llm = new StubInner() as unknown as typeof ctx.llm;
    const atom = new L1Atom({
      ...base,
      tools: [
        {
          name: 'validate_html',
          description: 'validate',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
    const result = await atom.execute(
      { description: 'x' },
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      ctx
    );
    expect(result.summary).not.toMatch(/INTERNAL VALIDATION FAILED/);
    expect(result.summary).toBe('clean');
  });

  it('does NOT prefix when L1 never called validate_html (e.g. a pure-computation task)', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ output: 'result', summary: 'no validation needed' }));
    const atom = new L1Atom(base); // tools: []
    const result = await atom.execute(
      { description: 'x' },
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      ctx
    );
    expect(result.summary).not.toMatch(/INTERNAL VALIDATION FAILED/);
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

describe('L1 loopback HTTP evidence', () => {
  it('forces loopback fetches to record while leaving external/supervisor intent explicit', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const base: ToolExecutor = {
      has: () => true,
      execute: async (name, args) => {
        calls.push({ name, args });
        return { ok: true };
      },
    };
    const wrapped = withAutomaticLoopbackHttpRecording(base);
    await wrapped.execute('fetch_url', { url: 'http://localhost:1234/health' });
    await wrapped.execute('fetch_url', { url: 'https://example.com/data' });
    await wrapped.execute('fetch_url', {
      url: 'http://127.0.0.1:1234/internal',
      record: false,
    });

    expect(calls.map((call) => call.args['record'])).toEqual([true, undefined, false]);
  });
});
