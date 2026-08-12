import { describe, it, expect } from 'vitest';
import { validateProbeManifest } from '../src/contracts/probeManifest.js';

/**
 * The probe manifest is written by PROMPT (L1 evidence contracts) and read
 * by COMPILED SCRIPTS with no validator in between. A malformed manifest
 * silently breaks every future deterministic dispatch, and the failure
 * surfaces far from its cause — a third-generation HTTP verifier crashed on
 * entries whose shape it didn't expect. This check turns that class of bug
 * into evidence the supervisor can see immediately.
 */
describe('validateProbeManifest', () => {
  it('accepts a shell-shaped manifest', () => {
    expect(
      validateProbeManifest(
        JSON.stringify({ version: 1, entries: [{ cmd: 'node x.js a', exitCode: 0, stdout: 'ok', stderr: '' }] })
      )
    ).toEqual([]);
  });

  it('accepts an http-shaped manifest', () => {
    expect(
      validateProbeManifest(
        JSON.stringify({
          version: 1,
          entries: [{ probe: 'http', method: 'GET', path: '/status', status: 200, body: '{}' }],
        })
      )
    ).toEqual([]);
  });

  it('accepts a web-shaped manifest (file + smoke, never the ephemeral URL)', () => {
    expect(
      validateProbeManifest(
        JSON.stringify({
          version: 1,
          entries: [
            {
              probe: 'web',
              file: 'index.html',
              interactions: [{ type: 'click', selector: '#start' }],
              smoke: 'window.__pomo.running === true',
              expected: 'true',
              consoleErrors: 0,
            },
          ],
        })
      )
    ).toEqual([]);
  });

  it('flags pixel-coordinate interactions — they die on the next re-render', () => {
    // Observed live: two web runs in the same batch, one recording
    // {selector:'#toggle'} (replayable) and one {x:304,y:392} (worthless to
    // a later pass). validate_html accepts both, so the contract must reject
    // coordinates here.
    const problems = validateProbeManifest(
      JSON.stringify({
        version: 1,
        entries: [
          {
            probe: 'web',
            file: 'index.html',
            smoke: 'window.__tally.count === 2',
            expected: 'true',
            interactions: [
              { type: 'click', x: 304, y: 392, label: '+1 button' },
              { type: 'click', selector: '#reset' },
            ],
          },
        ],
      })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/1 interaction\(s\) use pixel coordinates/);
  });

  it('accepts selector-based interactions', () => {
    expect(
      validateProbeManifest(
        JSON.stringify({
          version: 1,
          entries: [
            {
              probe: 'web',
              file: 'index.html',
              smoke: 'window.__x === true',
              expected: 'true',
              interactions: [
                { type: 'type', selector: '#name', text: 'Test User' },
                { type: 'click', selector: '#a' },
                { type: 'keydown', key: 'Enter' },
              ],
            },
          ],
        })
      )
    ).toEqual([]);
  });

  it('reports a web entry missing its replayable fields', () => {
    const problems = validateProbeManifest(
      JSON.stringify({ version: 1, entries: [{ probe: 'web', file: 'index.html' }] })
    );
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toMatch(/#0 \(web\).*smoke/);
    expect(problems.join('\n')).toMatch(/missing JSON-encoded "expected"/);
  });

  it('accepts a MIXED manifest — that is the documented contract', () => {
    expect(
      validateProbeManifest(
        JSON.stringify({
          version: 1,
          entries: [
            { cmd: 'node x.js', exitCode: 1, stdout: '', stderr: 'boom' },
            { probe: 'http', method: 'POST', path: '/inc', status: 200, body: '{"value":1}' },
            {
              probe: 'web',
              file: 'index.html',
              smoke: 'document.title === "x"',
              expected: 'true',
            },
          ],
        })
      )
    ).toEqual([]);
  });

  it('rejects a static test script disguised as a browser probe', () => {
    const problems = validateProbeManifest(
      JSON.stringify({
        version: 1,
        entries: [
          {
            probe: 'web',
            file: 'test-ui-browser.js',
            interactions: [
              { type: 'navigate', url: 'http://localhost:<port>/' },
              { type: 'verify', selector: '#entryForm' },
            ],
            smoke: 'UI exists and window.__test is initialized',
          },
        ],
      })
    );
    expect(problems.join('\n')).toMatch(/test\/probe script/);
    expect(problems.join('\n')).toMatch(/not a replayable JavaScript expression/);
    expect(problems.join('\n')).toMatch(/missing JSON-encoded "expected"/);
    expect(problems.join('\n')).toMatch(/unsupported type "navigate"/);
    expect(problems.join('\n')).toMatch(/unsupported type "verify"/);
  });

  it('tolerates unknown extra fields (forward compatibility)', () => {
    expect(
      validateProbeManifest(
        JSON.stringify({ version: 1, entries: [{ cmd: 'x', exitCode: 0, note: 'why', futureField: 42 }] })
      )
    ).toEqual([]);
  });

  it('reports non-JSON, wrong version, non-array entries, empty entries', () => {
    expect(validateProbeManifest('{not json')[0]).toMatch(/not valid JSON/);
    expect(validateProbeManifest(JSON.stringify({ version: 2, entries: [{ cmd: 'x', exitCode: 0 }] }))[0]).toMatch(
      /expected "version": 1/
    );
    expect(validateProbeManifest(JSON.stringify({ version: 1, entries: {} }))[0]).toMatch(/must be an array/);
    expect(validateProbeManifest(JSON.stringify({ version: 1, entries: [] }))[0]).toMatch(/is empty/);
  });

  it('reports per-entry shape breakage with the entry index', () => {
    const problems = validateProbeManifest(
      JSON.stringify({
        version: 1,
        entries: [
          { cmd: 'x' }, // shell, missing exitCode
          { probe: 'http', method: 'GET', path: '/a' }, // http, missing status
          { hello: 'world' }, // neither shape
        ],
      })
    );
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/#0 \(shell\).*exitCode/);
    expect(problems[1]).toMatch(/#1 \(http\).*status/);
    expect(problems[2]).toMatch(/#2: matches no known shape/);
  });
});

describe('manifest health check fires for HTTP children (audit rank-8)', () => {
  it('an http-tooled child with NO cmd-shaped probes still gets its manifest checked', async () => {
    // Dead-code regression: the gate keyed on extractRecordedProbes, which
    // requires `cmd` — http children record {method,path,status}, so the
    // exact family that writes http manifests was never health-checked.
    const { checkGroundTruth } = await import('../src/atoms/groundTruth.js');
    const executed: string[] = [];
    const tools = {
      has: (n: string) => ['read_file', 'list_files'].includes(n),
      execute: async (name: string, argsIn: Record<string, unknown>) => {
        executed.push(`${name}:${(argsIn['path'] as string | undefined) ?? ''}`);
        if (name === 'read_file' && argsIn['path'] === '.atoma-probes.json') {
          return { content: JSON.stringify({ version: 2, entries: [] }) }; // malformed on purpose
        }
        if (name === 'read_file') return { content: 'srv' };
        return { entries: [] };
      },
    };
    const child = {
      toolNames: () => ['write_file', 'run_shell', 'fetch_url', 'start_node_server'],
    };
    const res = await checkGroundTruth({
      ctx: { tools, logger: { debug() {}, info() {}, warn() {}, error() {} } } as never,
      subject: 'RESULT',
      payload: { output: { entry: 'server.js' }, summary: 's' },
      child: child as never,
    });
    expect(executed).toContain('read_file:.atoma-probes.json');
    expect(res.block).toMatch(/MALFORMED/);
    expect(res.block).toMatch(/expected "version": 1/);
    // Structural breakage does not prove the deliverable wrong, but it must
    // bypass the no-validator trust path so a reviewer sees the evidence.
    expect(res.contradiction).toBe(false);
    expect(res.requiresReview).toBe(true);
  });
});
