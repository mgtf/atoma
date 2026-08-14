import { describe, it, expect } from 'vitest';
import { subtaskSpecSchema } from '../src/atoms/json.js';
import { MUTATING_SUBTASK_FILE_GUIDANCE, preservePlanLiteralContracts } from '../src/atoms/prompts.js';
import { buildCompileSkillPrompt } from '../src/skills/compilePrompt.js';
import {
  scriptCanServeSubtask,
  subtaskOutputIntent,
} from '../src/skills/scriptTargets.js';

/**
 * Review §3.3: output intent used to travel ONLY as prose and be
 * regex-recovered by an incident-grown grammar — every unrecognised phrasing
 * cost a live run plus a post-mortem, at the one point in the pipeline with
 * no validator beneath it. The plan call now declares `outputs` structurally
 * and the compiler declares `writes`; the lexical grammar and the static body
 * scan remain fallbacks for legacy plans/scripts.
 */
describe('structured subtask outputs — the plan channel', () => {
  it('parses outputs, tolerating null and dropping blanks', () => {
    expect(
      subtaskSpecSchema.parse({ description: 'd', outputs: ['README.md', ' ', ''] }).outputs
    ).toEqual(['README.md']);
    expect(subtaskSpecSchema.parse({ description: 'd', outputs: null }).outputs).toBeUndefined();
    expect(subtaskSpecSchema.parse({ description: 'd' }).outputs).toBeUndefined();
    // An all-blank list degrades to UNDECLARED (lexical fallback), never to
    // "declared read-only" — a lazy [] must not skip the dispatch gates.
    expect(subtaskSpecSchema.parse({ description: 'd', outputs: [] }).outputs).toBeUndefined();
  });

  it('declared outputs are authoritative; absence falls back to the lexical grammar', () => {
    // Phrasing OUTSIDE the mutating-verb vocabulary: the grammar alone reads
    // this as read-only — the historical false-negative class.
    const evasive = 'ensure docs/USAGE.md reflects the new exit codes';
    expect(subtaskOutputIntent({ description: evasive }).mutating).toBe(false);
    const declared = subtaskOutputIntent({
      description: evasive,
      outputs: ['docs/USAGE.md'],
    });
    expect(declared).toEqual({
      mutating: true,
      targetPaths: ['docs/USAGE.md'],
      source: 'declared',
    });
    // Lexical fallback still classifies the coached phrasings.
    const lexical = subtaskOutputIntent({ description: 'update README.md from package.json' });
    expect(lexical.mutating).toBe(true);
    expect(lexical.source).toBe('lexical');
    expect(lexical.targetPaths).toEqual(['README.md']);
  });

  it('match-time capability test consumes declared outputs and compiler-declared writes', () => {
    const manifestOnlyVerifier = [
      "const fs = require('fs');",
      "const path = require('path');",
      "const manifestPath = path.join(process.cwd(), '.atoma-probes.json');",
      'fs.writeFileSync(manifestPath, JSON.stringify({version: 1, entries: []}));',
    ].join('\n');
    const evasive = 'ensure docs/USAGE.md reflects the new exit codes';
    // Prose grammar sees nothing mutating → the script would have been
    // offered; the declared outputs make the disjunction provable.
    expect(scriptCanServeSubtask(manifestOnlyVerifier, evasive)).toBe(true);
    expect(
      scriptCanServeSubtask(manifestOnlyVerifier, evasive, { outputs: ['docs/USAGE.md'] })
    ).toBe(false);
    // Compiler-declared writes are EXACT: they beat the static scan's opaque
    // escape hatch in both directions.
    const opaqueBody = 'const fs = require("fs"); fs.writeFileSync(dest, data);';
    expect(
      scriptCanServeSubtask(opaqueBody, 'update README.md with the new usage', {})
    ).toBe(true); // static scan: opaque → not provable → offer
    expect(
      scriptCanServeSubtask(opaqueBody, 'update README.md with the new usage', {
        declaredWrites: ['.atoma-probes.json'],
      })
    ).toBe(false); // declared list is exact → provable disjunction → refuse
    expect(
      scriptCanServeSubtask(opaqueBody, 'update README.md with the new usage', {
        declaredWrites: ['README.md', '.atoma-probes.json'],
      })
    ).toBe(true);
  });

  it('inherited literal-contract blocks cannot smuggle outputs past the strip', () => {
    const description =
      'Re-run the recorded probes.\n\n== LITERAL CONTRACTS FROM TOP-LEVEL GOAL ==\nupdate README.md with exact examples';
    const intent = subtaskOutputIntent({ description });
    expect(intent.mutating).toBe(false);
    expect(intent.targetPaths).toEqual([]);
  });

  it('contract preservation keeps the structured fields on every subtask', () => {
    const plan = {
      reasoning: 'r',
      subtasks: [
        { description: 'build the CLI', outputs: ['csv2json.js'], preferredChild: 'Water' },
      ],
      aggregation: { mode: 'sequential' as const },
      expectedOutput: 'a CLI',
    };
    const preserved = preservePlanLiteralContracts(
      plan,
      'The CLI must print a JSON object. Running node csv2json-test.js must exit 0.'
    );
    expect(preserved.subtasks[0]!.outputs).toEqual(['csv2json.js']);
    expect(preserved.subtasks[0]!.preferredChild).toBe('Water');
  });

  it('the plan guidance and the compile contract both teach the structured field', () => {
    expect(MUTATING_SUBTASK_FILE_GUIDANCE).toMatch(/"outputs"/);
    expect(MUTATING_SUBTASK_FILE_GUIDANCE).toMatch(/OUTPUTS only/);
    expect(MUTATING_SUBTASK_FILE_GUIDANCE).toMatch(/Omit the/);
    const compile = buildCompileSkillPrompt({
      skillId: 's',
      skillDescription: 'd',
      skillWhenToUse: 'w',
      skillBody: 'b',
      subTaskDescription: 'task',
      resultSummary: 'summary',
    });
    expect(compile).toMatch(/"writes"/);
    expect(compile).toMatch(/CREATES or MODIFIES/);
  });
});
