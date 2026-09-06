#!/usr/bin/env node

// No auth, no prompt, no turn/start: diagnose runner prerequisites safely.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_WORKTREE_TOOL, codexSupervisorConfig, codexSupervisorConfigArgs } from '../src/supervisor/codexSession.ts';
import { runCommand } from '../src/supervisor/session.ts';

const root = mkdtempSync(join(tmpdir(), 'atoma-codex-smoke-'));
const profile = join(root, 'profile'); const jail = join(root, 'jail');
mkdirSync(profile); mkdirSync(jail);
let ready = false;
let failure = null;
try {
  const result = await runCommand(process.env.ATOMA_SUPERVISOR_CMD_CODEX ?? 'codex',
    ['app-server', '--strict-config', ...codexSupervisorConfigArgs()], {
      cwd: jail, timeoutMs: 30_000,
      // Deliberately no inherited credentials, endpoints or personal config.
      env: { PATH: process.env.PATH, HOME: profile, CODEX_HOME: profile, CODEX_SQLITE_HOME: profile },
      input: JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'atoma-supervisor', version: '1' }, capabilities: { experimentalApi: true } } }) + '\n',
      onLine(line, send, end) {
        const message = JSON.parse(line);
        if (message.error) { failure = JSON.stringify({ id: message.id, error: message.error }); end(); return; }
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'thread/start', params: {
            model: 'gpt-5.6-sol', cwd: jail, ephemeral: true, approvalPolicy: 'never',
            baseInstructions: 'Protocol-only preflight. No inference.',
            config: codexSupervisorConfig(), dynamicTools: [CODEX_WORKTREE_TOOL],
          } });
        } else if (message.id === 2) { ready = Boolean(message.result?.thread?.id); end(); }
      },
    });
  if (!ready || failure) throw new Error(`Unauthenticated Codex preflight failed: ${failure ?? result.stderr}`);
  console.log('Codex supervisor protocol smoke passed (no credentials or inference)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
