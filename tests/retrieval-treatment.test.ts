import { mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { retrievalCampaignSpecSchema, retrievalRegistrationSchema, retrievalCampaignResultSchema } from '../src/contracts/retrievalCampaign.js';
import { formatRunStatsEpilogue } from '../src/contracts/runStats.js';
import { loadRetrievalDataset, questionFor, retrievalDocumentKey, retrievalSha256 } from '../src/cli/retrievalDataset.js';
import { retrievalCampaignPolicy, retrievalSchedule, validateRetrievalRegistration } from '../src/cli/retrievalRegistration.js';
import { retrievalIndexConfig } from '../src/projects/retrievalCorpus.js';
import { DEFAULT_PROJECT_RETRIEVAL_LIMITS } from '../src/contracts/projectRetrieval.js';
import { haystackTestRuntime } from './helpers/haystack.js';
import { runRetrievalCampaign } from '../src/cli/retrievalCampaign.js';
import { pairedRetrievalDecision } from '../src/cli/retrievalComparison.js';
import { retrievalObservations } from '../src/cli/retrievalObservations.js';
import { parseRunLog } from '../src/cli/burnin.js';
import { openDb } from '../src/registry/db.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { resolveProjectRegistryOwner } from '../src/projects/runAuthority.js';
import { ProjectStore } from '../src/projects/store.js';

const repo = resolve(import.meta.dirname, '..');
const dataset = loadRetrievalDataset(join(repo, 'benchmark/retrieval'));
const roots: string[] = [];
function temp() { const root = mkdtempSync(join(tmpdir(), 'atoma-haystack-test-')); roots.push(root); return root; }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function registration() {
  const spec = retrievalCampaignSpecSchema.parse({ version: 1, id: 'bm25-test', purpose: 'Compare the paired development treatment with fixed scoring.',
    kind: 'haystack-development', questionIds: ['northstar-11', 'northstar-12'], repetitions: 1, firstArm: 'atoma',
    models: { l1: 'sub:anthropic:haiku', l2: 'sub:anthropic:sonnet', l3: 'sub:anthropic:opus', frontier: 'sub:anthropic:opus' },
    workerImage: 'sha256:' + '1'.repeat(64), timeoutMs: 30_000, maxWallMs: 300_000,
    stopAfterConsecutiveInfrastructureFailures: 1, thresholds: { trust: 3, promote: 3, demote: 2 },
    treatment: { backend: 'haystack', index: retrievalIndexConfig(), queryLimits: DEFAULT_PROJECT_RETRIEVAL_LIMITS, launch: haystackTestRuntime(temp()) }, decision: { objective: 'paired-full-pass', minimumGain: 0.5, maxElapsedRatio: 1.25, maxPriceEquivalentRatio: 1.25 } });
  return retrievalRegistrationSchema.parse({ version: 1, registeredAt: new Date().toISOString(), spec,
    source: { revision: '1'.repeat(40), sha256: '2'.repeat(64) },
    instrumentsSha256: retrievalSha256(readFileSync(join(dataset.root, 'instruments.lock.json'))),
    runtime: { node: process.version, platform: process.platform, arch: process.arch }, policy: retrievalCampaignPolicy(spec), schedule: retrievalSchedule(spec) });
}
const delivered = { ...parseRunLog('--- spawn failed ---'), outcome: 'delivered' as const, costUsd: 0.1, llmCalls: 1 };

describe('registered Haystack treatment', () => {
  it('keeps archived SQLite registrations readable but refuses a new live execution before acquiring the lease', async () => {
    const historical = validateRetrievalRegistration(JSON.parse(readFileSync(join(repo,
      'benchmark/retrieval-bm25-pilot-2026-09-09/registration-r2.json'), 'utf8')), dataset);
    const acquire = vi.fn();
    await expect(runRetrievalCampaign(historical, dataset, { repo, out: join(temp(), 'historical') }, {
      acquire, verify: () => {}, archiveSource: () => {}, preflight: () => ({}),
    })).rejects.toThrow('historical');
    expect(acquire).not.toHaveBeenCalled();
  });
  it('requires frozen settings and a decision, balances three arms and refuses changed backend settings', () => {
    const r = registration();
    expect(r.schedule.map(e => e.arm)).toEqual(['atoma', 'atoma-haystack', 'frontier-direct', 'frontier-direct', 'atoma-haystack', 'atoma']);
    expect(validateRetrievalRegistration(r, dataset)).toEqual(r);
    expect(retrievalCampaignSpecSchema.safeParse({ ...r.spec, decision: undefined }).success).toBe(false);
    expect(retrievalCampaignSpecSchema.safeParse({ ...r.spec, treatment: undefined }).success).toBe(false);
    const changed = JSON.parse(JSON.stringify(r)); changed.spec.treatment.queryLimits.maxResults = 4;
    expect(() => validateRetrievalRegistration(changed, dataset)).toThrow('settings');
    expect(retrievalCampaignSpecSchema.safeParse({ ...r.spec, kind: 'agentic-characterization' }).success).toBe(false);
  });

  it('preserves incomplete pairs and separates observed screening from a production claim', () => {
    const r = registration();
    const rows = r.schedule.map(entry => retrievalCampaignResultSchema.parse({ entry, runId: 'test', startedAt: new Date().toISOString(),
      elapsedMs: 1000, runner: delivered, infrastructureFailure: false, score: { questionId: entry.questionId, full: true, checks: [] },
      full: entry.arm !== 'atoma', tracePath: 'trace.json' }));
    expect(pairedRetrievalDecision(r, rows)).toMatchObject({ completePairs: 2, pairedFullPassDifference: 1, decision: 'advance-to-new-confirmation' });
    expect(pairedRetrievalDecision(r, rows.slice(0, 3))).toMatchObject({ completePairs: 1, decision: 'inconclusive', pairedFullPassDifference: null });
    expect(pairedRetrievalDecision(r, rows.filter(row => row.entry.arm !== 'frontier-direct'))?.decision).toBe('inconclusive');
    rows[2]!.infrastructureFailure = true;
    expect(pairedRetrievalDecision(r, rows)?.decision).toBe('inconclusive');
    rows[2]!.infrastructureFailure = false;
    for (const row of rows) if (row.entry.arm === 'atoma-haystack') row.elapsedMs = 2000;
    expect(pairedRetrievalDecision(r, rows)?.decision).toBe('screen-not-met');
  });

  it('runs identical synthetic tenant paths and exposes the Haystack process protocol only to B in a new process', async () => {
    const r = registration(); const out = join(temp(), 'evidence'); const release = vi.fn();
    const seen: string[] = [];
    const report = await runRetrievalCampaign(r, dataset, { repo, out }, {
      acquire: () => ({ path: join(out, 'test-lease'), release, attachChild: () => {} }), verify: () => {}, archiveSource: () => {}, preflight: () => ({}),
      spawn: async opts => {
        const env = opts.env!; seen.push(env['ATOMA_DB_PATH']!);
        expect(env['ATOMA_TENANT_RUN']).toBe('1'); expect(env['ATOMA_SUBSCRIPTION_TIERS']).toBe('l1,l2,l3');
        expect(env['ATOMA_SKILL_LEARN']).toBe('0'); expect(env['ATOMA_EVENT_SKILLS']).toBe('0');
        const input = { dbPath: env['ATOMA_DB_PATH'], runId: env['ATOMA_RUN_ID'], workspacePath: env['ATOMA_BUILD_WORKSPACE'],
          runsPath: env['ATOMA_RUNS_DIR'], skillsPath: env['ATOMA_SKILLS_DIR'], treatment: env['ATOMA_HAYSTACK_CONFIG'] !== undefined, launch: env['ATOMA_HAYSTACK_CONFIG'] ? JSON.parse(env['ATOMA_HAYSTACK_CONFIG']) : null };
        const script = String.raw`
          import { readFileSync } from 'node:fs'; import assert from 'node:assert/strict';
          import { openProjectRunRetrievalAuthority } from './src/projects/retrievalLaunch.ts';
          import { openProjectRunHaystack } from './src/projects/retrievalHaystackLaunch.ts';
          import { resolveProjectRegistryOwner } from './src/projects/runAuthority.ts';
          import { createProjectRetrievalTool } from './src/tools/projectRetrieval.ts';
          const input = JSON.parse(readFileSync(0, 'utf8')); const owner = resolveProjectRegistryOwner(input);
          assert.equal(owner.kind, 'project');
          if (input.treatment) {
            const prepared = openProjectRunHaystack(input, input.launch);
            await prepared.prepare({ signal: new AbortController().signal, deadlineAt: Date.now() + 10000 });
            const tool = createProjectRetrievalTool(prepared.binding, { signal: new AbortController().signal, deadlineAt: Date.now() + 10000 });
            const result = await tool.execute({ query: 'annual price' }); assert.equal(result.ok, true); assert.ok(result.passages.length > 0);
            process.stdout.write(JSON.stringify(result)); await tool.close();
          } else { assert.throws(() => openProjectRunRetrievalAuthority(input)); process.stdout.write('null'); }
        `;
        const response = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
          cwd: repo, input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000,
        }));
        const db = openDb(input.dbPath!); const registry = new AtomRegistry(db, resolveProjectRegistryOwner(input as Parameters<typeof resolveProjectRegistryOwner>[0]));
        expect(registry.listByTier(1)).toEqual([]);
        registry.create(1, { description: 'Within-run learning', systemPrompt: 'Private trial', tools: [], params: {}, createdBy: 'trial' }); db.close();
        const seed = opts.extraArgs![opts.extraArgs!.indexOf('--seed') + 1]!;
        cpSync(seed, input.workspacePath!, { recursive: true });
        const inventory = JSON.parse(readFileSync(join(seed, 'CORPUS.json'), 'utf8'));
        const questionId = /questionId: "([^"]+)"/.exec(opts.goal)![1]!;
        writeFileSync(join(input.workspacePath!, 'retrieval-answer.json'), JSON.stringify({ ...inventory, documents: undefined,
          questionId, status: 'not_found', facts: [] }));
        writeFileSync(join(input.runsPath!, `${input.runId}.json`), JSON.stringify({ id: input.runId, endedAt: new Date().toISOString(),
          events: response ? [{ kind: 'tool', name: 'search_project_docs', result: response, durationMs: 1 }] : [] }));
        return formatRunStatsEpilogue(delivered);
      },
    });
    expect(report).toMatchObject({ attempted: 6, reason: 'completed' });
    expect(report.arms.every(arm => arm.full === 2)).toBe(true);
    expect(new Set(seen).size).toBe(6); expect(release).toHaveBeenCalledOnce();
    for (const entry of r.schedule) {
      const attempt = join(out, 'attempts', `${String(entry.ordinal).padStart(4, '0')}-${entry.arm}-${entry.questionId}`);
      const before = new Database(join(attempt, 'start.db'), { readonly: true });
      expect(before.prepare('SELECT COUNT(*) AS n FROM atom_types').get()).toEqual({ n: 0 }); before.close();
      const after = new Database(join(attempt, 'end.db'), { readonly: true });
      expect(after.prepare('SELECT COUNT(*) AS n FROM atom_types').get()).toEqual({ n: 1 }); after.close();
      const preparation = JSON.parse(readFileSync(join(attempt, 'preparation.json'), 'utf8'));
      expect(preparation.backend).toBe(entry.arm === 'atoma-haystack' ? 'haystack' : null);
      expect(preparation.sourceBytes).toBeGreaterThan(0);
      const result = JSON.parse(readFileSync(join(attempt, 'result.json'), 'utf8'));
      const observations = retrievalObservations(join(out, result.tracePath), dataset, questionFor(dataset, 'northstar-01'));
      expect(observations).toMatchObject(entry.arm === 'atoma-haystack' ?
        { calls: 1, failures: 0, invalidSourcePassages: 0, coveredFacts: 1, coverageDisposition: 'evidence-covered' } :
        { calls: 0, coverageDisposition: 'not-invoked' });
    }
  });

  it('separates returned evidence from failed queries, truncated spans and forged source bytes', () => {
    const root = temp(); const path = join(root, 'trace.json');
    const question = questionFor(dataset, 'northstar-01'); const evidence = question.expected[0]!.evidence[0]!;
    const bytes = dataset.documents.get(retrievalDocumentKey(question.snapshotId, evidence.path))!;
    const passage = (start: number, end: number) => {
      const excerpt = bytes.subarray(start, end).toString('utf8');
      const startLine = bytes.subarray(0, start).toString('utf8').split('\n').length;
      return { documentId: '1'.repeat(64), path: evidence.path, sha256: evidence.sha256,
        startByte: start, endByte: end, startLine,
        endLine: startLine + excerpt.split('\n').length - (excerpt.endsWith('\n') ? 2 : 1), headingContext: [], excerpt };
    };
    const response = (passages: ReturnType<typeof passage>[]) => ({ ok: true, status: 'ok', corpusId: 'fixture',
      snapshotId: 'fixture', snapshotSha256: '2'.repeat(64), generation: '3'.repeat(64), passages, truncated: false });
    const observe = (results: unknown[]) => {
      writeFileSync(path, JSON.stringify({ events: results.map(result => ({ kind: 'tool', name: 'search_project_docs', result, durationMs: 1 })) }));
      return retrievalObservations(path, dataset, question);
    };
    expect(observe([{ ok: false, status: 'unavailable' }])).toMatchObject({ failures: 1, coverageDisposition: 'no-successful-query' });
    const middle = evidence.startByte + 12;
    expect(observe([response([passage(evidence.startByte, middle)])])).toMatchObject({ coveredFacts: 0, coverageDisposition: 'evidence-not-covered' });
    expect(observe([response([passage(evidence.startByte, middle), passage(middle, evidence.endByte)])])).toMatchObject({ coveredFacts: 1 });
    const forged = passage(evidence.startByte, evidence.endByte); forged.excerpt = forged.excerpt.replace('19000', '99000');
    expect(observe([response([forged])])).toMatchObject({ invalidSourcePassages: 1, coveredFacts: 0, coverageDisposition: 'invalid-source' });
    expect(retrievalObservations(join(root, 'missing.json'), dataset, question)).toBeNull();
  });

  it.each(['failed', 'cancelled', 'error', 'missing'] as const)('persists %s outcomes through the real project completion path', async outcome => {
    const r = registration(); const out = join(temp(), 'evidence'); const release = vi.fn();
    const report = await runRetrievalCampaign(r, dataset, { repo, out }, {
      acquire: () => ({ path: join(out, 'test-lease'), release, attachChild: () => {} }),
      verify: () => {}, archiveSource: () => {}, preflight: () => ({}),
      spawn: async opts => {
        const env = opts.env!;
        writeFileSync(join(env['ATOMA_RUNS_DIR']!, `${env['ATOMA_RUN_ID']}.json`), JSON.stringify({
          id: env['ATOMA_RUN_ID'], endedAt: new Date().toISOString(), events: [],
        }));
        return outcome === 'missing' ? 'crashed before epilogue' : formatRunStatsEpilogue({ ...delivered, outcome });
      },
    });
    const infra = outcome === 'error' || outcome === 'missing';
    expect(report).toMatchObject({ attempted: infra ? 1 : 6, reason: infra ? 'infrastructure-stop' : 'completed' });
    expect(report.arms.every(arm => arm.full === 0)).toBe(true);
    const first = join(out, 'attempts/0001-atoma-northstar-11');
    const start = JSON.parse(readFileSync(join(first, 'start.json'), 'utf8'));
    const db = new Database(join(first, 'end.db'), { readonly: true });
    expect(db.prepare('SELECT status FROM project_runs WHERE project_run_id = ?').get(start.runId)).toEqual({ status: outcome === 'cancelled' ? 'cancelled' : 'failed' });
    db.close(); expect(release).toHaveBeenCalledOnce();
  });

  it('preserves the stopped attempt and accounting even if host completion persistence fails', async () => {
    const r = registration(); const out = join(temp(), 'evidence'); const release = vi.fn();
    const original = ProjectStore.prototype.transitionProjectRun;
    vi.spyOn(ProjectStore.prototype, 'transitionProjectRun').mockImplementation(function(this: ProjectStore, input) {
      if (input.to === 'failed') throw new Error('completion persistence fault');
      return original.call(this, input);
    });
    await expect(runRetrievalCampaign(r, dataset, { repo, out }, {
      acquire: () => ({ path: join(out, 'test-lease'), release, attachChild: () => {} }),
      verify: () => {}, archiveSource: () => {}, preflight: () => ({}),
      spawn: async () => formatRunStatsEpilogue({ ...delivered, outcome: 'failed' }),
    })).rejects.toThrow('completion persistence fault');
    expect(JSON.parse(readFileSync(join(out, 'aborted.json'), 'utf8'))).toMatchObject({
      reason: 'aborted', attempted: 1, subscriptionPriceEquivalentUsd: 0.1, comparison: { decision: 'inconclusive' },
    });
    expect(readFileSync(join(out, 'results.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(release).toHaveBeenCalledOnce();
  });
});
