import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PLATFORM_EVENT_DETAIL_MAX_CHARS,
  PLATFORM_EVENT_SEVERITY,
  PLATFORM_EVENT_SUMMARY_MAX_CHARS,
  platformEventInputSchema,
  platformEventKindSchema,
  severityForKind,
  type PlatformEventInput,
} from '../src/contracts/platformEvents.js';
import { closeStoreHandles } from '../src/core/stores.js';
import {
  PLATFORM_EVENTS_DEFAULT_RETENTION_DAYS,
  PLATFORM_EVENTS_MAX_PAGE_SIZE,
  PlatformEventLog,
  eventsRetentionDays,
  resetPlatformEventWarnings,
} from '../src/platform/events.js';

const roots: string[] = [];

afterEach(() => {
  resetPlatformEventWarnings();
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openLog(now?: () => Date): PlatformEventLog {
  return openLogAt(now).log;
}

/** Same log plus its path, for tests that need a second raw handle. */
function openLogAt(now?: () => Date): { log: PlatformEventLog; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'atoma-platform-events-'));
  roots.push(root);
  const dbPath = join(root, 'atoma.db');
  return { log: PlatformEventLog.open(dbPath, now), dbPath };
}

function login(overrides: Partial<PlatformEventInput> = {}): PlatformEventInput {
  return {
    kind: 'org.created',
    actorType: 'principal',
    actorId: 'principal-1',
    orgId: 'org-1',
    summary: 'New organisation created by its first login',
    ...overrides,
  };
}

describe('platform event contract', () => {
  it('assigns exactly one severity to every kind', () => {
    for (const kind of platformEventKindSchema.options) {
      expect(severityForKind(kind), kind).toBe(PLATFORM_EVENT_SEVERITY[kind]);
    }
    // The table is the whole vocabulary: a kind added to the enum without a
    // severity would be `undefined` here, and TypeScript would already have
    // refused the incomplete Record.
    expect(Object.keys(PLATFORM_EVENT_SEVERITY).sort()).toEqual(
      [...platformEventKindSchema.options].sort()
    );
  });

  it('defaults the scope fields to null so emitters may omit them', () => {
    const parsed = platformEventInputSchema.parse({
      kind: 'server.recovered',
      actorType: 'system',
      summary: 'Recovered interrupted project state after a restart',
    });
    expect(parsed).toMatchObject({
      actorId: null,
      orgId: null,
      projectId: null,
      runId: null,
    });
    expect(parsed.detail).toBeUndefined();
  });

  it('refuses an unattributable principal, control chars and oversized payloads', () => {
    expect(
      platformEventInputSchema.safeParse({
        kind: 'org.created',
        actorType: 'principal',
        summary: 'no actor id',
      }).success
    ).toBe(false);
    // A system actor needs no id.
    expect(
      platformEventInputSchema.safeParse({
        kind: 'server.recovered',
        actorType: 'system',
        summary: 'fine',
      }).success
    ).toBe(true);
    expect(
      platformEventInputSchema.safeParse(login({ summary: 'line one\nline two' })).success
    ).toBe(false);
    expect(
      platformEventInputSchema.safeParse(
        login({ summary: 'x'.repeat(PLATFORM_EVENT_SUMMARY_MAX_CHARS + 1) })
      ).success
    ).toBe(false);
    expect(
      platformEventInputSchema.safeParse(
        login({ detail: { blob: 'x'.repeat(PLATFORM_EVENT_DETAIL_MAX_CHARS) } })
      ).success
    ).toBe(false);
    // Unknown fields are a contract violation, not silently dropped.
    expect(
      platformEventInputSchema.safeParse({ ...login(), secret: 'token' }).success
    ).toBe(false);
  });
});

describe('PlatformEventLog append', () => {
  it('stores the derived severity and returns the persisted row', () => {
    const log = openLog(() => new Date('2026-08-21T10:00:00.000Z'));
    const stored = log.append(login({ detail: { provider: 'github' } }));
    expect(stored).toMatchObject({
      seq: 1,
      at: '2026-08-21T10:00:00.000Z',
      kind: 'org.created',
      severity: 'info',
      actorType: 'principal',
      actorId: 'principal-1',
      orgId: 'org-1',
      projectId: null,
      runId: null,
      detail: { provider: 'github' },
    });
    expect(log.list().events[0]).toEqual(stored);
  });

  it('is fail-open on invalid input: warns, drops, never throws', () => {
    const log = openLog();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(log.append({ ...login(), summary: '' })).toBeNull();
    expect(log.count()).toBe(0);
    expect(stderr).toHaveBeenCalledOnce();
    // The same reason warns only once, so a broken emitter cannot flood.
    expect(log.append({ ...login(), summary: '' })).toBeNull();
    expect(stderr).toHaveBeenCalledOnce();
    stderr.mockRestore();
  });

  it('notifies subscribers with the persisted row and contains their failures', async () => {
    const log = openLog();
    const seen: number[] = [];
    const unsubscribe = log.subscribe((event) => void seen.push(event.seq));
    const thrower = log.subscribe(() => {
      throw new Error('listener exploded');
    });
    const rejecter = log.subscribe(() => Promise.reject(new Error('listener rejected')));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(log.append(login())).not.toBeNull();
    expect(seen).toEqual([1]);
    // Let the rejected listener promise settle before asserting containment.
    await Promise.resolve();
    await Promise.resolve();
    stderr.mockRestore();

    thrower();
    rejecter();
    unsubscribe();
    log.append(login());
    expect(seen).toEqual([1]);
    expect(log.count()).toBe(2);
  });

  it('exposes a sink for domain modules that must not import a store', () => {
    const log = openLog();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const sink = log.sink;
    sink(login());
    expect(sink(login({ summary: '' }))).toBeUndefined();
    expect(log.count()).toBe(1);
    // The dropped event warns on ONE line, not as a JSON issue dump.
    const warning = String(stderr.mock.calls[0]?.[0] ?? '');
    expect(warning).toMatch(/^\[atoma events\] .*summary.*\n$/);
    expect(warning.split('\n')).toHaveLength(2);
    stderr.mockRestore();
  });
});

describe('PlatformEventLog paging', () => {
  it('pages newest-first and stops with a null cursor', () => {
    const log = openLog();
    for (let index = 0; index < 5; index++) {
      log.append(login({ summary: `event ${index}` }));
    }
    const first = log.list({ limit: 2 });
    expect(first.events.map((event) => event.seq)).toEqual([5, 4]);
    expect(first.nextBefore).toBe(4);
    const second = log.list({ limit: 2, before: first.nextBefore ?? undefined });
    expect(second.events.map((event) => event.seq)).toEqual([3, 2]);
    const third = log.list({ limit: 2, before: second.nextBefore ?? undefined });
    expect(third.events.map((event) => event.seq)).toEqual([1]);
    expect(third.nextBefore).toBeNull();
  });

  it('filters by kind, severity and organisation', () => {
    const log = openLog();
    log.append(login({ orgId: 'org-a' }));
    log.append(login({ kind: 'admin.granted', actorType: 'cli', actorId: null, orgId: null }));
    log.append(login({ kind: 'publication.failed', orgId: 'org-b' }));
    expect(log.list({ kind: 'admin.granted' }).events).toHaveLength(1);
    expect(log.list({ severity: 'security' }).events.map((event) => event.kind)).toEqual([
      'admin.granted',
    ]);
    expect(log.list({ orgId: 'org-b' }).events.map((event) => event.kind)).toEqual([
      'publication.failed',
    ]);
    expect(log.list({ orgId: 'org-missing' }).events).toEqual([]);
  });

  it('clamps the page size instead of erroring', () => {
    const log = openLog();
    log.append(login());
    expect(log.list({ limit: 5_000 }).events).toHaveLength(1);
    expect(log.list({ limit: 0 }).events).toHaveLength(1);
    expect(log.list({ limit: Number.NaN }).events).toHaveLength(1);
    expect(PLATFORM_EVENTS_MAX_PAGE_SIZE).toBe(200);
  });

  it('reads a foreign row tolerantly rather than blinding the page', () => {
    const { log, dbPath } = openLogAt();
    log.append(login({ summary: 'known row' }));
    // A row a newer build wrote: unknown kind, unknown severity, and a
    // detail blob torn mid-write. Dropping it would hide the rows around it.
    const raw = new Database(dbPath);
    raw
      .prepare(
        `INSERT INTO platform_events
           (at, kind, severity, actor_type, actor_id, org_id, project_id, run_id, summary, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        '2026-08-21T11:00:00.000Z',
        'quota.exceeded',
        'critical',
        'system',
        null,
        null,
        null,
        null,
        'from a newer build',
        '{"torn":'
      );
    raw.close();

    const page = log.list();
    expect(page.events).toHaveLength(2);
    const foreign = page.events[0]!;
    expect(foreign.kind).toBe('quota.exceeded');
    expect(foreign.severity).toBe('critical');
    // The unparseable detail degrades to absent; the event itself survives.
    expect(foreign.detail).toBeUndefined();
    expect(page.events[1]?.summary).toBe('known row');
  });
});

describe('PlatformEventLog retention', () => {
  it('reads the retention window through a validator', () => {
    expect(eventsRetentionDays({})).toBe(PLATFORM_EVENTS_DEFAULT_RETENTION_DAYS);
    expect(eventsRetentionDays({ ATOMA_EVENTS_RETENTION_DAYS: '7' })).toBe(7);
    for (const bad of ['0', '-5', 'abc', '', '99999']) {
      expect(eventsRetentionDays({ ATOMA_EVENTS_RETENTION_DAYS: bad }), bad).toBe(
        PLATFORM_EVENTS_DEFAULT_RETENTION_DAYS
      );
    }
  });

  it('sweeps by age while keeping rows inside the window', () => {
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const log = openLog(() => clock);
    log.append(login({ summary: 'ancient' }));
    clock = new Date('2026-06-01T00:00:00.000Z');
    log.append(login({ summary: 'recent' }));
    expect(log.count()).toBe(2);
    const swept = log.sweep({ ATOMA_EVENTS_RETENTION_DAYS: '30' });
    expect(swept.deleted).toBe(1);
    expect(log.list().events.map((event) => event.summary)).toEqual(['recent']);
  });
});
