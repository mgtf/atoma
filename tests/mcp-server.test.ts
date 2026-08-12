import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { INSTRUCTIONS } from '../src/mcp/server.js';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  RUN_FLAGS,
  RunRejected,
  buildRunArgs,
  cancelRun,
  repoRoot,
  resetRunsForTest,
  runStatus,
  shutdownRuns,
  startRun,
  validateStartInput,
  type RunDriver,
} from '../src/mcp/run.js';
import type { RunLeaseAcquirer } from '../src/mcp/runLock.js';
import { families, friction, registryList, runTrace, skillsList } from '../src/mcp/readers.js';
import { BUILTIN_TOOL_VOCABULARY } from '../src/atoms/verdict.js';
import { storeDbPath } from '../src/core/stores.js';

/**
 * The atoma MCP server — atoma exposed to an MCP host (Claude Code) over
 * STDIO.
 *
 * WHAT THIS SUITE IS FOR. AGENTS.md records, twice and with measurements, that
 * a SECOND ENTRYPOINT ROTS: `research-brief.ts` silently lacked every safety
 * guarantee the build path gained, and `curriculum.ts`'s copy of the provider
 * switch stopped matching the original. The insurance named there is not a
 * batch of live runs — it is a shape/selection suite that fails the moment the
 * second path stops agreeing with the first. So the cases below pin the
 * agreements that would otherwise drift silently:
 *   - the flags this server can emit are flags the runner actually accepts;
 *   - a goal can never be mistaken for a flag (the `--clean-workspace` class of
 *     bug, which here would archive the caller's workspace AND run the wrong
 *     task);
 *   - runs are serialised, because the workspace is shared;
 *   - stdout carries NOTHING but JSON-RPC frames, driven against a real
 *     subprocess rather than reasoned about.
 */

/** A driver that never spawns anything and never settles — the run stays "running". */
const neverSettles: RunDriver = () => new Promise<string>(() => {});
/** Unit tests exercise bookkeeping; filesystem-lease behavior has its own suite. */
const noLease: RunLeaseAcquirer = () => ({
  path: '<test>',
  attachChild() {},
  release() {},
});
const startTestRun = (
  input: Parameters<typeof startRun>[0],
  driver: RunDriver = neverSettles
): ReturnType<typeof startRun> => startRun(input, driver, noLease);

describe('MCP run tool — argv assembly and validation', () => {
  beforeEach(() => resetRunsForTest());
  afterEach(() => resetRunsForTest());

  it('every flag it can emit is a flag the runner actually accepts', () => {
    // The runner's parser is the authority. A flag this server invents would
    // be warn-and-DISCARDED by `parseRunnerArgs`, so the option would look
    // supported and do nothing — the silent-drift failure mode this suite
    // exists for.
    const runnerSrc = readFileSync(join(repoRoot(), 'src/run/runner.ts'), 'utf8');
    for (const flag of RUN_FLAGS) {
      expect(runnerSrc, `runner.ts never mentions "${flag}"`).toContain(`'${flag}'`);
    }
  });

  it('emits nothing by default, and one flag per opted-out lifecycle stage', () => {
    expect(buildRunArgs({ goal: 'x' })).toEqual([]);
    expect(buildRunArgs({ goal: 'x', learnSkills: false })).toEqual(['--no-learn-skills']);
    expect(
      buildRunArgs({ goal: 'x', learnSkills: false, promoteSkills: false, directSkills: false })
    ).toEqual(['--no-learn-skills', '--no-promote-skills', '--no-direct-skills']);
    expect(buildRunArgs({ goal: 'x', container: true, egress: true })).toEqual([
      '--container',
      '--egress',
    ]);
  });

  /**
   * THE MOTIVATING BUG CLASS. `parseRunnerArgs` warns-and-discards an
   * unrecognised `--` token and then falls back to the family's DEFAULT goal —
   * so a goal of `--clean-workspace ...` would archive the caller's workspace
   * and silently run the Minesweeper build. Same shape as the
   * `--clean-workspace`-mistaken-for-a-goal case pinned in
   * tests/tool-backend-selection.test.ts.
   */
  it('refuses a goal that would be parsed as a flag', () => {
    expect(() => validateStartInput({ goal: '--clean-workspace and then build a thing' })).toThrow(
      RunRejected
    );
    expect(() => validateStartInput({ goal: '--container' })).toThrow(/must not start with "--"/);
    // A single dash is NOT a flag to the runner, so it is a legal goal.
    expect(() => validateStartInput({ goal: '-x marks the spot' })).not.toThrow();
  });

  it('refuses an empty or whitespace-only goal', () => {
    expect(() => validateStartInput({ goal: '' })).toThrow(RunRejected);
    expect(() => validateStartInput({ goal: '   \n\t ' })).toThrow(/empty/);
  });

  it('resolves the family through findLaunchable, so unknown and traversal ids are refused', () => {
    expect(validateStartInput({ goal: 'g' }).family).toBe('build');
    expect(validateStartInput({ goal: 'g', family: 'build' }).family).toBe('build');
    expect(() => validateStartInput({ goal: 'g', family: 'nope' })).toThrow(/unknown family/);
    expect(() => validateStartInput({ goal: 'g', family: '../etc/passwd' })).toThrow(
      /unknown family/
    );
  });

  it('validates the timeout BEFORE spawning — the runner exits(2) on a bad one', () => {
    expect(validateStartInput({ goal: 'g' }).timeoutMs).toBe(DEFAULT_RUN_TIMEOUT_MS);
    expect(validateStartInput({ goal: 'g', timeoutMs: 60_000 }).timeoutMs).toBe(60_000);
    expect(() => validateStartInput({ goal: 'g', timeoutMs: 0 })).toThrow(/positive integer/);
    expect(() => validateStartInput({ goal: 'g', timeoutMs: -1 })).toThrow(RunRejected);
    expect(() => validateStartInput({ goal: 'g', timeoutMs: 1.5 })).toThrow(RunRejected);
    expect(() => validateStartInput({ goal: 'g', timeoutMs: Number.NaN })).toThrow(RunRejected);
  });
});

describe('MCP run tool — serialisation', () => {
  beforeEach(() => resetRunsForTest());
  afterEach(() => resetRunsForTest());

  /**
   * One run at a time is a CORRECTNESS requirement, not politeness: the build
   * workspace is a single shared directory that `--clean-workspace` archives
   * wholesale, and trace attribution is newest-mtime-since — so two concurrent
   * runs cross-attribute their traces and produce plausible-looking WRONG
   * economics instead of an error. The burn-in harness gets this free from its
   * sequential loop; a server has to enforce it.
   */
  it('refuses a second run while one is in flight, naming the one that holds the slot', () => {
    const first = startTestRun({ goal: 'build a thing' });
    expect(first.status).toBe('running');
    expect(() => startTestRun({ goal: 'build another thing' })).toThrow(RunRejected);
    try {
      startTestRun({ goal: 'build another thing' });
    } catch (err) {
      expect((err as Error).message).toContain(first.runId);
    }
  });

  it('keeps the slot while cancellation waits for the child to exit', async () => {
    let finish!: (log: string) => void;
    const driver: RunDriver = () =>
      new Promise<string>((resolveRun) => {
        finish = resolveRun;
      });
    const first = startTestRun({ goal: 'build a thing' }, driver);
    const cancelled = cancelRun({}) as { cancelled?: string };
    expect(cancelled.cancelled).toBe(first.runId);
    const status = runStatus({ runId: first.runId }) as { status: string };
    expect(status.status).toBe('cancelling');
    expect(() => startTestRun({ goal: 'too early' })).toThrow(RunRejected);

    finish('');
    await shutdownRuns();
    expect((runStatus({ runId: first.runId }) as { status: string }).status).toBe('cancelled');
    expect(() => startTestRun({ goal: 'a later run' })).not.toThrow();
  });

  it('the abort signal reaches the driver — that is what makes cancellation graceful', () => {
    let seen: AbortSignal | undefined;
    const capture: RunDriver = (opts) => {
      seen = opts.signal;
      return new Promise<string>(() => {});
    };
    startTestRun({ goal: 'build a thing' }, capture);
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);
    cancelRun({});
    // Aborting is what routes into spawnRun's SIGTERM → 5s grace → SIGKILL
    // sequence; a bare group SIGKILL is uncatchable and leaks browsers.
    expect(seen!.aborted).toBe(true);
  });

  it('server shutdown aborts the active group and waits for settlement', async () => {
    let seen: AbortSignal | undefined;
    let finish!: (log: string) => void;
    const driver: RunDriver = (opts) => {
      seen = opts.signal;
      return new Promise<string>((resolveRun) => {
        finish = resolveRun;
      });
    };
    const first = startTestRun({ goal: 'build a thing' }, driver);
    const shutdown = shutdownRuns('stdio closed');
    expect(seen?.aborted).toBe(true);
    expect((runStatus({ runId: first.runId }) as { status: string }).status).toBe('cancelling');

    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish('');
    await shutdown;
    expect(settled).toBe(true);
    expect((runStatus({ runId: first.runId }) as { status: string }).status).toBe('cancelled');
  });

  it('attaches the detached child pid to the cross-process lease', () => {
    let attachedPid: number | undefined;
    const acquire: RunLeaseAcquirer = () => ({
      path: '<test>',
      attachChild: (pid) => {
        attachedPid = pid;
      },
      release() {},
    });
    const driver: RunDriver = (opts) => {
      opts.onSpawn?.(4242);
      return new Promise<string>(() => {});
    };

    startRun({ goal: 'build a thing' }, driver, acquire);
    expect(attachedPid).toBe(4242);
  });

  it('pins the provider on the child rather than inheriting a dead API key', () => {
    let env: Readonly<Record<string, string>> | undefined;
    let cwd: string | undefined;
    let clean: boolean | undefined;
    const capture: RunDriver = (opts) => {
      env = opts.extraEnv;
      cwd = opts.cwd;
      clean = opts.cleanWorkspace;
      return new Promise<string>(() => {});
    };
    startTestRun({ goal: 'build a thing' }, capture);
    // The host environment carries an ANTHROPIC_API_KEY that the auth chain
    // prefers FIRST (the documented "#1 auth trap"); in this project it is
    // dead, and a run reaching the direct-API path dies in ~15s.
    expect(env?.['ATOMA_LLM']).toBe(process.env['ATOMA_LLM'] ?? 'claude-cli');
    // cwd must be the repo, not whatever directory the host launched us in,
    // or `npm run run:build` fails with a missing-script error.
    expect(cwd).toBe(repoRoot());
    expect(clean).toBe(true);
  });

  it('keepWorkspace is what stops the caller’s deliverable being archived', () => {
    let clean: boolean | undefined;
    const capture: RunDriver = (opts) => {
      clean = opts.cleanWorkspace;
      return new Promise<string>(() => {});
    };
    startTestRun({ goal: 'build a thing', keepWorkspace: true }, capture);
    expect(clean).toBe(false);
  });
});

describe('MCP readers', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-mcp-'));
    for (const k of ['ATOMA_DB_PATH', 'ATOMA_SKILLS_DIR', 'ATOMA_RUNS_DIR']) {
      saved[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('an ABSENT store is an answer, not an error', () => {
    process.env['ATOMA_DB_PATH'] = join(dir, 'nope.db');
    process.env['ATOMA_SKILLS_DIR'] = join(dir, 'no-skills');
    process.env['ATOMA_RUNS_DIR'] = join(dir, 'no-runs');
    const reg = registryList() as { note?: string; types: unknown[] };
    expect(reg.note).toMatch(/no atom store/);
    expect(reg.types).toEqual([]);
    expect((skillsList() as { namespaces: unknown[] }).namespaces).toEqual([]);
    expect((friction() as { runsScanned: number }).runsScanned).toBe(0);
  });

  /**
   * Read against a COPY, never the live store: `openDb` would exec the schema
   * and flip journal_mode on the real file. The copy pattern is
   * tests/run-profile-build.test.ts's.
   */
  it('reads a real store copy through a readonly handle', () => {
    const live = storeDbPath();
    if (!existsSync(live)) return; // fresh clone — nothing to read
    const copy = join(dir, 'copy.db');
    copyFileSync(live, copy);
    process.env['ATOMA_DB_PATH'] = copy;
    const out = registryList({ tier: 1 }) as {
      types: { name: string; tools: string[]; successes: number }[];
    };
    expect(Array.isArray(out.types)).toBe(true);
    for (const t of out.types) {
      expect(typeof t.name).toBe('string');
      expect(Array.isArray(t.tools)).toBe(true);
      expect(typeof t.successes).toBe('number');
    }
  });

  /**
   * The trace reader takes a FILENAME from the caller, so it is the one reader
   * with an escape risk. `basename` alone would accept `../../etc/passwd` as
   * `passwd`; comparing resolved paths refuses it outright. Same rule as
   * `isSafeSkillId` and the `sanitise` traversal fix.
   */
  it('runTrace refuses to leave the runs directory', () => {
    const runs = join(dir, 'runs');
    mkdirSync(runs, { recursive: true });
    process.env['ATOMA_RUNS_DIR'] = runs;
    writeFileSync(join(dir, 'secret.json'), '{"id":"outside"}', 'utf8');
    for (const bad of ['../secret.json', '../../etc/passwd', '/etc/passwd', 'nested/../../secret.json']) {
      expect(JSON.stringify(runTrace({ file: bad })), bad).toMatch(/refused|no trace at/);
    }
    // A real trace inside the directory is served, minus event payloads.
    writeFileSync(
      join(runs, 'ok.json'),
      JSON.stringify({ id: 'r1', label: 'l', startedAt: 'x', events: [{ id: 'e', kind: 'llm', ts: 1 }] }),
      'utf8'
    );
    const got = runTrace({ file: 'ok.json' }) as { id: string; eventCount: number };
    expect(got.id).toBe('r1');
    expect(got.eventCount).toBe(1);
  });

  it('exposes the launchable families with their guidance — the third consumer of TaskProfile', () => {
    const out = families();
    expect(out.families.length).toBeGreaterThan(0);
    for (const f of out.families) {
      expect(f.id.length).toBeGreaterThan(0);
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.help.length).toBeGreaterThan(0);
      expect(f.examples.length).toBeGreaterThan(0);
    }
  });
});

describe('MCP server instructions', () => {
  /**
   * Same rule tests/viz-launch-profiles.test.ts enforces over the Launch tab
   * guidance: never teach a caller to name a builtin tool in a goal. The
   * vocabulary is the closed builtin list, so this check tracks the toolset
   * automatically.
   */
  it('never teach the host to name a builtin tool in a goal', () => {
    for (const tool of BUILTIN_TOOL_VOCABULARY) {
      expect(INSTRUCTIONS, `instructions name the tool "${tool}"`).not.toContain(tool);
    }
  });

  it('states the two properties a host must not paraphrase away', () => {
    expect(INSTRUCTIONS).toMatch(/SERIALISED/);
    expect(INSTRUCTIONS).toMatch(/DESTRUCTIVE/);
  });
});

/**
 * THE LOAD-BEARING TEST. In MCP stdio, stdout IS the protocol and the peer's
 * frame reader THROWS on a non-JSON line — stricter than atoma's own container
 * protocol, which drops them. Meanwhile the run path is a stdout FLOOD (the
 * runner's logger is hardcoded to console.log, plus every `[tool:*]` line and
 * the whole `--- result ---` block), which is why a run has to be a child
 * process and why this file redirects `process.stdout.write` to stderr after
 * handing the transport the real one.
 *
 * That reasoning is only worth as much as a real subprocess says it is, so this
 * drives the actual server: initialize, tools/list, one reader call, and one
 * deliberately-refused call, then asserts every stdout line parses as a frame.
 * Precedent for spawning a real tsx entrypoint in a test:
 * tests/puppeteer-orphan-reaping.test.ts.
 */
describe('MCP server over real stdio', () => {
  it('emits nothing on stdout but JSON-RPC frames', async () => {
    const child = spawn('npx', ['tsx', 'src/mcp/server.ts'], {
      cwd: repoRoot(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString();
    });
    const send = (o: unknown): void => {
      child.stdin.write(JSON.stringify(o) + '\n');
    };
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const frames = (): {
      id?: number;
      result?: { content?: { text: string }[]; tools?: { name: string }[]; isError?: boolean };
    }[] =>
      out
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l) as { id?: number };
          } catch {
            return null;
          }
        })
        .filter((f): f is { id?: number } => f !== null);

    try {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '1' },
        },
      });
      // tsx has to compile the whole import graph before the server answers.
      for (let i = 0; i < 40 && !frames().some((f) => f.id === 1); i++) await wait(500);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'atoma_families', arguments: {} },
      });
      // A refusal must travel as a protocol frame too, not as a stderr crash.
      send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'atoma_run_start', arguments: { goal: '--clean-workspace oops' } },
      });
      for (let i = 0; i < 20 && !frames().some((f) => f.id === 4); i++) await wait(500);

      const lines = out.split('\n').filter((l) => l.trim());
      const nonJson = lines.filter((l) => {
        try {
          JSON.parse(l);
          return false;
        } catch {
          return true;
        }
      });
      expect(nonJson, `non-JSON on stdout: ${nonJson.slice(0, 3).join(' | ')}`).toEqual([]);
      expect(lines.length).toBeGreaterThan(0);

      const list = frames().find((f) => f.id === 2);
      const names = (list?.result?.tools ?? []).map((t) => t.name);
      expect(names).toContain('atoma_run_start');
      expect(names).toContain('atoma_registry_list');
      expect(names).toContain('atoma_families');

      const fam = frames().find((f) => f.id === 3);
      expect(fam?.result?.content?.[0]?.text).toContain('"build"');

      const refused = frames().find((f) => f.id === 4);
      expect(refused?.result?.isError).toBe(true);
      expect(refused?.result?.content?.[0]?.text).toMatch(/must not start with "--"/);

      // The banner proves the server announces itself where it is safe to.
      expect(err).toMatch(/\[atoma-mcp\] ready on stdio/);
    } finally {
      child.kill('SIGTERM');
    }
  }, 90_000);
});
