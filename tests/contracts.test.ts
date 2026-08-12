import { describe, it, expect } from 'vitest';
import {
  DECORATED_CMD_RE,
  EXAMPLE_HTTP_ENTRY,
  EXAMPLE_SHELL_ENTRY,
  EXAMPLE_WEB_ENTRY,
  PROBE_MANIFEST_FILENAME,
  manifestReaderLines,
  manifestWriterLines,
  validateProbeManifest,
  httpEntrySchema,
  shellEntrySchema,
  smokeOkIncludesStyling,
  smokeResultIncludesStyling,
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
  it('binds returned styling values into the aggregate smoke verdict', () => {
    expect(
      smokeResultIncludesStyling({ ok: true, milestoneClass: 'goal-reached' })
    ).toBe(true);
    expect(
      smokeOkIncludesStyling(
        '({ok: milestoneClass === "goal-reached", milestoneClass})'
      )
    ).toBe(true);
    expect(
      smokeOkIncludesStyling('({ok: milestoneCount === 4, milestoneClass})')
    ).toBe(false);
    expect(
      smokeOkIncludesStyling(
        '(() => { const checks = { goalClassApplied: milestone.className !== initial.className }; return { ok: Object.values(checks).every(Boolean), checks }; })()'
      )
    ).toBe(true);
  });

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

  it('rejects scenario labels masquerading as the web probe discriminator', () => {
    // Live habit-widget manifest used `probe: "reset_after_increments"`.
    // The smoke fallback inferred the web shape and silently accepted it,
    // even though every schema and replay reader dispatches on literal "web".
    const manifest = JSON.stringify({
      version: 1,
      entries: [
        {
          probe: 'reset_after_increments',
          file: 'index.html',
          interactions: [{ type: 'click', selector: '#reset' }],
          smoke: 'true',
          expected: 'true',
          consoleErrors: 0,
          failedRequests: 0,
        },
      ],
    });
    expect(validateProbeManifest(manifest)).toEqual([
      expect.stringMatching(/"probe" must be the literal "http" or "web"/),
    ]);
    expect(manifestWriterLines('web').join(' ')).toMatch(
      /"probe" MUST be the literal "web"/
    );
  });

  it('rejects a non-encoded web expected value just like the schema does', () => {
    const manifest = JSON.stringify({
      version: 1,
      entries: [
        {
          probe: 'web',
          file: 'index.html',
          smoke: '({ok:true})',
          expected: { ok: true },
        },
      ],
    });
    expect(validateProbeManifest(manifest)).toEqual([
      expect.stringMatching(/"expected" must be a JSON-encoded string/),
    ]);
    expect(
      webEntrySchema.safeParse({
        probe: 'web',
        file: 'index.html',
        smoke: '({ok:true})',
        expected: { ok: true },
      }).success
    ).toBe(false);
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
    const { witnessesFromPayload, recordedProbesFromWitnesses } = await import(
      '../src/contracts/witness.js'
    );
    const w = witnessesFromPayload({
      output: {
        examples_verified: [
          { command: 'node cli.js x', exit_code: 0, actual_stdout: 'X', expected_stdout: 'X' },
        ],
      },
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ source: 'recorded-probe', cmd: 'node cli.js x', exitCode: 0 });
    expect(recordedProbesFromWitnesses(w)).toEqual([
      expect.objectContaining({ cmd: 'node cli.js x', exitCode: 0 }),
    ]);
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

  it('forbids recording the long-running server process as a shell probe', () => {
    // Live habits-API run recorded `node server.js`: record_probe could only
    // time it out, persisted exit 1, and the note misleadingly called that
    // full verification. Endpoint requests or a finite harness are evidence;
    // the server lifecycle itself is not.
    const lines = manifestWriterLines('http').join(' ');
    expect(lines).toMatch(/NEVER record the long-running server command/);
    expect(lines).toMatch(/node server\.js/);
    expect(lines).toMatch(/record_probe is intentionally NOT in the HTTP toolset/);
    expect(lines).toMatch(/start_node_server.*fetch_url/s);
    expect(lines).toMatch(/probe harness.*run it through run_shell/s);
  });
});

describe('decorated cmds: `; echo EXIT=$?` corrupts the record — all three sides agree', () => {
  // Observed 2026-08-06 (cli-envcheck run): the build-phase L1 recorded
  // every cmd with the display decoration. Every exitCode became echo's
  // (0), the real error-case codes survived only inside stdout strings,
  // and the replay diffed against corrupted expectations — two phantom
  // mismatches auto-demoted a 30-success compiled verifier.
  it('the shell writer forbids recording decorations', () => {
    const lines = manifestWriterLines('shell').join(' ');
    expect(lines).toMatch(/BARE command/);
    expect(lines).toMatch(/NEVER append\s+display decorations/);
    expect(lines).toMatch(/exit code\s+belongs in "exitCode"/);
    expect(lines).toMatch(/supersedes:"<exact old cmd>"/);
  });

  it('the reader teaches trailing-newline tolerance and the skip-not-replay rule', () => {
    const lines = manifestReaderLines().join(' ');
    expect(lines).toMatch(/ONLY in trailing newline is a MATCH/);
    expect(lines).toMatch(/SKIP it with an explanatory note/);
    expect(lines).toMatch(/never silently pass/);
  });

  it('the health check reports a decorated shell cmd (and passes a clean one)', () => {
    const decorated = JSON.stringify({
      version: 1,
      entries: [{ cmd: 'node envcheck.js fixtures/valid.env; echo EXIT=$?', exitCode: 0, stdout: 'OK 6 vars\nEXIT=0' }],
    });
    const problems = validateProbeManifest(decorated);
    expect(problems.some((p) => p.includes('echo of $?'))).toBe(true);

    const clean = JSON.stringify({
      version: 1,
      entries: [{ cmd: 'node envcheck.js fixtures/valid.env', exitCode: 0, stdout: 'OK 6 vars\n' }],
    });
    expect(validateProbeManifest(clean)).toEqual([]);
  });

  it('a port-bearing recorded stdout is reported; the reader compares exitCode only', () => {
    // Observed live (contacts run, 2026-08-07): phase 2 recorded the harness
    // entry WITH its stdout — embedding the bound port — so the replay
    // diffed a fresh port against a stale one and phantom-failed a healthy
    // artefact (second direct failure → demotion of the compiled verifier).
    const portful = JSON.stringify({
      version: 1,
      entries: [{ cmd: 'node test-api.js', exitCode: 0, stdout: '[server] LISTENING_ON_PORT=55257\nAll checks passed' }],
    });
    expect(validateProbeManifest(portful).some((p) => p.includes('run-varying bound port'))).toBe(true);
    // The clean shape the writer contract asks for passes untouched.
    const clean = JSON.stringify({
      version: 1,
      entries: [{ cmd: 'node test-api.js', exitCode: 0 }],
    });
    expect(validateProbeManifest(clean)).toEqual([]);
    // The reader teaches the exitCode-only comparison for that entry shape.
    const reader = manifestReaderLines().join(' ');
    expect(reader).toMatch(/LISTENING_ON_PORT=<n> is port-bearing/);
    expect(reader).toMatch(/compare the\s+exitCode ONLY/);
    expect(reader).toMatch(/do NOT write the fresh port back/);
    // And the writer block makes the harness entry non-optional when a
    // test script exists, naming the demotion this class caused.
    const writer = manifestWriterLines('http').join(' ');
    expect(writer).toMatch(/HARNESS ENTRY — MANDATORY WHENEVER A TEST SCRIPT EXISTS/);
    expect(writer).toMatch(/omit "stdout"/);
  });

  it('a renamed field is named back: the checker says WHICH rename was made', () => {
    // Measured twice, both cascades: a run burned FOUR rejection cycles on
    // {kind, expect} instead of {probe, status}, another FIVE on
    // "expectExitCode" instead of "exitCode". Stating the absence alone
    // ("missing numeric status") left the writer guessing; naming the
    // rename turns a cascade into one coached cycle.
    const renamedHttp = JSON.stringify({
      version: 1,
      entries: [{ kind: 'http', method: 'GET', path: '/timers', expect: 200 }],
    });
    const p1 = validateProbeManifest(renamedHttp);
    expect(p1.some((p) => p.includes('this entry has "expect"'))).toBe(true);
    expect(p1.some((p) => p.includes('the field is named "status"'))).toBe(true);

    const renamedShell = JSON.stringify({
      version: 1,
      entries: [{ cmd: 'node x.js', expectExitCode: 0 }],
    });
    const p2 = validateProbeManifest(renamedShell);
    expect(p2.some((p) => p.includes('this entry has "expectExitCode"'))).toBe(true);
    expect(p2.some((p) => p.includes('the field is named "exitCode"'))).toBe(true);

    // No alias present → the plain message, no invented hint.
    const plainMissing = JSON.stringify({
      version: 1,
      entries: [{ probe: 'http', method: 'GET', path: '/x' }],
    });
    expect(validateProbeManifest(plainMissing).some((p) => p.includes('this entry has'))).toBe(false);

    // And the writer block forbids the renaming in the first place.
    const writer = manifestWriterLines('http').join(' ');
    expect(writer).toMatch(/FIELD NAMES ARE EXACT/);
    expect(writer).toMatch(/"probe", not "kind"/);
  });

  it('DECORATED_CMD_RE catches the variants and spares legitimate cmds', () => {
    expect(DECORATED_CMD_RE.test('node x.js; echo EXIT=$?')).toBe(true);
    expect(DECORATED_CMD_RE.test('node x.js && echo $?')).toBe(true);
    expect(DECORATED_CMD_RE.test('node x.js || echo rc=$?')).toBe(true);
    // Legitimate compound commands stay untouched — the signature is the
    // trailing echo of $?, not the separator.
    expect(DECORATED_CMD_RE.test('node x.js; echo done')).toBe(false);
    expect(DECORATED_CMD_RE.test('node build.js && node test.js')).toBe(false);
    expect(DECORATED_CMD_RE.test('node x.js')).toBe(false);
  });
});
