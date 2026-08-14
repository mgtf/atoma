import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { defaultBuiltinTools } from '../src/tools/builtin.js';
import { ToolSandbox } from '../src/tools/sandbox.js';
import {
  buildProfile,
  MERISTEM_SYSTEM_PROMPT,
  MERISTEM_DESCRIPTION,
} from '../src/run/profiles/build.js';
import {
  runTask,
  parseRunnerArgs,
  resolveSkillPromotion,
} from '../src/run/runner.js';

/**
 * Guards for the generic-runner extraction (build-app.ts 541 lines -> a
 * 20-line shell over src/run/runner.ts + src/run/profiles/build.ts).
 *
 * The refactor had to be a pure MOVE, and two things make that non-obvious:
 *
 *  1. SEEDS. `seedL3` re-aligns the persisted tier-3 prompt whenever the
 *     constant changes, and `AtomRegistry.patch` ZEROES trust counters. A
 *     single character drifting during the move would have been the first
 *     tier-3 patch in the project's history. The baseline below pins the
 *     post-taxonomy Meristem tissue prompt.
 *
 *  2. STDOUT. `src/cli/burnin.ts` parses the run's console output to build
 *     `burnin/results.csv`, 146 committed rows of longitudinal cost curve.
 *     Three markers are owned by the runner; losing one silently
 *     reclassifies every future run.
 */

const MERISTEM_PROMPT_SHA16 = '84e5c2227a6fad8a';

function sha16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

describe('build profile — the seeds survived the move byte-for-byte', () => {
  it('the tier-3 prompt still hashes to what the live store held', () => {
    expect(sha16(MERISTEM_SYSTEM_PROMPT)).toBe(MERISTEM_PROMPT_SHA16);
    expect(MERISTEM_SYSTEM_PROMPT.length).toBe(977);
  });

  it('seeding twice on a fresh store does not bump the version', () => {
    // The idempotence that keeps trust alive across runs.
    const reg = new AtomRegistry(openDb(':memory:'));
    const sandbox = new ToolSandbox('/tmp');
    const tools = defaultBuiltinTools({ sandbox }).map((t) => t.declaration);
    const log = (): void => undefined;
    const ctx = { registry: reg, toolDecls: tools, log };

    const first = buildProfile.seedL3(ctx);
    expect(first.systemPrompt).toBe(MERISTEM_SYSTEM_PROMPT);
    expect(first.description).toBe(MERISTEM_DESCRIPTION);
    buildProfile.seedCatalog(ctx);
    const versionsAfterFirst = reg
      .listByTier(1)
      .concat(reg.listByTier(2), reg.listByTier(3))
      .map((t) => `${t.name}:v${t.version}`)
      .sort();

    const second = buildProfile.seedL3(ctx);
    buildProfile.seedCatalog(ctx);
    const versionsAfterSecond = reg
      .listByTier(1)
      .concat(reg.listByTier(2), reg.listByTier(3))
      .map((t) => `${t.name}:v${t.version}`)
      .sort();

    expect(second.name).toBe(first.name);
    expect(versionsAfterSecond).toEqual(versionsAfterFirst);
  });

  it('seeds the three L1 buckets and the two L2 orchestrators', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const tools = defaultBuiltinTools({ sandbox: new ToolSandbox('/tmp') }).map(
      (t) => t.declaration
    );
    const ctx = { registry: reg, toolDecls: tools, log: (): void => undefined };
    buildProfile.seedL3(ctx);
    buildProfile.seedCatalog(ctx);
    expect(reg.listByTier(1)).toHaveLength(3);
    expect(reg.listByTier(2)).toHaveLength(2);
    expect(reg.listByTier(3)).toHaveLength(1);
  });

  it('carries the artefact-neutral task constraints', () => {
    const task = buildProfile.buildTask('do a thing');
    expect(task.description).toBe('do a thing');
    expect(task.constraints).toHaveLength(3);
    // The web pattern must NOT be the only verification named — that bias is
    // exactly what the greet-cli run exposed.
    const joined = (task.constraints ?? []).join(' ');
    expect(joined).toMatch(/start_node_server \+ fetch_url/);
    expect(joined).toMatch(/run_shell executing the artefact/);
  });
});

describe('runner CLI parsing — the divergence from parseCliArgs is load-bearing', () => {
  it('keeps the goal that FOLLOWS --clean-workspace', () => {
    // src/cli/args.ts treats --clean-workspace as a flag-with-value and would
    // swallow the goal, silently falling back to the default Minesweeper task
    // on every burn-in run. That is why the runner keeps its own parser.
    const args = parseRunnerArgs(['--clean-workspace', 'Build a CSV merger CLI']);
    expect(args.cleanWorkspace).toBe(true);
    expect(args.goal).toBe('Build a CSV merger CLI');
  });

  it('reads the skill kill switches and takes the FIRST positional as the goal', () => {
    const args = parseRunnerArgs([
      'first goal',
      'second ignored',
      '--no-learn-skills',
      '--no-promote-skills',
      '--no-direct-skills',
    ]);
    expect(args.goal).toBe('first goal');
    expect(args.noLearnSkills).toBe(true);
    expect(args.noPromoteSkills).toBe(true);
    expect(args.noDirectSkills).toBe(true);
  });

  it('marks --seed as maintenance context without swallowing the goal', () => {
    const args = parseRunnerArgs([
      '--seed',
      'benchmark/fixtures/wclite',
      'Maintain the seeded CLI',
    ]);
    expect(args.seed).toBe('benchmark/fixtures/wclite');
    expect(args.goal).toBe('Maintain the seeded CLI');
  });
});

describe('runner skill-promotion policy — pure, no provider calls', () => {
  it('freezes compilation on an unseeded run by default', () => {
    expect(resolveSkillPromotion({ noPromoteSkills: false }, undefined)).toEqual({
      enabled: false,
      source: 'default-disable',
    });
  });

  it('enables compilation by default for a seeded maintenance run', () => {
    expect(
      resolveSkillPromotion(
        { noPromoteSkills: false, seed: 'benchmark/fixtures/wclite' },
        undefined
      )
    ).toEqual({ enabled: true, source: 'seed-default' });
  });

  it('keeps exact ATOMA_SKILL_PROMOTE=1 as an explicit unseeded opt-in', () => {
    expect(resolveSkillPromotion({ noPromoteSkills: false }, '1')).toEqual({
      enabled: true,
      source: 'environment-enable',
    });
  });

  it('lets an explicit environment opt-out override the maintenance default', () => {
    expect(
      resolveSkillPromotion({ noPromoteSkills: false, seed: '/fixture' }, '0')
    ).toEqual({ enabled: false, source: 'environment-disable' });
  });

  it('fails closed on mistyped environment opt-ins', () => {
    expect(resolveSkillPromotion({ noPromoteSkills: false, seed: '/fixture' }, 'true')).toEqual({
      enabled: false,
      source: 'environment-disable',
    });
  });

  it('makes --no-promote-skills the final veto over env opt-in and seed mode', () => {
    expect(resolveSkillPromotion({ noPromoteSkills: true, seed: '/fixture' }, '1')).toEqual({
      enabled: false,
      source: 'cli-disable',
    });
  });
});

describe('runner stdout contract — burn-in parses this', () => {
  const src = readFileSync('src/run/runner.ts', 'utf8');

  // Legacy outcome markers remain stable for interrupted runs that cannot
  // emit the structured epilogue.
  it.each([
    ['✓ build finished', 'delivered'],
    ['--- run failed ---', 'failed'],
    ['TIMEOUT after', 'failed'],
  ])('still emits %s (burn-in reads it as "%s")', (marker) => {
    expect(src).toContain(marker);
  });

  it('emits the machine stats epilogue on delivered and failed paths', () => {
    expect(src.match(/formatRunStatsEpilogue\(machineRunStats\('delivered'/g)).toHaveLength(1);
    expect(src.match(/formatRunStatsEpilogue\(machineRunStats\('failed'/g)).toHaveLength(2);
  });

  it('exposes runTask taking a profile plus argv', () => {
    expect(typeof runTask).toBe('function');
    expect(runTask.length).toBe(2);
  });
});
