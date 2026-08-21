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
import { eventLabel } from '../contracts/platformEvents.js';
import { storeDbPath } from '../core/stores.js';
import { PlatformEventLog } from '../platform/events.js';
import { parseCliArgs } from './args.js';
import { applyCheckoutDotenvForSourceEntry } from './loadDotenv.js';

const DEFAULT_INVITE_TTL_HOURS = 24;
const MAX_INVITE_TTL_HOURS = 24 * 30;

const USAGE = `atoma auth — identity admission and inspection

usage:
  npm run auth -- list [--db path]
  npm run auth -- invite --org <org-id> [--role <role>] [--ttl-hours <hours>] [--db path]
  npm run auth -- grant-admin --principal <id-or-email> [--db path]
  npm run auth -- revoke-admin --principal <id-or-email> [--db path]

roles:
  org:owner | org:admin | org:member | org:viewer

platform admin:
  grant-admin/revoke-admin set the instance-wide operator flag on ONE
  principal. The flag is never derived from OAuth claims — only this CLI,
  run by the operator against the store on disk, can mint it. An email
  reference must match exactly one principal.

flags:
  --db <path>              use this product store
  --org <org-id>           target organisation (required for invite)
  --role <role>            invitation role (default org:member)
  --ttl-hours <hours>      invitation lifetime, 0 < hours <= 720 (default 24)
  --principal <id-or-email> principal to grant/revoke platform admin
  --help                   show this help`;

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

  const admins = store.listPlatformAdmins();
  if (admins.length === 0) {
    console.log('0 platform admin(s)');
  } else {
    console.log(`${admins.length} platform admin(s):`);
    for (const admin of admins) {
      console.log(`  ${safeTerminal(admin.displayName)} (${admin.principalId}) since ${admin.grantedAt}`);
    }
  }
}

export function runAuthCli(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): number {
  const parsed = parseCliArgs(argv, {
    booleanFlags: ['help'],
    valueFlags: ['db', 'org', 'role', 'ttl-hours', 'principal'],
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
  const KNOWN_COMMANDS = ['list', 'invite', 'grant-admin', 'revoke-admin'];
  if (parsed.positional.length > 0 || !KNOWN_COMMANDS.includes(command)) {
    console.error(`unknown auth command or argument: ${safeTerminal(parsed.positional[0] ?? command)}`);
    console.error(USAGE);
    return 1;
  }
  const missingValue = ['db', 'org', 'role', 'ttl-hours', 'principal'].find(
    (flag) => parsed.flags[flag] !== undefined && parsed.flags[flag].trim().length === 0
  );
  if (missingValue) {
    console.error(`--${missingValue} requires a non-empty value`);
    return 1;
  }
  if (command !== 'invite' && (
    parsed.flags['org'] !== undefined ||
    parsed.flags['role'] !== undefined ||
    parsed.flags['ttl-hours'] !== undefined
  )) {
    console.error('--org, --role and --ttl-hours are valid only with auth invite');
    return 1;
  }
  const adminCommand = command === 'grant-admin' || command === 'revoke-admin';
  if (!adminCommand && parsed.flags['principal'] !== undefined) {
    console.error('--principal is valid only with auth grant-admin / revoke-admin');
    return 1;
  }
  const principalRef = parsed.flags['principal']?.trim() ?? '';
  if (adminCommand && !principalRef) {
    console.error(`--principal is required with auth ${command}`);
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

    if (adminCommand) {
      if (!existsSync(dbPath)) {
        console.error(`no store at ${dbPath} — the principal must sign in first`);
        return 1;
      }
      const store = AuthStore.open(dbPath);
      const result = command === 'grant-admin'
        ? store.grantPlatformAdmin(principalRef)
        : store.revokePlatformAdmin(principalRef);
      const verb = command === 'grant-admin' ? 'granted to' : 'revoked from';
      // Journaled from a SEPARATE PROCESS: this writes the audit row into the
      // same store, and notifies nobody — the in-process bus lives in the viz
      // server. Operator power changing hands is exactly the kind of fact
      // that must survive in the journal even when no server is running.
      // A no-op (`already`) is not journaled: nothing changed.
      if (!result.already) {
        PlatformEventLog.open(dbPath).append({
          kind: command === 'grant-admin' ? 'admin.granted' : 'admin.revoked',
          actorType: 'cli',
          summary: `Platform admin ${verb} ${eventLabel(result.displayName)}`,
          detail: {
            principalId: result.principalId,
            displayName: eventLabel(result.displayName),
          },
        });
      }
      if (result.already) {
        console.log(
          command === 'grant-admin'
            ? `${safeTerminal(result.displayName)} (${result.principalId}) is already a platform admin.`
            : `${safeTerminal(result.displayName)} (${result.principalId}) was not a platform admin.`
        );
      } else {
        console.log(`Platform admin ${verb} ${safeTerminal(result.displayName)} (${result.principalId}).`);
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
    // The token stays out of the journal, exactly as on the HTTP path.
    PlatformEventLog.open(dbPath).append({
      kind: 'invitation.created',
      actorType: 'cli',
      orgId: invitation.orgId,
      summary: `Invitation minted for "${eventLabel(invitation.orgName)}" at role ${role}`,
      detail: { role, ttlHours, expiresAt: invitation.expiresAt },
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
