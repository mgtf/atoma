import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nodeVersionSupported } from '../src/cli/doctor.js';

describe('Node version contract', () => {
  it('keeps local nvm, CI and the package engine floor aligned', () => {
    const local = readFileSync('.nvmrc', 'utf8').trim();
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const release = readFileSync('.github/workflows/release.yml', 'utf8');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      engines?: { node?: string };
    };

    expect(local).toBe('22.13.0');
    // core, i18n, viz-smoke, preview-runtime, worker and mender isolation pin the
    // same Node as the engine floor — the count grows with the workflow on
    // purpose, so a new job cannot quietly run on whatever the runner happens
    // to ship.
    expect(ci.match(/node-version:\s*22\.13\.0/g)).toHaveLength(6);
    expect(release.match(/node-version:\s*22\.13\.0/g)).toHaveLength(1);
    expect(pkg.engines?.node).toContain('^22.13.0');
    expect(nodeVersionSupported(local)).toBe(true);
  });
});
