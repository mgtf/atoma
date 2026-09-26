# Reproductions — revue de code du 25 septembre 2026

Ces reproductions documentent la révision `149f141`, avant toute correction.
Elles étayent les findings de la [revue du 25 septembre](../code-review-2026-09-25.md) ;
ce ne sont pas des résultats attendus d'une future suite de non-régression.
Référence : `149f1416d78bee852f02d8f80dd105f34416dba7`.

Elles ont été exécutées sous Node `v24.20.0` (`.nvmrc`), dépendances installées,
depuis la racine du dépôt. Elles appellent les fonctions de production ; les
modèles sont le `MockLlmClient` du dépôt ou des fixtures, les stores sont des
fichiers temporaires sous `os.tmpdir()`, et les serveurs HTTP n'écoutent que
sur une adresse loopback et un port éphémère. Aucun appel LLM, accès GitHub,
conteneur ni store utilisateur. Aucun script ne modifie le dépôt. Les pins de
tiers de test viennent de `tests/setup-tier-pins.ts` lorsqu'un script en a
besoin.

Chaque script se lance ainsi, depuis la racine, avec le Node de `.nvmrc` :

```bash
node --import tsx --input-type=module < script.mjs
```

Les blocs ci-dessous se collent dans un fichier, ou directement dans un
heredoc (`node --import tsx --input-type=module <<'JS' … JS`).

## 1. Ligne de rerun et modèle retiré du catalogue (finding 1.1)

Vrais `AuthStore`, `ProjectStore`, `ProjectRunCoordinator`, `ProjectService` et
`retentionPlan` ; le processus enfant est un pilote de test qui écrit un
livrable, une trace et un épilogue. Le « déploiement suivant » est simulé en
retirant `claude-haiku-4-5` du catalogue en mémoire.

```js
// F3 repro: a persisted comparison rerun row is re-validated against the LIVE
// model catalogue on every read (projectRunSchema.modelOverrides =
// runTierModelsSchema, refine isAccountTierSelection). When a later deploy
// retires one of the models the rerun named, the row stops parsing and takes
// down every reader that lists the project's runs.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AuthStore } from './src/auth/store.ts';
import { formatRunStatsEpilogue } from './src/contracts/runStats.ts';
import { closeStoreHandles } from './src/core/stores.ts';
import { LLM_PROVIDER_CATALOG } from './src/core/providerCatalog.ts';
import { ProjectRunCoordinator } from './src/projects/coordinator.ts';
import { ProjectService } from './src/projects/service.ts';
import { ProjectStore } from './src/projects/store.ts';
import { retentionPlan } from './src/projects/retention.ts';
import { haystackTestEnvironment } from './tests/helpers/haystack.ts';
import { ANTHROPIC_PINS } from './tests/tier-pins.ts';

import { tmpdir } from 'node:os';
const root = mkdtempSync(join(tmpdir(), 'rerun-retired-'));
const dbPath = join(root, 'atoma.db');
const DELIVERED = {
  outcome: 'delivered', costUsd: 0.01, llmCalls: 1, opusCalls: 1, sonnetCalls: 0, haikuCalls: 0,
  otherCalls: 0, deterministicPhases: 0, deepenings: 0, rootRemediations: 0, landingReasons: [],
  escalations: 0, learnedSkills: 0, learnedEventSkills: 0, promotions: 0, refusals: 0,
  compileErrors: 0, demotions: 0, dispatchFallbacks: 0, uncoveredObligations: 0,
};
const OVERRIDES = {
  l1: 'api:anthropic:claude-haiku-4-5',
  l2: 'api:anthropic:claude-sonnet-4-5',
  l3: 'api:anthropic:claude-opus-4-5',
};
const auth = AuthStore.open(dbPath);
const login = auth.completeLogin({ provider: 'github', subject: 'owner', displayName: 'Owner', email: null, emailVerified: false }, null);
const viewer = login.viewer;
const { orgId, principalId } = viewer;
const store = ProjectStore.open(dbPath);
const project = store.createProject({ orgId, principalId, project: {
  name: 'Clock', slug: 'clock', initialPrompt: 'Build a clock.',
  repositoryTarget: { installationId: '123', owner: 'owner', name: 'clock', visibility: 'private' },
} });
const driver = async (options) => {
  const env = options.env ?? {};
  const runId = env['ATOMA_RUN_ID'];
  mkdirSync(env['ATOMA_BUILD_WORKSPACE'], { recursive: true });
  mkdirSync(env['ATOMA_RUNS_DIR'], { recursive: true });
  writeFileSync(join(env['ATOMA_BUILD_WORKSPACE'], 'index.html'), `<h1>${runId}</h1>`);
  writeFileSync(env['ATOMA_ARTIFACT_MANIFEST_PATH'], JSON.stringify({ version: 1, runId, generatedAt: new Date().toISOString(), outputs: ['index.html'] }));
  writeFileSync(join(env['ATOMA_RUNS_DIR'], `${runId}.json`), JSON.stringify({ id: runId, endedAt: new Date().toISOString(), result: { summary: 'verified' }, events: [] }));
  return formatRunStatsEpilogue(DELIVERED) + '\n✓ build finished\n';
};
const coordinator = new ProjectRunCoordinator({
  store, dbPath, projectsRoot: root, skillsDir: join(root, 'skills'),
  hostEnv: { ...haystackTestEnvironment(root), PATH: process.env['PATH'], ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'model-key' },
  driver,
  acquireLease: async () => ({ path: '/test/lease', attachChild() {}, release() {} }),
  publisher: { publish: async () => undefined },
});
const service = new ProjectService({ store, coordinator, github: null });
const start = async (request) => {
  const run = await coordinator.start({ orgId, principalId, projectId: project.projectId, request });
  await coordinator.waitForIdle();
  return store.getProjectRun(orgId, run.projectRunId);
};
const attempt = (label, fn) => {
  try { const value = fn(); console.log(label, '-> ok', value === undefined ? '' : JSON.stringify(value).slice(0, 120)); }
  catch (error) { console.log(label, '-> THROWS', `${error.name}: ${String(error.message).replace(/\s+/g, ' ').slice(0, 220)}`); }
};

await start({ idempotencyKey: 'r0', goal: 'Build a clock.' });
const a = await start({ idempotencyKey: 'a', goal: 'Add a timezone selector.' });
const b = await start({ idempotencyKey: 'b', rerunOf: a.projectRunId, models: OVERRIDES });
console.log('rerun', b.status, 'models', JSON.stringify(b.modelOverrides));
attempt('BEFORE: store.listProjectRuns', () => store.listProjectRuns(orgId, project.projectId).length);

// The next deploy's catalogue no longer offers claude-haiku-4-5 (a retired model).
const anthropic = LLM_PROVIDER_CATALOG.find((provider) => provider.id === 'anthropic');
anthropic.models.splice(anthropic.models.findIndex((model) => model.id === 'claude-haiku-4-5'), 1);

attempt('AFTER: store.getProjectRun(rerun)', () => store.getProjectRun(orgId, b.projectRunId).status);
attempt('AFTER: store.listProjectRuns', () => store.listProjectRuns(orgId, project.projectId).length);
attempt('AFTER: service.listProjectRuns (GET /api/projects/:id/runs, MCP atoma_project_runs)', () => service.listProjectRuns(viewer, project.projectId).length);
const db = new Database(dbPath);
attempt('AFTER: retentionPlan (offline retention, all orgs)', () => retentionPlan(db, root, undefined, new Date(Date.now() + 100 * 86_400_000)).length);
db.close();
// An ordinary run of the same project, on the host pins (unaffected models):
const c = await start({ idempotencyKey: 'c', goal: 'Add an alarm.' });
console.log('AFTER: next ordinary run of the project ->', c.status, '|', String(c.error).replace(/\s+/g, ' ').slice(0, 200));
closeStoreHandles();
```

Sortie observée :

```text
rerun delivered models {"l1":"api:anthropic:claude-haiku-4-5","l2":"api:anthropic:claude-sonnet-4-5","l3":"api:anthropic:claude-opus-4-5"}
BEFORE: store.listProjectRuns -> ok 3
AFTER: store.getProjectRun(rerun) -> THROWS ZodError: [ { "code": "custom", "message": "must be a catalogue model or an account subscription available to this tier", "path": [ "modelOverrides", "l1" ] } ]
AFTER: store.listProjectRuns -> THROWS ZodError: [ { "code": "custom", "message": "must be a catalogue model or an account subscription available to this tier", "path": [ "modelOverrides", "l1" ] } ]
AFTER: service.listProjectRuns (GET /api/projects/:id/runs, MCP atoma_project_runs) -> THROWS ZodError: [ { "code": "custom", "message": "must be a catalogue model or an account subscription available to this tier", "path": [ "modelOverrides", "l1" ] } ]
AFTER: retentionPlan (offline retention, all orgs) -> THROWS ZodError: [ { "code": "custom", "message": "must be a catalogue model or an account subscription available to this tier", "path": [ "modelOverrides", "l1" ] } ]
AFTER: next ordinary run of the project -> failed | [ { "code": "custom", "message": "must be a catalogue model or an account subscription available to this tier", "path": [ "modelOverrides", "l1" ] } ]
```

## 2. Travail fini perdu à la deadline hors de la branche landed (finding 1.2)

Vrais `runDepthTask`, `acceptRootResult` et `llmVerdict`. Cas A et B : même
minutage, la deadline tombe pendant le verdict racine, sur un résultat complet
puis sur un résultat landed. Cas C et D : un résultat complet est refusé ; avec
90 s restantes, la remédiation s'ouvre et la deadline la coupe avant sa
première phase ; avec 50 s, aucune remédiation.

```js
import './tests/setup-tier-pins.ts';
// Repro: root acceptance straddling the run deadline.
// Same production runDepthTask + acceptRootResult + llmVerdict; only the LLM is mocked.
// Case A: COMPLETE result (no unfinished phase) returned before the deadline; the
//         deadline fires while the root verdict is in progress (the verdict itself approves).
// Case B: identical, but the result LANDED (one unfinished phase).
import { createHash } from 'node:crypto';
import { Atom } from './src/core/atom.ts';
import { createAttestationLog } from './src/core/attestation.ts';
import { MockLlmClient } from './src/core/llm.ts';
import { DEFAULT_LIMITS } from './src/core/limits.ts';
import { runDepthTask } from './src/run/depth.ts';
import { markLanded } from './src/atoms/dispatch.ts';
import { makePlan, makeTools } from './tests/helpers/factories.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
class Executor {
  files = { 'index.html': '<button>Click</button>' };
  has(name) { return ['read_file', 'validate_html'].includes(name); }
  async execute(name, args) {
    const path = typeof args.path === 'string' ? args.path : 'index.html';
    if (name === 'read_file') { if (!(path in this.files)) throw new Error('ENOENT'); return { content: this.files[path] }; }
    return { ok: true, url: 'http://localhost:5050/', errors: [], warnings: [], failedRequests: [], interactionLog: ['click'],
      requestedInteractions: 1, ignoredInteractions: 0, document: { path, sha256: createHash('sha256').update(this.files[path]).digest('hex') } };
  }
}
class Actor extends Atom {
  tier = 2; model = 'test';
  constructor() { super({ name: 'actor-2', ordinal: 1, systemPrompt: '', tools: makeTools(['read_file', 'validate_html']), params: {} }); }
  async plan() { return makePlan(); }
  async execute() { return result; }
  async validatePlan() { return { approved: true, reasoning: 'ok' }; }
  async validateResult() { return { approved: true, reasoning: 'ok' }; }
}
const task = { description: 'Build the page' };
const result = { output: { complete: true }, summary: 'Done', trace: [], producedBy: { tier: 2, name: 'actor-2', viaFallback: false } };

async function scenario(label, landed) {
  const deadline = new AbortController();
  const llm = new MockLlmClient();
  // The root verdict call: the run deadline fires while it is in flight, then the verdict APPROVES.
  llm.enqueue(async (req) => {
    deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    await new Promise((r) => setTimeout(r, 20));
    return { text: JSON.stringify({ approved: true, reasoning: 'delivery verified' }), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
  });
  const ctx = { llm, logger: silent, signal: deadline.signal, limits: DEFAULT_LIMITS, tools: new Executor(),
    attempt: 1, attestations: createAttestationLog(), deadlineAt: Date.now() + 5_000 };
  const accepted = [];
  try {
    const out = await runDepthTask({ mode: 'short', task, floor: [], ctx, restart: async () => { throw new Error('no restart'); },
      onTopology() {}, onAcceptance: (a) => accepted.push(a.approved),
      createExecutor: () => ({ actor: new Actor(), handle: async () => landed ? markLanded(result, [{ description: 'unfinished' }]) : result }) });
    console.log(label, JSON.stringify({ outcome: 'returned', unfinishedPhases: out.unfinishedPhases ?? [], refusal: out.refusal ?? null, verdictsRecorded: accepted, llmCalls: llm.calls.length }));
  } catch (e) {
    console.log(label, JSON.stringify({ outcome: 'REJECTED (runner records failed)', error: `${e.name}: ${e.message}`, verdictsRecorded: accepted, llmCalls: llm.calls.length }));
  }
}
await scenario('A complete result, deadline during root verdict:', false);
await scenario('B landed result,   deadline during root verdict:', true);

// Case C: a COMPLETE result is REFUSED with 90 s left (> the 60 s phase floor), so one
// remediation pass opens; the deadline cuts that pass before it accepts any phase
// (dispatch rethrows when nothing was accepted). Case D: same, but only 50 s left (< floor).
async function remediation(label, secondsLeft) {
  const deadline = new AbortController();
  const llm = new MockLlmClient();
  llm.enqueueText(JSON.stringify({ approved: false, reasoning: 'root DOM proof missing' }));
  const ctx = { llm, logger: silent, signal: deadline.signal, limits: DEFAULT_LIMITS, tools: new Executor(),
    attempt: 1, attestations: createAttestationLog(), deadlineAt: Date.now() + secondsLeft * 1000 };
  const accepted = [];
  let passes = 0;
  try {
    const out = await runDepthTask({ mode: 'short', task, floor: [], ctx, restart: async () => { throw new Error('no restart'); },
      onTopology() {}, onAcceptance: (a) => accepted.push(a.approved),
      createExecutor: () => ({ actor: new Actor(), handle: async (_t, c) => {
        passes += 1;
        if (passes === 1) return result;
        deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        c.signal.throwIfAborted();
      } }) });
    console.log(label, JSON.stringify({ outcome: 'returned', passes, refusal: out.refusal ?? null, verdictsRecorded: accepted }));
  } catch (e) {
    console.log(label, JSON.stringify({ outcome: 'REJECTED (runner records failed)', passes, error: `${e.name}: ${e.message}`, verdictsRecorded: accepted }));
  }
}
await remediation('C refused complete result, 90 s left:', 90);
await remediation('D refused complete result, 50 s left:', 50);
```

Sortie observée :

```text
A complete result, deadline during root verdict: {"outcome":"REJECTED (runner records failed)","error":"TimeoutError: The operation was aborted due to timeout","verdictsRecorded":[],"llmCalls":1}
B landed result,   deadline during root verdict: {"outcome":"returned","unfinishedPhases":["unfinished"],"refusal":null,"verdictsRecorded":[true],"llmCalls":1}
C refused complete result, 90 s left: {"outcome":"REJECTED (runner records failed)","passes":2,"error":"TimeoutError: The operation was aborted due to timeout","verdictsRecorded":[false]}
D refused complete result, 50 s left: {"outcome":"returned","passes":1,"refusal":"root DOM proof missing","verdictsRecorded":[false]}
```

« REJECTED » signifie que `runDepthTask` rejette : le runner enregistre alors
`failed` (`src/run/runner.ts:1203-1250`).

## 3. Appels MCP en cours et éviction (finding 1.3)

Vrai `McpHttpHost` et SDK MCP installé, sur HTTP réel. L'horloge de l'hôte est
contrôlée et le balayeur est appelé directement. Le témoin garde son POST
connecté ; « resumed » coupe le flux après l'événement d'amorçage et reprend par
GET `Last-Event-ID`, comme le contrat de rejeu le prévoit ; « evicted » fixe le
plafond par caller à 2.

```js
// 1.4 closure probe: a long tools/call must keep its session until it answers.
//  control : the POST stays connected                          -> survives the idle sweep (the fix)
//  resumed : the POST SSE stream is cut after its priming event, the client resumes with
//            GET + Last-Event-ID (the documented replay contract) -> ?
//  evicted : same caller opens sessions past its ceiling while its oldest session is the busy one -> ?
import { McpHttpHost } from './src/mcp/http.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer, request } from 'node:http';

let now = 0;
let host;
const gates = [];
const server = createServer((req, res) => { void host.handle(req, res).catch(() => res.destroy()); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
function makeHost(maxSessionsPerCaller = 8) {
  return new McpHttpHost({
    now: () => now, resolveCaller: () => ({ kind: 'operator' }), allowedHosts: [`127.0.0.1:${port}`], maxSessionsPerCaller,
    buildServer: () => {
      const s = new McpServer({ name: 'probe', version: '0' });
      s.registerTool('slow', {}, async () => { await new Promise((r) => gates.push(r)); return { content: [{ type: 'text', text: 'FINISHED-RESULT' }] }; });
      return s;
    },
  });
}
const PV = '2025-11-25';
const base = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
function send(method, headers, body, onChunk) {
  let resolve; const done = new Promise((r) => { resolve = r; });
  const req = request({ host: '127.0.0.1', port, path: '/mcp', method, headers }, (res) => {
    let text = ''; res.on('data', (c) => { text += c; onChunk?.(text, req); });
    res.on('end', () => resolve({ status: res.statusCode, id: res.headers['mcp-session-id'], text }));
    res.on('aborted', () => resolve({ status: res.statusCode, text, aborted: true }));
    res.on('error', () => resolve({ status: res.statusCode, text, error: true }));
  });
  req.on('error', (e) => resolve({ error: e.code ?? e.message }));
  req.end(body);
  return done;
}
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
async function initialize() {
  const r = await send('POST', base, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PV, capabilities: {}, clientInfo: { name: 'p', version: '0' } } }));
  const h = { ...base, 'mcp-session-id': r.id, 'mcp-protocol-version': PV };
  await send('POST', h, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  return h;
}
const callBody = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } });
const state = () => { const x = host.health(); return `sessions=${x.sessions} evicted=${x.evicted}`; };

// control
host = makeHost();
let h1 = await initialize();
let pending = send('POST', h1, callBody);
await tick(); now = 31 * 60_000; await host.sweep(30 * 60_000);
console.log('control  after 31 min idle sweep:', state());
gates.shift()(); console.log('control  response contains result:', (await pending).text.includes('FINISHED-RESULT'));
await host.close();

// resumed
now = 0; host = makeHost();
h1 = await initialize();
let eventId;
const cut = send('POST', h1, callBody, (text, req) => { const m = /id: (\S+)/.exec(text); if (m && !eventId) { eventId = m[1]; req.destroy(); } });
await cut; await tick();
const resumed = send('GET', { ...h1, accept: 'text/event-stream', 'last-event-id': eventId });
await tick();
console.log('resumed  priming id:', eventId, 'resumed GET open, tool still pending:', gates.length === 1, state());
now = 31 * 60_000; await host.sweep(30 * 60_000);
console.log('resumed  after 31 min idle sweep:', state());
gates.shift()(); await tick();
const r = await Promise.race([resumed, tick(500).then(() => ({ text: '(stream still open)' }))]);
console.log('resumed  replayed stream carried the result:', r.text.includes('FINISHED-RESULT'), JSON.stringify(r.text.slice(0, 60)));
const again = await send('GET', { ...h1, accept: 'text/event-stream', 'last-event-id': eventId });
console.log('resumed  second resume attempt:', again.status, again.text.slice(0, 70));
await host.close();

// evicted (per-caller ceiling 2)
now = 0; host = makeHost(2);
const busy = await initialize();
now = 1_000; const busyCall = send('POST', busy, callBody); await tick();
now = 2_000; const idle = await initialize();
now = 3_000; await initialize();
console.log('evicted  third initialize by same caller:', state());
const busyResult = await Promise.race([busyCall, tick(500).then(() => ({ text: '(still open)' }))]);
const idleProbe = await send('POST', idle, JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }));
console.log('evicted  busy call response:', JSON.stringify(busyResult.text.slice(0, 60)), '| idle session still answers:', idleProbe.status);
for (const g of gates.splice(0)) g();
await host.close(); server.closeAllConnections(); await new Promise((r) => server.close(r));
```

Sortie observée :

```text
control  after 31 min idle sweep: sessions=1 evicted=0
control  response contains result: true
resumed  priming id: 00000003 resumed GET open, tool still pending: true sessions=1 evicted=0
resumed  after 31 min idle sweep: sessions=0 evicted=0
resumed  replayed stream carried the result: false ""
resumed  second resume attempt: 404 {"jsonrpc":"2.0","error":{"code":-32001,"message":"unknown or expired
evicted  third initialize by same caller: sessions=2 evicted=1
evicted  busy call response: "id: 00000003\ndata: \n\n" | idle session still answers: 200
```

## 4. Sondes du superviseur attestées comme preuves de l'enfant (finding 1.4)

Vrai chemin `L2Atom.handleDirect` → `forkBranch` → `superviseLoop` → L1 →
`validateResult`, registre en mémoire, LLM simulé piloté par rôle. L'enfant
écrit ses fichiers et appelle `validate_html` une fois (interactions
filtrées) ; il ne lit aucun fichier lui-même. `REJECTS` fixe le nombre de
verdicts de résultat refusés.

```js
// Same production path as supervisor-reads.mjs, role-driven so N rejected cycles can be run.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtomRegistry } from './src/registry/atomRegistry.ts';
import { openDb } from './src/registry/db.ts';
import { L2Atom } from './src/atoms/L2Atom.ts';
import { SkillRegistry } from './src/skills/registry.ts';
import { makeCtx, jsonText } from './tests/helpers.ts';

process.env.ATOMA_MODEL_L1 ??= 'api:anthropic:claude-haiku-4-5-20251001';
process.env.ATOMA_MODEL_L2 ??= 'api:anthropic:claude-sonnet-4-5';
process.env.ATOMA_MODEL_L3 ??= 'api:anthropic:claude-opus-4-1';
process.env.ATOMA_SKILL_LEARN = '0';
const REJECTS = Number(process.env.REJECTS ?? '2');

const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
const dir = mkdtempSync(join(tmpdir(), 'atoma-audit-'));
try {
  const skills = new SkillRegistry(dir);
  const reg = new AtomRegistry(openDb(':memory:'));
  const seed = { description: 'orchestrator', systemPrompt: 'You are an L2.', tools: [], params: {}, createdBy: 'test' };
  reg.create(2, seed);
  const names = ['write_file', 'read_file', 'fetch_url', 'start_node_server', 'validate_html'];
  const l1 = reg.create(1, { ...seed, description: 'full stack builder', systemPrompt: 'You are an L1.', tools: names.map(tool) });
  const files = {};
  const executed = [];
  const base = {
    has: (n) => names.includes(n) || n === 'list_files',
    execute: async (name, args) => {
      executed.push(name);
      if (name === 'write_file') { files[args.path] = args.content; return { ok: true }; }
      if (name === 'read_file') {
        if (!(args.path in files)) throw new Error(`ENOENT ${args.path}`);
        return { path: args.path, content: files[args.path] };
      }
      if (name === 'list_files') return { path: '.', entries: Object.keys(files).map((n) => ({ name: n, kind: 'file' })) };
      if (name === 'validate_html') return { ok: true, errors: [], failedRequests: [], interactionLog: [],
        requestedInteractions: 8, ignoredInteractions: 8, smokeResult: { ok: true } };
      if (name === 'fetch_url') return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
      return { ok: true };
    },
  };
  const ctx = { ...makeCtx(), tools: base };
  const big = (label) => `// ${label}\n` + 'export const value = 1; '.repeat(120);
  let executes = 0;
  let resultVerdicts = 0;
  const roles = [];
  const turn = async (req) => {
    roles.push(`${req.role}@${req.actor?.tier}`);
    let reply;
    if (req.role === 'prefilter') reply = { kind: 'reuse', target: l1.name, confidence: 'high', reasoning: 't' };
    else if (req.role === 'plan' && req.actor?.tier === 1) reply = { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' };
    else if (req.role === 'validate-plan') reply = { approved: true, reasoning: 'plan ok' };
    else if (req.role === 'execute') {
      executes += 1;
      if (executes === 1) {
        for (const f of ['index.html', 'server.js', 'a.js', 'b.js', 'c.js', 'd.js']) {
          await req.executor.execute('write_file', { path: f, content: big(f) });
        }
        await req.executor.execute('validate_html', { url: 'http://localhost:5051/',
          interactions: Array.from({ length: 8 }, () => ({ type: 'click', selector: '#b' })), smoke: '({ok:true})' });
      } else {
        await req.executor.execute('write_file', { path: 'a.js', content: big(`a.js v${executes}`) });
      }
      reply = { output: { url: 'http://localhost:5051/api', files: ['index.html', 'server.js', 'a.js', 'b.js', 'c.js', 'd.js'] },
        summary: `cycle ${executes} done` };
    } else if (req.role === 'validate-result') {
      resultVerdicts += 1;
      reply = resultVerdicts <= REJECTS
        ? { approved: false, reasoning: `distinct gap ${resultVerdicts} in module ${'abcdefgh'[resultVerdicts]}`, scope: 'ephemeral', modifications: {} }
        : { approved: true, reasoning: 'ok' };
    } else throw new Error(`unexpected role ${req.role}@${req.actor?.tier} after ${roles.join(',')}`);
    return { text: jsonText(reply), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  for (let i = 0; i < 40; i++) ctx.llm.enqueue(turn);
  const l2 = L2Atom.fromType(reg.getByName('Tracheid'), reg, [], skills);
  await l2.handleDirect({ description: 'Build an app' }, ctx);
  const resultPrompts = ctx.llm.calls.filter((c) => c.role === 'validate-result');
  const last = resultPrompts.at(-1).userContent;
  const block = last.slice(last.indexOf('== TRANSPORT-OBSERVED TOOL EVIDENCE =='));
  const lines = block.split('\n').filter((l) => /^[0-9a-f-]{36}: /.test(l));
  console.log(JSON.stringify({ rejects: REJECTS, childCycles: executes,
    evidenceLinesShown: lines.length, readFileLines: lines.filter((l) => l.includes(': read_file (')).length,
    omission: (block.match(/\d+ earlier observations omitted/) ?? [null])[0],
    childBrowserObservationShown: /FILTERED=8/.test(block) }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
```

Sorties observées, avec `REJECTS=2` puis `REJECTS=3` :

```text
{"rejects":2,"childCycles":3,"evidenceLinesShown":15,"readFileLines":12,"omission":null,"childBrowserObservationShown":true}
{"rejects":3,"childCycles":4,"evidenceLinesShown":16,"readFileLines":13,"omission":"6 earlier observations omitted","childBrowserObservationShown":false}
```

## 5. Grammaire des critères approuvés (finding 1.5)

Vrais `parseChecklistLines`, `captureAcceptanceSpec`, `coverAcceptanceChecklist`
et `renderChecklistCoverage`. Les observations sont celles d'un run qui n'a
exercé que les chemins nominaux.

```js
import {
  parseChecklistLines, coverAcceptanceChecklist, renderChecklistCoverage,
} from './src/contracts/acceptanceChecklist.ts';
import { captureAcceptanceSpec } from './src/run/acceptanceSpec.ts';

const lines = [
  'POST /api/notes returns 400 for invalid input',
  'GET /api/notes/:id — 404 for an unknown id',
  'DELETE /api/notes/:id: 404 when it does not exist',
  'GET /api/notes/:id 404 — an unknown id is refused',
].join('\n');
const parsed = parseChecklistLines(lines);
console.log('errors:', JSON.stringify(parsed.errors));
console.log('items:', JSON.stringify(parsed.items, null, 0));
const spec = captureAcceptanceSpec(parsed.items);
// What a run that only exercised the happy paths would have observed:
const observations = [
  { eventId: 'e1', http: { method: 'POST', path: '/api/notes', status: 201 } },
  { eventId: 'e2', http: { method: 'GET', path: '/api/notes/1', status: 200 } },
  { eventId: 'e3', http: { method: 'DELETE', path: '/api/notes/1', status: 204 } },
];
const coverage = coverAcceptanceChecklist(spec.items, observations);
console.log(renderChecklistCoverage(spec.items, coverage, { source: 'user' }));
```

Sortie observée :

```text
errors: []
items: [{"behaviour":"returns 400 for invalid input","check":{"kind":"http","method":"POST","path":"/api/notes"}},{"behaviour":"404 for an unknown id","check":{"kind":"http","method":"GET","path":"/api/notes/:id"}},{"behaviour":"when it does not exist","check":{"kind":"http","method":"DELETE","path":"/api/notes/:id","status":404}},{"behaviour":"an unknown id is refused","check":{"kind":"http","method":"GET","path":"/api/notes/:id","status":404}}]
ACCEPTANCE CRITERIA — approved by the user before launch; the host captured them and no model wrote them.
They are what the user asked this delivery to show. This block decides nothing by itself: judge each one.
OBSERVED / NOT OBSERVED are mechanical: whether THIS attempt made
that request through fetch_url to a server it started, and got that status. OBSERVED is status only,
not bound to the current bytes. NOT OBSERVED means no such request was seen — a request made with
run_shell is invisible here — not that the behaviour is broken; weigh it with the rest of the evidence.
REVIEW items are yours to judge against the evidence.
- [OBSERVED] c1 returns 400 for invalid input (POST /api/notes → 2xx)
- [OBSERVED] c2 404 for an unknown id (GET /api/notes/:id → 2xx)
- [NOT OBSERVED] c3 when it does not exist (DELETE /api/notes/:id → 404)
- [NOT OBSERVED] c4 an unknown id is refused (GET /api/notes/:id → 404)
```

## 6. Viewport absent de la preuve attestée (finding 1.6)

Vrais `parseBrowserObservation` et `renderObservation`, sur la forme exacte que
`validate_html` renvoie à `149f141` pour un succès à 320 px et à 800 px.

```js
// Does the supervisor-facing attestation carry the viewport validate_html now reports?
import { parseBrowserObservation, renderObservation } from './src/contracts/attestation.ts';

const make = (width) => {
  const args = { url: 'http://localhost:4000/', viewport: { width }, smoke: '(() => ({ ok: document.documentElement.scrollWidth <= innerWidth }))()' };
  // The shape validate_html returns on its success path at HEAD (builtin.ts:2047-2065).
  const result = {
    ok: true, url: args.url, title: 't', errors: [], warnings: [], failedRequests: [], interactionLog: [],
    requestedInteractions: 0, ignoredInteractions: 0,
    viewport: { width, height: 600 },
    document: { path: 'index.html', sha256: 'a'.repeat(64) },
    smokeResult: { ok: true },
  };
  const observation = parseBrowserObservation(args, result);
  return { observation, line: renderObservation({ eventId: 'e', tool: 'validate_html', observation }) };
};

const at320 = make(320);
const at800 = make(800);
console.log('observation keys  :', Object.keys(at320.observation).join(','));
console.log('has viewport      :', 'viewport' in at320.observation);
console.log('validator line 320:', at320.line);
console.log('validator line 800:', at800.line);
console.log('identical lines   :', at320.line === at800.line);
```

Sortie observée :

```text
observation keys  : kind,ok,url,requestedInteractions,ignoredInteractions,executedInteractions,smoke,smokeResult,consoleErrors,failedRequests,document
has viewport      : false
validator line 320: validate_html: ok=true, requested=0, executed=0, doc=index.html, consoleErrors=0, failedRequests=0, smokeResult={"ok":true}
validator line 800: validate_html: ok=true, requested=0, executed=0, doc=index.html, consoleErrors=0, failedRequests=0, smokeResult={"ok":true}
identical lines   : true
```

## 7. Recherche documentaire après approfondissement (finding 1.7)

Vrais `withProjectRetrievalBackend` et `localToolBackend`. Le service reproduit
le verrou de `openProjectRunHaystack` (`dispose()` pose `closed`, `authorize()`
renvoie `!closed && …`) ; le redémarrage est réduit à ses appels de backend.

```js
// The runner's deepening restart, reduced to its backend calls (src/run/runner.ts restart):
//   await backend.drain(); prepareWorkspace; seed(); backend = await makeBackend();
// where makeBackend wraps a fresh tool backend with the SAME `retrievalBinding`.
// The service below reproduces the latch of openProjectRunHaystack
// (src/projects/retrievalHaystackLaunch.ts): dispose() sets closed=true, authorize() returns !closed && ...
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localToolBackend, withProjectRetrievalBackend } from './src/run/toolBackend.ts';
import { silentLogger } from './tests/helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'atoma-audit-retrieval-'));
try {
  let closed = false;
  let disposals = 0;
  const binding = {
    scope: { kind: 'tenant', orgId: 'org_1', projectId: 'prj_1', runId: 'run_1', principalId: 'usr_1', corpusId: 'c1', snapshotId: 's1', snapshotSha256: 'a'.repeat(64), generation: 'b'.repeat(64) },
    service: {
      authorize: async () => !closed,
      search: async () => ({ ok: true, status: 'ok', corpusId: 'c1', snapshotId: 's1', snapshotSha256: 'a'.repeat(64), generation: 'b'.repeat(64), passages: [], truncated: false }),
      dispose: async () => { closed = true; disposals += 1; },
    },
  };
  const context = { signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 };
  const make = () => withProjectRetrievalBackend(localToolBackend({ workspaceRoot: join(root, 'ws'), logger: silentLogger() }), binding, context);
  let backend = await make();
  const name = backend.toolDecls.find((t) => /retriev|search/i.test(t.name))?.name;
  const before = await backend.executor.execute(name, { query: 'invoice schema' });
  await backend.drain();              // restart step 1
  backend = await make();             // restart step 4: same binding
  const after = await backend.executor.execute(name, { query: 'invoice schema' });
  console.log(JSON.stringify({ tool: name, attempt1: { ok: before.ok, status: before.status }, disposalsAtRestart: disposals, attempt2: after }));
  await backend.cleanup();
} catch (e) {
  console.log('error', e.message);
} finally {
  rmSync(root, { recursive: true, force: true });
}
```

Sortie observée :

```text
{"tool":"search_project_docs","attempt1":{"ok":true,"status":"ok"},"disposalsAtRestart":1,"attempt2":{"ok":false,"status":"denied"}}
```

## 8. Rerun d'une origine dont la trace a disparu (LOW 2.1)

Vrai `resolveRerunOrigin`, sur une ligne `ProjectRun` valide selon le schéma :
premier run du projet (`seed: none`), octets expirés, dossier de traces vide.

```js
// A comparison rerun of an origin that drafted its own list, after retention
// deleted the origin's run directory (traces/ included). Production resolver;
// the store is a two-method fake returning a schema-valid ProjectRun row.
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRerunOrigin } from './src/projects/rerun.ts';
import { projectRunSchema } from './src/contracts/projects.ts';
const root = mkdtempSync(join(tmpdir(), 'rerun-origin-'));
mkdirSync(join(root, 'traces'));                       // empty: the trace is gone
const origin = projectRunSchema.parse({
  projectRunId: randomUUID(), projectId: randomUUID(), orgId: randomUUID(), requestedByPrincipalId: randomUUID(),
  requestKey: 'k1', goal: 'Node API: GET /api/notes lists notes', status: 'delivered',
  bytesExpiredAt: '2026-06-01T00:00:00.000Z',          // retention ran
  hostPaths: { workspacePath: join(root, 'workspace'), runsPath: join(root, 'traces'), logPath: join(root, 'run.log') },
  seed: { kind: 'none' },                              // the project's first run
  traceId: null, stats: null, artifactManifest: null, artifactManifestHash: null, error: null,
  createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z', startedAt: null, endedAt: null,
});
const store = { getProjectRun: (_org, id) => (id === origin.projectRunId ? origin : null), getRunAcceptance: () => null };
const out = resolveRerunOrigin({ store, project: { projectId: origin.projectId, repositoryTarget: {} },
  orgId: origin.orgId, rerunOf: origin.projectRunId, recordedSourceRunId: () => undefined });
console.log(JSON.stringify({ refused: false, seedRun: out.seedRun, acceptance: out.acceptance }));
```

Sortie observée :

```text
{"refused":false,"seedRun":null,"acceptance":null}
```

`acceptance: null` n'écrit aucune ligne `project_run_acceptance` : le runner
enfant appelle alors `draftAcceptanceChecklist` avec les modèles du rerun
(`src/run/runner.ts:899-912`). Avec la vraie rétention (`applyRetention`,
100 jours plus tard), un relecteur a observé : avant rétention, `source:
drafted` transporté ; après, `ACCEPTANCE_SPEC carried: false`.

## 9. Autres défauts LOW, rejoués par l'auteur

Ces scripts de relecture ne sont pas reproduits ici ; les sorties ci-dessous
ont été rejouées le 2026-09-25 sur `149f141`, et chaque mécanisme se vérifie
par lecture aux lignes citées dans le rapport.

- **2.2 — journal du runner servi au rôle viewer.** Transport MCP HTTP réel,
  appelant `org:viewer` (11 outils visibles) : `atoma_run_trace section=log`
  renvoie le journal avec `--seed <chemin absolu>`, `workspace seeded from …`
  et `skills root: …` ; dans la même session, `atoma_skills_list` renvoie
  `skillsDir: "platform-skills"` (nom de base). Le contenu du journal est un
  fixture ; que le runner écrive ces lignes se lit dans `src/run/runner.ts`.
  Pour `publication.error` : `revalidateArtifactManifest` d'un manifeste
  hérité et `readManifestArtifact` renvoient `workspace does not exist:
  <chemin absolu …/orgs/<org>/projects/<projet>/runs/<run>/workspace>`.
- **2.3 — limite de 16 Ko.** Corps de requête de 26 607 octets (limite du
  service : 65 536) ; schéma de l'API : accepté ; capture : 12 items ;
  `encodeAcceptanceSpec` au lancement : « exceeds 16384 bytes » (26 754).
- **2.4 — couverture par regard.** Deux acceptations racine successives,
  aucune requête du travailleur : premier verdict `c1 uncovered`, second
  `- [OBSERVED] c1 lists notes (GET /api/notes → 2xx)`, dont la seule
  observation est la sonde racine de la première passe.
- **2.5 — oscillation et viewport.** 768 ✓, 375 ✗, 320 ✗, puis 1024 : « REFUSED
  as "smoke non-deterministic" before evaluation (ok:false) ».
- **2.6 — analyste résident.** Trois runs en file, fournisseur en refus de
  quota : trois sessions lancées, file vide après le drain, trois échecs
  comptés.
- **2.7 — guidage d'un rerun partiel.** `carriesOver: true`, « Your work is kept:
  run this project again to finish it », alors que le run suivant s'ensemence
  sur l'origine.
- **2.8 — trajectoires.** Une exécution rejetée suivie d'un `direct` donneur
  réussi : `credited=true` à `149f141`, `credited=false` avec la forme
  d'événement antérieure à `820025b` ; une injection d'event skill dans une
  branche fait créditer une exécution Hydrogen ultérieure et sans rapport.
- **2.9 et 2.10 — seed et `record_probe`.** Filtre du seed : « kept 2 dropped
  1 », l'entrée de harnais ne survit pas, alors que le contrat de lecture la
  compare sur le code de sortie seul ; zéro enregistrement d'attestation
  après `record_probe`, un après `run_shell`.

## 10. Suite de tests

Premier passage de `npm run release:check` dans un clone neuf, pendant les
reproductions : 9 tests rouges sur 4 466, tous des attentes de démarrage de
processus enfant `tsx` (10 à 45 s). Relance en isolation :
`retrieval-benchmark` 61/61 ; `retrieval-treatment`, seul son premier test
échoue (cache froid) ; serveur viz démarré à la main en 2,8 à 3,2 s. Second
passage complet, machine au repos : rc=0, 4 456 tests verts et 10 ignorés,
0 vulnérabilité, build et smokes compilés réussis.
