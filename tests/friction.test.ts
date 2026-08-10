import { describe, it, expect } from 'vitest';
import {
  frictionSignature,
  extractFrictionEvents,
  computeFrictionRows,
  runWasApproved,
} from '../src/viz/friction.js';
import type { VizRun } from '../src/viz/trace.js';

/**
 * The friction REPORT (the diagnostic stage that survived the 2026-08-07
 * adversarial pass — the runtime sensor itself was rejected, 0/6 root-caused
 * friction classes were learnable technique). The normalisation cases below
 * are the refutation's literal counter-examples: signatures that fragmented
 * when they should group, and pseudo-recurrences that grouped when they
 * should be told apart.
 */

function toolEv(over: Record<string, unknown>): Record<string, unknown> {
  return { id: 'e', ts: 1, kind: 'tool', llmEventId: 'l', name: 'run_shell', args: {}, durationMs: 1, ...over };
}

function run(events: Record<string, unknown>[], over: Partial<VizRun> = {}): VizRun {
  return {
    id: over.id ?? 'r1',
    label: 'test',
    task: { description: 't' },
    startedAt: '2026-08-07T00:00:00Z',
    endedAt: '2026-08-07T00:01:00Z',
    events: events as never,
    ...over,
  };
}

describe('frictionSignature — the refutation counter-examples', () => {
  it('groups the edit_file class across DIFFERENT quoted filenames, keeping the extension', () => {
    const a = frictionSignature('edit_file', 'edit_file: old_string not found in "index.html". It must match…');
    const b = frictionSignature('edit_file', 'edit_file: old_string not found in "other.html". It must match…');
    const c = frictionSignature('edit_file', 'edit_file: old_string not found in ".atoma-probes.json". It must match…');
    expect(a).toBe(b);
    expect(a).not.toBe(c); // extension survives: .html class ≠ .json class
    expect(a).toContain('"<file.html>"');
    expect(c).toContain('"<file.json>"');
  });

  it('groups the ESM class across line numbers (single digit!), harness prefixes and paths', () => {
    const a = frictionSignature(
      'run_shell',
      '[SERVER ERR] file:///Users/x/dev/atoma/build/app/server.js:1\nconst http = require(\'http\');\nReferenceError: require is not defined'
    );
    const b = frictionSignature(
      'run_shell',
      '[server error] file:///Users/x/dev/atoma/build/app.prev3/server.js:12\nconst http = require(\'http\');\nReferenceError: require is not defined'
    );
    expect(a).toBe(b);
  });

  it('collapses ports, PIDs and hex ids', () => {
    const a = frictionSignature('run_shell', 'Error: listen EADDRINUSE: address already in use :::8000');
    const b = frictionSignature('run_shell', 'Error: listen EADDRINUSE: address already in use :::52341');
    expect(a).toBe(b);
    expect(frictionSignature('t', 'run deadbeef01 failed')).toBe(frictionSignature('t', 'run 01beefdead failed'));
  });

  it('does NOT mistake version strings for filenames (letter-initial extension rule)', () => {
    const s = frictionSignature('run_shell', 'expected "1.0.0" in output');
    expect(s).not.toContain('<file.');
  });
});

describe('extractFrictionEvents — severity tiers', () => {
  it('thrown = hard; run_shell exit≠0 = soft; fetch_url non-2xx results NEVER count', () => {
    const r = run([
      toolEv({ name: 'edit_file', error: 'edit_file: old_string not found in "x.json".' }),
      toolEv({ name: 'run_shell', result: { exitCode: 1, stdout: '', stderr: 'boom' } }),
      toolEv({ name: 'run_shell', result: { exitCode: 0, stdout: 'ok', stderr: '' } }),
      // Deliberate error-case probe: a 404 the harness EXPECTS. Not friction.
      toolEv({ name: 'fetch_url', result: { ok: false, status: 404, body: 'not found' } }),
      toolEv({ name: 'fetch_url', error: 'timeout after 10000ms' }), // thrown DOES count
      toolEv({ name: 'validate_html', result: { ok: false, errors: ['smoke check failed: false'] } }),
    ]);
    const evs = extractFrictionEvents(r, 'r1.json');
    expect(evs.map((e) => [e.tool, e.severity])).toEqual([
      ['edit_file', 'hard'],
      ['run_shell', 'soft'],
      ['fetch_url', 'hard'],
      ['validate_html', 'soft'],
    ]);
  });
});

describe('computeFrictionRows — pseudo-recurrence unmasking', () => {
  it('validate_html smoke failures share one signature but distinctArgs exposes them', () => {
    const r = run([
      toolEv({ name: 'validate_html', args: { smoke: 'window.__test.score === 3' }, result: { ok: false, errors: ['smoke check failed: false'] } }),
      toolEv({ name: 'validate_html', args: { smoke: 'document.title.length > 0' }, result: { ok: false, errors: ['smoke check failed: false'] } }),
      toolEv({ name: 'validate_html', args: { smoke: 'grid.cells === 64' }, result: { ok: false, errors: ['smoke check failed: false'] } }),
    ]);
    const rows = computeFrictionRows(extractFrictionEvents(r, 'r1.json'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.events).toBe(3);
    expect(rows[0]!.distinctArgs).toBe(3); // one text, three unrelated assertions
  });

  it('aggregates across runs and counts approved runs separately', () => {
    const err = { name: 'edit_file', error: 'edit_file: old_string not found in "a.json".' };
    const approved = run([toolEv(err)], { id: 'rA' });
    const rejected = run(
      [
        toolEv(err),
        { id: 'v', ts: 2, kind: 'llm', role: 'validate-result', response: '{"approved": false, "reasoning": "no"}' },
      ],
      { id: 'rB' }
    );
    const cancelled = run([toolEv(err)], { id: 'rC', cancelled: true });
    const evs = [
      ...extractFrictionEvents(approved, 'a.json'),
      ...extractFrictionEvents(rejected, 'b.json'),
      ...extractFrictionEvents(cancelled, 'c.json'),
    ];
    const rows = computeFrictionRows(evs, new Map([['a.json', 'http'], ['b.json', 'cli']]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runs).toBe(3);
    expect(rows[0]!.approvedRuns).toBe(1); // only rA
    expect(rows[0]!.families).toEqual(['?', 'cli', 'http']);
  });
});

describe('runWasApproved', () => {
  it('mirrors the learning machinery exclusions: cancelled, degraded, errored, rejected', () => {
    expect(runWasApproved(run([]))).toBe(true);
    expect(runWasApproved(run([], { cancelled: true }))).toBe(false);
    expect(runWasApproved(run([], { degraded: true }))).toBe(false);
    expect(runWasApproved(run([], { error: 'watchdog' }))).toBe(false);
    expect(runWasApproved({ ...run([]), endedAt: undefined })).toBe(false);
    const rej = run([{ id: 'v', ts: 1, kind: 'llm', role: 'validate-plan', response: '{"approved": false}' }]);
    expect(runWasApproved(rej)).toBe(false);
    const appr = run([{ id: 'v', ts: 1, kind: 'llm', role: 'validate-plan', response: '{"approved": true}' }]);
    expect(runWasApproved(appr)).toBe(true);
  });
});
