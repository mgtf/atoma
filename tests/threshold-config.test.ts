import { describe, it, expect, afterEach } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
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
    const db = openDb(':memory:');
    try {
      const registry = new AtomRegistry(db);
      const created = registry.create(1, { description: 'Reader', systemPrompt: 'Read the source.',
        tools: [], params: {}, createdBy: 'test' });
      registry.recordFailure(created.name);
      for (let i = 0; i < 3; i++) registry.recordSuccess(created.name);
      const type = registry.getByName(created.name)!;
      expect(shouldTrustType(type)).toBe(true);
      process.env['ATOMA_TRUST_THRESHOLD'] = '5';
      expect(shouldTrustType(type)).toBe(false);
      expect(shouldTrustSkill({ successes: 3, failures: 0 })).toBe(false);
      expect(shouldTrustSkill({ successes: 5, failures: 0 })).toBe(true);
    } finally { db.close(); }
  });

  it('garbage or non-positive values fall back to the DEFAULT — never to a weaker gate', () => {
    for (const bad of ['0', '-1', 'abc', '', '2.5']) {
      process.env['ATOMA_TRUST_THRESHOLD'] = bad;
      expect(trustThreshold()).toBe(TRUST_THRESHOLD_SUCCESSES);
    }
  });
});
