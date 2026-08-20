#!/usr/bin/env tsx
/**
 * atoma auth CLI — operator-owned identity admission and inspection.
 *
 *   npm run auth:dev -- list [--db path]
 *   npm run auth:dev -- invite --org <org-id> [--role org:member] [--ttl-hours 24] [--db path]
 *
 * Invitations are bearer credentials shown exactly once. Only their SHA-256
 * is written to the consolidated product store. The target organisation is
 * always explicit; a first user signs in without an invitation and becomes
 * owner of their newly created organisation.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { authPublicOrigin, VIZ_PUBLIC_ORIGIN_ENV } from '../auth/gate.js';
import { AuthStore, ORG_ROLES, type OrgRole } from '../auth/store.js';
import { storeDbPath } from '../core/stores.js';
import { parseCliArgs } from './args.js';
import { applyCheckoutDotenvForSourceEntry } from './loadDotenv.js';

const DEFAULT_INVITE_TTL_HOURS = 24;
const MAX_INVITE_TTL_HOURS = 24 * 30;

const USAGE = `atoma auth — identity admission and inspection

usage:
  npm run auth -- list [--db path]
  npm run auth -- invite --org <org-id> [--role <role>] [--ttl-hours <hours>] [--db path]

roles:
  org:owner | org:admin | org:member | org:viewer

flags:
  --db <path>          use this product store
  --org <org-id>       target organisation (required for invite)
  --role <role>        invitation role (default org:member)
  --ttl-hours <hours>  invitation lifetime, 0 < hours <= 720 (default 24)
  --help               show this help`;

function safeTerminal(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? '�' : character;
  }).join('').slice(0, 300);
}

function parseRole(value: string | undefined): OrgRole | null {
  if (!value) return null;
  return ORG_ROLES.includes(value as OrgRole) ? value as OrgRole : null;
}

function publicInviteUrl(token: string, publicOrigin: URL | null): string {
  const path = `/?invite=${encodeURIComponent(token)}`;
  return publicOrigin ? new URL(path, publicOrigin).href : path;
}

function list(store: AuthStore, dbPath: string): void {
  const principals = store.listPrincipals();
  if (principals.length === 0) {
    console.log(`(no principals in ${dbPath})`);
  } else {
    for (const principal of principals) {
      console.log(`${safeTerminal(principal.displayName)}  [${principal.kind}]`);
      console.log(`  principal ${principal.principalId}`);
      for (const membership of principal.memberships) {
        console.log(
          `  ${membership.role.padEnd(12)} @ ${safeTerminal(membership.orgName)} (${membership.orgId})`
        );
      }
      for (const identity of principal.identities) {
        const email = identity.email ? `  email=${safeTerminal(identity.email)}` : '';
        console.log(`  ${safeTerminal(identity.provider).padEnd(8)} subject=${safeTerminal(identity.subject)}${email}`);
      }
    }
    console.log(`\n${principals.length} principal(s) — ${dbPath}`);
  }

  const now = Date.now();
  const activeInvitations = store.listInvitations().filter(
    (invitation) => invitation.consumedAt === null && new Date(invitation.expiresAt).getTime() > now
  );
  console.log(`${activeInvitations.length} active invitation(s)`);
}

export function runAuthCli(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): number {
  const parsed = parseCliArgs(argv, {
    booleanFlags: ['help'],
    valueFlags: ['db', 'org', 'role', 'ttl-hours'],
    undeclared: 'discard',
  });
  const command = parsed.command ?? 'list';

  if (parsed.flags['help'] === 'true' || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (parsed.undeclaredFlags.length > 0) {
    console.error(`unknown flag: ${parsed.undeclaredFlags[0]}`);
    console.error(USAGE);
    return 1;
  }
  if (parsed.positional.length > 0 || (command !== 'list' && command !== 'invite')) {
    console.error(`unknown auth command or argument: ${safeTerminal(parsed.positional[0] ?? command)}`);
    console.error(USAGE);
    return 1;
  }
  const missingValue = ['db', 'org', 'role', 'ttl-hours'].find(
    (flag) => parsed.flags[flag] !== undefined && parsed.flags[flag].trim().length === 0
  );
  if (missingValue) {
    console.error(`--${missingValue} requires a non-empty value`);
    return 1;
  }
  if (command === 'list' && (
    parsed.flags['org'] !== undefined ||
    parsed.flags['role'] !== undefined ||
    parsed.flags['ttl-hours'] !== undefined
  )) {
    console.error('--org, --role and --ttl-hours are valid only with auth invite');
    return 1;
  }
  const orgId = parsed.flags['org']?.trim() ?? '';
  if (command === 'invite' && !orgId) {
    console.error('--org is required with auth invite');
    return 1;
  }

  const explicitRoleRaw = parsed.flags['role'];
  const explicitRole = explicitRoleRaw === undefined ? null : parseRole(explicitRoleRaw);
  if (explicitRoleRaw !== undefined && !explicitRole) {
    console.error(`invalid role: ${safeTerminal(explicitRoleRaw)}`);
    console.error(USAGE);
    return 1;
  }

  const ttlRaw = parsed.flags['ttl-hours'];
  const ttlHours = ttlRaw === undefined ? DEFAULT_INVITE_TTL_HOURS : Number(ttlRaw);
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > MAX_INVITE_TTL_HOURS) {
    console.error(`invalid --ttl-hours: ${safeTerminal(ttlRaw ?? '')} (expected 0 < hours <= ${MAX_INVITE_TTL_HOURS})`);
    return 1;
  }

  let publicOrigin: URL | null = null;
  if (command === 'invite' && env[VIZ_PUBLIC_ORIGIN_ENV] !== undefined) {
    try {
      publicOrigin = authPublicOrigin(env);
    } catch (error) {
      console.error(`invalid ${VIZ_PUBLIC_ORIGIN_ENV}: ${safeTerminal(error instanceof Error ? error.message : String(error))}`);
      return 1;
    }
  }

  const dbPath = storeDbPath(parsed.flags['db'], env);
  if (command === 'list' && !existsSync(dbPath)) {
    console.log(`(no store at ${dbPath} — nothing to read)`);
    return 0;
  }

  try {
    if (command === 'list') {
      const store = AuthStore.openReadOnly(dbPath);
      if (!store) {
        console.log(`(no principals in ${dbPath})`);
        console.log('0 active invitation(s)');
        return 0;
      }
      try {
        list(store, dbPath);
      } finally {
        store.close();
      }
      return 0;
    }

    const existing = existsSync(dbPath) ? AuthStore.openReadOnly(dbPath) : null;
    try {
      if (!existing) {
        console.error('no organisation exists yet; the first user must sign in to create one');
        return 1;
      }
      if (!existing.listOrganisations().some((organisation) => organisation.orgId === orgId)) {
        console.error(`unknown organisation: ${safeTerminal(orgId)}`);
        return 1;
      }
    } finally {
      existing?.close();
    }

    const store = AuthStore.open(dbPath);
    const role = explicitRole ?? 'org:member';
    if (!store.listOrganisations().some((organisation) => organisation.orgId === orgId)) {
      console.error(`unknown organisation: ${safeTerminal(orgId)}`);
      return 1;
    }

    const token = randomBytes(32).toString('base64url');
    const invitation = store.createInvitation({
      orgId,
      token,
      role,
      ttlMs: ttlHours * 60 * 60 * 1_000,
    });
    console.log(
      `Invitation created for ${role} in ${safeTerminal(invitation.orgName)} (${invitation.orgId}); expires ${invitation.expiresAt}.`
    );
    console.log(`Token (shown once): ${token}`);
    console.log(`Open: ${publicInviteUrl(token, publicOrigin)}`);
    console.log('Treat this invitation as a password until it is used or expires.');
    return 0;
  } catch (error) {
    console.error(`auth command failed: ${safeTerminal(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }
}

if (process.argv[1] && /auth\.(ts|js)$/.test(process.argv[1])) {
  applyCheckoutDotenvForSourceEntry();
  process.exitCode = runAuthCli();
}
