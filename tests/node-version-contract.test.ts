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

    expect(local).toBe('22.14.0');
    // Core verifies both the engine floor and the observed production runtime.
    // The remaining jobs pin the floor, including the mender command image.
    expect(ci).toContain("node: ['22.14.0', '24.20.0']");
    expect(ci.match(/node-version:\s*\$\{\{ matrix.node \}\}/g)).toHaveLength(1);
    expect(ci.match(/node-version:\s*22\.14\.0/g)).toHaveLength(5);
    expect(readFileSync('docker/mender.Dockerfile', 'utf8')).toContain('FROM node:22.14.0-bookworm');
    expect(release.match(/node-version:\s*22\.14\.0/g)).toHaveLength(1);
    expect(pkg.engines?.node).toContain('^22.14.0');
    expect(nodeVersionSupported(local)).toBe(true);
  });
});
