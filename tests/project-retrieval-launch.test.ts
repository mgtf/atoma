import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeStoreHandles, openStoreHandle } from '../src/core/stores.js';
import { ProjectRetrievalLaunchStore } from '../src/projects/retrievalLaunch.js';
import { openProjectRunHaystack } from '../src/projects/retrievalHaystackLaunch.js';
import { haystackTestRuntime } from './helpers/haystack.js';
import { createProjectRetrievalTool } from '../src/tools/projectRetrieval.js';
import { retrievalContext } from './helpers/projectRetrievalCorpus.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-launch-')); });
afterEach(() => { closeStoreHandles(); rmSync(root, { recursive: true, force: true }); });

async function preparedFixture() {
  const fixture = projectRetrievalFixture(root);
  const source = fixture.makeRun({ 'docs/pricing.md': '# Pricing\r\nAnnual price: 190 euros.\r\n', 'config.json': '{"price":0}\n' });
  const current = fixture.makeRun();
  const launches = ProjectRetrievalLaunchStore.open(fixture.dbPath);
  const receipt = await launches.prepare(current.run.projectRunId, source.run.projectRunId, retrievalContext());
  const openBinding = (overrides: Partial<Parameters<typeof openProjectRunHaystack>[0]> = {}) => openProjectRunHaystack({
    dbPath: fixture.dbPath, runId: current.run.projectRunId, workspacePath: current.layout.workspacePath,
    runsPath: current.layout.runsPath, skillsPath: current.layout.skillsPath, ...overrides,
  }, haystackTestRuntime(root));
  return { ...fixture, source, current, launches, receipt, openBinding };
}

describe('authoritative project retrieval launch', () => {
  it('admits a binary artifact, archives its bytes and returns an extracted-text citation through L1', async () => {
    const f = projectRetrievalFixture(root);
    const bytes = readFileSync(new URL('./fixtures/retrieval-documents/pricing.pdf', import.meta.url));
    const source = f.makeRun({ 'pricing.PDF': bytes });
    const current = f.makeRun();
    const receipt = await ProjectRetrievalLaunchStore.open(f.dbPath).prepare(current.run.projectRunId,
      source.run.projectRunId, retrievalContext());
    expect(readFileSync(join(receipt.sourceRoot, 'pricing.PDF'))).toEqual(bytes);
    const prepared = openProjectRunHaystack({ dbPath: f.dbPath, runId: current.run.projectRunId,
      workspacePath: current.layout.workspacePath, runsPath: current.layout.runsPath,
      skillsPath: current.layout.skillsPath }, haystackTestRuntime(root));
    const tool = createProjectRetrievalTool(prepared.binding, retrievalContext());
    try {
      await prepared.prepare(retrievalContext());
      const result = await tool.execute({ query: 'annual price', filters: { formats: ['pdf'] } });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.passages[0]?.excerpt).toContain('190 euros');
        expect(result.passages[0]?.citation).toMatchObject({ path: 'pricing.PDF',
          extraction: { kind: 'extracted-text' } });
      }
    } finally { await tool.close(); }
  });

  it('freezes only admitted documentation and serves the archive after the original workspace changes', async () => {
    const f = await preparedFixture();
    expect(f.receipt.manifest.documents.map(d => d.path)).toEqual(['docs/pricing.md']);
    const source = readFileSync(join(f.receipt.sourceRoot, 'docs/pricing.md'), 'utf8');
    writeFileSync(join(f.source.layout.workspacePath, 'docs/pricing.md'), 'NEW unregistered price\n');
    const prepared = f.openBinding();
    await prepared.prepare(retrievalContext());
    const binding = prepared.binding;
    const tool = createProjectRetrievalTool(binding, retrievalContext());
    try {
      const result = await tool.execute({ query: 'annual price' });
      expect(result).toMatchObject({ ok: true, passages: [expect.objectContaining({ excerpt: source })] });
      expect(JSON.stringify(result)).not.toContain(root);
      expect(f.launches.resolve(f.current.run.projectRunId)).toEqual(f.receipt);
    } finally { await tool.close(); }
  });

  it('builds no SQLite search cache and ignores retained legacy cache data', async () => {
    const f = await preparedFixture();
    const db = openStoreHandle(f.dbPath, '');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'project_retrieval_%' AND name <> 'project_retrieval_launches' AND type = 'table'").all()).toEqual([]);
    // An old disposable cache is neither a search source nor an implicit migration target.
    db.exec("CREATE TABLE project_retrieval_generations_v1(marker TEXT); INSERT INTO project_retrieval_generations_v1 VALUES ('retained legacy evidence')");
    const next = f.makeRun();
    await f.launches.prepare(next.run.projectRunId, f.source.run.projectRunId, retrievalContext());
    const prepared = f.openBinding({ runId: next.run.projectRunId, workspacePath: next.layout.workspacePath,
      skillsPath: next.layout.skillsPath, runsPath: next.layout.runsPath });
    const tool = createProjectRetrievalTool(prepared.binding, retrievalContext());
    try {
      await prepared.prepare(retrievalContext());
      expect(await tool.execute({ query: 'price' })).toMatchObject({ ok: true });
      expect(db.prepare('SELECT marker FROM project_retrieval_generations_v1').all()).toEqual([{ marker: 'retained legacy evidence' }]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'project_retrieval_fts_%'").all()).toEqual([]);
    } finally { await tool.close(); }
  });

  it.each(['workspacePath', 'skillsPath', 'runsPath'])('refuses mismatched %s before exposing a binding', async key => {
    const f = await preparedFixture();
    expect(() => f.openBinding({ [key]: join(root, 'foreign') })).toThrow('unavailable or denied');
  });

  it.each(['role', 'archive', 'cancel', 'revoke', 'source-delete'])('rechecks current %s state on a previously admitted service', async kind => {
    const f = await preparedFixture();
    const prepared = f.openBinding();
    await prepared.prepare(retrievalContext());
    const binding = prepared.binding;
    const tool = createProjectRetrievalTool(binding, retrievalContext());
    try {
      expect(await tool.execute({ query: 'annual price' })).toMatchObject({ ok: true });
      const db = openStoreHandle(f.dbPath, '');
      if (kind === 'role') db.prepare("UPDATE auth_memberships SET role = 'org:viewer' WHERE principal_id = ?").run(f.viewer.principalId);
      if (kind === 'archive') db.prepare("UPDATE projects SET status = 'archived' WHERE project_id = ?").run(f.project.projectId);
      if (kind === 'cancel') f.projects.transitionProjectRun({ orgId: f.viewer.orgId, projectRunId: f.current.run.projectRunId, from: 'running', to: 'cancelled' });
      if (kind === 'revoke') f.launches.revoke(f.current.run.projectRunId);
      if (kind === 'source-delete') db.prepare('DELETE FROM project_runs WHERE project_run_id = ?').run(f.source.run.projectRunId);
      expect(await tool.execute({ query: 'annual price' })).toEqual({ ok: false, status: 'denied' });
      expect(() => f.openBinding()).toThrow('unavailable or denied');
    } finally { await tool.close(); }
  });

  it('discards a result if authority is revoked between the two host checks', async () => {
    const f = await preparedFixture();
    const prepared = f.openBinding();
    await prepared.prepare(retrievalContext());
    const binding = prepared.binding;
    const search = binding.service.search;
    binding.service.search = async (...args) => {
      const result = await search(...args);
      f.launches.revoke(f.current.run.projectRunId);
      return result;
    };
    const tool = createProjectRetrievalTool(binding, retrievalContext());
    try { expect(await tool.execute({ query: 'price' })).toEqual({ ok: false, status: 'denied' }); }
    finally { await tool.close(); }
  });

  it.each(['sibling-project', 'foreign-organisation'])('refuses a %s source stored in the same product database', async kind => {
    const f = await preparedFixture();
    const foreignFixture = projectRetrievalFixture(root, { slug: 'foreign', ...(kind === 'foreign-organisation' ? { subject: 'other-owner' } : {}) });
    const foreign = foreignFixture.makeRun({ 'docs.md': 'private foreign corpus' });
    expect(f.projects.getProjectRunAnyOrg(foreign.run.projectRunId)).not.toBeNull();
    expect(foreign.run.orgId === f.viewer.orgId).toBe(kind === 'sibling-project');
    const next = f.makeRun();
    await expect(f.launches.prepare(next.run.projectRunId, foreign.run.projectRunId, retrievalContext())).rejects.toThrow('preparation failed');
    expect(f.launches.resolve(next.run.projectRunId)).toBeNull();
  });

  it('refuses an unregistered child and an unavailable store', async () => {
    const f = await preparedFixture();
    const next = f.makeRun();
    expect(() => f.openBinding({ runId: next.run.projectRunId })).toThrow('unavailable or denied');
    expect(() => f.openBinding({ dbPath: join(root, 'missing.db') })).toThrow('unavailable or denied');
  });

  it('refuses changed admitted bytes before publishing a receipt', async () => {
    const f = projectRetrievalFixture(root);
    const source = f.makeRun({ 'docs.md': 'Original source' });
    writeFileSync(join(source.layout.workspacePath, 'docs.md'), 'Changed source!');
    const next = f.makeRun();
    const launches = ProjectRetrievalLaunchStore.open(f.dbPath);
    await expect(launches.prepare(next.run.projectRunId, source.run.projectRunId, retrievalContext())).rejects.toThrow('preparation failed');
    expect(launches.resolve(next.run.projectRunId)).toBe(null);
  });

  it('represents a first run as an authorized empty corpus and refuses cancellation', async () => {
    const f = projectRetrievalFixture(root);
    const next = f.makeRun();
    const launches = ProjectRetrievalLaunchStore.open(f.dbPath);
    await expect(launches.prepare(next.run.projectRunId, null, retrievalContext(1000, AbortSignal.abort()))).rejects.toThrow('cancelled');
    const receipt = await launches.prepare(next.run.projectRunId, null, retrievalContext());
    expect(receipt.manifest.documents).toEqual([]);
    const prepared = openProjectRunHaystack({ dbPath: f.dbPath, runId: next.run.projectRunId,
      workspacePath: next.layout.workspacePath, runsPath: next.layout.runsPath, skillsPath: next.layout.skillsPath }, haystackTestRuntime(root));
    await prepared.prepare(retrievalContext());
    const binding = prepared.binding;
    const tool = createProjectRetrievalTool(binding, retrievalContext());
    try { expect(await tool.execute({ query: 'price' })).toMatchObject({ ok: true, passages: [] }); }
    finally { await tool.close(); }
  });

  it('keeps launch receipts immutable and closes an adapter without closing the shared store', async () => {
    const f = await preparedFixture();
    const db = openStoreHandle(f.dbPath, '');
    expect(() => db.prepare("UPDATE project_retrieval_launches SET receipt_json = '{}' WHERE run_id = ?").run(f.current.run.projectRunId)).toThrow('immutable');
    const prepared = f.openBinding();
    await prepared.prepare(retrievalContext());
    const binding = prepared.binding;
    await binding.service.dispose();
    expect(await binding.service.authorize(binding.scope, retrievalContext())).toBe(false);
    expect(db.open).toBe(true);
  });
});
