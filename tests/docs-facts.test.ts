import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildIr, IR_PATH, withRepositoryEvidence } from '../scripts/architecture-ir.mjs';
import { collectFacts, collectNpmRunCommands, englishNumber } from '../scripts/repo-facts.mjs';
import {
  BEGIN,
  END,
  proseFailures,
  renderFactsBlock,
  replaceFactsBlock,
} from '../scripts/readme-facts.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const facts = collectFacts(repoRoot);

/**
 * These gates exist to fail when the repository moves and a document does not.
 * A test that only asserted "it passes today" would therefore prove the least
 * interesting half. Every block below feeds the checker a MUTATED document and
 * requires the specific complaint, because the failure message is the product:
 * it is what tells a contributor which sentence to rewrite and why.
 */
describe('docs facts, across the process boundary they ship as', () => {
  const script = (name: string, ...args: string[]) =>
    spawnSync(process.execPath, [fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), ...args], {
      encoding: 'utf8',
    });

  it('accepts this checkout: the README block and the IR are both current', () => {
    const readme = script('readme-facts.mjs');
    expect(readme.stderr).toBe('');
    expect(readme.status).toBe(0);
    expect(readme.stdout).toMatch(/^readme facts ok: /);

    const ir = script('architecture-ir.mjs');
    expect(ir.stderr).toBe('');
    expect(ir.status).toBe(0);
    expect(ir.stdout).toMatch(/^architecture ir ok: /);
  });

  it('writes nothing in check mode', () => {
    const before = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    script('readme-facts.mjs');
    expect(readFileSync(new URL('../README.md', import.meta.url), 'utf8')).toBe(before);
  });
});

describe('the derivations', () => {
  it('reads every subsystem the AGENTS.md map lists, with its contract path', () => {
    expect(facts.subsystems.length).toBeGreaterThan(10);
    for (const subsystem of facts.subsystems) {
      expect(subsystem.doc).toBe(`${subsystem.dir}/AGENTS.md`);
      expect(subsystem.owns.length).toBeGreaterThan(0);
    }
  });

  it('agrees with the sentences the repository already writes by hand', () => {
    // If these ever disagree, one of the two is wrong and the gate should say
    // so — which is the entire point of deriving them rather than typing them.
    const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
    expect(agents).toContain(`The ${facts.mcpTools} \`atoma_*\` MCP tools`);
    expect(agents).toContain(
      `${facts.pools.molecules} molecules, ${facts.pools.cells} cells, and ${facts.pools.tissues} tissues`,
    );
  });

  it('spells small numbers the way README prose does', () => {
    expect(englishNumber(13)).toBe('thirteen');
    expect(englishNumber(12)).toBe('twelve');
    // Past the table it falls back to digits rather than inventing a word.
    expect(englishNumber(97)).toBe('97');
  });

  it('collects the npm scripts a document tells a reader to type', () => {
    expect(collectNpmRunCommands('run `npm run doctor` then `npm run release:check`')).toEqual([
      'doctor',
      'release:check',
    ]);
  });
});

describe('the generated README block', () => {
  const rendered = renderFactsBlock(facts);

  it('states the derived numbers', () => {
    expect(rendered).toContain(`| MCP tools | ${facts.mcpTools} |`);
    expect(rendered).toContain(`${facts.pools.molecules} molecules`);
    expect(rendered).toContain(facts.node.display);
  });

  it('escapes the pipes inside the engines range so the table survives', () => {
    // "^22.13.0 || >=24" pasted raw ends the Markdown cell mid-value.
    expect(rendered).toContain('\\|\\|');
  });

  it('replaces only what lies between the markers', () => {
    const document = `before\n${BEGIN}\nstale\n${END}\nafter`;
    const updated = replaceFactsBlock(document, `${BEGIN}\nfresh\n${END}`);
    expect(updated).toBe(`before\n${BEGIN}\nfresh\n${END}\nafter`);
  });

  it('refuses a document that lost its markers rather than appending a second block', () => {
    expect(() => replaceFactsBlock('no markers here', rendered)).toThrow(/missing the/);
  });
});

describe('the prose assertions', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');

  it('passes on the current documents', () => {
    expect(proseFailures({ readme, agents, facts })).toEqual([]);
  });

  it('catches a tool count that drifted away from the server', () => {
    const drifted = readme.replace(/\*\*Twenty-four tools\.\*\*/, '**Eleven tools.**');
    expect(proseFailures({ readme: drifted, agents, facts })).toContainEqual(
      expect.stringContaining('says "Eleven tools"'),
    );
  });

  it('catches a Node version that drifted away from .nvmrc', () => {
    const drifted = readme.replace('22.13+ or 24+', '20.11+ or 24+');
    expect(proseFailures({ readme: drifted, agents, facts })).toContainEqual(
      expect.stringContaining('claims Node 20.11+'),
    );
  });

  it('catches a command the package does not define', () => {
    const drifted = `${readme}\n\nRun \`npm run deploy:everything\` to ship.\n`;
    expect(proseFailures({ readme: drifted, agents, facts })).toContainEqual(
      expect.stringContaining('npm run deploy:everything'),
    );
  });

  it('catches a stale pool sentence in the always-loaded agent contract', () => {
    const drifted = agents.replace(
      `${facts.pools.molecules} molecules`,
      `${facts.pools.molecules + 1} molecules`,
    );
    expect(proseFailures({ readme, agents: drifted, facts })).toContainEqual(
      expect.stringContaining('curated pools'),
    );
  });
});

describe('the architecture IR', () => {
  const ir = buildIr({ subsystems: facts.subsystems, facts });

  it('places every mapped subsystem exactly once', () => {
    expect(ir.components).toHaveLength(facts.subsystems.length);
    expect(new Set(ir.components.map((c: { id: string }) => c.id)).size).toBe(facts.subsystems.length);
  });

  it('matches the committed file, so the diagram cannot lag the map', () => {
    const committed = JSON.parse(readFileSync(new URL(`../${IR_PATH}`, import.meta.url), 'utf8'));
    expect(committed).toEqual(ir);
  });

  it('fails when a new subsystem appears in the map but nowhere in the layout', () => {
    const withNewcomer = [
      ...facts.subsystems,
      { dir: 'src/telemetry', name: 'telemetry', doc: 'src/telemetry/AGENTS.md', owns: 'something new' },
    ];
    expect(() => buildIr({ subsystems: withNewcomer, facts })).toThrow(/src\/telemetry.*not in LAYOUT/s);
  });

  it('fails when the map drops a subsystem the layout still places', () => {
    const withoutTools = facts.subsystems.filter((s: { name: string }) => s.name !== 'tools');
    expect(() => buildIr({ subsystems: withoutTools, facts })).toThrow(/no longer lists/);
  });

  it('keeps the committed IR free of a pinned revision', () => {
    // The pin belongs to a render, not to the source: a revision inside the
    // committed file would change on every commit and the drift check could
    // never be green.
    expect(ir.meta).not.toHaveProperty('repository');
    expect(ir.components.every((component) => !('sources' in component))).toBe(true);
  });

  it('adds verifiable provenance only at render time', () => {
    const revision = 'a'.repeat(40);
    const rendered = withRepositoryEvidence(ir, { subsystems: facts.subsystems, revision });
    expect(rendered.meta.repository).toEqual({ url: 'https://github.com/mgtf/atoma', revision });
    for (const component of rendered.components) {
      expect(component.sources).toEqual([{ path: `src/${component.id}/AGENTS.md`, label: 'contract' }]);
    }
  });
});
