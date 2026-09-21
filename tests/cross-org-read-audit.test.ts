import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeStoreHandles } from '../src/core/stores.js';
import { crossOrgReadSchema, type CrossOrgRead } from '../src/contracts/platformEvents.js';
import { CROSS_ORG_READ_WINDOW_MS, PlatformEventLog } from '../src/platform/events.js';
import { ProjectService } from '../src/projects/service.js';
import type { ProjectRunCoordinator } from '../src/projects/coordinator.js';
import { PUSH_ROUTES, renderPush } from '../src/viz/push/routes.js';
import { resolveAudience } from '../src/viz/push/router.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';

const roots: string[] = [];
afterEach(() => {
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-admin-read-'));
  roots.push(root);
  const a = projectRetrievalFixture(root, { subject: 'admin', slug: 'admin-project' });
  const b = projectRetrievalFixture(root, { subject: 'customer', slug: 'customer-project' });
  let clock = Date.parse('2026-09-20T12:00:00Z');
  const now = () => new Date(clock);
  const log = PlatformEventLog.open(a.dbPath, now);
  const admin = { ...a.viewer, platformAdmin: true };
  const service = new ProjectService({ store: a.projects, github: null,
    coordinator: {} as ProjectRunCoordinator, auditRead: read => log.recordCrossOrgRead(read) });
  const read: CrossOrgRead = { actorId: admin.principalId, orgId: b.viewer.orgId, surface: 'projects.index' };
  return { a, b, admin, service, log, read, now, advance: (ms: number) => { clock += ms; } };
}

describe('cross-organisation read audit', () => {
  it('coalesces every surface across reopen, and renews at the hour boundary', () => {
    const f = fixture();
    const publish = vi.fn();
    f.log.subscribe(publish);
    for (const surface of crossOrgReadSchema.shape.surface.options) f.log.recordCrossOrgRead({ ...f.read, surface });
    expect(f.log.list().events).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
    closeStoreHandles();
    const reopened = PlatformEventLog.open(f.a.dbPath, f.now);
    reopened.recordCrossOrgRead(f.read);
    expect(reopened.list().events).toHaveLength(1);
    f.advance(CROSS_ORG_READ_WINDOW_MS);
    reopened.recordCrossOrgRead(f.read);
    expect(reopened.list().events).toHaveLength(2);
    reopened.recordCrossOrgRead({ ...f.read, actorId: 'another-admin' });
    reopened.recordCrossOrgRead({ ...f.read, orgId: 'another-org' });
    expect(reopened.list().events).toHaveLength(4);
    f.advance(-2 * CROSS_ORG_READ_WINDOW_MS);
    reopened.recordCrossOrgRead(f.read);
    expect(reopened.list().events).toHaveLength(5); // future receipts cannot mask clock rollback
  });

  it('audits project index/detail before returning foreign data and rechecks authority', () => {
    const f = fixture();
    expect(f.service.listProjects(f.a.viewer)).toHaveLength(1);
    expect(f.log.list().events).toHaveLength(0);
    expect(f.service.listProjects(f.admin)).toHaveLength(2);
    expect(f.service.listProjectRuns(f.admin, f.b.project.projectId)).toEqual([]);
    const [event] = f.log.list().events;
    expect(event).toMatchObject({ kind: 'admin.cross_org_read', severity: 'security',
      actorId: f.admin.principalId, orgId: f.b.viewer.orgId });
    expect(() => f.service.listProjectRuns(f.a.viewer, f.b.project.projectId)).toThrow('project not found');
    expect(() => f.service.auditRead(f.a.viewer, f.b.viewer.orgId, 'runs.trace')).toThrow('cross-organisation read denied');
  });

  it('refuses a foreign read when persistence fails and publishes only committed rows', () => {
    const f = fixture();
    const raw = new Database(f.a.dbPath);
    const observed: unknown[] = [];
    const publish = vi.fn(() => {
      observed.push(raw.prepare("SELECT count(*) AS n FROM platform_events WHERE kind = 'admin.cross_org_read'").get());
    });
    f.log.subscribe(publish);
    try {
      raw.exec("CREATE TRIGGER reject_admin_read BEFORE INSERT ON platform_events WHEN NEW.kind = 'admin.cross_org_read' BEGIN SELECT RAISE(ABORT, 'disk refusal'); END");
      expect(() => f.service.listProjects(f.admin)).toThrow('cross-organisation audit unavailable');
      expect(publish).not.toHaveBeenCalled();
      raw.exec('DROP TRIGGER reject_admin_read');
      expect(f.service.listProjects(f.admin)).toHaveLength(2);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(observed).toEqual([{ n: 1 }]);
    } finally { raw.close(); }
    const unconfigured = new ProjectService({ store: f.a.projects, github: null, coordinator: {} as ProjectRunCoordinator });
    expect(() => unconfigured.listProjects(f.admin)).toThrow('cross-organisation audit unavailable');
    expect(unconfigured.listProjects(f.a.viewer)).toHaveLength(1);
  });

  it('routes the receipt to the target organisation owners, not all platform admins', () => {
    const f = fixture();
    f.log.recordCrossOrgRead(f.read);
    const event = f.log.list().events[0]!;
    const route = PUSH_ROUTES['admin.cross_org_read']!;
    expect(resolveAudience(event, route.audience, {
      ownersOf: orgId => orgId === f.b.viewer.orgId ? [f.b.viewer.principalId] : [],
      platformAdmins: () => [f.admin.principalId], allPrincipals: () => [], membersOf: () => [],
    })).toEqual([f.b.viewer.principalId]);
    expect(renderPush(event, 'en', route)).not.toBeNull();
    expect(event.detail).toEqual({ surface: 'projects.index', windowSeconds: 3600 });
  });
});
