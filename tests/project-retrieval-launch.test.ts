import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeStoreHandles, openStoreHandle } from '../src/core/stores.js';
import { projectRetrievalEnabled } from '../src/contracts/projectRetrievalLaunch.js';
import { openProjectRunRetrieval, ProjectRetrievalLaunchStore } from '../src/projects/retrievalLaunch.js';
import { createProjectRetrievalTool } from '../src/tools/projectRetrieval.js';
import { retrievalContext } from './helpers/projectRetrievalCorpus.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-launch-')); });
afterEach(() => { closeStoreHandles(); rmSync(root, { recursive: true, force: true }); });

async function prepared() {
  const fixture = projectRetrievalFixture(root);
  const source = fixture.makeRun({ 'docs/pricing.md': '# Pricing\r\nAnnual price: 190 euros.\r\n', 'config.json': '{"price":0}\n' });
  const current = fixture.makeRun();
  const launches = ProjectRetrievalLaunchStore.open(fixture.dbPath);
  const receipt = await launches.prepare(current.run.projectRunId, source.run.projectRunId, retrievalContext());
  const openBinding = (overrides: Partial<Parameters<typeof openProjectRunRetrieval>[0]> = {}) => openProjectRunRetrieval({
    dbPath: fixture.dbPath, runId: current.run.projectRunId, workspacePath: current.layout.workspacePath,
    runsPath: current.layout.runsPath, skillsPath: current.layout.skillsPath, ...overrides,
  });
  return { ...fixture, source, current, launches, receipt, openBinding };
}

describe('authoritative project retrieval launch', () => {
  it('is opt-in and rejects malformed switches', () => {
    expect(projectRetrievalEnabled({})).toBe(false);
    expect(projectRetrievalEnabled({ ATOMA_PROJECT_RETRIEVAL: '0' })).toBe(false);
    expect(projectRetrievalEnabled({ ATOMA_PROJECT_RETRIEVAL: '1' })).toBe(true);
    expect(() => projectRetrievalEnabled({ ATOMA_PROJECT_RETRIEVAL: 'yes' })).toThrow();
  });

  it('freezes only admitted documentation and serves the archive after the original workspace changes', async () => {
    const f = await prepared();
    expect(f.receipt.manifest.documents.map(d => d.path)).toEqual(['docs/pricing.md']);
    const source = readFileSync(join(f.receipt.sourceRoot, 'docs/pricing.md'), 'utf8');
    writeFileSync(join(f.source.layout.workspacePath, 'docs/pricing.md'), 'NEW unregistered price\n');
    const binding = f.openBinding();
    const tool = createProjectRetrievalTool(binding, retrievalContext());
    try {
      const result = await tool.execute({ query: 'annual price' });
      expect(result).toMatchObject({ ok: true, passages: [expect.objectContaining({ excerpt: source })] });
      expect(JSON.stringify(result)).not.toContain(root);
      expect(f.launches.resolve(f.current.run.projectRunId)).toEqual(f.receipt);
    } finally { await tool.close(); }
  });

  it.each(['workspacePath', 'skillsPath', 'runsPath'])('refuses mismatched %s before exposing a binding', async key => {
    const f = await prepared();
    expect(() => f.openBinding({ [key]: join(root, 'foreign') })).toThrow('unavailable or denied');
  });

  it.each(['role', 'archive', 'cancel', 'revoke', 'source-delete'])('rechecks current %s state on a previously admitted service', async kind => {
    const f = await prepared();
    const binding = f.openBinding();
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
    const f = await prepared();
    const binding = f.openBinding();
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
    const f = await prepared();
    const foreignFixture = projectRetrievalFixture(root, { slug: 'foreign', ...(kind === 'foreign-organisation' ? { subject: 'other-owner' } : {}) });
    const foreign = foreignFixture.makeRun({ 'docs.md': 'private foreign corpus' });
    expect(f.projects.getProjectRunAnyOrg(foreign.run.projectRunId)).not.toBeNull();
    expect(foreign.run.orgId === f.viewer.orgId).toBe(kind === 'sibling-project');
    const next = f.makeRun();
    await expect(f.launches.prepare(next.run.projectRunId, foreign.run.projectRunId, retrievalContext())).rejects.toThrow('preparation failed');
    expect(f.launches.resolve(next.run.projectRunId)).toBeNull();
  });

  it('refuses an unregistered child and an unavailable store', async () => {
    const f = await prepared();
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
    const binding = openProjectRunRetrieval({ dbPath: f.dbPath, runId: next.run.projectRunId,
      workspacePath: next.layout.workspacePath, runsPath: next.layout.runsPath, skillsPath: next.layout.skillsPath });
    const tool = createProjectRetrievalTool(binding, retrievalContext());
    try { expect(await tool.execute({ query: 'price' })).toMatchObject({ ok: true, passages: [] }); }
    finally { await tool.close(); }
  });

  it('keeps launch receipts immutable and closes an adapter without closing the shared store', async () => {
    const f = await prepared();
    const db = openStoreHandle(f.dbPath, '');
    expect(() => db.prepare("UPDATE project_retrieval_launches SET receipt_json = '{}' WHERE run_id = ?").run(f.current.run.projectRunId)).toThrow('immutable');
    const binding = f.openBinding();
    await binding.service.dispose();
    expect(await binding.service.authorize(binding.scope, retrievalContext())).toBe(false);
    expect(db.open).toBe(true);
  });
});
