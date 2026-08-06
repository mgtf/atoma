import { describe, it, expect } from 'vitest';
import {
  EXAMPLE_HTTP_ENTRY,
  EXAMPLE_SHELL_ENTRY,
  EXAMPLE_WEB_ENTRY,
  PROBE_MANIFEST_FILENAME,
  manifestReaderLines,
  manifestWriterLines,
  validateProbeManifest,
  httpEntrySchema,
  shellEntrySchema,
  webEntrySchema,
} from '../src/contracts/probeManifest.js';
import {
  EXAMPLE_ENVELOPE,
  parseScriptEnvelope,
  scriptEnvelopeSchema,
} from '../src/contracts/scriptEnvelope.js';

/**
 * THE GLUE TESTS: one definition, three consumers. The probe-manifest
 * contract drifted twice in production because writers (L1 prompts),
 * reader (compile prompt) and checker (validateProbeManifest) were three
 * hand-written copies. These tests pin the property that makes the
 * contracts module worth having: what one side emits, the other sides
 * accept.
 */
describe('contracts — schema/validator/prompt agreement', () => {
  it('every schema-validated EXAMPLE round-trips the health check clean', () => {
    // The exact drift class that "nearly broke iteration 4": a shape taught
    // to writers that the checker reports as MALFORMED.
    const manifest = JSON.stringify({
      version: 1,
      entries: [EXAMPLE_SHELL_ENTRY, EXAMPLE_HTTP_ENTRY, EXAMPLE_WEB_ENTRY],
    });
    expect(validateProbeManifest(manifest)).toEqual([]);
  });

  it('writer prompt blocks embed schema-validated examples, per bucket', () => {
    expect(manifestWriterLines('http').join('\n')).toContain('"probe": "http"');
    expect(manifestWriterLines('web').join('\n')).toContain('"probe": "web"');
    expect(manifestWriterLines('shell').join('\n')).toContain('"cmd"');
    for (const kind of ['shell', 'http', 'web'] as const) {
      expect(manifestWriterLines(kind).join('\n')).toContain(PROBE_MANIFEST_FILENAME);
    }
  });

  it('the reader block teaches ALL the shapes the writers emit', () => {
    const reader = manifestReaderLines().join('\n');
    expect(reader).toMatch(/THREE SHAPES/);
    expect(reader).toContain('"cmd"');
    expect(reader).toContain('"probe": "http"');
    expect(reader).toContain('"probe": "web"');
    // The honest ceiling: no browser tooling in a compiled script.
    expect(reader).toMatch(/REFUSE/);
  });

  it('a shell entry with an incidental extra "path" field is NOT misclassified (audit fix)', () => {
    // Old dispatch order inferred http from `path` before letting `cmd`
    // claim the shell shape — a correct shell entry with an extra field
    // produced a false MALFORMED that could reject a valid deliverable.
    const manifest = JSON.stringify({
      version: 1,
      entries: [{ cmd: 'node x.js', exitCode: 0, path: '/tmp/incidental', smoke: 'extra' }],
    });
    expect(validateProbeManifest(manifest)).toEqual([]);
  });

  it('the explicit probe discriminator still wins over cmd', () => {
    const manifest = JSON.stringify({
      version: 1,
      entries: [{ probe: 'http', cmd: 'curl …', method: 'GET', path: '/a', status: 200 }],
    });
    expect(validateProbeManifest(manifest)).toEqual([]);
    const bad = JSON.stringify({
      version: 1,
      entries: [{ probe: 'http', cmd: 'curl …' }],
    });
    expect(validateProbeManifest(bad)).toHaveLength(3); // method+path+status missing
  });

  it('schemas reject what the contract forbids', () => {
    // Coordinate-only interactions violate the replayability requirement.
    expect(
      webEntrySchema.safeParse({
        probe: 'web',
        file: 'index.html',
        smoke: 'x',
        interactions: [{ type: 'click', x: 304, y: 392 }],
      }).success
    ).toBe(false);
    expect(shellEntrySchema.safeParse({ cmd: '', exitCode: 0 }).success).toBe(false);
    expect(httpEntrySchema.safeParse({ probe: 'http', method: 'GET', path: '/a' }).success).toBe(false);
  });

  it('envelope: schema and strict parse agree on the failure guards', () => {
    expect(scriptEnvelopeSchema.safeParse(EXAMPLE_ENVELOPE).success).toBe(true);
    expect(scriptEnvelopeSchema.safeParse({ output: null, summary: 'x' }).success).toBe(false);
    expect(parseScriptEnvelope(JSON.stringify({ output: null, summary: 'x' }))).toBeNull();
    expect(parseScriptEnvelope(JSON.stringify({ output: 1, summary: 'FAILED: nope' }))).toBeNull();
    expect(parseScriptEnvelope('noise\n' + JSON.stringify({ output: 1, summary: 'ok' }))).toEqual({
      output: 1,
      summary: 'ok',
    });
  });
});

describe('contracts — typed witnesses (P5)', () => {
  it('witnessesFromPayload normalises historical probe spellings into tagged witnesses', async () => {
    const { witnessesFromPayload } = await import('../src/contracts/witness.js');
    const w = witnessesFromPayload({
      output: {
        examples_verified: [
          { command: 'node cli.js x', exit_code: 0, actual_stdout: 'X', expected_stdout: 'X' },
        ],
      },
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ source: 'recorded-probe', cmd: 'node cli.js x', exitCode: 0 });
  });

  it('an L1 result carries its witnesses as first-class evidence', async () => {
    const { L1Atom } = await import('../src/atoms/L1Atom.js');
    const { makeCtx, jsonText } = await import('./helpers.js');
    const atom = new L1Atom({
      name: 'H', ordinal: 1, systemPrompt: 'x', tools: [], params: {},
    });
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(
      jsonText({
        output: { probes: [{ cmd: 'node x.js', exitCode: 0, stdout: 'ok' }] },
        summary: 'done',
      })
    );
    const plan = await atom.plan({ description: 't' }, ctx);
    const result = await atom.execute({ description: 't' }, plan, ctx);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence![0]).toMatchObject({ source: 'recorded-probe', cmd: 'node x.js' });
  });
});

describe('http manifest: a SEQUENCE, not a keyed set', () => {
  // A real CRUD manifest recorded POST /recipes FOUR times (201, 400
  // malformed, 400 missing-fields, plus a repeat). The writer used to say
  // "merge by method+path", which would collapse those into one and
  // silently delete every error case — the opposite of what a replayable
  // record needs.
  it('tells the writer to append in order and never merge on the route', () => {
    const lines = manifestWriterLines('http').join(' ');
    expect(lines).toMatch(/APPEND in\s+order/);
    expect(lines).toMatch(/never merge by method\+path/);
    expect(lines).not.toMatch(/merge by method\+path if/);
  });

  it('asks for an executable harness as a SHELL entry — the replayable half', () => {
    // http entries carry no request payload, so a compiled script cannot
    // replay mutations from them. A harness recorded as {cmd, exitCode} is
    // replayable by the already-compiled shell path.
    const lines = manifestWriterLines('http').join(' ');
    expect(lines).toMatch(/EXECUTABLE probe harness/);
    expect(lines).toMatch(/"cmd":"node <harness>","exitCode":0/);
    expect(lines).toMatch(/omit "stdout"/);
  });
});
