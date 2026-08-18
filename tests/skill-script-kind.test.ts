import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRegistry, parseFrontmatter, renderFrontmatter } from '../src/skills/registry.js';
import { skillContextBlock } from '../src/atoms/L2Atom.js';
import {
  scriptArgv,
  scriptInvocationArgv,
  scriptInvocationArgvTemplate,
} from '../src/skills/abi.js';

/**
 * Phase 2 — `kind: 'script'` skills. Frontmatter accepts a `language`
 * field (node | python | bash); the body IS executable code in that
 * language. The L1 receives a different injected prompt that tells it
 * to write_file the body verbatim, run_shell with the right
 * interpreter, and return stdout.
 *
 * These tests cover only the storage + prompt-injection contract for
 * phase 2 — runtime is exercised end-to-end by an updated
 * skill-prefilter-injection test (a `kind: script` skill match
 * routes to the new prompt block).
 */

describe('parseFrontmatter / renderFrontmatter — kind: script (phase 2)', () => {
  it('parses kind:script with a valid language field', () => {
    const text = renderFrontmatter(
      {
        id: 'write-package-json',
        description: 'scaffold package.json',
        whenToUse: 'when the subtask asks for a Node package descriptor',
        kind: 'script',
        language: 'node',
      },
      "console.log('hello');"
    );
    const parsed = parseFrontmatter(text);
    expect(parsed.frontmatter.kind).toBe('script');
    expect(parsed.frontmatter.language).toBe('node');
    expect(parsed.body).toMatch(/hello/);
  });

  it('rejects kind:script WITHOUT a language', () => {
    const text = [
      '---',
      'name: x',
      'description: d',
      'when_to_use: w',
      'kind: script',
      '---',
      'body',
    ].join('\n');
    expect(() => parseFrontmatter(text)).toThrow(/kind:"script" requires a "language" field/);
  });

  it('rejects an unknown language value', () => {
    const text = [
      '---',
      'name: x',
      'description: d',
      'when_to_use: w',
      'kind: script',
      'language: ruby',
      '---',
      'body',
    ].join('\n');
    expect(() => parseFrontmatter(text)).toThrow(/language.*node\|python\|bash/);
  });

  it('rejects language on a kind:llm skill (forbidden combination)', () => {
    const text = [
      '---',
      'name: x',
      'description: d',
      'when_to_use: w',
      'kind: llm',
      'language: node',
      '---',
      'body',
    ].join('\n');
    expect(() => parseFrontmatter(text)).toThrow(/only valid with kind:"script"/);
  });

  it('omits the language line when rendering a kind:llm skill', () => {
    const out = renderFrontmatter(
      { id: 'x', description: 'd', whenToUse: 'w', kind: 'llm' },
      'b'
    );
    expect(out).not.toMatch(/language:/);
  });

  it('round-trips bash + python + node language values', () => {
    for (const lang of ['bash', 'python', 'node'] as const) {
      const text = renderFrontmatter(
        { id: 'x', description: 'd', whenToUse: 'w', kind: 'script', language: lang },
        'body'
      );
      const parsed = parseFrontmatter(text);
      expect(parsed.frontmatter.language).toBe(lang);
    }
  });
});

describe('SkillRegistry.save / loadFor — kind: script (phase 2)', () => {
  let dir: string;
  let reg: SkillRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-script-'));
    reg = new SkillRegistry(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('save then load round-trips a node script skill', () => {
    reg.save('Ammonia', {
      id: 'write-package-json',
      description: 'scaffold a Node package.json',
      whenToUse: 'when the subtask is a Node package descriptor with name + version',
      kind: 'script',
      language: 'node',
      body:
        "const fs = require('fs');\n" +
        "const [name, version='0.1.0'] = process.argv.slice(2);\n" +
        "fs.writeFileSync('package.json', JSON.stringify({name, version, private: true}, null, 2));\n" +
        "console.log(`wrote package.json: ${name}@${version}`);",
    });
    const loaded = reg.loadFor('Ammonia');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.kind).toBe('script');
    expect(loaded[0]!.language).toBe('node');
    expect(loaded[0]!.body).toMatch(/writeFileSync\('package\.json'/);
  });

  it('rejects save() of kind:script without a language at the API level', () => {
    expect(() =>
      reg.save('Ammonia', {
        id: 'x',
        description: 'd',
        whenToUse: 'w',
        kind: 'script',
        body: 'b',
      })
    ).toThrow(/requires a language/);
  });

  it('rejects save() of kind:llm WITH a language (forbidden combination)', () => {
    expect(() =>
      reg.save('Ammonia', {
        id: 'x',
        description: 'd',
        whenToUse: 'w',
        kind: 'llm',
        language: 'node',
        body: 'b',
      })
    ).toThrow(/must not declare a language/);
  });

  it('persists language in SKILL.md frontmatter (hand-readable)', () => {
    reg.save('Ammonia', {
      id: 'x',
      description: 'd',
      whenToUse: 'w',
      kind: 'script',
      language: 'bash',
      body: 'echo hi',
    });
    const text = readFileSync(join(dir, 'Ammonia', 'x', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/kind: script/);
    expect(text).toMatch(/language: bash/);
  });
});

describe('skillContextBlock — kind: script (phase 2)', () => {
  it('derives both dispatch forms from the shared argv ABI', () => {
    expect(scriptArgv('write "quoted" output')).toEqual([
      JSON.stringify('write "quoted" output'),
    ]);
    expect(scriptInvocationArgv('_skill_x.mjs', 'write "quoted" output')).toEqual([
      '_skill_x.mjs',
      JSON.stringify('write "quoted" output'),
    ]);
    expect(scriptInvocationArgvTemplate('_skill_x.mjs')).toBe(
      '["_skill_x.mjs", <JSON.stringify(subtaskDescription)>]'
    );
  });

  it('emits the EXECUTE THIS SCRIPT prompt with the right interpreter for node', () => {
    const out = skillContextBlock({
      id: 'write-package-json',
      kind: 'script',
      language: 'node',
      body: 'console.log("hi");',
    });
    expect(out).toMatch(/== ACTIVE SKILL: write-package-json \(kind: script, language: node\) ==/);
    expect(out).toMatch(/_skill_write-package-json\.mjs/);
    expect(out).toMatch(/run_shell.*command: "node"/);
    expect(out).toMatch(/console\.log\("hi"\)/);
    expect(out).toMatch(/Do NOT improvise additional tool calls/);
    expect(out).toMatch(/NEVER call record_probe.*ephemeral/s);
  });

  it('uses python3 + .py for kind: script + language: python', () => {
    const out = skillContextBlock({
      id: 'compute-hash',
      kind: 'script',
      language: 'python',
      body: 'import sys; print(sys.argv[1])',
    });
    expect(out).toMatch(/_skill_compute-hash\.py/);
    expect(out).toMatch(/run_shell.*command: "python3"/);
  });

  it('uses bash + .sh for kind: script + language: bash', () => {
    const out = skillContextBlock({
      id: 'init-git',
      kind: 'script',
      language: 'bash',
      body: '#!/bin/bash\nset -euo pipefail\ngit init "$1"',
    });
    expect(out).toMatch(/_skill_init-git\.sh/);
    expect(out).toMatch(/run_shell.*command: "bash"/);
  });

  it('falls back to the legacy LLM-recipe prompt when kind is omitted (back-compat)', () => {
    const out = skillContextBlock({ id: 'x', body: 'do step 1\ndo step 2' });
    expect(out).toMatch(/Follow this recipe step-by-step/);
    expect(out).not.toMatch(/EXECUTE THIS SCRIPT/i);
    expect(out).not.toMatch(/_skill_x/);
  });

  it('throws when kind:script is passed without a language', () => {
    expect(() =>
      skillContextBlock({ id: 'x', kind: 'script', body: 'oops' })
    ).toThrow(/requires language/);
  });
});
