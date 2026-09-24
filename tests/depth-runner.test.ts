import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTierClients } from '../src/run/providers.js';
import { startTask, resetHostLifecycleSnapshotForTests } from '../src/run/runner.js';
import { buildProfile } from '../src/run/profiles/build.js';
import { parseRunLog } from '../src/cli/burnin.js';
import { baseExecutorOf } from '../src/core/attestation.js';
import { ensureCanonicalFullStack } from '../src/atoms/capability.js';
import { SKILL_PREFILTER_SYSTEM_PROMPT } from '../src/atoms/cost.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { closeStoreHandles } from '../src/core/stores.js';
import type { AtomRegistry } from '../src/registry/atomRegistry.js';
import type { LlmCompletionRequest, ToolExecutor } from '../src/core/types.js';
import type { VizRun } from '../src/viz/trace.js';
import { makePlan } from './helpers/factories.js';
import { forceKillTestProcessTree } from './helpers.js';
import { OLLAMA_PINS } from './tier-pins.js';

vi.mock('../src/run/providers.js', async (original) => ({
  ...await original<typeof import('../src/run/providers.js')>(), buildTierClients: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetHostLifecycleSnapshotForTests(); });

describe('runner supervision depth, concrete L3/L2/L1 and real backend', () => {
  it.each<{ mode: string; matched: boolean; rootApproved: boolean; deadline?: boolean }>([
    { mode: 'short', matched: false, rootApproved: true, deadline: true },
    { mode: 'short', matched: false, rootApproved: false, deadline: true },
    { mode: 'default', matched: false, rootApproved: false }, { mode: 'default', matched: true, rootApproved: false },
    { mode: 'default', matched: false, rootApproved: true },
    { mode: 'short', matched: false, rootApproved: false }, { mode: 'deep', matched: false, rootApproved: false },
    { mode: 'short', matched: true, rootApproved: false }, { mode: 'deep', matched: true, rootApproved: false },
  ])('keeps phase trust and learning/credit with $mode supervision (matched=$matched, rootApproved=$rootApproved)', async ({ mode, matched, rootApproved, deadline }) => {
    const unfinishedDescription = 'Write unfinished.txt. ' + 'Verify restart persistence and concurrent writes. '.repeat(100);
    const root = mkdtempSync(join(tmpdir(), 'atoma-depth-credit-'));
    const runs = join(root, 'runs');
    const skillRoot = join(root, 'skills');
    for (const [key, value] of Object.entries({ ...OLLAMA_PINS,
      // One store for the run's handle and the test's handle-less registry
      // (W4: skill trust is rows in the store the ledger resolves).
      ATOMA_DB_PATH: join(root, 'store.db'), ATOMA_LEDGER_DB: join(root, 'store.db'), ATOMA_SKILLS_DIR: skillRoot, ATOMA_RUNS_DIR: runs,
      ATOMA_BUILD_WORKSPACE: join(root, 'workspace'), ATOMA_BUILD_TIMEOUT_MS: deadline ? '600000' : '60000',
      ATOMA_CONTAINER: '0', ATOMA_REQUIRE_ISOLATION: '0', ATOMA_PREFILTER_CACHE: '0',
      ATOMA_SKILL_LEARN: '1', ATOMA_SKILL_PROMOTE: '0', ATOMA_SKILL_DIRECT: '1',
    })) vi.stubEnv(key, value);
    resetHostLifecycleSnapshotForTests();
    const deadlineController = new AbortController();
    if (deadline) {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 600000 ? deadlineController.signal : timeout(ms));
    }
    let executions = 0;
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => logs.push(parts.map(String).join(' ')));
    }
    const skills = new SkillRegistry(skillRoot);
    const recipe = { id: 'write-server-entry-file', description: 'Write a Node entry file',
      whenToUse: 'When asked to create a Node server entry file', kind: 'llm' as const,
      body: 'Write server.js with the requested handler, then read it back.' };
    let registry: AtomRegistry;
    let leafName = '';
    let leafId = '';
    let cellName = '';
    const calls: LlmCompletionRequest[] = [];
    vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async (req) => {
      calls.push(req);
      let reply: unknown;
      if (req.role === 'prefilter' && req.systemPrompt === SKILL_PREFILTER_SYSTEM_PROMPT) reply = {
        kind: 'reuse', target: recipe.id, confidence: 'high', reasoning: 'Match the recipe' };
      else if (req.role === 'prefilter') reply = { kind: 'reuse', target: req.actor?.tier === 3 ? cellName : leafName,
        confidence: deadline ? 'low' : 'high', reasoning: 'Reuse the canonical executor' };
      else if (req.role === 'validate-plan') reply = { approved: true, reasoning: 'Plan approved' };
      else if (req.role === 'validate-result') {
        if (req.actor?.name === 'run-root') {
          // Credits and distillation must already be durable BEFORE root rejection.
          expect(registry.getByName(leafName)!.successes).toBe(1);
          expect(skills.loadFor(leafId)).toHaveLength(1);
          if (matched) expect(skills.loadFor(leafId)[0]!.successes).toBe(1);
          reply = { approved: rootApproved, reasoning: rootApproved ? 'Reviewed delivery accepted' : 'Required route behavior is unverified' };
        } else reply = { approved: true, reasoning: 'Server phase approved', activeSkillFollowed: true };
      } else if (req.role === 'plan' && req.actor?.tier !== 1) reply = [
        { strategy: 'reuse', target: req.actor?.tier === 3 ? cellName : leafName, reasoning: 'One server phase' },
        makePlan({ subtasks: [{ description: 'Write server.js', outputs: ['server.js'] }, ...(deadline ? [{ description: unfinishedDescription, outputs: ['unfinished.txt'] }] : [])], aggregation: { mode: 'sequential' } }),
      ];
      else if (req.role === 'plan') reply = { reasoning: 'Write the server', proposedAction: 'Write server.js', expectedOutput: 'Server on disk' };
      else if (req.role === 'execute') {
        if (deadline && ++executions === 2) {
          deadlineController.abort(new DOMException('Execution deadline', 'TimeoutError'));
          req.signal!.throwIfAborted();
        }
        const args = { path: 'server.js', content: 'module.exports = { ready: true };' };
        const startedAt = Date.now();
        const value = await req.executor!.execute('write_file', args);
        req.onToolInvocation?.({ name: 'write_file', args, result: value, startedAt, durationMs: Date.now() - startedAt });
        reply = { output: { files: ['server.js'] }, summary: 'Server written' };
      } else if (req.role === 'skill') reply = recipe;
      else throw new Error(`Unexpected request: ${req.role}`);
      return { text: JSON.stringify(reply), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
    } } });
    let handle: Awaited<ReturnType<typeof startTask>> | undefined;
    try {
      handle = await startTask({ ...buildProfile, seedCatalog(seed) {
        buildProfile.seedCatalog(seed);
        registry = seed.registry;
        const leaf = ensureCanonicalFullStack(seed.registry, seed.toolDecls, 1)!;
        leafName = leaf.name; leafId = leaf.atomId;
        cellName = ensureCanonicalFullStack(seed.registry, seed.toolDecls, 2)!.name;
        if (matched) skills.save(leafId, recipe);
      } }, [...(mode === 'default' ? [] : ['--depth', mode]), '--clean-workspace', 'Build a page backed by server.js']);
      // A refused delivery LANDS since 2026-09-24: the run kept every byte it
      // wrote and seeds the next run, so the outcome is `partial`, not
      // `failed`. What this test is about is unchanged and is asserted below —
      // phase trust and skill credit survive a root refusal, because the root
      // judges the DELIVERY and never the method.
      expect(await handle.settled).toEqual({ outcome: rootApproved && !deadline ? 'delivered' : 'partial' });
      const path = readdirSync(runs).find((name) => name.endsWith('.json') && name !== 'index.json')!;
      const trace = JSON.parse(readFileSync(join(runs, path), 'utf8')) as VizRun;
      if (deadline) {
        expect(deadlineController.signal.aborted).toBe(true);
        expect(trace.result?.unfinishedPhases).toEqual([unfinishedDescription]);
        const stats = parseRunLog(logs.join('\n'));
        expect(stats.outcome).toBe('partial');
        expect(stats.landingReasons?.[0]).toContain('[truncated]');
        expect(stats.landingReasons?.[0]!.length).toBeLessThanOrEqual(2000);
        if (!rootApproved) expect(stats.landingReasons).toHaveLength(2);
        expect(existsSync(join(root, 'workspace', 'server.js'))).toBe(true);
      }
      expect(trace.events.filter((event) => event.kind === 'topology')).toMatchObject([
        { mode: mode === 'default' ? 'short' : mode, attempt: 1 },
      ]);
      if (mode !== 'deep') expect(calls.some((req) => req.actor?.tier === 3 && req.actor.name !== 'run-root')).toBe(false);
      expect(trace.events.filter((event) => event.kind === 'acceptance'), trace.error).toMatchObject([
        { approved: rootApproved, floorCoverage: [], phaseCoverage: [{ obligations: [] }] },
      ]);
      expect(calls.filter((req) => req.actor?.name === 'run-root')).toHaveLength(1);
      expect(calls.some((req) => req.role === 'skill')).toBe(!matched);
      expect(parseRunLog(logs.join('\n'))).toMatchObject({ uncoveredObligations: 0, deepenings: 0 });
      expect(trace.events.some((event) => event.kind === 'skill' && event.op === 'credit-withheld')).toBe(false);
      expect(skills.loadFor(leafId)).toHaveLength(1);
    } finally {
      await handle?.shutdown();
      // The test's registry holds the cached handle on the store (W4);
      // Windows will not remove a directory holding an open database file.
      closeStoreHandles();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('reaps the abandoned server, archives its files, recreates tools, and accounts for both attempts in one failed run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-depth-runner-'));
    const workspace = join(root, 'workspace');
    const runs = join(root, 'runs');
    for (const [key, value] of Object.entries({ ...OLLAMA_PINS,
      ATOMA_DB_PATH: join(root, 'store.db'), ATOMA_SKILLS_DIR: join(root, 'skills'), ATOMA_RUNS_DIR: runs,
      ATOMA_BUILD_WORKSPACE: workspace, ATOMA_BUILD_TIMEOUT_MS: '60000', ATOMA_CONTAINER: '0',
      ATOMA_REQUIRE_ISOLATION: '0', ATOMA_PREFILTER_CACHE: '0',
    })) vi.stubEnv(key, value);
    resetHostLifecycleSnapshotForTests();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => logs.push(parts.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => logs.push(parts.map(String).join(' ')));
    const calls: LlmCompletionRequest[] = [];
    let originalTools: ToolExecutor | undefined;
    let serverPid: number | undefined;
    let enteredDeep = false;
    let provedFreshBackend = false;
    const perform = async (req: LlmCompletionRequest, name: string, args: Record<string, unknown>) => {
      const startedAt = Date.now();
      const value = await req.executor!.execute(name, args);
      req.onToolInvocation?.({ name, args, result: value, startedAt, durationMs: Date.now() - startedAt });
      return value;
    };
    vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async (req) => {
      calls.push(req);
      let reply: unknown;
      const role = req.role;
      if (req.actor?.tier === 3 && req.actor.name !== 'run-root' && !enteredDeep) {
        enteredDeep = true;
        expect(existsSync(join(workspace, 'abandoned.txt'))).toBe(false);
        expect(readdirSync(root).some((name) => name.startsWith('workspace.prev'))).toBe(true);
        expect(() => process.kill(serverPid!, 0)).toThrow();
      }
      if (role === 'prefilter') reply = { outcome: 'escalate', reasoning: 'Exercise decomposition' };
      else if (role === 'validate-plan') reply = { approved: true, reasoning: 'Plan approved' };
      else if (role === 'validate-result') reply = { approved: false, reasoning: 'Fixture rejects output', scope: 'ephemeral', modifications: {} };
      else if (role === 'plan' && req.actor?.tier !== 1) reply = [
        { strategy: 'create', reasoning: 'One phase' },
        makePlan({ subtasks: [{ description: 'Write index.html', outputs: ['index.html'] }], aggregation: { mode: 'sequential' } }),
      ];
      else if (role === 'plan' || role === 'fallback-plan') reply = { reasoning: 'Write the page', proposedAction: 'Write index.html and report it', expectedOutput: 'Page on disk' };
      else if (role === 'execute' || role === 'fallback-execute') {
        expect(req.executor).toBeDefined();
        if (!enteredDeep) expect(req.actor?.tier).toBe(1);
        if (!originalTools) {
          originalTools = baseExecutorOf(req.executor!);
          await perform(req, 'write_file', { path: 'abandoned.txt', content: 'Evidence from attempt one' });
          await perform(req, 'write_file', { path: 'server.cjs', content: "const http=require('node:http');process.on('SIGTERM',()=>{});const s=http.createServer((q,r)=>r.end('old'));s.listen(0,'127.0.0.1',()=>console.log('LISTENING_ON_PORT='+s.address().port));" });
          const started = await perform(req, 'start_node_server', { entry: 'server.cjs' }) as { pid: number };
          serverPid = started.pid;
        } else if (enteredDeep) {
          expect(baseExecutorOf(req.executor!)).not.toBe(originalTools);
          provedFreshBackend = true;
        }
        await perform(req, 'write_file', { path: 'index.html', content: '<button>Fixture page</button>' });
        reply = { output: { files: ['index.html'] }, summary: 'Page written' };
      } else throw new Error(`Unexpected mock request: ${role}`);
      return { text: JSON.stringify(reply), stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 }, servedModel: 'claude-haiku-4-5-20251001' };
    } } });
    let handle: Awaited<ReturnType<typeof startTask>> | undefined;
    try {
      handle = await startTask(buildProfile, ['--clean-workspace', '--no-learn-skills', '--no-direct-skills', 'Build index.html']);
      // `partial` since 2026-09-24: this run deepened, was refused at delivery,
      // and its second attempt's workspace holds real files. What the test is
      // about is below and unchanged — the abandoned server is reaped, the
      // first attempt's workspace is archived, tools are recreated, and BOTH
      // attempts are accounted for in one run.
      expect(await handle.settled).toEqual({ outcome: 'partial' });
      const files = readdirSync(runs).filter((name) => name.endsWith('.json') && name !== 'index.json');
      expect(files).toHaveLength(1);
      const trace = JSON.parse(readFileSync(join(runs, files[0]!), 'utf8')) as VizRun;
      expect(trace.events.filter((event) => event.kind === 'topology'), trace.error).toMatchObject([
        { mode: 'short', attempt: 1 }, { at: 'deepening', mode: 'deep', attempt: 2 },
      ]);
      expect(trace.events.filter((event) => event.kind === 'acceptance')).toMatchObject([
        { approved: false, attempt: 2, executor: { tier: 3, viaFallback: true }, basis: 'validation-call' },
      ]);
      expect(trace.events.filter((event) => event.kind === 'llm').every((event) => event.attempt === 1 || event.attempt === 2)).toBe(true);
      expect(provedFreshBackend).toBe(true);
      expect(calls.some((req) => req.role === 'fallback-execute' && req.actor?.tier === 2)).toBe(true);
      expect(calls.filter((req) => req.actor?.name === 'run-root')).toHaveLength(1);
      expect(calls.find((req) => req.actor?.name === 'run-root')!.userContent).toContain('DIRECT — the child IS the executor');
      expect(trace.totals!.calls).toBe(calls.length);
      const stats = parseRunLog(logs.join('\n'));
      expect(stats).toMatchObject({ outcome: 'partial', deepenings: 1, llmCalls: calls.length });
      expect(stats.costUsd).toBeGreaterThan(0);
      expect(stats.costUsd).toBeCloseTo(trace.totals!.costUsd, 4);
    } finally {
      await handle?.shutdown();
      forceKillTestProcessTree(serverPid);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});
