import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nodeVersionSupported } from '../src/cli/doctor.js';

const PIN = '24.20.0';

describe('Node version contract', () => {
  it('keeps local nvm, CI, the images and the package engine floor on one Node line', () => {
    const local = readFileSync('.nvmrc', 'utf8').trim();
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const release = readFileSync('.github/workflows/release.yml', 'utf8');
    const ruleset = readFileSync('.github/rulesets/protect-main.json', 'utf8');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      engines?: { node?: string };
    };

    // One supported line since 2026-09-07: the pin is the runtime production
    // runs. The matrix keeps a Node LINE label because the protect-main
    // ruleset requires the hermetic check by name; a patch bump must not
    // orphan a required check.
    expect(local).toBe(PIN);
    expect(ci).toContain(`- node: '${PIN}'\n            line: '24'`);
    expect(ci).not.toMatch(/line: '22'/);
    expect(ci).toContain('name: Hermetic checks (Node ${{ matrix.line }})');
    expect(ruleset).toContain('"context": "Hermetic checks (Node 24)"');
    expect(ruleset).not.toContain('Node 22');
    expect(ci.match(/node-version:\s*\$\{\{ matrix.node \}\}/g)).toHaveLength(1);
    expect([...ci.matchAll(/node-version:\s*(\d\S*)/g)].map((m) => m[1])).toEqual(Array<string>(5).fill(PIN));
    expect(ci.match(new RegExp(`node-version:\\s*${PIN.replace(/\./g, '\\.')}`, 'g'))).toHaveLength(5);
    expect(readFileSync('docker/mender.Dockerfile', 'utf8')).toContain(`FROM node:${PIN}-bookworm`);
    expect(readFileSync('docker/worker.Dockerfile', 'utf8')).toContain('FROM node:24-slim');
    expect(readFileSync('docker/preview.Dockerfile', 'utf8')).toContain('FROM node:24-slim');
    expect(release.match(new RegExp(`node-version:\\s*${PIN.replace(/\./g, '\\.')}`, 'g'))).toHaveLength(1);
    expect(pkg.engines?.node).toBe('>=24');
    expect(nodeVersionSupported(local)).toBe(true);
    expect(nodeVersionSupported('22.14.0')).toBe(false);
  });
});
