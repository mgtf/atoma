import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TRACE_READ_LIMITS,
  MAX_TRACE_BYTES,
  readTraceTopLevelFields,
  TRACE_READ_ERRORS,
  TraceFieldReadError,
  type JsonShape,
  type TraceFieldSpec,
} from '../src/contracts/traceFields.js';
import { TraceRecorder } from '../src/viz/trace.js';
import type { Task } from '../src/core/types.js';

/**
 * The reader that replaced the coordinator's whole-file `JSON.parse`.
 *
 * WHY THIS FILE EXISTS: project run `2857a579` delivered its work, wrote a
 * 781_071-byte trace, and was recorded `failed` because a 524_288-byte cap
 * refused to read it. The old fixtures in `tests/project-coordinator.test.ts`
 * hand-wrote ~120-byte three-key traces, which is exactly why a cap on a file
 * growing ~19KB per tool call could ship unnoticed. Everything here is pinned
 * against the REAL writer or against `JSON.parse` itself.
 */

const task: Task = { description: 'build an expense tracker' };

const SPEC: TraceFieldSpec = {
  values: ['id', 'endedAt', 'cancelled', 'degraded'],
  shapes: ['result', 'error'],
};

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-tracefields-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function shapeOfValue(value: unknown): JsonShape {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const kind = typeof value;
  if (kind === 'object') return 'object';
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return kind;
  throw new Error(`a JSON document cannot hold ${kind}`);
}

/**
 * What `JSON.parse` would have produced for the same spec. The accumulators
 * are null-prototype for the same reason the reader's are: a `__proto__`
 * member of the document must become an own property here too, or the
 * comparison would be against a poisoned reference.
 */
function referenceProjection(file: string, spec: TraceFieldSpec) {
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const values = Object.create(null) as Record<string, unknown>;
  const shapes = Object.create(null) as Record<string, JsonShape>;
  for (const key of [...spec.values, ...spec.shapes]) {
    if (!Object.prototype.hasOwnProperty.call(doc, key)) continue;
    shapes[key] = shapeOfValue(doc[key]);
  }
  for (const key of spec.values) {
    if (!Object.prototype.hasOwnProperty.call(doc, key)) continue;
    const value = doc[key];
    // The reader captures primitives only; a wanted member holding a container
    // is reported as a shape and its value stays absent.
    if (value === null || typeof value !== 'object') values[key] = value;
  }
  return { values, shapes };
}

/** Stable comparison across null-prototype objects. */
function entries(record: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(record).sort((a, b) => a[0].localeCompare(b[0]));
}

function expectMatchesJsonParse(file: string, spec: TraceFieldSpec = SPEC): void {
  const expected = referenceProjection(file, spec);
  const actual = readTraceTopLevelFields(file, spec, {
    maxValueBytes: 8_192,
    maxCaptureBytes: 131_072,
  });
  expect(entries(actual.values)).toEqual(entries(expected.values));
  expect(entries(actual.shapes)).toEqual(entries(expected.shapes));
}

describe('readTraceTopLevelFields — against the real writer', () => {
  /**
   * Every terminal state `TraceRecorder` can reach, including the two persist
   * orderings (a throttled partial flush moves `totals` ahead of `endedAt`,
   * which is why nothing may depend on member order).
   */
  it('matches JSON.parse field-for-field on every shape the recorder emits', () => {
    const dir = scratch();
    const cases: Array<[string, (r: TraceRecorder) => void]> = [
      [
        'delivered',
        (r) =>
          void r.endRun({
            result: {
              summary: 'the tracker persists expenses',
              output: 'index.html, app.js, server.js',
              producedBy: { tier: 3, name: 'Meristem', viaFallback: false },
            },
          }),
      ],
      [
        'degraded',
        (r) =>
          void r.endRun({
            result: {
              summary: 'here is how you would do it',
              output: { note: 'prose instead of an artefact' },
              producedBy: { tier: 3, name: 'Meristem', viaFallback: true },
            },
          }),
      ],
      ['errored', (r) => void r.endRun({ error: 'run aborted after 900s budget' })],
      ['cancelled', (r) => void r.endRun({ cancelled: true })],
      [
        'flushed-then-ended',
        (r) => {
          r.flushPartial();
          r.endRun({
            result: {
              summary: 'flushed first',
              output: 'o',
              producedBy: { tier: 1, name: 'Water', viaFallback: false },
            },
          });
        },
      ],
      // A complete file describing an UNFINISHED run: `totals` present, no
      // `endedAt`, no `result`. No real trace on disk exhibits this.
      ['partial-only', (r) => r.flushPartial()],
    ];

    for (const [name, finish] of cases) {
      const recorder = new TraceRecorder(dir);
      recorder.beginRun(task, `trace ${name}`, { runId: `run-${name}` });
      recorder.record({
        id: 'e1',
        ts: Date.now(),
        kind: 'tool',
        llmEventId: 'l1',
        name: 'write_file',
        args: { path: 'app.js', contents: 'const total = 0; // {"id":"forged"}' },
        result: 'written',
        durationMs: 4,
      });
      finish(recorder);
      expectMatchesJsonParse(join(dir, `run-${name}.json`));
    }
  });

  /**
   * The measured erasure, at both real sizes. The assertion on file size comes
   * FIRST so the case fails loudly if the writer ever stops producing a large
   * trace, instead of passing vacuously.
   */
  it('reads a trace past both measured sizes without materialising it', () => {
    const dir = scratch();
    for (const [runId, floor] of [
      ['at-2857a579-scale', 781_071],
      ['at-949ecd5d-scale', 1_173_116],
    ] as const) {
      const recorder = new TraceRecorder(dir);
      recorder.beginRun(task, runId, { runId });
      // ~19KB per tool event is the measured slope; this reaches the floor the
      // same way a real run does, through events.
      const filler = 'x'.repeat(19_000);
      for (let i = 0; i < Math.ceil(floor / 19_000) + 2; i++) {
        recorder.record({
          id: `e${i}`,
          ts: Date.now(),
          kind: 'tool',
          llmEventId: 'l1',
          name: 'write_file',
          args: { path: `f${i}.js`, contents: filler },
          durationMs: 1,
        });
      }
      recorder.endRun({
        result: {
          summary: 'delivered',
          output: 'ok',
          producedBy: { tier: 3, name: 'Meristem', viaFallback: false },
        },
      });
      const file = join(dir, `${runId}.json`);
      expect(statSync(file).size).toBeGreaterThan(floor);
      const read = readTraceTopLevelFields(file, SPEC);
      expect(read.values['id']).toBe(runId);
      expect(typeof read.values['endedAt']).toBe('string');
      expect(read.shapes['result']).toBe('object');
      expect(read.shapes['error']).toBeUndefined();
      expect(read.values['cancelled']).toBeUndefined();
      expect(read.values['degraded']).toBeUndefined();
    }
  });
});

describe('readTraceTopLevelFields — the projection is bounded, the file is not', () => {
  /**
   * The property the whole design rests on. `result.output` is typed `unknown`
   * and capped nowhere, so a reader that captured it would have rebuilt the
   * erasure bug at a larger threshold. Under the coordinator's spec `result`
   * is shape-only, so a 4MB result and an 8MB event array are read with a
   * 2048-byte capture budget.
   */
  it('never captures a member it was asked only to shape', () => {
    const dir = scratch();
    const file = join(dir, 'huge.json');
    const event = JSON.stringify({
      id: 'e1',
      kind: 'tool',
      prose: `braces { } brackets [ ] quote \\" backslash \\\\ "id": "forged"`,
    });
    const events = `[${new Array(Math.ceil((8 * 1024 * 1024) / event.length)).fill(event).join(',')}]`;
    const output = 'o'.repeat(4 * 1024 * 1024);
    writeFileSync(
      file,
      `{"id":"big-run","events":${events},"result":{"summary":"s","output":${JSON.stringify(output)}},"endedAt":"2026-08-23T12:00:00.000Z"}`,
      'utf8'
    );
    expect(statSync(file).size).toBeGreaterThan(12 * 1024 * 1024);

    const read = readTraceTopLevelFields(file, SPEC, { maxCaptureBytes: 2_048 });
    expect(read.values['id']).toBe('big-run');
    expect(read.values['endedAt']).toBe('2026-08-23T12:00:00.000Z');
    expect(read.shapes['result']).toBe('object');
    // Structural tags only — the 4MB string never entered the control plane.
    expect(read.values['result']).toBeUndefined();
  });

  it('refuses a member longer than the capture budget rather than truncating it', () => {
    const dir = scratch();
    const file = join(dir, 'long-id.json');
    writeFileSync(file, `{"id":"${'a'.repeat(4_000)}","endedAt":"now"}`, 'utf8');
    expect(() => readTraceTopLevelFields(file, SPEC)).toThrow(TRACE_READ_ERRORS.overCapture);
  });

  it('refuses an oversized file on the stat, before reading a byte', () => {
    const dir = scratch();
    const file = join(dir, 'over.json');
    writeFileSync(file, `{"id":"x","endedAt":"now","result":{}}`, 'utf8');
    expect(() => readTraceTopLevelFields(file, SPEC, { maxFileBytes: 8 })).toThrow(
      TRACE_READ_ERRORS.overCeiling
    );
  });

  /**
   * NOT COVERED BEHAVIOURALLY, and deliberately so: the cumulative counter in
   * `peek` that enforces the ceiling on bytes READ rather than on a stat. Both
   * stat checks shadow it for a regular file, so triggering it needs a
   * concurrent writer appending between the stat and the read — a race this
   * suite cannot make deterministic. It is kept because a stat is stale the
   * moment it returns and the child owns that directory.
   */
  it('shares one ceiling with the sentinel', () => {
    expect(MAX_TRACE_BYTES).toBe(32 * 1024 * 1024);
    expect(DEFAULT_TRACE_READ_LIMITS.maxFileBytes).toBe(MAX_TRACE_BYTES);
  });
});

describe('readTraceTopLevelFields — fails closed', () => {
  /**
   * Absence is only reportable once the document is proven to end. This is the
   * property that rules out the cheaper head+tail byte window, which cannot
   * tell "the member is not there" from "my window was too small" — and a
   * missing `error` member read as "no error" would publish a failed run.
   */
  const malformed: Array<[string, string]> = [
    ['empty file', ''],
    ['whitespace only', '   \n\t '],
    ['unclosed object', '{'],
    ['unclosed after a member', '{"id":"a"'],
    ['trailing comma', '{"id":"a",}'],
    ['leading comma', '{,"id":"a"}'],
    ['missing colon', '{"id" "a"}'],
    ['unquoted member name', '{id:"a"}'],
    ['trailing bytes', '{"id":"a"} trailing'],
    ['two documents', '{"id":"a"}{"id":"b"}'],
    ['byte-order mark', '﻿{"id":"a"}'],
    ['an escaped closing quote swallowing the document', '{"events":[{"a":"\\"}]}'],
    ['a leading-zero number at depth 1', '{"events":01,"id":"x"}'],
    ['a bare word at depth 1', '{"id":truthy}'],
    ['a lone minus at depth 1', '{"durationMs":-}'],
    ['an unterminated string value', '{"id":"a'],
  ];

  for (const [name, text] of malformed) {
    it(`refuses ${name}`, () => {
      const dir = scratch();
      const file = join(dir, 'bad.json');
      writeFileSync(file, text, 'utf8');
      // Whatever the reason, it must be a refusal and never a partial record.
      expect(() => readTraceTopLevelFields(file, SPEC)).toThrow(TraceFieldReadError);
      // And `JSON.parse` agrees that this document is not readable.
      expect(() => JSON.parse(text)).toThrow();
    });
  }

  /** Valid JSON, wrong top level: a trace is an object or it is nothing. */
  const notAnObject: Array<[string, string]> = [
    ['a top-level array', '[{"id":"a"}]'],
    ['a top-level string', '"just a string"'],
    ['a top-level number', '42'],
    ['a top-level literal', 'null'],
  ];

  for (const [name, text] of notAnObject) {
    it(`refuses ${name}`, () => {
      const dir = scratch();
      const file = join(dir, 'shape.json');
      writeFileSync(file, text, 'utf8');
      expect(() => readTraceTopLevelFields(file, SPEC)).toThrow(TRACE_READ_ERRORS.notObject);
      // Unlike the table above, these parse — the refusal is about the shape.
      expect(() => JSON.parse(text)).not.toThrow();
    });
  }

  it('reports every member absent for an empty object, and nothing else', () => {
    const dir = scratch();
    const file = join(dir, 'empty-object.json');
    writeFileSync(file, '{}', 'utf8');
    const read = readTraceTopLevelFields(file, SPEC);
    expect(entries(read.values)).toEqual([]);
    expect(entries(read.shapes)).toEqual([]);
  });

  it('takes the last of duplicate members, as JSON.parse does', () => {
    const dir = scratch();
    const file = join(dir, 'dupes.json');
    writeFileSync(file, '{"id":"first","id":"second","result":"s","result":{}}', 'utf8');
    expectMatchesJsonParse(file);
    const read = readTraceTopLevelFields(file, SPEC);
    expect(read.values['id']).toBe('second');
    expect(read.shapes['result']).toBe('object');
  });

  it('drops an earlier captured value when the duplicate is a container', () => {
    const dir = scratch();
    const file = join(dir, 'dupe-container.json');
    writeFileSync(file, '{"id":"first","id":{"nested":true}}', 'utf8');
    const read = readTraceTopLevelFields(file, SPEC);
    expect(read.values['id']).toBeUndefined();
    expect(read.shapes['id']).toBe('object');
  });

  it('makes __proto__ an own property instead of reaching the prototype setter', () => {
    const dir = scratch();
    const file = join(dir, 'proto.json');
    writeFileSync(file, '{"__proto__":{"polluted":true},"id":"clean"}', 'utf8');
    const read = readTraceTopLevelFields(file, {
      values: ['id', '__proto__'],
      shapes: ['__proto__'],
    });
    expect(read.shapes['__proto__']).toBe('object');
    expect(read.values['id']).toBe('clean');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('reads a member name spelled with unicode escapes the way JSON.parse does', () => {
    const dir = scratch();
    const file = join(dir, 'escaped-key.json');
    writeFileSync(file, '{"\\u0069\\u0064":"escaped","endedAt":"now"}', 'utf8');
    expect(readTraceTopLevelFields(file, SPEC).values['id']).toBe('escaped');
  });

  it('cannot match a member name longer than the key budget', () => {
    const dir = scratch();
    const file = join(dir, 'long-key.json');
    const long = 'k'.repeat(400);
    writeFileSync(file, `{"${long}":"ignored","id":"kept"}`, 'utf8');
    const read = readTraceTopLevelFields(file, { values: ['id', long], shapes: [] });
    expect(read.values['id']).toBe('kept');
    expect(read.values[long]).toBeUndefined();
  });
});

describe('readTraceTopLevelFields — differential fuzz against JSON.parse', () => {
  /**
   * Order- and whitespace-agnosticism, escape handling and prototype parity,
   * over documents no fixture would think to write. Seeded, so a failure is
   * reproducible.
   */
  it('agrees with JSON.parse over 500 seeded documents', () => {
    const dir = scratch();
    const file = join(dir, 'fuzz.json');
    let seed = 0x5eed;
    const rnd = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;

    const names = [
      'id',
      'label',
      'task',
      'startedAt',
      'events',
      'initialTypes',
      'totals',
      'endedAt',
      'durationMs',
      'result',
      'error',
      'cancelled',
      'degraded',
      'x"y',
      '__proto__',
      'constructor',
      'toString',
      'accentué',
      '\\u0069\\u0064',
    ];
    const scalars = [
      '"plain"',
      '"with \\" quote"',
      '"with \\\\ backslash"',
      '"braces { } and brackets [ ]"',
      '"comma , colon : brace }"',
      '"\\u00e9\\u00e8 accents and \\ud83d\\ude80 emoji"',
      `"${'long '.repeat(320)}"`,
      '"café — naïve 🚀"',
      '0',
      '-1',
      '3.5',
      '1e10',
      '-2.5E-3',
      'true',
      'false',
      'null',
    ];
    const containers = [
      '{}',
      '[]',
      '{"nested":{"deep":["a","b"]}}',
      '[1,2,{"k":"v \\" }"}]',
      '{"prose":"looks like a member: \\"id\\": \\"forged\\""}',
    ];
    const spaces = ['', ' ', '  ', '\n', '\r\n', '\t', ' \n\t ', '\n\n  '];

    const spec: TraceFieldSpec = {
      values: ['id', 'endedAt', 'cancelled', 'degraded', 'durationMs', '__proto__'],
      shapes: ['result', 'error', 'events', 'totals', 'task'],
    };

    for (let round = 0; round < 500; round++) {
      const members: string[] = [];
      const count = 1 + Math.floor(rnd() * 8);
      for (let i = 0; i < count; i++) {
        const name = pick(names);
        const value = rnd() < 0.75 ? pick(scalars) : pick(containers);
        members.push(`${pick(spaces)}"${name}"${pick(spaces)}:${pick(spaces)}${value}`);
      }
      const text = `${pick(spaces)}{${members.join(`${pick(spaces)},`)}${pick(spaces)}}${pick(spaces)}`;
      writeFileSync(file, text, 'utf8');
      // Only compare where JSON.parse itself succeeds; the generator is not
      // trying to produce valid documents only.
      let parses = true;
      try {
        JSON.parse(text);
      } catch {
        parses = false;
      }
      if (!parses) {
        expect(() => readTraceTopLevelFields(file, spec)).toThrow(TraceFieldReadError);
        continue;
      }
      try {
        expectMatchesJsonParse(file, spec);
      } catch (error) {
        throw new Error(`round ${round} disagreed for: ${text}\n${String(error)}`);
      }
    }
  });
});

describe('readTraceTopLevelFields — refuses what it must not open', () => {
  it('refuses an absent trace by name', () => {
    const dir = scratch();
    expect(() => readTraceTopLevelFields(join(dir, 'nope.json'), SPEC)).toThrow(
      TRACE_READ_ERRORS.absent
    );
  });

  it('refuses a symlink pointing at a perfectly good trace', () => {
    const dir = scratch();
    const real = join(dir, 'real.json');
    const link = join(dir, 'link.json');
    writeFileSync(real, '{"id":"x","endedAt":"now","result":{}}', 'utf8');
    symlinkSync(real, link);
    expect(() => readTraceTopLevelFields(link, SPEC)).toThrow(TRACE_READ_ERRORS.notRegular);
  });

  it('refuses a directory', () => {
    const dir = scratch();
    const inner = join(dir, 'a-directory.json');
    mkdirSync(inner);
    expect(() => readTraceTopLevelFields(inner, SPEC)).toThrow(TRACE_READ_ERRORS.notRegular);
  });

  it('never leaks a filesystem path into a refusal', () => {
    const dir = scratch();
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{', 'utf8');
    let message = '';
    try {
      readTraceTopLevelFields(file, SPEC);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(TRACE_READ_ERRORS.truncated);
    expect(message).not.toContain(dir);
    for (const value of Object.values(TRACE_READ_ERRORS)) {
      expect(value).not.toMatch(/[/\\]/);
    }
  });

  /**
   * A FIFO must be refused by the `lstat` BEFORE any `openSync`, because
   * `openSync` on a FIFO with no writer blocks forever and a Vitest timeout
   * cannot interrupt a synchronous block. So this case runs in a CHILD with a
   * hard kill: if the ordering ever regresses, the child is reaped and this
   * test fails, instead of hanging the suite.
   */
  it('refuses a FIFO without opening it, proven under a hard kill', () => {
    const dir = scratch();
    const fifo = join(dir, 'fifo.json');
    const made = spawnSync('mkfifo', [fifo], { timeout: 10_000 });
    // No silent skip: on a platform that has `mkfifo`, the case must run.
    if (process.platform === 'win32') return;
    expect(made.status).toBe(0);
    const probe = join(dir, 'probe.ts');
    writeFileSync(
      probe,
      [
        `import { readTraceTopLevelFields } from ${JSON.stringify(
          join(process.cwd(), 'src', 'contracts', 'traceFields.ts')
        )};`,
        'try {',
        `  readTraceTopLevelFields(${JSON.stringify(fifo)}, { values: ['id'], shapes: [] });`,
        `  process.stdout.write('OPENED');`,
        '} catch (error) {',
        '  process.stdout.write(error instanceof Error ? error.message : String(error));',
        '}',
      ].join('\n'),
      'utf8'
    );
    const run = spawnSync(join('node_modules', '.bin', 'tsx'), [probe], {
      timeout: 30_000,
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(run.signal).toBeNull();
    expect(run.stdout).toContain(TRACE_READ_ERRORS.notRegular);
  });
});
