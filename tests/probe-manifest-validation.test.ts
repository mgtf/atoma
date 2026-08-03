import { describe, it, expect } from 'vitest';
import { validateProbeManifest } from '../src/atoms/L2Atom.js';

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

  it('reports a web entry missing its replayable fields', () => {
    const problems = validateProbeManifest(
      JSON.stringify({ version: 1, entries: [{ probe: 'web', file: 'index.html' }] })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/#0 \(web\).*smoke/);
  });

  it('accepts a MIXED manifest — that is the documented contract', () => {
    expect(
      validateProbeManifest(
        JSON.stringify({
          version: 1,
          entries: [
            { cmd: 'node x.js', exitCode: 1, stdout: '', stderr: 'boom' },
            { probe: 'http', method: 'POST', path: '/inc', status: 200, body: '{"value":1}' },
            { probe: 'web', file: 'index.html', smoke: 'document.title === "x"' },
          ],
        })
      )
    ).toEqual([]);
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
