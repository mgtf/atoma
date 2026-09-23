import { describe, expect, it } from 'vitest';
import { parseRunnerArgs, resolveSupervisionDepth, RunnerConfigError } from '../src/run/runner.js';

/**
 * A PROJECT RUN IS SUPERVISED LIKE ANY OTHER RUN.
 *
 * Measured on production run `e743b47d` (2026-09-23): its delivered result
 * carried `probes: []`, and it published to the tenant's repository anyway.
 * The cause was not in `rootAcceptance.ts` — that code never ran. The default
 * supervision depth was skipped whenever `--seed` was present, and
 * `ProjectRunCoordinator` passes `--seed` for every run after a project's
 * first ("the workspace is the seed of the next"). So `runDepthTask`, and with
 * it root delivery acceptance, the ground-truth probe, the delivery proof
 * floor and the attestation log, were absent from every project run but the
 * first — silently, and increasingly, as a project's corpus grew.
 *
 * Two populations pass `--seed` for unrelated reasons, and only one of them
 * means "hold my protocol fixed". `--comparison` now says that out loud.
 */
describe('supervision depth for a seeded run', () => {
  const profileDefault = 'short' as const;

  it('gives a seeded run the family default — a seed is not a protocol freeze', () => {
    // The regression itself. Before 2026-09-23 this resolved to undefined,
    // which is how a project run lost its root acceptance.
    const args = parseRunnerArgs(['--seed', '/tmp/previous-workspace', 'Build a thing']);
    expect(args.seed).toBe('/tmp/previous-workspace');
    expect(args.comparison).toBe(false);
    expect(resolveSupervisionDepth(args, profileDefault)).toBe('short');
  });

  it('keeps a registered comparison arm on its own protocol', () => {
    const args = parseRunnerArgs(['--comparison', '--seed', '/tmp/round-3', 'Build a thing']);
    expect(args.comparison).toBe(true);
    expect(resolveSupervisionDepth(args, profileDefault)).toBeUndefined();
  });

  it('keeps a baseline arm on its own protocol, seeded or not', () => {
    expect(resolveSupervisionDepth(parseRunnerArgs(['--baseline', 'g']), profileDefault)).toBeUndefined();
  });

  it('lets an explicit --depth win over the family default', () => {
    const args = parseRunnerArgs(['--depth', 'deep', 'Build a thing']);
    expect(resolveSupervisionDepth(args, profileDefault)).toBe('deep');
  });

  it('answers undefined for a family with no depth contract', () => {
    expect(resolveSupervisionDepth(parseRunnerArgs(['g']), undefined)).toBeUndefined();
  });

  it('now ACCEPTS --depth beside a seed, and still refuses it beside a comparison arm', () => {
    // The guard used to read `baseline || seed`, so a project run could not be
    // given a depth explicitly either — the exclusion was stated twice.
    expect(parseRunnerArgs(['--depth', 'short', '--seed', '/tmp/w', 'g']).depth).toBe('short');
    expect(() => parseRunnerArgs(['--depth', 'short', '--comparison', 'g'])).toThrow(RunnerConfigError);
    expect(() => parseRunnerArgs(['--depth', 'short', '--baseline', 'g'])).toThrow(RunnerConfigError);
  });
});
