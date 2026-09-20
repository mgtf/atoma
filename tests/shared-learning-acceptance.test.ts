import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { TRUST_PROMOTE_THRESHOLD_SUCCESSES, TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { ledgerScope, setLedgerScope } from '../src/core/ledger.js';
import type { Result, SkillEventInfo } from '../src/core/types.js';
import { projectRunEnvironment, projectRunHostLayout } from '../src/projects/coordinator.js';
import { assertProjectRunAuthority } from '../src/projects/runAuthority.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { SkillLifecycle } from '../src/skills/lifecycle.js';
import { namespaceOf } from '../src/skills/namespace.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { localToolBackend, type ToolBackend } from '../src/run/toolBackend.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { jsonText, makeCtx, silentLogger } from './helpers.js';

// W14's shared-learning arm only. Real store, identities, skill files and tool
// execution; mocked distillation/compiler/prefilters. No container isolation claim.
const roots: string[] = [];
const backends: ToolBackend[] = [];
const originalScope = ledgerScope();
afterEach(async () => {
  try {
    for (const backend of backends.splice(0)) await backend.cleanup();
  } finally {
    setLedgerScope(originalScope);
    vi.unstubAllEnvs();
    closeStoreHandles();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

const skillId = 'inspect-workspace-input';
const task = { description: 'Verify input.txt and report its current text.' };
const recipe = 'Read input.txt with read_file and report the observed text without changing the file.';
const script = `import fs from 'node:fs';
const text = fs.readFileSync('input.txt', 'utf8');
console.log(JSON.stringify({ output: { text }, summary: 'Input inspected successfully' }));`;

describe.skipIf(process.platform === 'win32')('W14 shared learning across organisations', () => {
  it('distills in A, reloads the shared catalog in B, dispatches there and attributes B credit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-commons-'));
    roots.push(root);
    const catalog = join(root, 'platform-skills');
    const a = projectRetrievalFixture(root, { subject: 'org-a-owner', slug: 'alpha' });
    const b = projectRetrievalFixture(root, { subject: 'org-b-owner', slug: 'beta' });
    expect(a.viewer.orgId).not.toBe(b.viewer.orgId);
    const db = openDb(a.dbPath);
    const registry = new AtomRegistry(db);
    vi.stubEnv('ATOMA_LEDGER_DB', a.dbPath);
    vi.stubEnv('ATOMA_SKILL_DIRECT', '1');
    vi.stubEnv('ATOMA_SKILL_PROMOTE', '1');
    vi.stubEnv('ATOMA_TRUST_THRESHOLD', String(TRUST_THRESHOLD_SUCCESSES));
    vi.stubEnv('ATOMA_PROMOTE_THRESHOLD', String(TRUST_PROMOTE_THRESHOLD_SUCCESSES));

    const makeRun = (tenant: typeof a, text: string) => {
      const runId = randomUUID();
      const layout = projectRunHostLayout(root, tenant.viewer.orgId, tenant.project.projectId, runId);
      tenant.projects.createProjectRun({ orgId: tenant.viewer.orgId, projectId: tenant.project.projectId,
        principalId: tenant.viewer.principalId, projectRunId: runId,
        request: { idempotencyKey: runId, goal: task.description },
        hostPaths: { workspacePath: layout.workspacePath, runsPath: layout.runsPath,
          logPath: layout.logPath, skillsPath: catalog } });
      tenant.projects.transitionProjectRun({ orgId: tenant.viewer.orgId, projectRunId: runId, from: 'queued', to: 'running' });
      mkdirSync(layout.workspacePath, { recursive: true });
      writeFileSync(join(layout.workspacePath, 'input.txt'), text);
      const paths = { dbPath: a.dbPath, runId, workspacePath: layout.workspacePath, runsPath: layout.runsPath, skillsPath: catalog };
      const environment = projectRunEnvironment({ ...paths, orgId: tenant.viewer.orgId,
        artifactManifestPath: layout.artifactManifestPath,
        hostEnv: { ATOMA_MODEL_L1: 'api:ollama:test', ATOMA_MODEL_L2: 'api:ollama:test',
          ATOMA_MODEL_L3: 'api:ollama:test', OLLAMA_BASE_URL: 'http://127.0.0.1:1' } }).environment;
      const activate = () => {
        for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
        const authority = assertProjectRunAuthority(paths);
        setLedgerScope({ orgId: authority.orgId, projectId: authority.projectId, runId,
          actorType: 'principal', actorId: authority.requestedByPrincipalId });
      };
      const backend = localToolBackend({ workspaceRoot: layout.workspacePath, logger: silentLogger() });
      backends.push(backend);
      return { paths, layout, activate, backend, runId };
    };

    const first = makeRun(a, 'alpha source');
    first.activate();
    const tools = first.backend.toolDecls.filter(tool => ['read_file', 'write_file', 'run_shell'].includes(tool.name));
    const seed = { description: 'Inspect workspace input', systemPrompt: 'Report observed file contents.', tools, params: {}, createdBy: 'w14-fixture' };
    const supervisor = registry.create(2, { ...seed, tools: [] });
    const molecule = registry.create(1, seed);
    const namespace = namespaceOf(molecule);
    const skillsA = new SkillRegistry(catalog, { db });
    const host = L2Atom.fromType(supervisor, registry, [], skillsA);
    const lifecycle = new SkillLifecycle({ name: host.name, model: host.model, params: {},
      toLlmRequest: (role, args) => host.toLlmRequest(role, args) }, skillsA);
    // The accepted attempt is a fixture; its observed action uses the real tool.
    const observation = await first.backend.executor.execute('read_file', { path: 'input.txt' });
    expect(JSON.stringify(observation)).toContain('alpha source');
    const result: Result = { output: { text: 'alpha source' }, summary: 'Input inspected successfully',
      toolCallResults: [{ name: 'read_file', ok: true, result: observation }],
      trace: [], producedBy: { tier: 1, name: molecule.name, viaFallback: false } };
    const learning = makeCtx();
    learning.llm.enqueueText(jsonText({ id: skillId, description: 'Inspect a workspace input file',
      when_to_use: 'When asked to verify input.txt and report its text', body: recipe }));
    await lifecycle.learnSkillFromRun({ l1Name: namespace, subTask: task, result,
      child: L1Atom.fromType(molecule), ctx: learning });
    expect(skillsA.loadFor(namespace)[0]).toMatchObject({ id: skillId, kind: 'llm', provenance: { mechanism: 'distilled' } });

    // Eligibility history is seeded: this acceptance tests transfer across orgs,
    // not whether a compiler or model earns trust over real-world tasks.
    for (let i = 0; i < TRUST_PROMOTE_THRESHOLD_SUCCESSES; i++) skillsA.recordSuccess(namespace, skillId);
    const compiling = makeCtx();
    compiling.llm.enqueueText(jsonText({ promotable: true, language: 'node', body: script, writes: [] }));
    await lifecycle.tryPromoteSkill({ l1Name: namespace, skillId, subTask: task, result,
      ctx: compiling, hostTools: tools.map(tool => tool.name) });
    expect(skillsA.loadFor(namespace)[0]).toMatchObject({ kind: 'script', successes: 0, fallbackBody: recipe });
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) {
      skillsA.recordSuccess(namespace, skillId);
      registry.recordSuccess(molecule.name);
    }
    a.projects.transitionProjectRun({ orgId: a.viewer.orgId, projectRunId: first.runId, from: 'running', to: 'delivered' });
    await first.backend.drain?.();

    const second = makeRun(b, 'beta source');
    second.activate();
    expect(second.paths.skillsPath).toBe(first.paths.skillsPath);
    expect(second.paths.workspacePath).not.toBe(first.paths.workspacePath);
    expect(() => assertProjectRunAuthority({ ...second.paths, workspacePath: first.paths.workspacePath })).toThrow('denied');
    expect(b.projects.getProjectRun(b.viewer.orgId, first.runId)).toBeNull();
    const reloadedRegistry = new AtomRegistry(openDb(a.dbPath));
    const skillsB = new SkillRegistry(second.paths.skillsPath, { db });
    expect(skillsB.loadFor(namespace)[0]).toMatchObject({ id: skillId, kind: 'script', successes: TRUST_THRESHOLD_SUCCESSES });
    const events: SkillEventInfo[] = [];
    const context = { ...makeCtx(), tools: second.backend.executor, recordSkill: (event: SkillEventInfo) => events.push(event) };
    context.llm.enqueueText(jsonText({ kind: 'reuse', target: molecule.name, confidence: 'high', reasoning: 'shared molecule' }));
    context.llm.enqueueText(jsonText({ kind: 'reuse', target: skillId, confidence: 'high', reasoning: 'shared recipe' }));
    const delivered = await L2Atom.fromType(reloadedRegistry.getByAtomId(supervisor.atomId)!, reloadedRegistry, [], skillsB).handleDirect(task, context);
    expect(delivered.output).toEqual({ text: 'beta source' });
    expect(context.llm.calls).toHaveLength(2); // no L1 model execution or validators
    expect(events.map(event => event.op)).toEqual(['match', 'direct', 'success']);
    expect(skillsA.loadFor(namespace)[0]!.successes).toBe(TRUST_THRESHOLD_SUCCESSES + 1);
    expect(readFileSync(join(first.paths.workspacePath, 'input.txt'), 'utf8')).toBe('alpha source');
    expect(readFileSync(join(second.paths.workspacePath, 'input.txt'), 'utf8')).toBe('beta source');
    expect(existsSync(join(second.paths.workspacePath, `_skill_${skillId}.mjs`))).toBe(false);
    const credit = db.prepare('SELECT org_id, project_id, run_id, actor_id FROM lifecycle_events WHERE kind = ? ORDER BY rowid DESC LIMIT 1')
      .get('skill-success');
    expect(credit).toEqual({ org_id: b.viewer.orgId, project_id: b.project.projectId, run_id: second.runId, actor_id: b.viewer.principalId });
  });
});
