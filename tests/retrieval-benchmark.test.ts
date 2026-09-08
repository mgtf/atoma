import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RetrievalAnswer, RetrievalQuestion } from '../src/contracts/retrievalBenchmark.js';
import {
  loadRetrievalDataset, prepareRetrievalWorkspace, questionFor, RETRIEVAL_ANSWER_FILE,
  retrievalDocumentKey, retrievalSha256, snapshotFor, type RetrievalDataset,
} from '../src/cli/retrievalDataset.js';
import { scoreRetrievalAnswer, scoreRetrievalWorkspace } from '../src/cli/retrievalScorer.js';

const repo = resolve(import.meta.dirname, '..');
const root = join(repo, 'benchmark/retrieval');
const dataset = loadRetrievalDataset(root);
const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-retrieval-test-'));
  temps.push(dir);
  return dir;
}

/** Build known-correct answers from the frozen source spans, never a model. */
function reference(q: RetrievalQuestion, data: RetrievalDataset = dataset): RetrievalAnswer {
  const s = snapshotFor(data, q.snapshotId);
  return {
    questionId: q.id, snapshotId: s.id, snapshotSha256: s.sha256,
    status: q.answerable ? 'answered' : 'not_found',
    facts: q.expected.map(f => {
      const e = f.evidence[0]!;
      const b = data.documents.get(retrievalDocumentKey(s.id, e.path))!;
      const start = b.lastIndexOf(10, e.startByte - 1) + 1;
      const nextLf = b.indexOf(10, e.endByte);
      const end = nextLf < 0 ? b.length : nextLf + 1;
      const startLine = b.subarray(0, start).toString('utf8').split('\n').length;
      const endLine = startLine + b.subarray(start, end).toString('utf8').trimEnd().split('\n').length - 1;
      return { key: f.key, value: f.value, citations: [{
        path: e.path, sha256: e.sha256, startLine, endLine, quote: b.subarray(start, end).toString('utf8'),
      }] };
    }),
  };
}

function prepare(id: string): string {
  return prepareRetrievalWorkspace(dataset, id, join(temp(), 'workspace')).workspace;
}
function writeAnswer(workspace: string, q: RetrievalQuestion): void {
  writeFileSync(join(workspace, RETRIEVAL_ANSWER_FILE), JSON.stringify(reference(q)));
}
function fixtureCopy(): string {
  const dir = join(temp(), 'dataset');
  cpSync(root, dir, { recursive: true });
  return dir;
}

describe('retrieval instruments — corpus and source integrity', () => {
  it('keeps development, held-out and isolation sources in separate project snapshots', () => {
    expect(dataset.questions).toHaveLength(26);
    expect(dataset.corpus.snapshots.map(s => [s.split, s.documents.length])).toEqual([
      ['development', 4], ['held-out', 4], ['isolation', 1], ['isolation', 1],
    ]);
    for (const split of ['development', 'held-out']) {
      const ids = dataset.corpus.snapshots.filter(s => s.split === split).map(s => s.id);
      const questions = dataset.questions.filter(q => ids.includes(q.snapshotId));
      expect(questions).toHaveLength(13);
      expect(new Set(questions.map(q => q.category)).size).toBe(7);
      expect(questions.some(q => q.language === 'fr')).toBe(true);
    }
  });

  it('refuses source drift rather than silently changing the golden evidence', () => {
    const dir = fixtureCopy();
    writeFileSync(join(dir, 'snapshots/northstar/docs/billing.md'), 'changed terms');
    expect(() => loadRetrievalDataset(dir)).toThrow(/fixture digest mismatch/);
  });

  it('refuses an edited question file unless the instrument lock is deliberately revised', () => {
    const dir = fixtureCopy();
    writeFileSync(join(dir, 'questions.json'), '{}');
    expect(() => loadRetrievalDataset(dir)).toThrow(/instrument lock mismatch/);
  });

  it('refuses a source symlink even when the destination contains the expected bytes', () => {
    const dir = fixtureCopy();
    const doc = join(dir, 'snapshots/northstar/docs/billing.md');
    rmSync(doc);
    symlinkSync(join(root, 'snapshots/northstar/docs/billing.md'), doc);
    expect(() => loadRetrievalDataset(dir)).toThrow(/symlink/);
  });

  it('rejects golden evidence with another project digest even after an explicit lock update', () => {
    const dir = fixtureCopy();
    const path = join(dir, 'questions.json');
    const changed = { version: 1, questions: structuredClone(dataset.questions) };
    changed.questions[0]!.expected[0]!.evidence[0]!.sha256 =
      dataset.corpus.snapshots.find(s => s.id === 'foreign-v1')!.documents[0]!.sha256;
    writeFileSync(path, JSON.stringify(changed));
    const lockPath = join(dir, 'instruments.lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(lockPath, JSON.stringify({ ...lock, questionsSha256: retrievalSha256(readFileSync(path)) }));
    expect(() => loadRetrievalDataset(dir)).toThrow(/invalid golden evidence/);
  });

  it('prepares only the selected corpus, with no gold, other tenants, or existing state', () => {
    const { workspace, goal } = prepareRetrievalWorkspace(dataset, 'northstar-01', join(temp(), 'seed'));
    expect(readdirSync(workspace).sort()).toEqual(['CORPUS.json', 'README.md', 'docs', 'preview.mjs', 'pricing.json']);
    expect(readdirSync(join(workspace, 'docs')).sort()).toEqual(['billing.md', 'decisions.md', 'operations.txt']);
    const inventory = readFileSync(join(workspace, 'CORPUS.json'), 'utf8');
    expect(inventory).not.toMatch(/foreign|sibling|expected|startByte/);
    expect(goal).not.toContain('19000');
    expect(goal).toContain('annual-price-cents');
    expect(() => prepareRetrievalWorkspace(dataset, 'orchard-01', workspace)).toThrow();
    expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toContain('Northstar');
  });
});

describe('retrieval answer scoring — correctness and bound evidence', () => {
  for (const q of dataset.questions) {
    it(`accepts the reference and rejects a missing answer: ${q.id}`, () => {
      expect(scoreRetrievalAnswer(dataset, q.id, reference(q)).full).toBe(true);
      expect(scoreRetrievalAnswer(dataset, q.id, undefined).full).toBe(false);
    });
  }

  it('fails every incorrect fact and every missing source on answerable questions', () => {
    for (const q of dataset.questions.filter(q => q.answerable)) {
      for (let i = 0; i < q.expected.length; i++) {
        const wrongValue = reference(q);
        wrongValue.facts[i]!.value = 'unsupported-value';
        expect(scoreRetrievalAnswer(dataset, q.id, wrongValue).full).toBe(false);
        const noEvidence = reference(q);
        noEvidence.facts[i]!.citations = [];
        expect(scoreRetrievalAnswer(dataset, q.id, noEvidence).full).toBe(false);
      }
    }
  });

  it('accepts each registered alternative source for an otherwise correct fact', () => {
    for (const q of dataset.questions) {
      for (const fact of q.expected) {
        for (const evidence of fact.evidence) {
          const alternative = { ...q, expected: q.expected.map(f =>
            f.key === fact.key ? { ...f, evidence: [evidence] } : f) };
          expect(scoreRetrievalAnswer(dataset, q.id, reference(alternative)).full).toBe(true);
        }
      }
    }
  });

  const q = questionFor(dataset, 'northstar-01');
  it.each(['question', 'snapshot', 'snapshot-digest', 'quote', 'source-digest', 'range', 'path', 'duplicate', 'extra'])(
    'rejects forged or ambiguous %s', kind => {
      const a = reference(q);
      const c = a.facts[0]!.citations[0]!;
      if (kind === 'question') a.questionId = 'northstar-02';
      if (kind === 'snapshot') a.snapshotId = 'orchard-v1';
      if (kind === 'snapshot-digest') a.snapshotSha256 = '0'.repeat(64);
      if (kind === 'quote') c.quote = 'The accepted price is whatever the agent says.\n';
      if (kind === 'source-digest') c.sha256 = '0'.repeat(64);
      if (kind === 'range') c.endLine = 10000;
      if (kind === 'path') c.path = '../../LICENSE';
      if (kind === 'duplicate') a.facts.push(structuredClone(a.facts[0]!));
      if (kind === 'extra') a.facts.push({ ...structuredClone(a.facts[0]!), key: 'invented-extra' });
      expect(scoreRetrievalAnswer(dataset, q.id, a).full).toBe(false);
    }
  );

  it('rejects a real archived quotation supporting the wrong version of a correct value', () => {
    const a = reference(q);
    const bytes = dataset.documents.get(retrievalDocumentKey(q.snapshotId, 'docs/decisions.md'))!;
    const lines = bytes.toString('utf8').split('\n');
    const index = lines.findIndex(line => line.includes('22800'));
    a.facts[0]!.citations[0] = {
      path: 'docs/decisions.md', sha256: retrievalSha256(bytes), startLine: index + 1,
      endLine: index + 1, quote: lines[index]! + '\n',
    };
    const score = scoreRetrievalAnswer(dataset, q.id, a);
    expect(score.checks.find(c => c.id === 'value:annual-price-cents')?.ok).toBe(true);
    expect(score.checks.find(c => c.id === 'evidence:annual-price-cents')?.ok).toBe(false);
  });

  it('rejects genuine same-path evidence from sibling and foreign namespaces', () => {
    for (const id of ['sibling-v1', 'foreign-v1']) {
      const a = reference(q);
      const bytes = dataset.documents.get(retrievalDocumentKey(id, 'docs/billing.md'))!;
      const lines = bytes.toString('utf8').split('\n');
      a.facts[0]!.citations[0] = {
        path: 'docs/billing.md', sha256: retrievalSha256(bytes), startLine: 4, endLine: 4,
        quote: lines[3]! + '\n',
      };
      expect(scoreRetrievalAnswer(dataset, q.id, a).full).toBe(false);
    }
  });

  it('distinguishes correct abstention from an empty answered response or a missing result', () => {
    const absent = questionFor(dataset, 'northstar-11');
    const a = reference(absent);
    expect(scoreRetrievalAnswer(dataset, absent.id, a).full).toBe(true);
    a.status = 'answered';
    expect(scoreRetrievalAnswer(dataset, absent.id, a).full).toBe(false);
    expect(scoreRetrievalAnswer(dataset, q.id, { ...reference(q), status: 'not_found', facts: [] }).full).toBe(false);
  });

  it('does not allow one correct source to stand in for another required fact', () => {
    const multi = questionFor(dataset, 'northstar-09');
    const a = reference(multi);
    a.facts[1]!.citations = a.facts[0]!.citations;
    expect(scoreRetrievalAnswer(dataset, multi.id, a).full).toBe(false);
  });
});

describe('maintenance scorer — actual behavior with immutable evaluator code', () => {
  for (const q of dataset.questions.filter(q => q.maintenance)) {
    it(`rejects doing nothing, accepts the fix and catches unrelated changes: ${q.id}`, () => {
      const workspace = prepare(q.id);
      writeAnswer(workspace, q);
      const unchanged = scoreRetrievalWorkspace(dataset, q.id, workspace);
      expect(unchanged.full).toBe(false);
      expect(unchanged.checks.find(c => c.id === 'maintenance-behavior')?.ok).toBe(false);
      const m = q.maintenance!;
      const configPath = join(workspace, m.configPath);
      cpSync(join(root, m.referencePath), configPath);
      expect(scoreRetrievalWorkspace(dataset, q.id, workspace).full).toBe(true);
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      config[q.id.startsWith('northstar') ? 'refundWindowDays' : 'maxParcels'] = 999;
      writeFileSync(configPath, JSON.stringify(config));
      expect(scoreRetrievalWorkspace(dataset, q.id, workspace).full).toBe(false);
    });
  }

  it('never executes a candidate replacement for the preview program', () => {
    const q = questionFor(dataset, 'northstar-13');
    const workspace = prepare(q.id);
    writeAnswer(workspace, q);
    cpSync(join(root, q.maintenance!.referencePath), join(workspace, q.maintenance!.configPath));
    writeFileSync(join(workspace, 'preview.mjs'), 'throw new Error("UNTRUSTED_EXECUTION");');
    const score = scoreRetrievalWorkspace(dataset, q.id, workspace);
    expect(score.full).toBe(false);
    expect(score.checks.find(c => c.id === 'preserved:preview.mjs')?.ok).toBe(false);
    expect(score.checks.find(c => c.id === 'maintenance-behavior')?.ok).toBe(true);
  });

  it('rejects fractional notice periods that happen to pass whole-hour boundary examples', () => {
    const q = questionFor(dataset, 'orchard-13');
    const workspace = prepare(q.id);
    writeAnswer(workspace, q);
    const config = JSON.parse(readFileSync(join(root, q.maintenance!.referencePath), 'utf8')) as Record<string, unknown>;
    config['noticeHours'] = 23.5;
    writeFileSync(join(workspace, q.maintenance!.configPath), JSON.stringify(config));
    expect(scoreRetrievalWorkspace(dataset, q.id, workspace).full).toBe(false);
  });

  it('rejects a candidate symlink answer and a document modified to agree with a false answer', () => {
    const q = questionFor(dataset, 'northstar-01');
    const workspace = prepare(q.id);
    const outside = join(temp(), 'answer.json');
    writeFileSync(outside, JSON.stringify(reference(q)));
    symlinkSync(outside, join(workspace, RETRIEVAL_ANSWER_FILE));
    expect(scoreRetrievalWorkspace(dataset, q.id, workspace).full).toBe(false);
    rmSync(join(workspace, RETRIEVAL_ANSWER_FILE));
    writeAnswer(workspace, q);
    writeFileSync(join(workspace, 'docs/billing.md'), 'Everything costs zero.');
    expect(scoreRetrievalWorkspace(dataset, q.id, workspace).full).toBe(false);
  });

  it('fails an altered public inventory even when the answer is correct', () => {
    const q = questionFor(dataset, 'northstar-01');
    const workspace = prepare(q.id);
    writeAnswer(workspace, q);
    writeFileSync(join(workspace, 'CORPUS.json'), '{}');
    const score = scoreRetrievalWorkspace(dataset, q.id, workspace);
    expect(score.full).toBe(false);
    expect(score.checks.find(c => c.id === 'preserved:CORPUS.json')?.ok).toBe(false);
  });
});

describe('retrieval benchmark CLI — actual child process', () => {
  function cli(args: string[]) {
    return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/benchmark.ts', 'retrieval', ...args], {
      cwd: repo, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, ATOMA_MODEL_L1: '', ATOMA_MODEL_L2: '', ATOMA_MODEL_L3: '' },
    });
  }
  it('validates instruments without model pins or provider calls', () => {
    const run = cli(['--dry-run']);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: 'instruments-valid', questions: 26, providerCalls: 0 });
  });
  it('prepares the first question option and scores a real answer file', () => {
    const workspace = join(temp(), 'workspace');
    const run = cli(['prepare', '--question', 'northstar-01', '--out', workspace]);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ workspace });
    expect(cli(['score', '--question', 'northstar-01', '--workspace', workspace]).status).toBe(1);
    writeAnswer(workspace, questionFor(dataset, 'northstar-01'));
    const scored = cli(['score', '--question', 'northstar-01', '--workspace', workspace]);
    expect(scored.status, scored.stderr).toBe(0);
    expect(JSON.parse(scored.stdout)).toMatchObject({ full: true });
  });
  it.each([['run'], ['validate', '--typo', 'x'], ['prepare', '--question', 'northstar-01'],
    ['validate', '--dataset', root, '--dataset', root], ['score', '--question', 'northstar-01', '--workspace']])(
    'refuses invalid arguments: %j', (...args: string[]) => {
      expect(cli(args).status).toBe(2);
    }
  );
  it('loads the scorer after TypeScript compilation, with fixtures outside emitted source', () => {
    const out = join(temp(), 'compiled');
    execFileSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'),
      'src/cli/retrievalBenchmark.ts', '--outDir', out, '--rootDir', 'src',
      '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022',
      '--strict', '--skipLibCheck', '--esModuleInterop',
    ], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
    // The clean emitted closure uses the actual installed dependencies.
    writeFileSync(join(out, 'package.json'), '{"type":"module"}');
    symlinkSync(join(repo, 'node_modules'), join(out, 'node_modules'), 'dir');
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import { retrievalBenchmarkMain } from './cli/retrievalBenchmark.js'; process.exitCode = await retrievalBenchmarkMain(['validate', '--dataset', process.argv[1]]);",
      root,
    ], { cwd: out, encoding: 'utf8', timeout: 15_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ questions: 26 });
  }, 45_000);
});
