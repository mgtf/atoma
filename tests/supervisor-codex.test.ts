import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLE_SUPERVISOR_VERDICT, SUPERVISOR_VERDICT_JSON_SCHEMA, supervisorVerdictSchema } from '../src/contracts/supervisorVerdict.js';
import { analyseRun } from '../src/supervisor/analyst.js';
import { createEvidenceReader } from '../src/supervisor/codexReader.js';
import { codexOutputSchema, codexSupervisorConfig, restoreOptionalFields, runCodexSupervisor } from '../src/supervisor/codexSession.js';
import { analystProvider, menderProvider, runCommand } from '../src/supervisor/session.js';
import { writeCodexStub } from './supervisorCodexFixture.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'supervisor-codex-')); roots.push(root);
  for (const dir of ['src', 'docs', 'runs', 'auth']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'src/example.ts'), 'export const answer = 42;');
  writeFileSync(join(root, 'AGENTS.md'), 'Read intentional choices.');
  writeFileSync(join(root, 'auth/auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'initial' } }));
  return root;
}

it('selects Codex as a complete subscription provider set, never borrowing API credentials', () => {
  expect(analystProvider({ ATOMA_ANALYST_TRANSPORT: 'codex' })).toMatchObject({ transport: 'codex', model: 'gpt-5.6-sol', authToken: null });
  expect(menderProvider({ ATOMA_ANALYST_TRANSPORT: 'codex', ATOMA_MENDER_TRANSPORT: 'codex', ATOMA_MENDER_CODEX_HOME: '/private' })).toMatchObject({ source: 'mender', codexHome: '/private' });
  expect(() => analystProvider({ ATOMA_ANALYST_TRANSPORT: 'codex', ATOMA_ANALYST_AUTH_TOKEN: 'api' })).toThrow('remove');
  expect(() => analystProvider({ ATOMA_ANALYST_TRANSPORT: 'typo' })).toThrow('must be');
});

it('derives required nullable optional fields and restores the original strict contract', () => {
  const schema = codexOutputSchema(SUPERVISOR_VERDICT_JSON_SCHEMA);
  expect(JSON.stringify(schema)).toContain('anyOf');
  const verdict = { ...EXAMPLE_SUPERVISOR_VERDICT, findings: [{ kind: 'observation', title: 'x', detail: 'x', confidence: 'high', evidence: [], proposedFix: null }] };
  expect(supervisorVerdictSchema.parse(restoreOptionalFields(verdict, SUPERVISOR_VERDICT_JSON_SCHEMA)).findings[0]).not.toHaveProperty('proposedFix');
});

it('keeps model execution and external capabilities disabled for the analyst', () => {
  const config = codexSupervisorConfig();
  expect(config['features']).toMatchObject({ shell_tool: false, unified_exec: false, apps: false, hooks: false, multi_agent: false });
  expect(config['forced_login_method']).toBe('chatgpt');
  expect(config['permissions.atoma-supervisor.network.enabled']).toBe(false);
});

it('reads only enumerated evidence and bounds queries without executing patterns', () => {
  const root = fixture();
  const reader = createEvidenceReader(root, {});
  expect(reader({ path: '', query: 'example', offset: 0, limit: 10 })).toContain('src/example.ts');
  expect(reader({ path: 'src/example.ts', query: '', offset: 0, limit: 10 })).toContain('42');
  for (const path of ['../.env', 'auth/auth.json', '/etc/passwd']) expect(() => reader({ path, query: '', offset: 0, limit: 10 })).toThrow();
  expect(() => reader({ path: 'src/example.ts', query: '', offset: 0, limit: 201 })).toThrow();
});

describe.skipIf(process.platform === 'win32')('Codex supervisor process boundaries', () => {
  it('preflights the real script without credentials or starting inference', async () => {
    const root = fixture(); const stub = join(root, 'smoke.mjs'); const log = join(root, 'smoke.jsonl');
    writeCodexStub(stub, { report: {}, log });
    const result = await runCommand(process.execPath, ['--import', 'tsx', 'scripts/codex-supervisor-smoke.mjs'], {
      cwd: process.cwd(), timeoutMs: 15_000,
      env: { ...process.env, ATOMA_SUPERVISOR_CMD_CODEX: stub, OPENAI_API_KEY: 'must-not-inherit', GH_TOKEN: 'must-not-inherit' },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no credentials or inference');
    const requests = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(requests.map((request) => request.method)).toEqual(['initialize', 'initialized', 'thread/start']);
    expect(requests[2].params.dynamicTools[0].name).toBe('worktree_command');
  }, 20_000);

  it.each(['initialize', 'thread/start', 'turn/start'])('identifies a rejected %s without persisting provider prose', async (method) => {
    const root = fixture(); const stub = join(root, 'rejected.mjs');
    writeCodexStub(stub, { report: {}, log: join(root, 'rejected.jsonl'),
      rpcError: { method, code: -32600, message: 'HTTP 401 Unauthorized private@example.test refresh_token=secret-value /private/profile' },
    });
    const result = await runCodexSupervisor({ command: stub,
      provider: { transport: 'codex', codexHome: join(root, 'auth'), model: 'gpt-5.6-sol', source: 'mender', baseUrl: null, authToken: null },
      cwd: root, prompt: 'x', hardening: 'x', schema: SUPERVISOR_VERDICT_JSON_SCHEMA, timeoutMs: 5000,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`Codex rejected supervisor ${method} (RPC -32600; authentication-required)`);
    expect(result.usage.served).toBeNull();
    expect(readFileSync(join(root, 'auth/auth.json'), 'utf8')).toContain('initial');
  });

  it('preserves subscription refreshes and partial usage even when the model turn fails', async () => {
    const root = fixture(); const stub = join(root, 'failed.mjs');
    writeCodexStub(stub, { report: {}, log: join(root, 'failed.jsonl'), fail: true });
    const result = await runCodexSupervisor({ command: stub,
      provider: { transport: 'codex', codexHome: join(root, 'auth'), model: 'gpt-5.6-sol', source: 'analyst', baseUrl: null, authToken: null },
      cwd: root, prompt: 'x', hardening: 'x', schema: SUPERVISOR_VERDICT_JSON_SCHEMA,
      timeoutMs: 5000, readEvidence: createEvidenceReader(root, {}),
    });
    expect(result.code).toBe(1);
    expect(result.usage.served?.[0]?.outputTokens).toBe(20);
    expect(readFileSync(join(root, 'auth/auth.json'), 'utf8')).toContain('rotated');
  });

  it('rejects symlinked evidence and API-key auth before starting any session', async () => {
    const root = fixture();
    symlinkSync(join(root, 'auth/auth.json'), join(root, 'src/secret.ts'));
    const reader = createEvidenceReader(root, {});
    expect(() => reader({ path: 'src/secret.ts', query: '', offset: 0, limit: 10 })).toThrow();
    writeFileSync(join(root, 'auth/auth.json'), JSON.stringify({ OPENAI_API_KEY: 'test' }));
    await expect(runCodexSupervisor({ command: 'never-executed', provider: { transport: 'codex', codexHome: join(root, 'auth'), model: 'gpt-5.6-sol', source: 'analyst', baseUrl: null, authToken: null }, cwd: root,
      prompt: 'x', hardening: 'x', schema: SUPERVISOR_VERDICT_JSON_SCHEMA, timeoutMs: 1000, readEvidence: reader })).rejects.toThrow('ChatGPT subscription');
  });

  it('analyses a finished run through dynamic reads and dispatches an eligible defect, preserving refreshed auth', async () => {
    const root = fixture();
    const runId = 'codex-test';
    writeFileSync(join(root, 'runs', `${runId}.json`), JSON.stringify({ id: runId, startedAt: '2026-09-01T00:00:00Z', endedAt: '2026-09-01T00:01:00Z', error: 'bug', events: [], totals: { costUsd: 0 } }));
    const stub = join(root, 'codex.mjs'); const log = join(root, 'protocol.jsonl');
    writeCodexStub(stub, { report: EXAMPLE_SUPERVISOR_VERDICT, log, read: true });
    const dispatched: string[] = [];
    const result = await analyseRun(runId, {
      repoRoot: root, runsDir: join(root, 'runs'), supervisorDir: join(root, 'supervisor'), leasePath: join(root, 'lease.db'),
      provider: { transport: 'codex', codexHome: join(root, 'auth'), model: 'gpt-5.6-sol', source: 'analyst', baseUrl: null, authToken: null },
      claudeCommand: 'never-claude', codexCommand: stub, budgetUsd: 2, timeoutMs: 10_000, dryRun: false, force: false,
      journal: () => {}, log: () => {}, warn: () => {},
      dispatch: { repo: 'owner/repo', token: 'test', eventType: 'atoma-mend', minConfidence: 'high', instance: null, apiBase: 'https://example.invalid' },
      fetchImpl: async (_url, init) => { dispatched.push(init.body); return { status: 204, text: async () => '' }; },
    });
    expect(result.outcome).toBe('analysed');
    expect(dispatched.length).toBeGreaterThan(0);
    const saved = JSON.parse(readFileSync(result.verdictPath!, 'utf8'));
    expect(saved._meta.analysisCostUsd).toBeNull();
    expect(saved._meta.modelsServed[0]).toMatchObject({ model: 'gpt-5.6-sol', inputTokens: 40, cacheReadInputTokens: 60, outputTokens: 20 });
    expect(readFileSync(join(root, 'auth/auth.json'), 'utf8')).toContain('rotated');
    const messages = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(messages.find((m) => m.id === 10).result.success).toBe(true);
    expect(messages.find((m) => m.id === 11).result.success).toBe(false);
    expect(messages.find((m) => m.method === 'thread/start').params.dynamicTools).toHaveLength(1);
  }, 15_000);
});
