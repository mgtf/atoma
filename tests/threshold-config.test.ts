import { describe, it, expect, afterEach } from 'vitest';
import {
  trustThreshold,
  promoteThreshold,
  demoteAfter,
  shouldTrustType,
  shouldTrustSkill,
  TRUST_THRESHOLD_SUCCESSES,
  TRUST_PROMOTE_THRESHOLD_SUCCESSES,
  DIRECT_DISPATCH_DEMOTE_AFTER,
} from '../src/atoms/cost.js';

const VARS = ['ATOMA_TRUST_THRESHOLD', 'ATOMA_PROMOTE_THRESHOLD', 'ATOMA_DEMOTE_AFTER'];

describe('lifecycle thresholds are operator-configurable', () => {
  afterEach(() => {
    for (const v of VARS) delete process.env[v];
  });

  it('defaults match the documented constants (and the helpers survive TDZ)', () => {
    expect(trustThreshold()).toBe(TRUST_THRESHOLD_SUCCESSES);
    expect(promoteThreshold()).toBe(TRUST_PROMOTE_THRESHOLD_SUCCESSES);
    expect(demoteAfter()).toBe(DIRECT_DISPATCH_DEMOTE_AFTER);
  });

  it('env overrides are honoured at CALL time', () => {
    process.env['ATOMA_TRUST_THRESHOLD'] = '10';
    process.env['ATOMA_PROMOTE_THRESHOLD'] = '20';
    process.env['ATOMA_DEMOTE_AFTER'] = '1';
    expect(trustThreshold()).toBe(10);
    expect(promoteThreshold()).toBe(20);
    expect(demoteAfter()).toBe(1);
  });

  it('a raised trust threshold really delays the fast-path', () => {
    const type = { successes: 3, failures: 0 } as never as Parameters<typeof shouldTrustType>[0];
    expect(shouldTrustType(type)).toBe(true);
    process.env['ATOMA_TRUST_THRESHOLD'] = '5';
    expect(shouldTrustType(type)).toBe(false);
    expect(shouldTrustSkill({ successes: 3, failures: 0 })).toBe(false);
    expect(shouldTrustSkill({ successes: 5, failures: 0 })).toBe(true);
  });

  it('garbage or non-positive values fall back to the DEFAULT — never to a weaker gate', () => {
    for (const bad of ['0', '-1', 'abc', '', '2.5']) {
      process.env['ATOMA_TRUST_THRESHOLD'] = bad;
      expect(trustThreshold()).toBe(TRUST_THRESHOLD_SUCCESSES);
    }
  });
});
