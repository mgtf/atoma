import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  CodexCliLlmClient,
  buildCodexArgs,
  codexCallTimeoutMs,
  codexEffortFor,
  foldCodexEvents,
  isCodexTransientError,
  mapCodexUsage,
  resolveCodexModel,
  CODEX_MODEL_FRONTIER,
  CODEX_MODEL_MID,
  CODEX_MODEL_SMALL,
  DEFAULT_CODEX_CALL_TIMEOUT_MS,
} from '../src/core/llmCodexCli.js';
import { pricesFor } from '../src/core/metrics.js';
import type { LlmCompletionRequest, ToolExecutor } from '../src/core/types.js';
import { makeTools } from './helpers/factories.js';

/**
 * The Codex transport: a ChatGPT-subscription provider for tiers 2 and 3.
 * Every assertion here is anchored on something measured against
 * codex-cli 0.147.0 on 2026-08-11 — see the class docstring in
 * src/core/llmCodexCli.ts.
 */

function req(over: Partial<LlmCompletionRequest> = {}): LlmCompletionRequest {
  return {
    model: 'gpt-5.6-sol',
    systemPrompt: 'you are an atom',
    userContent: 'plan this',
    ...over,
  };
}

/** Minimal ChildProcess double: scripted stdout lines, then close. */
function fakeChild(script: {
  lines?: readonly string[];
  gapMs?: number;
  stderr?: string;
  neverEnd?: boolean;
}): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: (s: string) => void };
    killed: boolean;
  };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.assign(child, {
    stdout,
    stderr,
    stdin: { end: () => undefined },
    pid: undefined,
    killed: false,
    kill: () => {
      (child as { killed: boolean }).killed = true;
      // A killed subprocess closes; the client must not hang waiting.
      setImmediate(() => child.emit('close', null));
      return true;
    },
  });
  const gap = script.gapMs ?? 0;
  void (async () => {
    // Yield FIRST. The client attaches its listeners inside the Promise
    // executor that follows the spawn call, so a synchronous emit here
    // would fire into the void — a bug in the double, not the client (real
    // Node streams never emit before the next tick).
    await new Promise((r) => setImmediate(r));
    for (const line of script.lines ?? []) {
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      stdout.emit('data', Buffer.from(line + '\n'));
    }
    if (script.stderr) stderr.emit('data', Buffer.from(script.stderr));
    if (!script.neverEnd) setImmediate(() => child.emit('close', 0));
  })();
  return child;
}

const OK_LINES = [
  '{"type":"thread.started","thread_id":"t1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"{\\"ok\\":1}"}}',
  '{"type":"turn.completed","usage":{"input_tokens":9768,"cached_input_tokens":6912,"cache_write_input_tokens":0,"output_tokens":9,"reasoning_output_tokens":4}}',
];

describe('resolveCodexModel — a subscription serves slugs, not families', () => {
  afterEach(() => {
    delete process.env['ATOMA_CODEX_MODEL'];
  });

  it('passes a real Codex slug through verbatim, so a new release needs no code change', () => {
    expect(resolveCodexModel('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(resolveCodexModel('gpt-5.6-luna')).toBe('gpt-5.6-luna');
    expect(resolveCodexModel('gpt-7-whatever')).toBe('gpt-7-whatever');
  });

  it('rewrites bare `gpt-5` — MEASURED to hard-400 on a ChatGPT account', () => {
    // "The 'gpt-5' model is not supported when using Codex with a ChatGPT
    // account." A plausible-looking pin that cannot work.
    expect(resolveCodexModel('gpt-5')).toBe(CODEX_MODEL_FRONTIER);
  });

  it('maps Anthropic tier defaults by POWER rather than 400ing on them', () => {
    expect(resolveCodexModel('claude-opus-5')).toBe(CODEX_MODEL_FRONTIER);
    expect(resolveCodexModel('claude-sonnet-5')).toBe(CODEX_MODEL_MID);
    expect(resolveCodexModel('claude-haiku-4-5-20251001')).toBe(CODEX_MODEL_SMALL);
  });

  it('ATOMA_CODEX_MODEL overrides every tier (debug escape hatch)', () => {
    process.env['ATOMA_CODEX_MODEL'] = 'gpt-5.4-mini';
    expect(resolveCodexModel('gpt-5.6-sol')).toBe('gpt-5.4-mini');
  });
});

describe('mapCodexUsage — OpenAI counts cached INSIDE input, Anthropic does not', () => {
  it('subtracts the cached portions to recover atoma\'s disjoint convention', () => {
    // VERIFIED, not assumed: two identical calls both reported
    // input=9768 cached=6912. Under a disjoint convention the warm second
    // call's `input` would have collapsed; it did not move.
    const u = mapCodexUsage({
      input_tokens: 9768,
      cached_input_tokens: 6912,
      cache_write_input_tokens: 0,
      output_tokens: 9,
      reasoning_output_tokens: 4,
    });
    expect(u.inputTokens).toBe(9768 - 6912);
    expect(u.cacheReadInputTokens).toBe(6912);
    // estimateCostUsd's invariant: total = input + cache_read + cache_create.
    expect(u.inputTokens + (u.cacheReadInputTokens ?? 0)).toBe(9768);
  });

  it('counts reasoning tokens as output — they are billed and are NOT in output_tokens', () => {
    // Measured on a real plan call: 186 output, 41 reasoning, reported
    // separately. Ignoring reasoning would make a high-effort plan read as
    // nearly free.
    const u = mapCodexUsage({ input_tokens: 10, output_tokens: 186, reasoning_output_tokens: 41 });
    expect(u.outputTokens).toBe(227);
  });

  it('clamps at zero, so a future counter-semantics change under-estimates instead of going negative', () => {
    // The failure AGENTS.md records for the Anthropic path was a
    // subtraction producing NEGATIVE costs. Here subtraction is the
    // conversion, so the guard is the clamp.
    const u = mapCodexUsage({ input_tokens: 100, cached_input_tokens: 900 });
    expect(u.inputTokens).toBe(0);
  });

  it('omits cache fields when zero, matching the Anthropic client\'s shape', () => {
    const u = mapCodexUsage({ input_tokens: 50, output_tokens: 5 });
    expect(u.cacheReadInputTokens).toBeUndefined();
    expect(u.cacheCreationInputTokens).toBeUndefined();
  });
});

describe('buildCodexArgs — the isolation guarantees live here', () => {
  const args = buildCodexArgs({
    model: 'gpt-5.6-sol',
    cwd: '/tmp/jail/cwd',
    instructionsFile: '/tmp/jail/instructions.txt',
    effort: 'medium',
  });

  it('confines the model to an empty cwd that is not a git repo', () => {
    // THE LOAD-BEARING FLAG. Codex keeps its own shell/read tools
    // (openai/codex#6049), so the cwd bounds what it can reach — an empty
    // dir outside the repo keeps atoma.db and skills/ off the map.
    expect(args).toContain('-C');
    expect(args[args.indexOf('-C') + 1]).toBe('/tmp/jail/cwd');
    expect(args).toContain('--skip-git-repo-check');
  });

  it('forbids writes: L2/L3 produce text, never disk changes', () => {
    expect(args[args.indexOf('-s') + 1]).toBe('read-only');
  });

  it('isolates from operator config, the settingSources:[] equivalent', () => {
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ignore-rules');
  });

  it('persists no session: atoma makes stateless one-shot calls', () => {
    expect(args).toContain('--ephemeral');
  });

  it('carries the ATOM system prompt in place of Codex\'s own preamble', () => {
    // Measured -3.5k input tokens, and the only key that works:
    // experimental_instructions_file / base_instructions_file are ignored.
    expect(args).toContain('model_instructions_file=/tmp/jail/instructions.txt');
  });

  it('emits JSONL and reads the prompt from stdin (argv cannot hold a catalog)', () => {
    expect(args).toContain('--json');
    expect(args[args.length - 1]).toBe('-');
  });

  it('passes a pinned effort through — the one real cost lever here', () => {
    // maxTokens is advisory-only on this transport, as under claude-cli.
    expect(args).toContain('model_reasoning_effort=medium');
    expect(codexEffortFor(req({ params: { effort: 'low' } }))).toBe('low');
  });

  it('FLOORS an unpinned call at medium instead of taking the provider default', () => {
    // atoma pins effort: 'medium' on L2/L3 plan and nowhere else, because on
    // Anthropic an unpinned call inherits the MODEL's default — 'high' on
    // Opus 5 / Sonnet 5 — so the pin exists to bring plan calls DOWN.
    // gpt-5.6-sol defaults the other way, to 'low'. Passing nothing through
    // therefore inverts the intent rather than reproducing it, and it lands
    // on selfPlan/selfExecute: the FALLBACK turns the loop reaches only after
    // L1 and L2 have both failed, i.e. where the run has least margin.
    expect(codexEffortFor(req())).toBe('medium');
    const bare = buildCodexArgs({ model: 'm', cwd: '/c', instructionsFile: '/i' });
    expect(bare.join(' ')).not.toContain('model_reasoning_effort');
  });
});

describe('foldCodexEvents — tolerant fold of the JSONL stream', () => {
  it('extracts the agent message and the usage', () => {
    const o = foldCodexEvents(OK_LINES);
    expect(o.text).toBe('{"ok":1}');
    expect(o.usage.inputTokens).toBe(2856);
    expect(o.error).toBeUndefined();
  });

  it('does NOT treat an `error` ITEM as a failure — it rides alongside a good answer', () => {
    // Measured: "Model metadata for `gpt-5` not found. Defaulting to
    // fallback metadata" arrives as an item.completed of type error on
    // turns that then succeed. Reading it as the outcome's error would
    // fail healthy calls.
    const o = foldCodexEvents([
      '{"type":"item.completed","item":{"type":"error","message":"metadata not found, using fallback"}}',
      ...OK_LINES,
    ]);
    expect(o.error).toBeUndefined();
    expect(o.text).toBe('{"ok":1}');
  });

  it('reports a turn.failed / error event as the outcome error', () => {
    const failed = foldCodexEvents([
      '{"type":"error","message":"{\\"status\\":400,\\"error\\":{\\"message\\":\\"nope\\"}}"}',
      '{"type":"turn.failed","error":{"message":"{\\"status\\":400}"}}',
    ]);
    expect(failed.error).toBeDefined();
    expect(failed.text).toBe('');
  });

  it('skips unparseable lines rather than dying — the CLI may add event types', () => {
    const o = foldCodexEvents(['not json at all', '', ...OK_LINES]);
    expect(o.text).toBe('{"ok":1}');
  });

  it('lets the LAST agent message win, so a preamble cannot displace the payload', () => {
    const o = foldCodexEvents([
      '{"type":"item.completed","item":{"type":"agent_message","text":"thinking out loud"}}',
      ...OK_LINES,
    ]);
    expect(o.text).toBe('{"ok":1}');
  });
});

describe('isCodexTransientError', () => {
  it('retries 5xx and the 429 subscription throttle', () => {
    expect(isCodexTransientError('{"status":503,"error":{}}')).toBe(true);
    // A burn-in batch throttling on a subscription is transient by definition.
    expect(isCodexTransientError('{"status":429,"error":{}}')).toBe(true);
  });

  it('does NOT retry a real request error the caller must see', () => {
    expect(
      isCodexTransientError(
        '{"status":400,"error":{"message":"The \'gpt-5\' model is not supported"}}'
      )
    ).toBe(false);
  });
});

describe('CodexCliLlmClient — L1 is refused STRUCTURALLY', () => {
  it('throws when handed tools: Codex cannot disable its own built-ins (#6049)', async () => {
    // The refusal is the whole safety story of this provider. Silently
    // serving a tool-bearing request would let the model act on the
    // filesystem OUTSIDE ToolSandbox: no jail, no #8a scope gate, no
    // record_probe, no VizToolEvents. A wrong tier pin must fail LOUDLY at
    // the first call, not produce an unobservable run.
    const client = new CodexCliLlmClient({ spawnFn: () => fakeChild({ lines: OK_LINES }) });
    await expect(client.complete(req({ tools: makeTools(['write_file']) }))).rejects.toThrow(
      /tiers 2 and 3 only/
    );
  });

  it('throws when handed an executor even with no declared tools', async () => {
    const executor: ToolExecutor = { execute: async () => undefined, has: () => true };
    const client = new CodexCliLlmClient({ spawnFn: () => fakeChild({ lines: OK_LINES }) });
    await expect(client.complete(req({ executor }))).rejects.toThrow(/openai\/codex#6049/);
  });

  it('names a working alternative in the error, not just the problem', async () => {
    const client = new CodexCliLlmClient({ spawnFn: () => fakeChild({ lines: OK_LINES }) });
    await expect(client.complete(req({ tools: makeTools(['read_file']) }))).rejects.toThrow(
      /ATOMA_MODEL_L1=/
    );
  });
});

describe('CodexCliLlmClient — transport', () => {
  it('returns the agent message and mapped usage on a healthy call', async () => {
    const client = new CodexCliLlmClient({ spawnFn: () => fakeChild({ lines: OK_LINES }) });
    const res = await client.complete(req());
    expect(res.text).toBe('{"ok":1}');
    expect(res.usage.inputTokens).toBe(2856);
    expect(res.usage.cacheReadInputTokens).toBe(6912);
    expect(res.usage.outputTokens).toBe(13);
  });

  it('spawns exactly ONE subprocess per successful call', async () => {
    let spawns = 0;
    const client = new CodexCliLlmClient({
      spawnFn: () => {
        spawns++;
        return fakeChild({ lines: OK_LINES });
      },
    });
    await client.complete(req());
    expect(spawns).toBe(1);
  });

  it('retries ONCE on a transient error, then surfaces it', async () => {
    const bad = ['{"type":"turn.failed","error":{"message":"{\\"status\\":503}"}}'];
    let spawns = 0;
    const client = new CodexCliLlmClient({
      spawnFn: () => {
        spawns++;
        return fakeChild({ lines: bad });
      },
    });
    await expect(client.complete(req())).rejects.toThrow(/after 1 retry/);
    expect(spawns).toBe(2);
  }, 20000);

  it('does not retry a non-transient error', async () => {
    let spawns = 0;
    const client = new CodexCliLlmClient({
      spawnFn: () => {
        spawns++;
        return fakeChild({
          lines: ['{"type":"turn.failed","error":{"message":"{\\"status\\":400}"}}'],
        });
      },
    });
    await expect(client.complete(req())).rejects.toThrow(/codex call failed/);
    expect(spawns).toBe(1);
  });

  it('treats a silent dead subprocess as an error, never as an empty answer', async () => {
    // Missing CLI / auth failure / crash: stderr is the only evidence.
    const client = new CodexCliLlmClient({
      spawnFn: () => fakeChild({ lines: [], stderr: 'command not found: codex' }),
    });
    await expect(client.complete(req())).rejects.toThrow(/command not found/);
  });

  it('kills a wedged call on the INACTIVITY deadline', async () => {
    // The 11-day-zombie shape: a subprocess that emits nothing, forever.
    const client = new CodexCliLlmClient({
      callTimeoutMs: 60,
      spawnFn: () => fakeChild({ neverEnd: true }),
    });
    await expect(client.complete(req())).rejects.toThrow(/idle/);
  });

  it('does NOT kill a LONG BUT ACTIVE call — the clock measures silence', async () => {
    // The lesson that cost real work on the claude-cli transport: a
    // total-duration cap axed a healthy web run that was still emitting
    // tool calls. Total runtime here (~4 gaps of 40ms) exceeds the 60ms
    // deadline several times over, yet every gap is under it.
    const client = new CodexCliLlmClient({
      callTimeoutMs: 60,
      spawnFn: () => fakeChild({ lines: OK_LINES, gapMs: 40 }),
    });
    const res = await client.complete(req());
    expect(res.text).toBe('{"ok":1}');
  });

  it('honours an already-aborted signal without spawning', async () => {
    let spawns = 0;
    const client = new CodexCliLlmClient({
      spawnFn: () => {
        spawns++;
        return fakeChild({ lines: OK_LINES });
      },
    });
    const ac = new AbortController();
    ac.abort(new Error('run budget exhausted'));
    await expect(client.complete(req({ signal: ac.signal }))).rejects.toThrow(
      /run budget exhausted/
    );
    expect(spawns).toBe(0);
  });

  it('codexCallTimeoutMs falls back to the DEFAULT on a typo, never disabling the guard', () => {
    const prev = process.env['ATOMA_CODEX_CALL_TIMEOUT_MS'];
    try {
      process.env['ATOMA_CODEX_CALL_TIMEOUT_MS'] = 'not-a-number';
      expect(codexCallTimeoutMs()).toBe(DEFAULT_CODEX_CALL_TIMEOUT_MS);
      process.env['ATOMA_CODEX_CALL_TIMEOUT_MS'] = '-5';
      expect(codexCallTimeoutMs()).toBe(DEFAULT_CODEX_CALL_TIMEOUT_MS);
      process.env['ATOMA_CODEX_CALL_TIMEOUT_MS'] = '1234';
      expect(codexCallTimeoutMs()).toBe(1234);
    } finally {
      if (prev === undefined) delete process.env['ATOMA_CODEX_CALL_TIMEOUT_MS'];
      else process.env['ATOMA_CODEX_CALL_TIMEOUT_MS'] = prev;
    }
  });
});

describe('pricing — a Codex call must never read as free', () => {
  it('prices the GPT-5.6 slugs, with or without the routing prefix', () => {
    // Unmatched models fall to 0/0/0, which would make every tiering
    // comparison flattering and false: the spend has moved to another
    // subscription, not vanished.
    expect(pricesFor('codex:gpt-5.6-sol')).toEqual({ input: 5, output: 30, cachedInput: 0.5 });
    expect(pricesFor('gpt-5.6-terra')).toEqual({ input: 2, output: 12, cachedInput: 0.2 });
    expect(pricesFor('codex:gpt-5.6-luna')).toEqual({ input: 0.2, output: 1.2, cachedInput: 0.02 });
  });

  it('falls back for older slugs instead of pricing them at zero', () => {
    expect(pricesFor('codex:gpt-5.4-mini').input).toBeGreaterThan(0);
    expect(pricesFor('gpt-5.5').output).toBeGreaterThan(0);
  });

  it('does not disturb the Anthropic or GLM rows', () => {
    expect(pricesFor('claude-opus-5')).toEqual({ input: 5, output: 25, cachedInput: 0.5 });
    expect(pricesFor('claude-sonnet-5').output).toBe(15);
    expect(pricesFor('zai:glm-4.5-air').input).toBe(0.6);
  });
});
