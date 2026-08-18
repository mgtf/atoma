import { describe, it, expect } from 'vitest';
import { parseFrontmatter, renderFrontmatter } from '../src/skills/registry.js';
import { exportSkillToSpec, SPEC_DESCRIPTION_MAX_CHARS } from '../src/skills/exportSpec.js';
import type { Skill } from '../src/skills/types.js';

/**
 * Agent Skills base-spec alignment (agentskills.io): the frontmatter's
 * canonical key is `name` (written), `id` is accepted as a read alias
 * (read), and `skills export` emits a two-field SKILL.md portable to
 * every spec runtime including the strictest (claude.ai upload rejects
 * any key outside the base six — so the export carries name +
 * description ONLY, when_to_use folded into the description).
 */

function fakeSkill(over: Partial<Skill>): Skill {
  return {
    id: 'x',
    description: 'd',
    whenToUse: 'w',
    kind: 'llm',
    body: 'b',
    successes: 0,
    failures: 0,
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...over,
  };
}

describe('frontmatter — spec-canonical name key', () => {
  it('renderFrontmatter emits name:, parseFrontmatter round-trips it', () => {
    const md = renderFrontmatter(
      { id: 'build-cli', description: 'd', whenToUse: 'w', kind: 'llm' },
      'body'
    );
    expect(md).toMatch(/^name: build-cli$/m);
    expect(md).not.toMatch(/^id:/m);
    expect(parseFrontmatter(md).frontmatter.id).toBe('build-cli');
  });

});

describe('exportSkillToSpec — portable two-field SKILL.md', () => {
  it('emits ONLY name + description, folding when_to_use in', () => {
    const out = exportSkillToSpec(
      fakeSkill({
        id: 'scaffold-node-cli',
        description: 'Scaffold a node CLI with tests.',
        whenToUse: 'the task asks for a command-line tool',
        body: '1. write the entry\n2. verify invocations',
      })
    );
    expect('content' in out).toBe(true);
    const content = (out as { content: string }).content;
    expect(content).toMatch(/^name: scaffold-node-cli$/m);
    expect(content).toMatch(/^description: Scaffold a node CLI with tests\. Use when: the task asks for a command-line tool$/m);
    // No atoma-runtime keys, no Claude-Code-only keys.
    for (const forbidden of ['kind:', 'when_to_use:', 'trigger:', 'language:', 'id:']) {
      expect(content).not.toMatch(new RegExp(`^${forbidden}`, 'm'));
    }
    expect(content).toMatch(/1\. write the entry/);
  });

  it('caps the folded description at the spec maximum', () => {
    const out = exportSkillToSpec(
      fakeSkill({ description: 'x'.repeat(900), whenToUse: 'y'.repeat(900) })
    ) as { content: string };
    const descLine = out.content.split('\n').find((l) => l.startsWith('description: '))!;
    expect(descLine.length - 'description: '.length).toBeLessThanOrEqual(SPEC_DESCRIPTION_MAX_CHARS);
  });

  it('refuses script and event skills instead of mistranslating them', () => {
    const script = exportSkillToSpec(
      fakeSkill({ kind: 'script', language: 'node', body: 'console.log(1)' })
    );
    expect('error' in script && script.error).toMatch(/kind:script/);
    const event = exportSkillToSpec(fakeSkill({ trigger: 'validator rejects x' }));
    expect('error' in event && event.error).toMatch(/event-driven/);
  });
});
