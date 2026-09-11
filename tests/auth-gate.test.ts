import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  authPublicOrigin,
  openAuthGate,
  vizAuthEnabled,
} from '../src/auth/gate.js';
import { closeStoreHandles } from '../src/core/stores.js';

const roots: string[] = [];

afterEach(() => {
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('viz authentication configuration', () => {
  it('accepts explicit booleans and rejects every ambiguous auth switch', () => {
    expect(vizAuthEnabled({ ATOMA_VIZ_AUTH: '1' })).toBe(true);
    expect(vizAuthEnabled({ ATOMA_VIZ_AUTH: 'true' })).toBe(true);
    expect(vizAuthEnabled({ ATOMA_VIZ_AUTH: '0' })).toBe(false);
    expect(vizAuthEnabled({ ATOMA_VIZ_AUTH: 'false' })).toBe(false);
    expect(vizAuthEnabled({})).toBe(false);
    for (const value of ['', 'TRUE', 'yes', '2', ' false ']) {
      expect(() => vizAuthEnabled({ ATOMA_VIZ_AUTH: value })).toThrow(
        /must be one of: 0, false, 1, true/
      );
    }
  });

  it('accepts HTTPS and loopback HTTP as canonical origins', () => {
    expect(authPublicOrigin({ ATOMA_VIZ_PUBLIC_ORIGIN: 'https://viz.example:8443' }).origin)
      .toBe('https://viz.example:8443');
    expect(authPublicOrigin({ ATOMA_VIZ_PUBLIC_ORIGIN: 'http://127.0.0.1:4111' }).origin)
      .toBe('http://127.0.0.1:4111');
    expect(authPublicOrigin({ ATOMA_VIZ_PUBLIC_ORIGIN: 'http://localhost:4111' }).origin)
      .toBe('http://localhost:4111');
  });

  it.each([
    [undefined, /is required/],
    ['http://viz.example', /must use https/],
    ['ftp://viz.example', /must use https/],
    ['https://user:pass@viz.example', /must contain only/],
    ['https://viz.example/auth', /must contain only/],
    ['https://viz.example/?x=1', /must contain only/],
  ])('rejects an unsafe or non-origin public URL (%s)', (value, pattern) => {
    expect(() => authPublicOrigin(value ? { ATOMA_VIZ_PUBLIC_ORIGIN: value } : {})).toThrow(pattern);
  });

  it('opens auth tables in the explicit viz database, not an ambient store', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-auth-gate-'));
    roots.push(root);
    const selected = join(root, 'selected.db');
    const ambient = join(root, 'ambient.db');
    const gate = openAuthGate({
      env: { ATOMA_VIZ_AUTH: '1', ATOMA_DB_PATH: ambient },
      dbPath: selected,
    });
    expect(gate.enabled).toBe(true);
    expect(existsSync(selected)).toBe(true);
    expect(existsSync(ambient)).toBe(false);

    const db = new Database(selected, { readonly: true });
    try {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_sessions'").get()
      ).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it.each([false, true])('rejects duplicate cookies and legacy HTTPS cookies (secure=%s)', (secure) => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-auth-gate-cookie-'));
    roots.push(root);
    const gate = openAuthGate({
      env: { ATOMA_VIZ_AUTH: '1', ...(secure ? { ATOMA_VIZ_PUBLIC_ORIGIN: 'https://atoma.run' } : {}) },
      dbPath: join(root, 'atoma.db'),
    });
    const store = gate.store;
    if (!store) throw new Error('expected an enabled auth store');

    const login = store.completeLogin(
      {
        provider: 'github',
        subject: '123',
        displayName: 'Alice',
        email: null,
        emailVerified: false,
      },
      null
    );
    if (!login) throw new Error('expected an admitted test principal');
    const token = 'clear-session-token';
    store.createSession({
      principalId: login.viewer.principalId,
      orgId: login.viewer.orgId,
      token,
      ttlMs: 60_000,
    });
    const request = (cookie: string): IncomingMessage =>
      ({ headers: { cookie } }) as IncomingMessage;

    const name = secure ? '__Host-atoma_session' : 'atoma_session';
    if (secure) expect(gate.resolve(request(`atoma_session=${token}`))).toBeNull();
    expect(gate.resolve(request(`other=1; ${name}=${token}`))?.principalId)
      .toBe(login.viewer.principalId);
    expect(
      gate.resolve(request(`${name}=${token}; ${name}=${token}`))
    ).toBeNull();
    expect(
      gate.resolve(request(`${name}=attacker; ${name}=${token}`))
    ).toBeNull();
  });
});
