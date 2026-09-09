import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { resolveProjectRegistryOwner } from '../src/projects/runAuthority.js';
import { AnthropicLlmClient } from '../src/core/llm.js';
import { closeStoreHandles, openStoreHandle } from '../src/core/stores.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { SkillLifecycle } from '../src/skills/lifecycle.js';
import { assessShareability } from '../src/skills/shareability.js';
import { exportSkillToSpec } from '../src/skills/exportSpec.js';
import { namespaceOf } from '../src/skills/namespace.js';
import { visibleSkillNamespaces } from '../src/skills/visibility.js';
import { ProjectRetrievalLaunchStore } from '../src/projects/retrievalLaunch.js';
import { openProjectRunHaystack } from '../src/projects/retrievalHaystackLaunch.js';
import { haystackTestRuntime } from './helpers/haystack.js';
import { projectRunEnvironment } from '../src/projects/coordinator.js';
import { localToolBackend, withProjectRetrievalBackend } from '../src/run/toolBackend.js';
import { PROJECT_RETRIEVAL_TOOL_NAME as SEARCH } from '../src/contracts/projectRetrieval.js';
import { prefilterCacheGet, prefilterCachePut, PREFILTER_CACHE_TABLE_DDL } from '../src/atoms/prefilterCache.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { retrievalContext } from './helpers/projectRetrievalCorpus.js';
import { makeCtx, jsonText, jsonTextPair, silentLogger } from './helpers.js';

// Synthetic tenant evidence, not a secret detector vocabulary or a live customer document.
const FACT = 'Asterfall private annual price is 731 euros.';
const SOURCE = `# Private pricing\n${FACT}\n`;
const RELOAD_IN_ANOTHER_PROCESS = String.raw`
  import { readFileSync } from 'node:fs';
  import { AtomRegistry } from './src/registry/atomRegistry.ts';
  import { openDb } from './src/registry/db.ts';
  import { resolveProjectRegistryOwner } from './src/projects/runAuthority.ts';
  import { L1Atom } from './src/atoms/L1Atom.ts';
  import { L2Atom } from './src/atoms/L2Atom.ts';
  import { L3Atom } from './src/atoms/L3Atom.ts';
  import { closeStoreHandles } from './src/core/stores.ts';
  import { openProjectRunHaystack } from './src/projects/retrievalHaystackLaunch.ts';
  import { createProjectRetrievalTool } from './src/tools/projectRetrieval.ts';
  import { makeCtx, jsonText, jsonTextPair } from './tests/helpers.ts';
  const { dbPath, launch } = JSON.parse(readFileSync(0, 'utf8'));
  const prepared = openProjectRunHaystack({ dbPath, runId: process.env.ATOMA_RUN_ID,
    workspacePath: process.env.ATOMA_BUILD_WORKSPACE, skillsPath: process.env.ATOMA_SKILLS_DIR,
    runsPath: process.env.ATOMA_RUNS_DIR }, launch);
  await prepared.prepare({ signal: new AbortController().signal, deadlineAt: Date.now() + 10000 });
  const binding = prepared.binding;
  const search = createProjectRetrievalTool(binding, { signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 });
  const ownSource = await search.execute({ query: 'annual price' });
  const registry = new AtomRegistry(openDb(dbPath), resolveProjectRegistryOwner({ dbPath,
    runId: process.env.ATOMA_RUN_ID, workspacePath: process.env.ATOMA_BUILD_WORKSPACE,
    skillsPath: process.env.ATOMA_SKILLS_DIR, runsPath: process.env.ATOMA_RUNS_DIR }));
  // Each fresh project bootstraps from code, never from another owner's rows.
  const seed = { description: 'Reads documented constraints', systemPrompt: 'Read authorized sources.',
    tools: [{ name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: {} } }], params: {}, createdBy: 'privacy-fixture' };
  if (!registry.listByTier(1).length) registry.create(1, seed);
  if (!registry.listByTier(2).length) registry.create(2, seed);
  const prompts = [];
  for (const type of registry.listByTier(1)) {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'Read my own docs', expectedOutput: 'e' }));
    await L1Atom.fromType(type).plan({ description: 'Read this other project.' }, ctx);
    prompts.push(ctx.llm.calls[0].systemPrompt);
  }
  const ctx = makeCtx();
  ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: registry.listByTier(1)[0].name, confidence: 'high', reasoning: 'reader' }));
  await L2Atom.fromType(registry.listByTier(2)[0], registry, []).plan({ description: 'Read this other project.' }, ctx);
  const root = registry.listByTier(3)[0] ?? registry.create(3, seed);
  const parent = makeCtx();
  parent.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'inspect catalogue' }));
  parent.llm.enqueueText(jsonTextPair({ strategy: 'reuse', target: registry.listByTier(2)[0].name, reasoning: 'read' },
    { reasoning: 'read', subtasks: [{ description: 'Read source' }], aggregation: { mode: 'concat' }, expectedOutput: 'source' }));
  await L3Atom.buildWithModel(root, registry, 'api:ollama:test').plan({ description: 'Read this project.' }, parent);
  process.stdout.write(JSON.stringify({ prompts, catalogue: ctx.llm.calls[0].userContent + parent.llm.calls.map(call => call.userContent).join('\n'),
    types: [1, 2, 3].flatMap(tier => registry.listByTier(tier)),
    ownPassages: ownSource.ok ? ownSource.passages.length : null }));
  await search.close();
  closeStoreHandles();
`;
async function readNextProject(dbPath: string, other: ReturnType<ReturnType<typeof projectRetrievalFixture>['makeRun']>): Promise<{ prompts: string[]; catalogue: string; types: unknown[] }> {
  await ProjectRetrievalLaunchStore.open(dbPath).prepare(other.run.projectRunId, null, retrievalContext());
  const result = JSON.parse(execFileSync(process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', RELOAD_IN_ANOTHER_PROCESS], {
      input: jsonText({ dbPath, launch: haystackTestRuntime(root) }), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, ATOMA_RUN_ID: other.run.projectRunId, ATOMA_SKILLS_DIR: other.layout.skillsPath,
        ATOMA_BUILD_WORKSPACE: other.layout.workspacePath, ATOMA_RUNS_DIR: other.layout.runsPath },
    }));
  expect(result.ownPassages).toBe(0); // its authorized corpus cannot supply the other project's fact
  return result;
}
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-privacy-')); });
afterEach(() => { vi.unstubAllEnvs(); closeStoreHandles(); rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const f = projectRetrievalFixture(root);
  const source = f.makeRun({ 'private/pricing.md': SOURCE });
  const run = f.makeRun();
  const environment = projectRunEnvironment({ hostEnv: {
    ATOMA_MODEL_L1: 'api:ollama:test', ATOMA_MODEL_L2: 'api:ollama:test', ATOMA_MODEL_L3: 'api:ollama:test', OLLAMA_BASE_URL: 'http://127.0.0.1:1',
  }, orgId: f.viewer.orgId, dbPath: f.dbPath, runId: run.run.projectRunId,
  workspacePath: run.layout.workspacePath, skillsPath: run.layout.skillsPath,
  runsPath: run.layout.runsPath, artifactManifestPath: run.layout.artifactManifestPath }).environment;
  for (const [key, value] of Object.entries(environment)) if (key.startsWith('ATOMA_')) vi.stubEnv(key, value);
  const context = retrievalContext();
  await ProjectRetrievalLaunchStore.open(f.dbPath).prepare(run.run.projectRunId, source.run.projectRunId, context);
  vi.stubEnv('ATOMA_PROJECT_RETRIEVAL_RECEIPT', '1');
  const prepared = openProjectRunHaystack({ dbPath: f.dbPath, runId: run.run.projectRunId,
    workspacePath: run.layout.workspacePath, skillsPath: run.layout.skillsPath, runsPath: run.layout.runsPath }, haystackTestRuntime(root));
  await prepared.prepare(context);
  const binding = prepared.binding;
  const backend = await withProjectRetrievalBackend(localToolBackend({ workspaceRoot: run.layout.workspacePath, logger: silentLogger() }), binding, context);
  const owner = resolveProjectRegistryOwner({ dbPath: f.dbPath, runId: run.run.projectRunId,
    workspacePath: run.layout.workspacePath, skillsPath: run.layout.skillsPath, runsPath: run.layout.runsPath });
  const registry = new AtomRegistry(openDb(f.dbPath), owner);
  const tools = backend.toolDecls.filter(t => t.name === SEARCH || t.name === 'write_file');
  const seed = { description: 'Reads documented constraints', systemPrompt: 'Read the authorized source and cite it.', tools, params: {}, createdBy: 'privacy-fixture' };
  const supervisor = registry.create(2, seed);
  const child = registry.create(1, seed);
  const skills = new SkillRegistry(run.layout.skillsPath);
  return { ...f, run, owner, registry, child, supervisor, skills, backend, tools };
}

function enqueueSearch(ctx: ReturnType<typeof makeCtx>): void {
  let quoted = false;
  const sdk = { messages: { create: async (params: { messages: { content: unknown }[] }) => {
    const content = params.messages.at(-1)!.content;
    const results = Array.isArray(content) ? content.filter((b: { type?: string }) => b.type === 'tool_result') : [];
    if (results.length) {
      const response = JSON.parse((results[0] as { content: string }).content);
      expect(response.passages[0].excerpt).toBe(SOURCE);
      quoted = true;
      return { content: [{ type: 'text', text: jsonText({ output: FACT, summary: FACT }) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    }
    return { content: [{ type: 'tool_use', id: 'search', name: SEARCH, input: { query: 'annual price' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } };
  } } };
  const transport = new AnthropicLlmClient(sdk as unknown as ConstructorParameters<typeof AnthropicLlmClient>[0]);
  ctx.llm.enqueue(async request => {
    const result = await transport.complete(request);
    expect(quoted).toBe(true);
    return result;
  });
}

function enqueueAttempt(ctx: ReturnType<typeof makeCtx>): void {
  ctx.llm.enqueueText(jsonText({ reasoning: 'Consult original evidence', proposedAction: 'Read the authorized documentation', expectedOutput: 'Cited source' }));
  ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'bounded read' }));
  enqueueSearch(ctx);
}

describe('tenant retrieval downstream privacy audit', () => {
  it('keeps a deliberately non-generalized learned recipe in the owning project, including after reload and namespace sharing', async () => {
    const f = await fixture();
    const ctx = { ...makeCtx(), tools: f.backend.executor };
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: f.child.name, confidence: 'high', reasoning: 'source reader' }));
    enqueueAttempt(ctx);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'source consulted' }));
    ctx.llm.enqueueText(jsonText({ id: 'read-private-pricing', description: 'Read pricing', when_to_use: 'When asked for pricing', body: `1. ${SEARCH} for annual price.\n2. ${FACT}` }));
    try {
      await L2Atom.fromType(f.supervisor, f.registry, [], f.skills).handleDirect({ description: 'Find the annual price.' }, ctx);
      const distillation = ctx.llm.calls.find(call => call.role === 'skill');
      expect(distillation?.userContent).toContain(FACT);
      expect(distillation?.userContent).toContain('THE BODY MUST GENERALISE');
      const owner = namespaceOf(f.child);
      const learned = new SkillRegistry(f.run.layout.skillsPath).loadFor(owner)[0]!;
      // Characterization: the prompt does not mechanically remove a copied private fact.
      expect(learned.body).toContain(FACT);
      expect(learned.provenance?.mechanism).toBe('distilled');
      const reader = f.registry.create(1, { ...f.child, createdBy: 'privacy-fixture' });
      const visibleIn = (store: SkillRegistry) => visibleSkillNamespaces({ home: namespaceOf(reader),
        readerToolNames: f.tools.map(t => t.name), namespaces: store.listNamespaces(),
        toolNamesFor: ns => f.registry.getByAtomId(ns)?.tools.map(t => t.name) ?? null });
      expect(visibleIn(f.skills)).toContain(owner); // sharing really is enabled inside this root
      expect(visibleIn(f.skills).flatMap(ns => f.skills.loadFor(ns))).toContainEqual(learned);
      for (const options of [{ slug: 'sibling' }, { subject: 'foreign-owner', slug: 'foreign' }]) {
        const other = projectRetrievalFixture(root, options).makeRun();
        const otherSkills = new SkillRegistry(other.layout.skillsPath);
        expect(visibleIn(otherSkills).flatMap(ns => otherSkills.loadFor(ns))).toEqual([]);
      }
      expect(new SkillRegistry(join(root, 'operator-skills')).loadFor(owner)).toEqual([]);
      // A clean hygiene assessment is expressly NOT approval to share this fact.
      const assessment = assessShareability({ skill: learned, ownerToolNames: [SEARCH] });
      expect(assessment).toMatchObject({ verdict: 'review-required', blockers: [] });
      expect(assessment.humanMustCheck).toContain('read the instruction text');
      // The operator's format converter is not a privacy/sanitization gate either.
      const exported = exportSkillToSpec(learned);
      expect('content' in exported && exported.content.includes(FACT)).toBe(true);
    } finally { await f.backend.cleanup(); }
  });

  it('contains copied recovery guidance in project storage and marks it non-shareable', async () => {
    const f = await fixture();
    const ctx = makeCtx();
    const supervisor = L2Atom.fromType(f.supervisor, f.registry, [], f.skills);
    const lifecycle = new SkillLifecycle({ name: supervisor.name, model: supervisor.model, params: {},
      toLlmRequest: (role, args) => supervisor.toLlmRequest(role, args) }, f.skills);
    ctx.llm.enqueueText(jsonText({ id: 'recover-missing-source', description: 'Recover source citation',
      trigger: 'missing quoted source evidence', body: `Quote the source: ${FACT}` }));
    try {
      await lifecycle.learnEventSkillFromRecovery({ l1Name: namespaceOf(f.child), subTask: { description: 'Read pricing' },
        diagnostic: 'missing quoted source evidence', recoverySummary: FACT, ctx });
      expect(ctx.llm.calls[0]?.userContent).toContain(FACT);
      const learned = new SkillRegistry(f.run.layout.skillsPath).loadFor(namespaceOf(f.child))[0]!;
      expect(learned.body).toContain(FACT);
      expect(assessShareability({ skill: learned, ownerToolNames: f.tools.map(t => t.name) }).verdict).toBe('not-shareable');
      const other = projectRetrievalFixture(root, { subject: 'other-owner', slug: 'other' }).makeRun();
      expect(new SkillRegistry(other.layout.skillsPath).loadFor(namespaceOf(f.child))).toEqual([]);
    } finally { await f.backend.cleanup(); }
  });

  it('neither reads an existing common decision nor writes a new one with the coordinator cache policy', async () => {
    const f = await fixture();
    try {
      const db = openStoreHandle(f.dbPath, PREFILTER_CACHE_TABLE_DDL);
      db.prepare('INSERT INTO prefilter_cache(key,outcome,at,hits) VALUES (?,?,?,0)')
        .run('previous', jsonText({ kind: 'escalate', reasoning: FACT }), new Date().toISOString());
      expect(process.env['ATOMA_PREFILTER_CACHE']).toBe('0');
      expect(prefilterCacheGet('previous')).toBeNull();
      prefilterCachePut('current', { kind: 'escalate', reasoning: FACT });
      expect(db.prepare('SELECT key,hits FROM prefilter_cache').all()).toEqual([{ key: 'previous', hits: 0 }]);
    } finally { await f.backend.cleanup(); }
  });

  it.each(['ephemeral', 'patch', 'branch'] as const)('contains %s validator coaching through retrieval, persistence and another project reload', async scope => {
    const f = await fixture();
    vi.stubEnv('ATOMA_SKILL_LEARN', '0');
    const ctx = { ...makeCtx(), tools: f.backend.executor };
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: f.child.name, confidence: 'high', reasoning: 'source reader' }));
    enqueueAttempt(ctx);
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Use the documented value', scope,
      modifications: { systemPromptAppend: FACT, additionalContext: 'Cite private/pricing.md.' } }));
    enqueueAttempt(ctx);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'source consulted' }));
    try {
      await L2Atom.fromType(f.supervisor, f.registry, [], f.skills).handleDirect({ description: 'Find the annual price.' }, ctx);
      expect(ctx.llm.calls.some(call => call.role === 'plan' && call.systemPrompt.includes(FACT))).toBe(true);
      const other = projectRetrievalFixture(root, { subject: 'other-owner', slug: 'other' }).makeRun();
      const reloaded = new AtomRegistry(openDb(f.dbPath), f.owner);
      const tainted = reloaded.listByTier(1).filter(type => type.systemPrompt.includes(FACT));
      expect(tainted).toHaveLength(scope === 'ephemeral' ? 0 : 1);
      for (const type of tainted) expect(type.systemPrompt).not.toContain('Cite private/pricing.md.');
      for (const next of [other, projectRetrievalFixture(root, { slug: 'sibling' }).makeRun()]) {
        const { prompts, catalogue, types } = await readNextProject(f.dbPath, next);
        expect(JSON.stringify({ prompts, catalogue, types })).not.toContain(FACT);
      }
      const sameProject = await readNextProject(f.dbPath, f.makeRun());
      expect(sameProject.prompts.some(prompt => prompt.includes(FACT))).toBe(scope !== 'ephemeral');
      expect(new AtomRegistry(openDb(f.dbPath)).listByTier(1)).toEqual([]);
    } finally { await f.backend.cleanup(); }
  });

  it('keeps planner-created L1 descriptions and tool metadata inside the project', async () => {
    const f = await fixture(); vi.stubEnv('ATOMA_SKILL_LEARN', '0');
    const ctx = { ...makeCtx(), tools: f.backend.executor };
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'new reader' }));
    ctx.llm.enqueueText(jsonTextPair({ strategy: 'create', reasoning: 'new reader',
      seed: { description: FACT, systemPrompt: FACT, tools: [{ name: 'private_metadata', description: FACT,
        inputSchema: { type: 'object', properties: {} } }], params: {} } },
    { reasoning: 'read', subtasks: [{ description: 'Find annual price' }], aggregation: { mode: 'concat' }, expectedOutput: 'source' }));
    enqueueAttempt(ctx); ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'source consulted' }));
    try {
      await L2Atom.fromType(f.supervisor, f.registry, [], f.skills).handleDirect({ description: 'Find annual price' }, ctx);
      expect(f.registry.listByTier(1).some(type => JSON.stringify(type).includes(FACT))).toBe(true);
      const other = projectRetrievalFixture(root, { subject: 'other-owner', slug: 'other' }).makeRun();
      expect(JSON.stringify(await readNextProject(f.dbPath, other))).not.toContain(FACT);
    } finally { await f.backend.cleanup(); }
  });

  it.each(['patch', 'branch', 'create'] as const)('contains L3-to-L2 %s metadata from a source-derived decision', async scope => {
    const f = await fixture();
    vi.stubEnv('ATOMA_SKILL_LEARN', '0');
    const root = f.registry.create(3, { ...f.supervisor, createdBy: 'privacy-fixture' });
    const ctx = { ...makeCtx(), tools: f.backend.executor };
    const privateTool = { name: 'private_metadata', description: FACT, inputSchema: { type: 'object', properties: {} } };
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'plan explicitly' }));
    ctx.llm.enqueueText(jsonTextPair(scope === 'create'
      ? { strategy: 'create', seed: { description: FACT, systemPrompt: FACT, tools: [privateTool], params: {} }, reasoning: 'new reader' }
      : { strategy: 'reuse', target: f.supervisor.name, reasoning: 'reader' },
    { reasoning: 'read', subtasks: [{ description: 'Find annual price' }], aggregation: { mode: 'concat' }, expectedOutput: 'source' }));
    // L2 execution still reads the real host retrieval element; only provider responses are mocked.
    const reuse = () => ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: f.child.name, confidence: 'high', reasoning: 'reader' }));
    reuse();
    enqueueAttempt(ctx);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'cited source' }));
    if (scope !== 'create') {
      ctx.llm.enqueueText(jsonText({ approved: false, scope, branchName: 'Private-731', reasoning: FACT,
        modifications: { systemPromptAppend: FACT, descriptionReplace: FACT, addTools: [privateTool] } }));
      reuse();
        enqueueAttempt(ctx);
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'cited source' }));
    }
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'done' }));
    try {
      await L3Atom.buildWithModel(root, f.registry, 'api:ollama:test').handle({ description: 'Find annual price' }, ctx);
      expect(f.registry.listByTier(2).some(type => JSON.stringify(type).includes(FACT))).toBe(true);
      const other = projectRetrievalFixture(f.root, { subject: 'other-owner', slug: 'other' }).makeRun();
      expect(JSON.stringify(await readNextProject(f.dbPath, other))).not.toContain(FACT);
      expect(JSON.stringify(await readNextProject(f.dbPath, f.makeRun()))).toContain(FACT);
    } finally { await f.backend.cleanup(); }
  });

  it.each(['description', 'branch-name'])('keeps private %s out of another organisation’s routing catalogue', async field => {
    const f = await fixture();
    vi.stubEnv('ATOMA_SKILL_LEARN', '0');
    const ctx = { ...makeCtx(), tools: f.backend.executor };
    const marker = field === 'description' ? FACT : 'Asterfall-annual-731';
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: f.child.name, confidence: 'high', reasoning: 'source reader' }));
    enqueueAttempt(ctx);
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Specialize the reader',
      ...(field === 'description'
        ? { scope: 'patch', modifications: { descriptionReplace: marker } }
        : { scope: 'branch', branchName: marker, modifications: { additionalContext: FACT } }),
    }));
    enqueueAttempt(ctx);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'source consulted' }));
    try {
      await L2Atom.fromType(f.supervisor, f.registry, [], f.skills).handleDirect({ description: 'Find the annual price.' }, ctx);
      const other = projectRetrievalFixture(root, { subject: 'other-owner', slug: 'other' }).makeRun();
      expect((await readNextProject(f.dbPath, other)).catalogue).not.toContain(marker);
    } finally { await f.backend.cleanup(); }
  });
});
