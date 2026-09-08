// Compiled coordinator -> real spawnRun -> child receipt -> L1 -> host search.
// Default is a quota-free host smoke. --container also exercises the real worker image.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { AuthStore } from '../dist/auth/store.js';
import { ProjectStore } from '../dist/projects/store.js';
import { ProjectRunCoordinator, projectRunHostLayout } from '../dist/projects/coordinator.js';
import { buildArtifactManifest } from '../dist/projects/artifacts.js';
import { closeStoreHandles } from '../dist/core/stores.js';
import { ProjectRetrievalLaunchStore, openProjectRunRetrieval } from '../dist/projects/retrievalLaunch.js';
import { parseRunLog, spawnRun } from '../dist/cli/burnin.js';
import { L1Atom } from '../dist/atoms/L1Atom.js';
import { AnthropicLlmClient } from '../dist/core/llm.js';
import { DEFAULT_LIMITS } from '../dist/core/limits.js';
import { containerToolBackend, localToolBackend, withProjectRetrievalBackend } from '../dist/run/toolBackend.js';
import { createProjectRetrievalTool } from '../dist/tools/projectRetrieval.js';
import { startTask } from '../dist/run/runner.js';
import { buildProfile } from '../dist/run/profiles/build.js';
import { runHostSupported } from '../dist/run/platform.js';

const SOURCE = '# Pricing\r\nPrivate annual price: 190 euros.\r\n';
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const SEARCH = 'search_project_docs';

if (process.argv.includes('--child')) {
  const env = process.env;
  // The real compiled runner must refuse a forged path before constructing providers/workers.
  const workspace = env.ATOMA_BUILD_WORKSPACE;
  env.ATOMA_BUILD_WORKSPACE = workspace + '-wrong';
  await assert.rejects(startTask(buildProfile, ['--container', '--no-promote-skills', '--no-direct-skills', 'Read docs.']), /unavailable or denied/);
  env.ATOMA_BUILD_WORKSPACE = workspace;
  const binding = openProjectRunRetrieval({ dbPath: env.ATOMA_DB_PATH, runId: env.ATOMA_RUN_ID,
    workspacePath: workspace, skillsPath: env.ATOMA_SKILLS_DIR, runsPath: env.ATOMA_RUNS_DIR });
  const run = { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 };
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'probe.txt'), 'workspace fixture');
  const realContainer = env.ATOMA_RETRIEVAL_SMOKE_CONTAINER === '1';
  const base = realContainer ? await containerToolBackend({ workspaceRoot: workspace, egress: false }) : localToolBackend({ workspaceRoot: workspace, logger });
  assert.equal(base.executor.has(SEARCH), false);
  const backend = await withProjectRetrievalBackend(base, binding, run);
  const received = [];
  let calls = 0;
  const sdk = { messages: { create: async request => {
    const content = request.messages.at(-1).content;
    if (Array.isArray(content)) received.push(...content.filter(part => part.type === 'tool_result').map(part => JSON.parse(part.content)));
    calls++;
    if (calls === 1) return {
      // One tool round fits the real L1 deadline cap. Both calls still traverse production dispatch.
      content: [
        { type: 'tool_use', id: 'search', name: SEARCH, input: { query: 'annual price' } },
        realContainer ? { type: 'tool_use', id: 'worker', name: 'run_shell', input: { command: 'node', args: ['-e',
          'console.log(JSON.stringify({source:require("node:fs").existsSync(process.argv[1]),db:process.env.ATOMA_DB_PATH??null,retrieval:process.env.ATOMA_PROJECT_RETRIEVAL??null}))',
          join(dirname(workspace), 'retrieval-source/docs.md')] } } :
          { type: 'tool_use', id: 'worker', name: 'read_file', input: { path: 'probe.txt' } },
      ], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
    };
    return { content: [{ type: 'text', text: '{"output":"190 euros","summary":"Source consulted."}' }],
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
  } } };
  const llm = new AnthropicLlmClient(sdk);
  const atom = new L1Atom({ name: 'Ammonia', ordinal: 3, model: 'test', systemPrompt: 'Consult source data.', tools: backend.toolDecls, params: {} });
  try {
    const result = await atom.execute({ description: 'Find the annual price.' },
      { reasoning: 'Read original evidence', subtasks: [], aggregation: { mode: 'concat' }, expectedOutput: 'Cited price' },
      { ...run, limits: DEFAULT_LIMITS, logger, llm, tools: backend.executor });
    assert.equal(received[0].passages[0].excerpt, SOURCE);
    assert.deepEqual(result.toolCallResults, [{ name: SEARCH, ok: true }, { name: realContainer ? 'run_shell' : 'read_file', ok: true }]);
    if (realContainer) {
      assert.ok(received[1], JSON.stringify({ result, received }));
      assert.deepEqual(JSON.parse(received[1].stdout), { source: false, db: null, retrieval: null });
    }
    console.log('ATOMA_RETRIEVAL_SMOKE_READY');
    const tool = createProjectRetrievalTool(binding, run);
    try {
      let after;
      for (let attempt = 0; attempt < 40; attempt++) {
        after = await tool.execute({ query: 'annual price' });
        if (after.status === 'denied') break;
        await setTimeout(25);
      }
      assert.deepEqual(after, { ok: false, status: 'denied' });
    } finally { await tool.close(); }
    console.log('ATOMA_RETRIEVAL_SMOKE_PASSED');
  } finally { await backend.cleanup(); closeStoreHandles(); }
} else if (!runHostSupported()) {
  console.log('Project retrieval process smoke not probed: runs require a supported POSIX host.');
} else {
  const root = mkdtempSync(join(tmpdir(), 'atoma-project-retrieval-smoke-'));
  const dbPath = join(root, 'product.db');
  const realContainer = process.argv.includes('--container');
  const script = fileURLToPath(import.meta.url);
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true,
      scripts: { 'run:build': `node ${JSON.stringify(script)} --child` } }));
    const auth = AuthStore.open(dbPath);
    const { viewer } = auth.completeLogin({ provider: 'github', subject: 'smoke-owner', displayName: 'Owner', email: null, emailVerified: false }, null);
    const projects = ProjectStore.open(dbPath);
    const project = projects.createProject({ orgId: viewer.orgId, principalId: viewer.principalId,
      project: { name: 'Docs', slug: 'docs', repositoryTarget: { installationId: '123', owner: 'owner', name: 'docs', visibility: 'private' } } });
    const sourceId = randomUUID();
    const source = projectRunHostLayout(root, viewer.orgId, project.projectId, sourceId);
    mkdirSync(source.workspacePath, { recursive: true }); writeFileSync(join(source.workspacePath, 'docs.md'), SOURCE);
    projects.createProjectRun({ orgId: viewer.orgId, projectId: project.projectId, principalId: viewer.principalId,
      request: { idempotencyKey: sourceId, goal: 'Source fixture' }, projectRunId: sourceId,
      hostPaths: { workspacePath: source.workspacePath, runsPath: source.runsPath, logPath: source.logPath } });
    projects.transitionProjectRun({ orgId: viewer.orgId, projectRunId: sourceId, from: 'queued', to: 'running' });
    projects.transitionProjectRun({ orgId: viewer.orgId, projectRunId: sourceId, from: 'running', to: 'delivered', traceId: sourceId, stats: parseRunLog('✓ build finished') });
    projects.saveArtifactManifest(viewer.orgId, sourceId, buildArtifactManifest({ workspaceRoot: source.workspacePath, declaredPaths: ['docs.md'] }).manifest);
    let childLog;
    const coordinator = new ProjectRunCoordinator({ store: projects, dbPath, projectsRoot: root, cwd: root, timeoutMs: 60_000,
      hostEnv: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        ATOMA_PROJECT_RETRIEVAL: '1', ATOMA_MODEL_L1: 'api:ollama:test', ATOMA_MODEL_L2: 'api:ollama:test', ATOMA_MODEL_L3: 'api:ollama:test', OLLAMA_BASE_URL: 'http://127.0.0.1:1' },
      driver: async options => {
        const launches = ProjectRetrievalLaunchStore.open(dbPath);
        childLog = await spawnRun({ ...options, env: { ...options.env, ATOMA_RETRIEVAL_SMOKE_CONTAINER: realContainer ? '1' : '0' },
          hardKillMarginMs: 0, onChunk: chunk => {
            if (chunk.includes('ATOMA_RETRIEVAL_SMOKE_READY')) launches.revoke(options.env.ATOMA_RUN_ID);
          } });
        return childLog;
      },
    });
    await coordinator.start({ orgId: viewer.orgId, principalId: viewer.principalId, projectId: project.projectId,
      request: { idempotencyKey: randomUUID(), goal: 'Consult admitted documents' } });
    await coordinator.waitForIdle();
    assert.match(childLog, /ATOMA_RETRIEVAL_SMOKE_PASSED/);
    assert.equal(readFileSync(join(source.workspacePath, 'docs.md'), 'utf8'), SOURCE);
    // This is a boundary probe, not a delivery/quality run: the child supplies no delivery manifest.
    console.log(`Project retrieval compiled process smoke passed (container=${realContainer})`);
  } finally { closeStoreHandles(); rmSync(root, { recursive: true, force: true }); }
}
