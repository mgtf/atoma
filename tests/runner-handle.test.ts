import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RunnerConfigError,
  hostLifecycleSnapshot,
  resetHostLifecycleSnapshotForTests,
  resolveDirectDispatch,
  resolveSkillLearning,
  startTask,
} from '../src/run/runner.js';
import { ANTHROPIC_PINS, CLAUDE_CLI_PINS, OLLAMA_PINS } from './tier-pins.js';
import { buildProfile } from '../src/run/profiles/build.js';

/**
 * Review §3.5: runTask used to BE the process (park-forever, process.exit on
 * six paths, sticky env). `startTask` is the library half — it throws typed
 * config errors instead of exiting, resolves lifecycle toggles against a
 * HOST snapshot instead of reading back its own writes, and returns a handle
 * that never parks. The CLI shell (`runTask`) keeps the historical exit
 * codes and stdout byte-for-byte; the real-subprocess suites pin those.
 */

const LIFECYCLE_VARS = [
  'ATOMA_SKILL_LEARN',
  'ATOMA_SKILL_PROMOTE',
  'ATOMA_SKILL_DIRECT',
  'ATOMA_MODEL_L1',
] as const;

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

  it('a snapshot writing ATOMA_MODEL_L1 cannot change the next run\'s host pin', () => {
    delete process.env['ATOMA_MODEL_L1'];
    const first = hostLifecycleSnapshot();
    expect(first.modelL1).toBeUndefined();
    process.env['ATOMA_MODEL_L1'] = 'api:zai:glm-4.5-air';
    expect(hostLifecycleSnapshot().modelL1).toBeUndefined();
  });
});

describe('startTask — typed config errors before any side effect', () => {
  const RUNNER_VARS = [
    buildProfile.envVars.timeoutMs,
    'ATOMA_MODEL_L1',
    'ATOMA_MODEL_L2',
    'ATOMA_MODEL_L3',
    'ATOMA_REQUIRE_ISOLATION',
    'ATOMA_CONTAINER',
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
    process.env['ATOMA_MODEL_L1'] = 'sub:openai:gpt-5.4-mini';
    await expect(startTask(buildProfile, ['goal'])).rejects.toThrow(RunnerConfigError);
    await expect(startTask(buildProfile, ['goal'])).rejects.toThrow(
      /ATOMA_MODEL_L1=sub:openai:gpt-5.4-mini: Codex cannot expose tools/
    );
  });

  it('refuses claude-cli at LAUNCH when the caller supplied a credential snapshot', async () => {
    // claude-cli binds to the machine's `claude /login` session and reads no
    // key, so a supplied credential would be silently ignored and the work
    // would bill the host's subscription. Failing before any spend is the
    // same shape as the codex L1 refusal above.
    process.env[buildProfile.envVars.timeoutMs] = '60000';
    const snapshot: NodeJS.ProcessEnv = {
      ...CLAUDE_CLI_PINS,
      ANTHROPIC_API_KEY: 'sk-ant-tenant-key',
    };
    await expect(
      startTask(buildProfile, ['goal'], { providerEnv: snapshot })
    ).rejects.toThrow(RunnerConfigError);
    await expect(
      startTask(buildProfile, ['goal'], { providerEnv: snapshot })
    ).rejects.toThrow(/cannot honour a supplied credential snapshot/);
  });

  it('refuses the local backend at LAUNCH when isolation is required (T1)', async () => {
    process.env[buildProfile.envVars.timeoutMs] = '60000';
    process.env['ATOMA_REQUIRE_ISOLATION'] = '1';
    await expect(startTask(buildProfile, ['goal'])).rejects.toThrow(RunnerConfigError);
    await expect(startTask(buildProfile, ['goal'])).rejects.toThrow(/not a boundary/);
  });

  it('a run cannot unlock its own jail through the environment it supplies', async () => {
    // The security property of the asymmetry in startTask: providerEnv drives
    // every provider decision, but the isolation requirement is read from the
    // HOST environment. A tenant handed control of both would simply switch
    // the boundary off.
    process.env[buildProfile.envVars.timeoutMs] = '60000';
    process.env['ATOMA_REQUIRE_ISOLATION'] = '1';
    await expect(
      startTask(buildProfile, ['goal'], {
        providerEnv: { ...OLLAMA_PINS, ATOMA_REQUIRE_ISOLATION: '0' },
      })
    ).rejects.toThrow(/not a boundary/);
  });

  it('accepts the run once a container backend is selected', async () => {
    // Proves the gate is passed rather than skipped: with the boundary
    // satisfied, the launch proceeds to the next validation and fails on the
    // deliberately invalid timeout instead.
    process.env['ATOMA_REQUIRE_ISOLATION'] = '1';
    process.env['ATOMA_CONTAINER'] = '1';
    process.env[buildProfile.envVars.timeoutMs] = 'abc';
    await expect(startTask(buildProfile, ['goal'])).rejects.toThrow(/expected positive integer/);
  });

  it('leaves the developer path alone: claude-cli with NO snapshot is accepted', async () => {
    // The guard triggers on the caller having supplied an environment, not on
    // the transport itself. A developer running `sub:anthropic:` tiers against
    // their own subscription supplies nothing, so selection proceeds and the
    // run fails later — here on the deliberately invalid timeout, which only
    // gets evaluated once the transport has been accepted.
    Object.assign(process.env, CLAUDE_CLI_PINS);
    process.env[buildProfile.envVars.timeoutMs] = 'abc';
    await expect(startTask(buildProfile, ['goal'])).rejects.toThrow(/expected positive integer/);
  });

  it('refuses a codex L1 pin that lives ONLY in the snapshot (review 2026-08-18 §1.6)', async () => {
    process.env[buildProfile.envVars.timeoutMs] = '60000';
    delete process.env['ATOMA_MODEL_L1'];
    await expect(
      startTask(buildProfile, ['goal'], {
        providerEnv: { ...OLLAMA_PINS, ATOMA_MODEL_L1: 'sub:openai:gpt-5.4-mini' },
      })
    ).rejects.toThrow(/ATOMA_MODEL_L1=sub:openai:gpt-5.4-mini: Codex cannot expose tools/);
  });

  it('an ambient Codex L1 pin does not fire when the snapshot omits it', async () => {
    // Inverse: the host has a leftover pin; the run was handed its own
    // environment without one and must serve the default, not inherit the
    // ambient detonation.
    process.env['ATOMA_MODEL_L1'] = 'sub:openai:gpt-5.4-mini';
    process.env[buildProfile.envVars.timeoutMs] = 'abc';
    await expect(
      startTask(buildProfile, ['goal'], { providerEnv: { ...OLLAMA_PINS } })
    ).rejects.toThrow(/expected positive integer/);
  });

  it('refuses a machine-bound tier pin inside an otherwise key-bearing snapshot', async () => {
    process.env[buildProfile.envVars.timeoutMs] = '60000';
    await expect(
      startTask(buildProfile, ['goal'], {
        providerEnv: {
          ...ANTHROPIC_PINS,
          ANTHROPIC_API_KEY: 'sk-ant-tenant',
          ATOMA_MODEL_L2: 'sub:anthropic:sonnet',
        },
      })
    ).rejects.toThrow(/ATOMA_MODEL_L2=sub:anthropic:sonnet cannot honour a supplied credential snapshot/);
  });

  it('reads the transport from the SNAPSHOT, not from process.env', async () => {
    // The inverse of the guard: process.env pins sub:anthropic, but the run was
    // handed its own environment and must obey that one. It gets past the
    // transport guard and fails later on the invalid timeout IN THE SNAPSHOT's
    // absence — proving the snapshot, not the ambient value, drove selection.
    Object.assign(process.env, CLAUDE_CLI_PINS);
    process.env[buildProfile.envVars.timeoutMs] = 'abc';
    await expect(
      startTask(buildProfile, ['goal'], {
        providerEnv: { ...OLLAMA_PINS },
      })
    ).rejects.toThrow(/expected positive integer/);
  });
});
