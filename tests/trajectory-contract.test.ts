import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assembleTrajectoryReference,
  buildTrajectoryReference,
  collapseTrajectory,
  deriveTrajectorySignatures,
  referenceSamples,
  scoreTrajectory,
  trajectoryKeyId,
  trajectoryScoreSchema,
  trajectorySignatureSchema,
  trajectorySimilarity,
  TRAJECTORY_MAX_TOOLS,
  TRAJECTORY_SIGNATURE_EXAMPLE,
  type TrajectorySignature,
  type TrajectoryTraceEvent,
} from '../src/contracts/trajectory.js';
import type { VizRun, VizRunIndexEntry } from '../src/viz/trace.js';

/**
 * Trajectory signatures (Stage A of docs/trajectory-predictability-design-2026-09-09.md).
 *
 * What these hold: one execution is one `llmEventId` and is complete only once
 * its `llm` event is in the window; the injected skill keys the execution it
 * preceded and is consumed; credit is the next skill success or trust RESULT
 * for that Molecule in its lane, so a retry leaves its failed first attempt
 * uncredited; the score is a nearest-neighbour, length-normalised edit
 * distance over element NAMES; and the derivation reproduces, on five real
 * traces reduced to the fields it reads, the sequences the design document
 * quotes.
 *
 * FIXTURE PROVENANCE. `tests/fixtures/sentinel-trajectory-traces.json` is five
 * traces from `runs/` (2026-09-07: 10:33, 10:47, 11:04, 11:22, 11:31) with
 * every tool `args`/`result`, prompt, response and reasoning removed — only the
 * runtime-stamped fields the derivation reads remain. Regenerate from a runs
 * directory holding those traces with:
 *
 *   node -e 'const fs=require("fs");const picks=["2026-09-07T10-33-01","2026-09-07T10-47-00","2026-09-07T11-04-13","2026-09-07T11-22-00","2026-09-07T11-31-08"];
 *   const files=fs.readdirSync("runs").filter(f=>f.endsWith(".json")&&f!=="index.json");const index=JSON.parse(fs.readFileSync("runs/index.json","utf8"));
 *   const zero={inputTokens:0,outputTokens:0,cacheReadInputTokens:0,cacheCreationInputTokens:0};const out=[];
 *   for(const p of picks){const t=JSON.parse(fs.readFileSync("runs/"+files.find(x=>x.startsWith(p)),"utf8"));const events=[];
 *   for(const e of t.events){const b={id:e.id,ts:e.ts,kind:e.kind,...(e.branchId!==undefined?{branchId:e.branchId}:{}),...(e.actor?{actor:e.actor}:{})};
 *   switch(e.kind){case"tool":events.push({...b,llmEventId:e.llmEventId,name:e.name,args:{},durationMs:e.durationMs});break;
 *   case"llm":events.push({...b,role:e.role,model:e.model,...(e.child?{child:e.child}:{}),...(e.subject?{subject:e.subject}:{}),systemPrompt:"",userContent:"",response:"",stopReason:e.stopReason??null,durationMs:e.durationMs,usage:zero,costUsd:0,...(e.error!==undefined?{error:"[redacted]"}:{})});break;
 *   case"llm-start":events.push({...b,llmEventId:e.llmEventId,model:e.model,role:e.role});break;
 *   case"skill":events.push({...b,op:e.op,l1Name:e.l1Name,l1AtomId:e.l1AtomId,skillId:e.skillId});break;
 *   case"trust":events.push({...b,child:e.child,subject:e.subject,successes:e.successes,failures:e.failures,reasoning:""});break;
 *   case"branch":events.push({...b,op:e.op,branchId:e.branchId,index:e.index,total:e.total,aggregationMode:e.aggregationMode,label:""});break;}}
 *   const i=index.find(x=>x.id===t.id);out.push({index:{id:i.id,label:i.label,startedAt:i.startedAt,...(i.endedAt?{endedAt:i.endedAt}:{}),hasError:i.hasError},
 *   trace:{id:t.id,label:t.label,task:{description:t.task.description},startedAt:t.startedAt,...(t.endedAt?{endedAt:t.endedAt}:{}),events}});}
 *   fs.writeFileSync("tests/fixtures/sentinel-trajectory-traces.json",JSON.stringify(out)+"\n");'
 */

let seq = 0;
const nextId = (prefix: string): string => {
  seq += 1;
  return `${prefix}-${seq}`;
};

function tool(actor: string, executionId: string, name: string, branchId?: string): TrajectoryTraceEvent {
  return {
    kind: 'tool',
    id: nextId('tool'),
    llmEventId: executionId,
    name,
    actor: { name: actor, tier: 1 },
    ...(branchId !== undefined ? { branchId } : {}),
  };
}

/** The `llm` event that closes an execution: same id as the tool events' `llmEventId`. */
function close(actor: string, executionId: string, branchId?: string): TrajectoryTraceEvent {
  return {
    kind: 'llm',
    id: executionId,
    actor: { name: actor, tier: 1 },
    ...(branchId !== undefined ? { branchId } : {}),
  };
}

function skill(op: string, l1Name: string, skillId: string, branchId?: string): TrajectoryTraceEvent {
  return {
    kind: 'skill',
    id: nextId('skill'),
    op,
    l1Name,
    skillId,
    ...(branchId !== undefined ? { branchId } : {}),
  };
}

function trust(child: string, subject: 'PLAN' | 'RESULT', branchId?: string): TrajectoryTraceEvent {
  return {
    kind: 'trust',
    id: nextId('trust'),
    child: { name: child, tier: 1 },
    subject,
    ...(branchId !== undefined ? { branchId } : {}),
  };
}

function execution(actor: string, executionId: string, tools: readonly string[], branchId?: string) {
  return [...tools.map((name) => tool(actor, executionId, name, branchId)), close(actor, executionId, branchId)];
}

describe('deriving signatures from a window', () => {
  it('yields one signature per llmEventId, in start order, with element names in order', () => {
    const events = [
      tool('Methane', 'x1', 'write_file'),
      tool('Water', 'x2', 'read_file'),
      tool('Methane', 'x1', 'start_node_server'),
      close('Methane', 'x1'),
      tool('Water', 'x2', 'validate_html'),
    ];
    const signatures = deriveTrajectorySignatures('run', events);
    expect(signatures.map((s) => [s.executionId, s.key.l1Name, s.tools, s.completed])).toEqual([
      ['x1', 'Methane', ['write_file', 'start_node_server'], true],
      ['x2', 'Water', ['read_file', 'validate_html'], false],
    ]);
    expect(signatures[0]!.firstIndex).toBe(0);
    expect(signatures[0]!.completedIndex).toBe(3);
    expect(signatures[1]!.completedIndex).toBeNull();
    for (const signature of signatures) expect(trajectorySignatureSchema.parse(signature)).toEqual(signature);
  });

  it('drops a tool event without an actor instead of guessing one', () => {
    const orphan: TrajectoryTraceEvent = { kind: 'tool', id: 't', llmEventId: 'x', name: 'read_file' };
    expect(deriveTrajectorySignatures('run', [orphan, { kind: 'llm', id: 'x' }])).toEqual([]);
  });

  it('ignores an llm event that made no tool calls: a plan is not a trajectory', () => {
    expect(deriveTrajectorySignatures('run', [{ kind: 'llm', id: 'plan-1', actor: { name: 'Methane' } }])).toEqual([]);
  });

  it('keys an execution on the skill injected before it, and consumes that inject', () => {
    const events = [
      skill('match', 'Methane', 'node-api'),
      skill('inject', 'Methane', 'node-api'),
      ...execution('Methane', 'x1', ['write_file']),
      ...execution('Methane', 'x2', ['write_file']),
    ];
    const [first, second] = deriveTrajectorySignatures('run', events);
    expect(first!.key).toEqual({ l1Name: 'Methane', skillId: 'node-api', keyedBy: 'skill' });
    expect(second!.key).toEqual({ l1Name: 'Methane', skillId: null, keyedBy: 'atom' });
    expect(trajectoryKeyId(first!.key)).toBe('Methane::node-api');
    expect(trajectoryKeyId(second!.key)).toBe('Methane::*');
  });

  it('never borrows another lane inject, and prefers its own lane over a lane-less one', () => {
    const events = [
      skill('inject', 'Methane', 'for-lane-b', 'b'),
      skill('inject', 'Methane', 'for-any-lane'),
      ...execution('Methane', 'xa', ['write_file'], 'a'),
      ...execution('Methane', 'xb', ['write_file'], 'b'),
    ];
    const [laneA, laneB] = deriveTrajectorySignatures('run', events);
    expect(laneA!.key.skillId).toBe('for-any-lane');
    expect(laneB!.key.skillId).toBe('for-lane-b');
  });

  it('credits the most recent closed execution on a skill success or a trust RESULT, so a retry leaves its first attempt uncredited', () => {
    const events = [
      skill('inject', 'Methane', 'node-api'),
      ...execution('Methane', 'attempt-1', ['write_file', 'fetch_url']),
      // No credit arrived: the validator sent it back and it ran again.
      skill('inject', 'Methane', 'node-api'),
      ...execution('Methane', 'attempt-2', ['write_file', 'fetch_url', 'read_file']),
      trust('Methane', 'PLAN'),
      trust('Sclereid', 'RESULT'),
      skill('success', 'Methane', 'node-api'),
      trust('Methane', 'RESULT'),
    ];
    const signatures = deriveTrajectorySignatures('run', events);
    expect(signatures.map((s) => [s.executionId, s.credited])).toEqual([
      ['attempt-1', false],
      ['attempt-2', true],
    ]);
  });

  it('credits through a trust RESULT alone when no skill drove the execution', () => {
    const events = [...execution('Methane', 'x1', ['write_file']), trust('Methane', 'RESULT')];
    expect(deriveTrajectorySignatures('run', events)[0]).toMatchObject({ key: { keyedBy: 'atom' }, credited: true });
  });

  it('does not let a success for another skill credit an execution handed a different one', () => {
    const events = [
      skill('inject', 'Methane', 'node-api'),
      ...execution('Methane', 'x1', ['write_file']),
      skill('success', 'Methane', 'some-other-skill'),
    ];
    expect(deriveTrajectorySignatures('run', events)[0]!.credited).toBe(false);
  });

  it('caps the element names it keeps and says so', () => {
    const events = [
      ...Array.from({ length: TRAJECTORY_MAX_TOOLS + 3 }, () => tool('Methane', 'x1', 'fetch_url')),
      close('Methane', 'x1'),
    ];
    const [signature] = deriveTrajectorySignatures('run', events);
    expect(signature!.tools).toHaveLength(TRAJECTORY_MAX_TOOLS);
    expect(signature!.truncated).toBe(true);
    expect(trajectorySignatureSchema.parse(signature)).toEqual(signature);
  });

  it('ships an example that parses', () => {
    expect(TRAJECTORY_SIGNATURE_EXAMPLE.key.keyedBy).toBe('skill');
  });
});

describe('scoring a path against its reference', () => {
  it('is 1 for the same path, 0 for paths sharing nothing, symmetric and length-normalised', () => {
    expect(trajectorySimilarity(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    expect(trajectorySimilarity(['a', 'b'], ['c', 'd'])).toBe(0);
    expect(trajectorySimilarity([], [])).toBe(1);
    expect(trajectorySimilarity(['a', 'b', 'c', 'd'], ['a', 'b'])).toBe(0.5);
    expect(trajectorySimilarity(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(0.5);
  });

  it('takes the nearest neighbour and the median length', () => {
    const observed = ['w', 's', 'f', 'f', 'r'];
    const samples = [
      ['w', 's', 'f', 'r'],
      ['w', 'w', 's', 'f', 'f', 'f', 'r', 'r'],
      ['x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x'],
    ];
    const score = scoreTrajectory(observed, samples);
    expect(trajectoryScoreSchema.parse(score)).toEqual(score);
    expect(score.score).toBeCloseTo(0.8, 5);
    expect(score.nearestLen).toBe(4);
    expect(score.predictedLen).toBe(8);
    expect(score.lengthRatio).toBeCloseTo(5 / 8, 5);
    expect(score.sampleSize).toBe(3);
    // Even count: the median is the mean of the two middle lengths.
    expect(scoreTrajectory(observed, samples.slice(0, 2)).predictedLen).toBe(6);
  });

  it('scores nothing against an empty reference', () => {
    expect(scoreTrajectory(['a'], [])).toEqual({
      score: 0,
      observedLen: 1,
      predictedLen: 0,
      nearestLen: 0,
      lengthRatio: 1,
      sampleSize: 0,
    });
  });

  it('collapses repeats for an operator and bounds the text', () => {
    expect(collapseTrajectory(['write_file', 'write_file', 'start_node_server', 'fetch_url', 'fetch_url', 'fetch_url'])).toBe(
      'write_file×2 › start_node_server › fetch_url×3'
    );
    const long = collapseTrajectory(Array.from({ length: 200 }, (_u, i) => `tool_${i}`), 40);
    expect(long).toHaveLength(40);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('assembling a reference', () => {
  const credited = (executionId: string, tools: string[], over: Partial<TrajectorySignature> = {}): TrajectorySignature => ({
    runId: 'r',
    executionId,
    key: { l1Name: 'Methane', skillId: 'node-api', keyedBy: 'skill' },
    tier: 1,
    branchId: null,
    firstIndex: 0,
    completedIndex: 1,
    tools,
    truncated: false,
    completed: true,
    credited: true,
    ...over,
  });

  it('keeps only completed, credited signatures and the newest per key', () => {
    const reference = assembleTrajectoryReference(
      [
        [credited('a', ['w']), credited('open', ['w'], { completed: false, completedIndex: null })],
        [credited('b', ['w', 'w']), credited('uncredited', ['w'], { credited: false })],
        [credited('c', ['w', 'w', 'w'])],
      ],
      2
    );
    expect(reference.runs).toBe(3);
    expect(reference.signatures).toBe(2);
    const samples = referenceSamples(reference, { l1Name: 'Methane', skillId: 'node-api', keyedBy: 'skill' });
    expect(samples.map((s) => s.executionId)).toEqual(['b', 'c']);
    expect(referenceSamples(reference, { l1Name: 'Methane', skillId: null, keyedBy: 'atom' })).toEqual([]);
  });

  it('builds straight from run windows', () => {
    const run = (runId: string, tools: string[]) => ({
      runId,
      events: [skill('inject', 'Methane', 'node-api'), ...execution('Methane', `${runId}-x`, tools), skill('success', 'Methane', 'node-api')],
    });
    const reference = buildTrajectoryReference([run('r1', ['w']), run('r2', ['w', 'f'])]);
    expect(reference.runs).toBe(2);
    expect(reference.signatures).toBe(2);
  });
});

interface FixtureRun {
  readonly index: VizRunIndexEntry;
  readonly trace: VizRun;
}

const FIXTURE: readonly FixtureRun[] = JSON.parse(
  readFileSync(new URL('./fixtures/sentinel-trajectory-traces.json', import.meta.url), 'utf8')
) as FixtureRun[];

function fixtureRun(hhmm: string): FixtureRun {
  const run = FIXTURE.find((entry) => entry.trace.id.includes(`T${hhmm.replace(':', '-')}`));
  if (!run) throw new Error(`fixture run ${hhmm} missing`);
  return run;
}

function shape(signature: TrajectorySignature): [string, number | null, string | null, boolean, number, string] {
  return [
    signature.key.l1Name,
    signature.tier,
    signature.key.skillId,
    signature.credited,
    signature.tools.length,
    collapseTrajectory(signature.tools),
  ];
}

describe('on five real traces reduced to the fields it reads', () => {
  it('reproduces the 10:47 run the design document reads as drift: three credited Methane phases, four uncredited fallback executions', () => {
    const { trace } = fixtureRun('10:47');
    const signatures = deriveTrajectorySignatures(trace.id, trace.events);
    expect(signatures.every((s) => s.completed)).toBe(true);
    expect(signatures.map(shape)).toEqual([
      ['Methane', 1, 'node-http-static-json-api', true, 19, 'write_file×4 › start_node_server › fetch_url×12 › read_file×2'],
      ['Methane', 1, 'build-vanilla-js-frontend-for-api', true, 12, 'write_file×3 › start_node_server › fetch_url×7 › read_file'],
      ['Methane', 1, 'probe-http-api-contract', true, 9, 'read_file › start_node_server › fetch_url×6 › read_file'],
      ['Dopamine', 1, null, false, 10, 'read_file › list_files › read_file×3 › start_static_server › validate_html › read_file×3'],
      ['Dopamine', 1, null, false, 20, 'read_file › write_file×2 › start_static_server › list_files › write_file › validate_html×3 › write_file › read_file×2 › write_file › validate_html › list_files › read_file×3 › validate_html×2'],
      ['Adrenaline', 1, null, false, 15, 'list_files › read_file×4 › start_static_server › validate_html › list_files › edit_file×3 › validate_html×2 › edit_file › validate_html'],
      ['Adrenaline', 1, null, false, 11, 'list_files › read_file×4 › start_static_server › edit_file › validate_html › write_file › edit_file › list_files'],
      // The L2's own fallback self-execution, credited by the L3's trust move.
      ['Tracheid', 2, null, true, 2, 'write_file×2'],
    ]);
    // Per actor, the totals the design document's table quotes: 40 + 30 + 26.
    const perActor = new Map<string, number>();
    for (const s of signatures) perActor.set(s.key.l1Name, (perActor.get(s.key.l1Name) ?? 0) + s.tools.length);
    expect(Object.fromEntries(perActor)).toEqual({ Methane: 40, Dopamine: 30, Adrenaline: 26, Tracheid: 2 });
  });

  it('reproduces the clean Node runs: 10:33 in two credited phases (18 calls) and 11:04 in one (13 calls)', () => {
    const early = deriveTrajectorySignatures('10:33', fixtureRun('10:33').trace.events);
    expect(early.map(shape)).toEqual([
      ['Methane', 1, 'node-http-static-json-api', true, 12, 'write_file×3 › start_node_server › fetch_url×4 › read_file › fetch_url×3'],
      ['Methane', 1, null, true, 6, 'write_file×2 › start_node_server › fetch_url×2 › read_file'],
      ['Tracheid', 2, null, true, 9, 'write_file×3 › start_static_server › validate_html › read_file×3 › list_files'],
    ]);
    const late = deriveTrajectorySignatures('11:04', fixtureRun('11:04').trace.events);
    // No skill event in that run at all: keyed on the Molecule alone, credited by trust.
    expect(late.map(shape)).toEqual([
      ['Methane', 1, null, true, 13, 'write_file×3 › start_node_server › fetch_url×8 › read_file'],
      ['Tracheid', 2, null, true, 7, 'write_file×4 › start_static_server › validate_html×2'],
    ]);
  });

  it('reproduces the pomodoro pair: the repeat carries a fourteen-long validate_html streak and earns no credit for it', () => {
    const first = deriveTrajectorySignatures('11:22', fixtureRun('11:22').trace.events);
    expect(first.map(shape)).toEqual([
      ['Water', 1, 'build-interactive-html-widget', true, 5, 'write_file › start_static_server › validate_html › list_files › write_file'],
      // `credit-withheld` in the trace: no success event, and the trust move is Tracheid's.
      ['Water', 1, 'build-stateful-widget-html', false, 6, 'read_file › start_static_server › validate_html×2 › write_file › list_files'],
    ]);
    const second = deriveTrajectorySignatures('11:31', fixtureRun('11:31').trace.events);
    expect(second.map(shape)).toEqual([
      ['Water', 1, 'build-interactive-html-widget', true, 9, 'write_file › start_static_server › validate_html×4 › list_files › write_file › read_file'],
      ['Water', 1, null, false, 17, 'read_file › start_static_server › validate_html×14 › write_file'],
    ]);
  });

  it('orders the three readings of the design document mechanically: clean repeat > drifted phase > streak', () => {
    const tools = (hhmm: string, index: number) =>
      deriveTrajectorySignatures(hhmm, fixtureRun(hhmm).trace.events)[index]!.tools;
    const cleanRepeat = scoreTrajectory(tools('11:04', 0), [tools('10:33', 0), tools('10:47', 0)]);
    const driftedPhase = scoreTrajectory(tools('10:47', 0), [tools('10:33', 0), tools('11:04', 0)]);
    const streak = scoreTrajectory(tools('11:31', 1), [tools('11:22', 0), tools('11:22', 1)]);
    expect(cleanRepeat.score).toBeGreaterThan(0.8);
    expect(driftedPhase.score).toBeGreaterThan(0.6);
    expect(driftedPhase.score).toBeLessThan(0.75);
    expect(streak.score).toBeLessThan(0.5);
    expect(streak.lengthRatio).toBeGreaterThan(2);
  });

  it('assembles a reference from the five finished runs with only credited, closed paths', () => {
    const reference = buildTrajectoryReference(FIXTURE.map(({ trace }) => ({ runId: trace.id, events: trace.events })));
    expect(reference.runs).toBe(5);
    expect(referenceSamples(reference, { l1Name: 'Tracheid', skillId: null, keyedBy: 'atom' })).toHaveLength(3);
    expect(referenceSamples(reference, { l1Name: 'Methane', skillId: 'node-http-static-json-api', keyedBy: 'skill' })).toHaveLength(2);
    expect(referenceSamples(reference, { l1Name: 'Dopamine', skillId: null, keyedBy: 'atom' })).toHaveLength(0);
  });
});
