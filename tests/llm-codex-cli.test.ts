import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  CodexCliLlmClient,
  CodexTransportError,
  buildCodexArgs,
  CODEX_TEXT_ONLY_DISABLED_FEATURES,
  cleanupCodexJails,
  codexChildEnvironment,
  codexCallTimeoutMs,
  codexEffortFor,
  foldCodexEvents,
  isCodexTransientError,
  mapCodexUsage,
  resolveCodexModel,
  resetCodexModelOverrideWarningForTests,
  CODEX_MODEL_FRONTIER,
  CODEX_MODEL_MID,
  CODEX_MODEL_SMALL,
  DEFAULT_CODEX_CALL_TIMEOUT_MS,
} from '../src/core/llmCodexCli.js';
import { InMemoryMetrics, MetricsLlmClient, pricesFor } from '../src/core/metrics.js';
import { RoutingLlmClient } from '../src/core/llmRouting.js';
import type { LlmCompletionRequest, ToolExecutor } from '../src/core/types.js';
import { PERSONAL_CODEX_PROFILE_ROOT_ENV } from '../src/core/codexHomeLease.js';
import { makeTools } from './helpers/factories.js';

afterEach(() => cleanupCodexJails());

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
  pid?: number;
  closeOnKill?: boolean;
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
    pid: script.pid,
    killed: false,
    kill: () => {
      (child as { killed: boolean }).killed = true;
      // A killed subprocess closes; the client must not hang waiting.
      if (script.closeOnKill !== false) setImmediate(() => child.emit('close', null));
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

function installFakeCodex(binRoot: string): void {
  const executable = path.join(binRoot, 'codex');
  writeFileSync(
    executable,
    [
      '#!/usr/bin/env node',
      `const lines = ${JSON.stringify(OK_LINES)}`,
      'process.stdin.resume()',
      "process.stdin.on('end', () => { for (const line of lines) console.log(line) })",
    ].join('\n'),
    'utf8'
  );
  chmodSync(executable, 0o755);
}

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
    // A second boundary around residual built-ins: the permission profile
    // makes this empty directory the only readable workspace.
    expect(args).toContain('-C');
    expect(args[args.indexOf('-C') + 1]).toBe('/tmp/jail/cwd');
    expect(args).toContain('--skip-git-repo-check');
  });

  it('uses one strict permission profile, never the incompatible legacy sandbox', () => {
    expect(args).not.toContain('-s');
    expect(args).not.toContain('--sandbox');
    expect(args).toContain('--strict-config');
    expect(args).toContain('default_permissions="atoma-text-only"');
    expect(args).toContain(
      'permissions.atoma-text-only.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"}}'
    );
    expect(args).toContain('permissions.atoma-text-only.network.enabled=false');
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain('cli_auth_credentials_store="file"');
  });

  it('removes every avoidable Codex tool from a text-only completion', () => {
    const disabled = args.flatMap((arg, index) =>
      arg === '--disable' ? [args[index + 1]] : []
    );
    expect(disabled).toEqual(CODEX_TEXT_ONLY_DISABLED_FEATURES);
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain('agents.enabled=false');
    expect(args).toContain('orchestrator.mcp.enabled=false');
    expect(args).toContain('orchestrator.skills.enabled=false');
    // Codex has no supported apply_patch-off switch. Its remaining patch
    // tool is made inert by root=deny + workspace=read above.
  });

  it('gives any residual command path an empty environment', () => {
    expect(args).toContain('shell_environment_policy.inherit="none"');
    expect(args).toContain('shell_environment_policy.ignore_default_excludes=false');
    expect(args).toContain('allow_login_shell=false');
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

describe('codexChildEnvironment — explicit allowlist, never provider secrets', () => {
  it('keeps only process/runtime paths, proxies, certificates and the selected Codex profile', () => {
    expect(
      codexChildEnvironment({
        PATH: '/safe/bin',
        HOME: '/home/atoma/state',
        LANG: 'en_US.UTF-8',
        HTTPS_PROXY: 'http://proxy.internal',
        SSL_CERT_FILE: '/etc/ssl/custom.pem',
        CODEX_HOME: '/profiles/principal-a/codex',
        CODEX_SQLITE_HOME: '/profiles/principal-a/codex',
        OPENAI_API_KEY: 'must-not-leak',
        CODEX_API_KEY: 'must-not-leak',
        CODEX_ACCESS_TOKEN: 'must-not-leak',
        ANTHROPIC_API_KEY: 'must-not-leak',
        ZAI_API_KEY: 'must-not-leak',
        ATOMA_WEBHOOK_SECRET: 'must-not-leak',
      })
    ).toEqual({
      PATH: '/safe/bin',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy.internal',
      SSL_CERT_FILE: '/etc/ssl/custom.pem',
      CODEX_HOME: '/profiles/principal-a/codex',
      CODEX_SQLITE_HOME: '/profiles/principal-a/codex',
      HOME: '/profiles/principal-a/codex',
      USERPROFILE: '/profiles/principal-a/codex',
    });
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

  it('reduces turn.failed / error diagnostics to a stable non-sensitive code', () => {
    const secret = 'account=private@example.test token=secret-token profile=/private/codex';
    const failed = foldCodexEvents([
      JSON.stringify({
        type: 'error',
        message: JSON.stringify({ status: 400, error: { message: secret } }),
      }),
      JSON.stringify({ type: 'turn.failed', error: { message: `status: 400 ${secret}` } }),
    ]);
    expect(failed.error).toBe('request-rejected');
    expect(JSON.stringify(failed)).not.toContain(secret);
    expect(failed.text).toBe('');
  });

  it('classifies authentication diagnostics without retaining account or token text', () => {
    const secret = 'refresh token super-secret for private@example.test';
    const failed = foldCodexEvents([
      JSON.stringify({
        type: 'turn.failed',
        error: { message: `HTTP 401 unauthorized: invalid ${secret}` },
      }),
    ]);
    expect(failed.error).toBe('authentication-required');
    expect(JSON.stringify(failed)).not.toContain(secret);
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
    expect(isCodexTransientError('HTTP/1.1 502 Bad Gateway')).toBe(true);
    // A burn-in batch throttling on a subscription is transient by definition.
    expect(isCodexTransientError('{"status":429,"error":{}}')).toBe(true);
    expect(isCodexTransientError('HTTP 429 Too Many Requests')).toBe(true);
  });

  it('does NOT retry a real request error the caller must see', () => {
    expect(
      isCodexTransientError(
        '{"status":400,"error":{"message":"The \'gpt-5\' model is not supported"}}'
      )
    ).toBe(false);
  });
});

describe('CodexCliLlmClient — tool request preconditions', () => {
  it('refuses declarations without an executor before spawning', async () => {
    const spawnFn = vi.fn();
    const client = new CodexCliLlmClient({ spawnFn });
    await expect(client.complete(req({ tools: makeTools(['write_file']) }))).rejects.toThrow(/both declared tools and an executor/);
    expect(spawnFn).not.toHaveBeenCalled();
  });
  it('refuses an executor without declarations before spawning', async () => {
    const executor: ToolExecutor = { execute: async () => undefined, has: () => true };
    const spawnFn = vi.fn();
    const client = new CodexCliLlmClient({ spawnFn });
    await expect(client.complete(req({ executor }))).rejects.toThrow(/both declared tools and an executor/);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe('CodexCliLlmClient — transport', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps the host subscription direct and wraps only a personal profile',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'atoma-codex-default-spawn-'));
      try {
        const binRoot = path.join(root, 'bin');
        mkdirSync(binRoot);
        installFakeCodex(binRoot);
        const childPath = `${binRoot}${path.delimiter}${process.env['PATH'] ?? ''}`;

        const host = new CodexCliLlmClient({
          env: { PATH: childPath, HOME: root },
          callTimeoutMs: 5_000,
        });
        await expect(host.complete(req())).resolves.toMatchObject({ text: '{"ok":1}' });
        expect(readdirSync(root).some((name) => name.includes('process-slot'))).toBe(false);

        const profilesRoot = path.join(root, 'profiles');
        const profileHome = path.join(profilesRoot, 'principal', 'codex', 'generation');
        mkdirSync(profileHome, { recursive: true, mode: 0o700 });
        chmodSync(profilesRoot, 0o700);
        chmodSync(path.join(profilesRoot, 'principal'), 0o700);
        chmodSync(path.join(profilesRoot, 'principal', 'codex'), 0o700);
        const personal = new CodexCliLlmClient({
          env: {
            PATH: childPath,
            CODEX_HOME: profileHome,
            CODEX_SQLITE_HOME: profileHome,
            [PERSONAL_CODEX_PROFILE_ROOT_ENV]: profilesRoot,
          },
          callTimeoutMs: 5_000,
        });
        await expect(personal.complete(req())).resolves.toMatchObject({ text: '{"ok":1}' });
        expect(readdirSync(profilesRoot).some((name) => name.includes('process-slot'))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('spawns from an immutable supplied snapshot, in the empty jail, with no API key', async () => {
    const supplied: NodeJS.ProcessEnv = {
      PATH: '/snapshot/bin',
      CODEX_HOME: '/profiles/principal-a/codex',
      CODEX_SQLITE_HOME: '/profiles/principal-a/codex',
      HOME: '/home/atoma/state',
      USERPROFILE: 'C:\\Users\\atoma',
      ATOMA_CODEX_MODEL: 'gpt-5.4-mini',
      OPENAI_API_KEY: 'api-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
    };
    let seenEnv: Readonly<NodeJS.ProcessEnv> | undefined;
    let seenCwd = '';
    let seenArgs: readonly string[] = [];
    const client = new CodexCliLlmClient({
      env: supplied,
      spawnFn: (args, _stdin, env, cwd) => {
        seenArgs = args;
        seenEnv = env;
        seenCwd = cwd;
        return fakeChild({ lines: OK_LINES });
      },
    });

    // Mutating either source after construction cannot switch the payer/profile.
    supplied['CODEX_HOME'] = '/profiles/principal-b/codex';
    supplied['ATOMA_CODEX_MODEL'] = 'gpt-5.6-luna';
    const result = await client.complete(req());

    expect(result.servedModel).toBe('gpt-5.4-mini');
    expect(seenArgs[seenArgs.indexOf('-m') + 1]).toBe('gpt-5.4-mini');
    expect(seenCwd).toBe(seenArgs[seenArgs.indexOf('-C') + 1]);
    expect(seenEnv).toEqual({
      PATH: '/snapshot/bin',
      CODEX_HOME: '/profiles/principal-a/codex',
      CODEX_SQLITE_HOME: '/profiles/principal-a/codex',
      HOME: '/profiles/principal-a/codex',
      USERPROFILE: '/profiles/principal-a/codex',
    });
    expect(Object.isFrozen(seenEnv)).toBe(true);
  });

  it('removes its ephemeral cwd and instruction files on cleanup', async () => {
    let cwd = '';
    const client = new CodexCliLlmClient({
      spawnFn: (args) => {
        cwd = args[args.indexOf('-C') + 1] ?? '';
        return fakeChild({ lines: OK_LINES });
      },
    });
    await client.complete(req());
    expect(existsSync(cwd)).toBe(true);
    cleanupCodexJails();
    expect(existsSync(cwd)).toBe(false);
  });

  it('returns the agent message and mapped usage on a healthy call', async () => {
    const client = new CodexCliLlmClient({ spawnFn: () => fakeChild({ lines: OK_LINES }) });
    const res = await client.complete(req());
    expect(res.text).toBe('{"ok":1}');
    expect(res.usage.inputTokens).toBe(2856);
    expect(res.usage.cacheReadInputTokens).toBe(6912);
    expect(res.usage.outputTokens).toBe(13);
  });

  it('reports the SERVED slug so accounting is not billed on the pin', async () => {
    // resolveCodexModel rewrites Anthropic-shaped pins; without servedModel
    // the metrics layer priced gpt-5.6-sol tokens at the /opus/i row
    // (review 2026-08-14 §1.13).
    const client = new CodexCliLlmClient({ spawnFn: () => fakeChild({ lines: OK_LINES }) });
    const mapped = await client.complete(req({ model: 'claude-opus-5' }));
    expect(mapped.servedModel).toBe(CODEX_MODEL_FRONTIER);
    const verbatim = await client.complete(req({ model: 'gpt-5.6-luna' }));
    expect(verbatim.servedModel).toBe('gpt-5.6-luna');
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

  it('serializes concurrent calls that share one personal CODEX_HOME', async () => {
    const controller = new AbortController();
    let spawns = 0;
    const profileEnv = { CODEX_HOME: '/profiles/principal-a/codex' };
    const first = new CodexCliLlmClient({
      env: profileEnv,
      callTimeoutMs: 5_000,
      spawnFn: () => {
        spawns++;
        return fakeChild({ neverEnd: true });
      },
    });
    const second = new CodexCliLlmClient({
      env: profileEnv,
      spawnFn: () => {
        spawns++;
        return fakeChild({ lines: OK_LINES });
      },
    });

    const firstCall = first.complete(req({ signal: controller.signal }));
    await vi.waitFor(() => expect(spawns).toBe(1));
    const secondCall = second.complete(req());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawns).toBe(1);

    controller.abort(new Error('cancel first lane'));
    await expect(firstCall).rejects.toThrow('cancel first lane');
    await expect(secondCall).resolves.toMatchObject({ text: '{"ok":1}' });
    expect(spawns).toBe(2);
  });

  it('keeps the personal CODEX_HOME lease until a timed-out child is actually reaped', async () => {
    let spawns = 0;
    let firstChild: ChildProcess | null = null;
    const profileEnv = { CODEX_HOME: '/profiles/principal-reap/codex' };
    const first = new CodexCliLlmClient({
      env: profileEnv,
      callTimeoutMs: 20,
      spawnFn: () => {
        spawns++;
        firstChild = fakeChild({
          neverEnd: true,
          pid: 2_147_000_000,
          closeOnKill: false,
        });
        return firstChild;
      },
    });
    const second = new CodexCliLlmClient({
      env: profileEnv,
      spawnFn: () => {
        spawns++;
        return fakeChild({ lines: OK_LINES });
      },
    });

    let firstSettled = false;
    const firstCall = first.complete(req());
    void firstCall.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      }
    );
    await vi.waitFor(() => expect(spawns).toBe(1));
    const secondCall = second.complete(req());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(firstSettled).toBe(false);
    expect(spawns).toBe(1);

    (firstChild as ChildProcess | null)?.emit('close', null);
    await expect(firstCall).rejects.toMatchObject({ code: 'timeout' });
    await expect(secondCall).resolves.toMatchObject({ text: '{"ok":1}' });
    expect(spawns).toBe(2);
  });

  it('retries ONCE on a transient error, then surfaces only its stable code', async () => {
    const secret = 'account=private@example.test token=secret-token';
    const bad = [
      JSON.stringify({
        type: 'turn.failed',
        error: { message: JSON.stringify({ status: 503, detail: secret }) },
      }),
    ];
    let spawns = 0;
    const client = new CodexCliLlmClient({
      spawnFn: () => {
        spawns++;
        return fakeChild({ lines: bad });
      },
    });
    let caught: unknown;
    try {
      await client.complete(req());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CodexTransportError);
    expect(caught).toMatchObject({
      code: 'service-unavailable',
      retried: true,
      message: 'codex call failed [service-unavailable] after 1 retry',
    });
    expect(String(caught)).not.toContain(secret);
    expect(spawns).toBe(2);
  }, 20000);

  it('does not retry or disclose a non-transient provider diagnostic', async () => {
    const secret = 'private@example.test /profiles/principal-a/codex secret-token';
    let spawns = 0;
    const client = new CodexCliLlmClient({
      spawnFn: () => {
        spawns++;
        return fakeChild({
          lines: [
            JSON.stringify({
              type: 'turn.failed',
              error: { message: `status: 400 rejected for ${secret}` },
            }),
          ],
        });
      },
    });
    let caught: unknown;
    try {
      await client.complete(req());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'request-rejected',
      retried: false,
      message: 'codex call failed [request-rejected]',
    });
    expect(String(caught)).not.toContain(secret);
    expect(spawns).toBe(1);
  });

  it('classifies silent-process stderr without disclosing it', async () => {
    // Missing CLI / auth failure / crash: stderr is the only evidence.
    const secret = 'command not found at /private/codex for private@example.test';
    const client = new CodexCliLlmClient({
      spawnFn: () => fakeChild({ lines: [], stderr: secret }),
    });
    let caught: unknown;
    try {
      await client.complete(req());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'transport-unavailable',
      message: 'codex call failed [transport-unavailable]',
    });
    expect(String(caught)).not.toContain(secret);
  });

  it('classifies a synchronous spawn failure without disclosing it', async () => {
    const secret = 'ENOENT /private/bin/codex profile=private@example.test';
    const client = new CodexCliLlmClient({
      spawnFn: () => {
        throw new Error(secret);
      },
    });
    let caught: unknown;
    try {
      await client.complete(req());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'transport-unavailable',
      message: 'codex call failed [transport-unavailable]',
    });
    expect(String(caught)).not.toContain(secret);
  });

  it('kills a wedged call on the INACTIVITY deadline', async () => {
    // The 11-day-zombie shape: a subprocess that emits nothing, forever.
    const client = new CodexCliLlmClient({
      callTimeoutMs: 60,
      spawnFn: () => fakeChild({ neverEnd: true }),
    });
    await expect(client.complete(req())).rejects.toMatchObject({
      code: 'timeout',
      message: 'codex call failed [timeout]',
    });
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

describe('ATOMA_CODEX_MODEL override banner (review 2026-08-14 §1.13)', () => {
  afterEach(() => {
    delete process.env['ATOMA_CODEX_MODEL'];
    resetCodexModelOverrideWarningForTests();
  });

  it('warns ONCE per process on stderr, naming the override and the flattening risk', () => {
    resetCodexModelOverrideWarningForTests();
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }));
    try {
      process.env['ATOMA_CODEX_MODEL'] = 'gpt-5.4-mini';
      // The override rewrites EVERY codex call — the banner must not.
      resolveCodexModel('gpt-5.6-sol');
      resolveCodexModel('claude-opus-5');
      const banners = writes.filter((w) => w.includes('ATOMA_CODEX_MODEL'));
      expect(banners).toHaveLength(1);
      expect(banners[0]).toMatch(/gpt-5\.4-mini/);
      expect(banners[0]).toMatch(/flatten/i);
    } finally {
      spy.mockRestore();
    }
  });

  it('stays silent when the override is not set', () => {
    resetCodexModelOverrideWarningForTests();
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }));
    try {
      resolveCodexModel('gpt-5.6-sol');
      expect(writes.filter((w) => w.includes('ATOMA_CODEX_MODEL'))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('pricing — a Codex call must never read as free', () => {
  it('a codex-PINNED call is priced end to end on the served GPT slug, not the /opus/i row', async () => {
    // Full chain: MetricsLlmClient wraps the ROUTER (where observability
    // lives in production), the router strips the `sub:openai:` selector and
    // dispatches, the transport resolves `claude-opus-5` → gpt-5.6-sol and
    // reports it back.
    const codexClient = new CodexCliLlmClient({ spawnFn: () => fakeChild({ lines: OK_LINES }) });
    const metrics = new InMemoryMetrics();
    const client = new MetricsLlmClient(
      new RoutingLlmClient({ 'codex-cli': codexClient }),
      metrics
    );
    await client.complete({
      model: 'sub:openai:claude-opus-5',
      systemPrompt: 's',
      userContent: 'u',
    });
    expect(metrics.events[0]!.model).toBe(CODEX_MODEL_FRONTIER);
    // OK_LINES usage on the gpt-5.6-sol row ($5 in / $0.5 cached / $30 out):
    //   2856×5/1M + 6912×0.5/1M + 13×30/1M ≈ $0.018126
    // The /opus/i row ($25 out) would read ≈ $0.018061 — close, which is
    // exactly why the row KEY is the assertion that matters.
    expect(metrics.summary().totals.costUsd).toBeCloseTo(0.018126, 5);
  });

  it('prices the GPT-5.6 slugs, with or without the selector', () => {
    // Unmatched models fall to 0/0/0, which would make every tiering
    // comparison flattering and false: the spend has moved to another
    // subscription, not vanished.
    expect(pricesFor('sub:openai:gpt-5.6-sol')).toEqual({ input: 5, output: 30, cachedInput: 0.5 });
    expect(pricesFor('gpt-5.6-terra')).toEqual({ input: 2, output: 12, cachedInput: 0.2 });
    expect(pricesFor('api:openai:gpt-5.6-luna')).toEqual({ input: 0.2, output: 1.2, cachedInput: 0.02 });
  });

  it('falls back for older slugs instead of pricing them at zero', () => {
    expect(pricesFor('sub:openai:gpt-5.4-mini').input).toBeGreaterThan(0);
    expect(pricesFor('gpt-5.5').output).toBeGreaterThan(0);
  });

  it('does not disturb the Anthropic or GLM rows', () => {
    expect(pricesFor('claude-opus-5')).toEqual({ input: 5, output: 25, cachedInput: 0.5 });
    expect(pricesFor('claude-sonnet-5').output).toBe(15);
    expect(pricesFor('api:zai:glm-4.5-air').input).toBe(0.6);
  });
});


describe('Codex L1 host-side action loop', () => {
  function messages(action: unknown): string[] {
    const value = action as { type: string; name?: string; arguments?: unknown; text?: string };
    action = { type: value.type, name: value.name ?? '', argumentsJson: JSON.stringify(value.arguments ?? {}), text: value.text ?? '' };
    return [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(action) } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 2 } })];
  }
  it('keeps each subprocess isolated, refuses off-scope tools, and feeds observed results back', async () => {
    const execute = vi.fn(async () => 'observed-' + 'x'.repeat(25000));
    const observe = vi.fn();
    const inputs: string[] = [];
    const actions = [
      { type: 'tool', name: 'run_shell', arguments: { cmd: 'no' } },
      { type: 'tool', name: 'read_file', arguments: { path: 'answer.txt' } },
      { type: 'final', text: '{"output":"done","summary":"read"}' },
    ];
    const client = new CodexCliLlmClient({ env: {}, spawnFn: (args, input, _env, cwd) => {
      expect(args).toContain('--ignore-user-config');
      expect(args).toContain('permissions.atoma-text-only.network.enabled=false');
      expect(readdirSync(cwd)).toEqual([]);
      inputs.push(input);
      return fakeChild({ lines: messages(actions.shift()) });
    } });
    const result = await client.complete(req({ tools: makeTools(['read_file']), executor: { execute, has: () => true }, onToolInvocation: observe }));
    expect(execute).toHaveBeenCalledExactlyOnceWith('read_file', { path: 'answer.txt' });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe.mock.calls[0]?.[0]).toMatchObject({ name: 'run_shell', error: expect.any(String) });
    expect(observe.mock.calls[1]?.[0].result.length).toBe(25009);
    expect(inputs[1]).toContain('run_shell');
    expect(inputs[2]!.length).toBeLessThan(22000);
    expect(result.text).toBe('{"output":"done","summary":"read"}');
    expect(result.usage).toMatchObject({ inputTokens: 24, outputTokens: 9, cacheReadInputTokens: 6 });
  });
  it('finalizes once at budget and never executes a finalization tool request', async () => {
    const execute = vi.fn(async () => 'ok');
    let calls = 0;
    const client = new CodexCliLlmClient({ env: {}, spawnFn: () => {
      calls++;
      return fakeChild({ lines: messages({ type: 'tool', name: 'write_file', arguments: {} }) });
    } });
    await expect(client.complete(req({ tools: makeTools(['write_file']), executor: { execute, has: () => true }, maxToolIterations: 1 })))
      .rejects.toMatchObject({ message: expect.stringContaining('budget was exhausted'), partialUsage: { inputTokens: 16, outputTokens: 6 } });
    expect(calls).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed actions without execution and retains their usage', async () => {
    const execute = vi.fn();
    const client = new CodexCliLlmClient({ env: {}, spawnFn: () => fakeChild({ lines: messages({ type: 'tool', name: 'write_file', arguments: 'bad' }) }) });
    await expect(client.complete(req({ tools: makeTools(['write_file']), executor: { execute, has: () => true } })))
      .rejects.toMatchObject({ message: expect.stringContaining('invalid Atoma'), partialUsage: { inputTokens: 8, outputTokens: 3 } });
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not issue another model call after cancellation during an action', async () => {
    const controller = new AbortController();
    const spawnFn = vi.fn(() => fakeChild({ lines: messages({ type: 'tool', name: 'read_file', arguments: {} }) }));
    const client = new CodexCliLlmClient({ env: {}, spawnFn });
    await expect(client.complete(req({ signal: controller.signal, tools: makeTools(['read_file']), executor: {
      has: () => true, execute: async () => { controller.abort(new Error('stop')); return 'read'; },
    } }))).rejects.toMatchObject({ message: 'stop', partialUsage: { outputTokens: 3 } });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});
