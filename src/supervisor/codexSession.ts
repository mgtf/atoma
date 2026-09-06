import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireCodexHomeLease } from '../core/codexHomeLease.js';
import { CODEX_TEXT_ONLY_DISABLED_FEATURES, codexChildEnvironment } from '../core/llmCodexCli.js';
import type { JsonSchema } from '../contracts/jsonSchema.js';
import { CODEX_EVIDENCE_TOOL } from './codexReader.js';
import { parseLooseJson, runCommand, type ClaudeSessionResult, type SupervisorProvider } from './session.js';

function object(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

/** OpenAI requires optional fields to be required-and-nullable. Derive from the one schema. */
export function codexOutputSchema(schema: JsonSchema): JsonSchema {
  const result = { ...schema };
  if (schema['type'] === 'object') {
    const properties = object(schema['properties']);
    const required = schema['required'] as string[] | undefined;
    result['properties'] = Object.fromEntries(Object.entries(properties).map(([key, value]) => {
      const child = codexOutputSchema(object(value));
      return [key, required?.includes(key) ? child : { anyOf: [child, { type: 'null' }] }];
    }));
    result['required'] = Object.keys(properties);
    result['additionalProperties'] = false;
  }
  if (schema['items']) result['items'] = codexOutputSchema(object(schema['items']));
  return result;
}

export function restoreOptionalFields(value: unknown, schema: JsonSchema): unknown {
  if (Array.isArray(value)) return value.map((entry) => restoreOptionalFields(entry, object(schema['items'])));
  if (!value || typeof value !== 'object') return value;
  const properties = object(schema['properties']);
  const required = schema['required'] as string[] | undefined;
  return Object.fromEntries(Object.entries(value).filter(([key, child]) => !(key in properties && child === null && !required?.includes(key)))
    .map(([key, child]) => [key, restoreOptionalFields(child, object(properties[key]))]));
}

export function codexSupervisorConfig(mender: boolean): Record<string, unknown> {
  const disabled: readonly string[] = mender
    ? CODEX_TEXT_ONLY_DISABLED_FEATURES.filter((feature) => feature !== 'shell_tool' && feature !== 'unified_exec')
    : CODEX_TEXT_ONLY_DISABLED_FEATURES;
  return {
    features: Object.fromEntries(disabled.map((feature) => [feature, false])),
    cli_auth_credentials_store: 'file', forced_login_method: 'chatgpt',
    approval_policy: 'never', allow_login_shell: false, web_search: 'disabled',
    'agents.enabled': false, 'orchestrator.mcp.enabled': false, 'orchestrator.skills.enabled': false,
    'shell_environment_policy.inherit': 'none',
    'shell_environment_policy.ignore_default_excludes': false,
    // The mender uses Docker as its outer boundary. Codex still denies network
    // and host paths to model-authored commands; no bypass flag is used.
    default_permissions: 'atoma-supervisor',
    'permissions.atoma-supervisor.filesystem': { ':root': 'deny', ':minimal': 'read', ':workspace_roots': { '.': mender ? 'write' : 'read' }, ...(mender ? { '/tmp': 'write' } : {}) },
    'permissions.atoma-supervisor.network.enabled': false,
  };
}

export interface CodexSupervisorOptions {
  command: string;
  provider: SupervisorProvider;
  cwd: string;
  prompt: string;
  hardening: string;
  schema: JsonSchema;
  timeoutMs: number;
  execute?: typeof runCommand;
  readEvidence?: (args: unknown) => string;
  onLog?: (line: string) => void;
}

export function codexSupervisorConfigArgs(mender: boolean): string[] {
  return Object.entries(codexSupervisorConfig(mender)).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]);
}

/** One ephemeral app-server thread; dynamic reads never execute model commands. */
export async function runCodexSupervisor(options: CodexSupervisorOptions): Promise<ClaudeSessionResult> {
  const mender = !options.readEvidence;
  const originalHome = options.provider.codexHome ?? join(homedir(), '.codex');
  const release = await acquireCodexHomeLease(originalHome, AbortSignal.timeout(options.timeoutMs));
  const temporary = mkdtempSync(join(tmpdir(), 'atoma-supervisor-'));
  const profile = join(temporary, 'profile');
  const jail = join(temporary, 'jail');
  mkdirSync(profile); mkdirSync(jail);
  const originalAuth = join(originalHome, 'auth.json');
  const authFile = join(profile, 'auth.json');
  let started = false;
  try {
    const auth = object(JSON.parse(readFileSync(originalAuth, 'utf8')));
    if (!object(auth['tokens'])['refresh_token'] || auth['OPENAI_API_KEY'] || auth['auth_mode'] === 'apikey') {
      throw new Error('Supervisor requires a ChatGPT subscription login, not an OpenAI API key');
    }
    copyFileSync(originalAuth, authFile);
    const env = codexChildEnvironment({ ...process.env, CODEX_HOME: profile, CODEX_SQLITE_HOME: profile });
    // No personal config, plugins, rules or MCP registrations enter this fresh profile.
    const config = codexSupervisorConfig(mender);
    const args = ['app-server', '--strict-config', ...codexSupervisorConfigArgs(mender)];
    let text = '';
    let threadId: string | null = null;
    let model: string | null = null;
    let done = false;
    let failed = false;
    let tokenUsage: Record<string, unknown> | null = null;
    let protocolError: string | null = null;
    const startedAt = Date.now();
    started = true;
    const result = await (options.execute ?? runCommand)(options.command, args, {
      cwd: mender ? options.cwd : jail, env, timeoutMs: options.timeoutMs,
      ...(mender ? { codexHome: profile } : {}),
      ...(options.onLog ? { onLog: options.onLog } : {}),
      input: `${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'atoma-supervisor', version: '1' }, capabilities: { experimentalApi: true } } })}\n`,
      onLine(line, send, end) {
        try {
          const message = object(JSON.parse(line));
          const response = object(message['result']);
          const params = object(message['params']);
          if (message['error']) { failed = true; protocolError = 'Codex rejected the supervisor protocol/configuration'; end(); return; }
          if (message['id'] === 1 && !message['method']) {
            send({ method: 'initialized' });
            send({ id: 2, method: 'thread/start', params: {
              model: options.provider.model, cwd: mender ? '/work' : jail, ephemeral: true,
              approvalPolicy: 'never', baseInstructions: options.hardening,
              config, ...(options.readEvidence ? { dynamicTools: [CODEX_EVIDENCE_TOOL] } : {}),
            } });
          } else if (message['id'] === 2 && !message['method']) {
            threadId = String(object(response['thread'])['id']);
            model = typeof response['model'] === 'string' ? response['model'] : null;
            send({ id: 3, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: options.prompt }], outputSchema: codexOutputSchema(options.schema) } });
          } else if (message['method'] === 'item/tool/call') {
            let output = 'Tool unavailable'; let success = false;
            try {
              if (params['tool'] !== CODEX_EVIDENCE_TOOL.name || !options.readEvidence) throw new Error('Tool unavailable');
              output = options.readEvidence(params['arguments']); success = true;
            } catch { output = 'Evidence request refused: use an available path and bounded read arguments.'; }
            send({ id: message['id'], result: { contentItems: [{ type: 'inputText', text: output }], success } });
          } else if (message['method'] && message['id'] !== undefined) {
            send({ id: message['id'], error: { code: -32601, message: 'Supervisor does not grant approvals or additional tools' } });
          } else if (message['method'] === 'item/completed') {
            const item = object(params['item']);
            if (item['type'] === 'agentMessage' && typeof item['text'] === 'string') text = item['text'];
          } else if (message['method'] === 'thread/tokenUsage/updated') {
            tokenUsage = object(object(params['tokenUsage'])['total']);
          } else if (message['method'] === 'turn/completed') {
            done = true; failed = object(params['turn'])['status'] !== 'completed'; end();
          }
        } catch { failed = true; protocolError = 'Invalid Codex supervisor protocol response'; end(); }
      },
    });
    options.onLog?.('Codex subscription session: wall-clock bounded; USD budget is unsupported and cost is unreported');
    const tokens = object(tokenUsage);
    const count = (key: string): number => typeof tokens[key] === 'number' ? tokens[key] : 0;
    return {
      ...result, code: result.code === 0 && done && !failed ? 0 : result.code || 1,
      stderr: protocolError ?? result.stderr, wrapper: null,
      structured: restoreOptionalFields(parseLooseJson(text), options.schema),
      usage: { costUsd: null, durationMs: Date.now() - startedAt, turns: done ? 1 : null, sessionId: threadId,
        served: model && tokenUsage ? [{ model, costUsd: null, inputTokens: Math.max(0, count('inputTokens') - count('cachedInputTokens')),
          outputTokens: count('outputTokens'), cacheReadInputTokens: count('cachedInputTokens'), cacheCreationInputTokens: 0 }] : null },
    };
  } finally {
    try {
      // The executor reaps the child/container before returning, including timeout.
      // Preserve a rotated refresh token under the same HOME lease, on failures too.
      if (started && existsSync(authFile)) {
        persistCodexAuth(authFile, originalHome, originalAuth);
      }
    } finally { rmSync(temporary, { recursive: true, force: true }); release(); }
  }
}

function persistCodexAuth(authFile: string, home: string, destination: string): void {
  const renewed = object(JSON.parse(readFileSync(authFile, 'utf8')));
  if (!object(renewed['tokens'])['refresh_token'] || renewed['OPENAI_API_KEY']) throw new Error('Invalid refreshed ChatGPT credentials');
  const staging = join(home, 'auth.atoma-refresh.tmp');
  writeFileSync(staging, readFileSync(authFile), { mode: 0o600 });
  renameSync(staging, destination);
}

/** TOML inline values, not JSON objects (which are invalid TOML config overrides). */
function toml(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) return `{${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}=${toml(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
