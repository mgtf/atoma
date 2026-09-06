import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_TOOL_VOCABULARY } from '../src/atoms/verdict.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { LAUNCHABLE_PROFILES } from '../src/run/profiles/index.js';
import {
  MAX_COMPLETION_VALUES,
  SKILL_REVIEW_CAVEAT,
  TRACE_ERROR_CAVEAT,
  completeAtomName,
  completeMoleculeName,
  completeTraceFile,
} from '../src/mcp/readers.js';
import {
  AGENT_PROMPT,
  SKILLS_PROMPT,
  TRACE_PROMPT,
  agentPromptText,
  goalPromptName,
  goalPromptText,
  promptNames,
  skillsPromptText,
  tracePromptText,
} from '../src/mcp/prompts.js';

/**
 * The MCP PROMPT surface and its argument completions.
 *
 * WHAT THIS SUITE IS FOR. Prompts are a second place where atoma tells a host
 * how to phrase a goal, and a second place where the caveats that must not be
 * paraphrased are written down. Both are exactly the drift AGENTS.md records
 * twice with measurements (`research-brief.ts`, the `curriculum.ts` provider
 * switch), so the cases below pin the two agreements that would rot silently:
 * the prompt text QUOTES the single source (`TaskProfileGuidance`, the reader
 * caveat constants) instead of restating it, and the completion sources stay
 * bounded, tolerant of an absent store, and typed in the vocabulary a person
 * can actually type back.
 */
describe('MCP prompts — one per family, plus the reader drivers', () => {
  it('exposes a goal prompt for every launchable family and nothing duplicated', () => {
    const names = promptNames();
    expect(names).toEqual([...new Set(names)]);
    for (const { profile } of LAUNCHABLE_PROFILES) {
      expect(names).toContain(goalPromptName(profile.id));
    }
    expect(names).toEqual(expect.arrayContaining([TRACE_PROMPT, AGENT_PROMPT, SKILLS_PROMPT]));
    // The host lists prompts and tools side by side; a bare name would be
    // ambiguous in a picker that also holds other servers' prompts.
    for (const name of names) expect(name).toMatch(/^atoma_/);
  });

  /**
   * The same ban `tests/viz-launch-profiles.test.ts` holds the family guidance
   * to, one level further out. Commit ae63e06 removed tool-naming from subtask
   * descriptions after 194 of 237 archived subtasks did it and a run burned
   * half its calls on a phase the wording implied; a prompt is written in the
   * human's own words, so it is exactly where that would come back.
   */
  it('no prompt text teaches a caller to name a builtin element', () => {
    const corpus = [
      ...LAUNCHABLE_PROFILES.map((p) => goalPromptText(p, 'a neutral goal')),
      tracePromptText('2026-08-11T10-00-00.json'),
      agentPromptText('Water'),
      skillsPromptText('Water'),
    ]
      .join('\n')
      // ONE exemption, and it is quoted, not written here: TRACE_ERROR_CAVEAT
      // names `edit_file` because that is the reader whose error strings echo
      // file spans back. Naming a tool while WARNING about its output is the
      // opposite of teaching a caller to prescribe it in a goal, and the
      // string is pinned to production below — it cannot drift into advice.
      .split(TRACE_ERROR_CAVEAT)
      .join('');
    for (const tool of BUILTIN_TOOL_VOCABULARY) {
      expect(corpus, `prompt text names "${tool}"`).not.toContain(tool);
    }
  });

  it('the goal prompt quotes the family guidance rather than restating it', () => {
    for (const launchable of LAUNCHABLE_PROFILES) {
      const text = goalPromptText(launchable, 'ship a thing');
      expect(text).toContain(launchable.profile.guidance.help);
      for (const example of launchable.profile.guidance.examples) expect(text).toContain(example);
      expect(text).toContain('ship a thing');
      expect(text).toContain(`family "${launchable.profile.id}"`);
    }
  });

  /**
   * A prompt that starts a run must carry the two properties `atoma_operator_run_start`
   * carries, in the same words. A host that reached the run through the prompt
   * would otherwise never have read the tool description.
   */
  it('the goal prompt states DESTRUCTIVE and SERIALISED', () => {
    for (const launchable of LAUNCHABLE_PROFILES) {
      const text = goalPromptText(launchable, 'x');
      expect(text).toMatch(/DESTRUCTIVE/);
      expect(text).toMatch(/SERIALISED/);
      expect(text).toContain('atoma_operator_run_start');
      expect(text).toContain('atoma_operator_run_status');
    }
  });

  /**
   * The caveats are pinned to the PRODUCTION constants, not to a copy: a
   * paraphrase in the prompt is the one-concept-two-definitions drift the
   * 2026-08-14 review measured.
   */
  it('the reader prompts carry the production caveats verbatim', () => {
    expect(tracePromptText('t.json')).toContain(TRACE_ERROR_CAVEAT);
    expect(skillsPromptText('Water')).toContain(SKILL_REVIEW_CAVEAT);
    expect(skillsPromptText('Water')).toMatch(/thresholds/);
    expect(agentPromptText('Water')).toMatch(/UNTRUSTED DATA/);
    expect(tracePromptText('t.json')).toContain('atoma_run_trace');
    expect(agentPromptText('Water')).toContain('atoma_registry_show');
    for (const tool of ['atoma_skills_list', 'atoma_skills_stats', 'atoma_skills_review']) {
      expect(skillsPromptText('Water')).toContain(tool);
    }
  });
});

describe('MCP completion sources', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-mcp-completion-'));
    for (const k of ['ATOMA_DB_PATH', 'ATOMA_SKILLS_DIR', 'ATOMA_RUNS_DIR']) {
      saved[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('an ABSENT store completes to nothing rather than throwing', () => {
    process.env['ATOMA_DB_PATH'] = join(dir, 'nope.db');
    process.env['ATOMA_SKILLS_DIR'] = join(dir, 'no-skills');
    process.env['ATOMA_RUNS_DIR'] = join(dir, 'no-runs');
    expect(completeTraceFile('')).toEqual([]);
    expect(completeAtomName('')).toEqual([]);
    expect(completeMoleculeName('')).toEqual([]);
  });

  /**
   * A completion fires on every keystroke, so "the SDK slices at 100" is not
   * enough: a source that materialises every row first is truncated at the
   * edge, not bounded. This directory holds more traces than the cap.
   */
  it('trace completion is bounded, newest-first, and prefix-filtered', () => {
    const runs = join(dir, 'runs');
    mkdirSync(runs, { recursive: true });
    process.env['ATOMA_RUNS_DIR'] = runs;
    const total = MAX_COMPLETION_VALUES + 25;
    for (let i = 0; i < total; i++) {
      const file = join(runs, `2026-08-${String(i).padStart(3, '0')}.json`);
      writeFileSync(file, '{}', 'utf8');
      // Newest last, so the newest-first order is not the directory order.
      const when = new Date(1_700_000_000_000 + i * 1000);
      utimesSync(file, when, when);
    }
    // index.json is the viz index, never a trace.
    writeFileSync(join(runs, 'index.json'), '[]', 'utf8');

    const all = completeTraceFile('');
    expect(all).toHaveLength(MAX_COMPLETION_VALUES);
    expect(all).not.toContain('index.json');
    expect(all[0]).toBe(`2026-08-${String(total - 1).padStart(3, '0')}.json`);

    expect(completeTraceFile('2026-08-12')).toEqual([
      '2026-08-124.json',
      '2026-08-123.json',
      '2026-08-122.json',
      '2026-08-121.json',
      '2026-08-120.json',
    ]);
    expect(completeTraceFile('nothing-like-this')).toEqual([]);

    // The bound is on the SCAN, not on the filter: trace names are timestamps,
    // so a human types a date prefix. Filtering after the 100-value cap would
    // answer "no such trace" for anything older than the newest hundred —
    // exactly the traces a date prefix is typed to find.
    expect(all).not.toContain('2026-08-000.json');
    expect(completeTraceFile('2026-08-000')).toEqual(['2026-08-000.json']);
  });

  it('agent-type completion reads every tier through the readonly path', () => {
    const fixture = join(dir, 'fixture.db');
    const db = openDb(fixture);
    const registry = new AtomRegistry(db);
    const made = ([1, 2, 3] as const).map((tier) =>
      registry.create(tier, {
        description: 'fixture',
        systemPrompt: 'fixture',
        tools: [],
        params: {},
        createdBy: 'test',
      })
    );
    db.close();
    process.env['ATOMA_DB_PATH'] = fixture;

    const names = completeAtomName('');
    for (const atom of made) expect(names).toContain(atom.name);
    // Case-insensitive prefix: a person types lowercase, names are capitalised.
    const first = made[0]!.name;
    expect(completeAtomName(first.slice(0, 3).toLowerCase())).toContain(first);
    expect(completeAtomName('zzz-no-such-type')).toEqual([]);
  });

  /**
   * A namespace key is an atom id. Completion must offer the DISPLAY name for
   * the same reason the payloads carry one: a bare UUID is not something a
   * person can type back, and `resolveMoleculeRef` accepts either.
   */
  it('molecule completion offers display names and degrades to the raw key', () => {
    const fixture = join(dir, 'fixture.db');
    const db = openDb(fixture);
    const registry = new AtomRegistry(db);
    const atom = registry.create(1, {
      description: 'fixture',
      systemPrompt: 'fixture',
      tools: [],
      params: {},
      createdBy: 'test',
    });
    db.close();
    process.env['ATOMA_DB_PATH'] = fixture;

    const skills = join(dir, 'skills');
    mkdirSync(join(skills, atom.atomId), { recursive: true });
    mkdirSync(join(skills, 'orphaned-atom-id'), { recursive: true });
    process.env['ATOMA_SKILLS_DIR'] = skills;

    const names = completeMoleculeName('');
    expect(names).toContain(atom.name);
    expect(names).not.toContain(atom.atomId);
    expect(names).toContain('orphaned-atom-id');
  });
});
