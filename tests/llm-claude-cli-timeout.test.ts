import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * PER-CALL DEADLINE on the claude-cli transport.
 *
 * The run-level `AbortSignal.timeout` is ADVISORY — it cancels work that
 * OBSERVES it. A subprocess wedged on a dropped connection observes
 * nothing: the SDK stream never yields a `result` message and the await
 * never settles. Measured consequence before this guard: a build-app
 * process alive after 11 DAYS with 2 minutes of CPU, still holding a
 * headless Chrome and an esbuild service.
 *
 * These tests drive a stream that NEVER yields — the exact wedged shape —
 * and assert the call gives up, aborts the controller (which terminates
 * the subprocess) and throws a labelled error instead of hanging.
 */

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

const { ClaudeCliLlmClient, cliCallTimeoutMs, DEFAULT_CLI_CALL_TIMEOUT_MS } = await import(
  '../src/core/llmClaudeCli.js'
);

/** A stream that never produces a message and never ends — the wedge. */
function neverYieldingStream(onAbort: (reason: unknown) => void) {
  // `opts` is optional-chained on purpose: vitest invokes the recorded
  // implementation once more, argument-less, during teardown. Production
  // calls it exactly once with the real options (asserted below).
  return (opts?: { options?: { abortController?: AbortController } }) => {
    const ctrl = opts?.options?.abortController;
    return {
      async *[Symbol.asyncIterator]() {
        await new Promise<never>((_, reject) => {
          ctrl?.signal.addEventListener('abort', () => {
            onAbort(ctrl.signal.reason);
            reject(ctrl.signal.reason ?? new Error('aborted'));
          });
        });
        yield undefined as never; // unreachable — satisfies the generator type
      },
    };
  };
}

const REQ = {
  model: 'claude-haiku-4-5',
  systemPrompt: 's',
  userContent: 'u',
  params: { maxTokens: 64 },
};

describe('cliCallTimeoutMs — operator override', () => {
  let before: string | undefined;
  beforeEach(() => {
    before = process.env['ATOMA_CLI_CALL_TIMEOUT_MS'];
    delete process.env['ATOMA_CLI_CALL_TIMEOUT_MS'];
  });
  afterEach(() => {
    if (before === undefined) delete process.env['ATOMA_CLI_CALL_TIMEOUT_MS'];
    else process.env['ATOMA_CLI_CALL_TIMEOUT_MS'] = before;
  });

  it('defaults to the documented ceiling', () => {
    expect(cliCallTimeoutMs()).toBe(DEFAULT_CLI_CALL_TIMEOUT_MS);
  });

  it('honours a valid override', () => {
    process.env['ATOMA_CLI_CALL_TIMEOUT_MS'] = '1234';
    expect(cliCallTimeoutMs()).toBe(1234);
  });

  it('falls back to the DEFAULT on invalid / zero / negative values — a typo must not disable the guard', () => {
    for (const bad of ['0', '-1', 'abc', '']) {
      process.env['ATOMA_CLI_CALL_TIMEOUT_MS'] = bad;
      expect(cliCallTimeoutMs()).toBe(DEFAULT_CLI_CALL_TIMEOUT_MS);
    }
  });
});

describe('a wedged call cannot hang forever', () => {
  beforeEach(() => queryMock.mockReset());

  it('aborts the SDK controller and throws a labelled timeout', async () => {
    let abortReason: unknown = null;
    queryMock.mockImplementation(neverYieldingStream((r) => { abortReason = r; }));
    const client = new ClaudeCliLlmClient({ callTimeoutMs: 60 });

    await expect(client.complete(REQ as never)).rejects.toThrow(/timed out after 60ms/);
    // The controller must have been aborted — that is what terminates the
    // subprocess. Without it we would stop waiting but leak the process,
    // which is the very leak this guard exists to close.
    expect(abortReason).toBeInstanceOf(Error);
    expect(String((abortReason as Error).message)).toMatch(/exceeded 60ms/);
  });

  it('names the dropped connection so the trace points at the cause', async () => {
    queryMock.mockImplementation(neverYieldingStream(() => {}));
    const client = new ClaudeCliLlmClient({ callTimeoutMs: 40 });
    await expect(client.complete(REQ as never)).rejects.toThrow(/dropped connection/);
  });

  it('a caller-supplied abort still wins and is NOT relabelled as a timeout', async () => {
    queryMock.mockImplementation(neverYieldingStream(() => {}));
    const client = new ClaudeCliLlmClient({ callTimeoutMs: 10_000 });
    const ac = new AbortController();
    const p = client.complete({ ...REQ, signal: ac.signal } as never);
    ac.abort(new Error('user interrupt'));
    await expect(p).rejects.toThrow(/user interrupt/);
  });

  it('does not fire on a healthy call that returns before the deadline', async () => {
    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'success',
          result: 'PONG',
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 1 },
        };
      },
    }));
    const client = new ClaudeCliLlmClient({ callTimeoutMs: 5000 });
    const r = await client.complete(REQ as never);
    expect(r.text).toBe('PONG');
    // Exactly ONE subprocess per call — a retry loop or a double spawn
    // here would cost twice the tokens and twice the wall time.
    expect(queryMock.mock.calls.length).toBe(1);
  });
});
