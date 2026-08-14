import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RunnerConfigError,
  hostLifecycleSnapshot,
  resetHostLifecycleSnapshotForTests,
  resolveDirectDispatch,
  resolveSkillLearning,
  startTask,
} from '../src/run/runner.js';
import { buildProfile } from '../src/run/profiles/build.js';

/**
 * Review §3.5: runTask used to BE the process (park-forever, process.exit on
 * six paths, sticky env). `startTask` is the library half — it throws typed
 * config errors instead of exiting, resolves lifecycle toggles against a
 * HOST snapshot instead of reading back its own writes, and returns a handle
 * that never parks. The CLI shell (`runTask`) keeps the historical exit
 * codes and stdout byte-for-byte; the real-subprocess suites pin those.
 */

const LIFECYCLE_VARS = ['ATOMA_SKILL_LEARN', 'ATOMA_SKILL_PROMOTE', 'ATOMA_SKILL_DIRECT'] as const;

describe('lifecycle toggles — pure resolvers over HOST intent', () => {
  it('CLI flag > env kill switch > default-on, for learning and direct dispatch', () => {
    for (const resolve of [resolveSkillLearning, resolveDirectDispatch]) {
      expect(resolve(true, undefined)).toEqual({ enabled: false, source: 'cli-disable' });
      expect(resolve(true, '1')).toEqual({ enabled: false, source: 'cli-disable' });
      expect(resolve(false, '0')).toEqual({ enabled: false, source: 'environment-disable' });
      expect(resolve(false, undefined)).toEqual({ enabled: true, source: 'default-enable' });
      // Only the exact kill value disables; garbage stays default-on.
      expect(resolve(false, 'off')).toEqual({ enabled: true, source: 'default-enable' });
    }
  });
});

describe('host lifecycle snapshot — the sticky-env fix', () => {
  const before = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const v of LIFECYCLE_VARS) before.set(v, process.env[v]);
    resetHostLifecycleSnapshotForTests();
  });
  afterEach(() => {
    for (const v of LIFECYCLE_VARS) {
      const prev = before.get(v);
      if (prev === undefined) delete process.env[v];
      else process.env[v] = prev;
    }
    resetHostLifecycleSnapshotForTests();
  });

  it('a run writing the env vars cannot change what the next run resolves against', () => {
    // The documented bug: run 1 with --no-learn-skills wrote
    // ATOMA_SKILL_LEARN='0', and run 2 WITHOUT the flag read that '0' back
    // as the operator's choice — default-on silently became sticky-off.
    delete process.env['ATOMA_SKILL_LEARN'];
    const first = hostLifecycleSnapshot();
    expect(first.learn).toBeUndefined();
    // Run 1 mutates the live env (what startTask does after resolving).
    process.env['ATOMA_SKILL_LEARN'] = '0';
    // Run 2 must still see the HOST's intent, not run 1's write.
    const second = hostLifecycleSnapshot();
    expect(second.learn).toBeUndefined();
    expect(resolveSkillLearning(false, second.learn).enabled).toBe(true);
  });
});

describe('startTask — typed config errors before any side effect', () => {
  const RUNNER_VARS = [
    buildProfile.envVars.timeoutMs,
    'ATOMA_MODEL_L1',
    'ATOMA_LLM',
  ] as const;
  const before = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const v of RUNNER_VARS) before.set(v, process.env[v]);
    resetHostLifecycleSnapshotForTests();
  });
  afterEach(() => {
    for (const v of RUNNER_VARS) {
      const prev = before.get(v);
      if (prev === undefined) delete process.env[v];
      else process.env[v] = prev;
    }
    resetHostLifecycleSnapshotForTests();
  });

  it('rejects an invalid timeout with RunnerConfigError (the CLI maps it to exit 2)', async () => {
    process.env[buildProfile.envVars.timeoutMs] = 'abc';
    await expect(startTask(buildProfile, [])).rejects.toThrow(RunnerConfigError);
    await expect(startTask(buildProfile, [])).rejects.toThrow(/expected positive integer/);
  });

  it('rejects a missing --seed directory before touching anything', async () => {
    process.env[buildProfile.envVars.timeoutMs] = '60000';
    await expect(
      startTask(buildProfile, ['--seed', '/nonexistent/atoma-seed-dir', 'goal'])
    ).rejects.toThrow(/--seed: no such directory/);
  });

  it('refuses a codex L1 tier pin at LAUNCH instead of mid-run (review §3.9)', async () => {
    // Codex cannot expose tools through ToolSandbox: an L1 pin would serve
    // every text-only prefilter/validator and detonate at the first
    // tool-bearing execute, after real spend. Doctor has this check; the
    // runner must too, because doctor is optional.
    process.env[buildProfile.envVars.timeoutMs] = '60000';
    process.env['ATOMA_MODEL_L1'] = 'codex:gpt-5.4-mini';
    await expect(startTask(buildProfile, ['goal'])).rejects.toThrow(RunnerConfigError);
    await expect(startTask(buildProfile, ['goal'])).rejects.toThrow(
      /ATOMA_MODEL_L1 cannot use codex/
    );
  });
});
