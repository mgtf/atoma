import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, relative, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { SkillRegistry } from '../skills/registry.js';
import { skillsDirPath, storeDbPath } from '../core/stores.js';
import { LAUNCHABLE_PROFILES } from '../run/profiles/index.js';
import { assessShareability, type ShareAssessment } from '../skills/shareability.js';

/**
 * Tiny read-only HTTP server that exposes runs/*.json produced by
 * `TraceRecorder` plus the Vite-built static client bundled under
 * `dist/viz/client`. The server remains framework-free and read-only:
 * `node:http` serves APIs plus hashed assets, while Vite is build/dev only.
 *
 * Also exposes a read-only view of any atom registry (SQLite DB) so the UI
 * can render a "Registry" screen independent of any particular run.
 *
 * Usage:  npm run viz -- --dir ./runs --port 4111 [--db ./atoma.db ...]
 */

interface Cli {
  dir: string;
  port: number;
  host: string;
  /** One or more DB paths to expose under /api/registry. */
  dbs: string[];
  /** Optional skills root dir (overrides ATOMA_SKILLS_DIR). */
  skillsDir?: string;
}

function parseArgs(argv: string[]): Cli {
  const out: Cli = { dir: './runs', port: 4111, host: '127.0.0.1', dbs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir' && argv[i + 1]) out.dir = argv[++i]!;
    else if (a === '--port' && argv[i + 1]) out.port = Number(argv[++i]);
    else if (a === '--host' && argv[i + 1]) out.host = argv[++i]!;
    else if (a === '--db' && argv[i + 1]) out.dbs.push(argv[++i]!);
    else if (a === '--skills-dir' && argv[i + 1]) out.skillsDir = argv[++i]!;
  }
  return out;
}

const cli = parseArgs(process.argv.slice(2));
const RUNS_DIR = resolve(cli.dir);
const BURNIN_CSV = resolve(process.env['ATOMA_BURNIN_CSV'] ?? './burnin/results.csv');

/**
 * Parse burnin/results.csv (written by `npm run burnin`) into typed rows.
 * The CSV is machine-written with simple cells (no quoting needed — task
 * goals are not in it), so a plain split is correct. Missing file → empty
 * list: the UI shows a "run a batch" hint instead of an error.
 */
function loadBurnin(): {
  rows: {
    ts: string;
    taskId: string;
    family: string;
    outcome: string;
    costUsd: number | null;
    durationS: number | null;
    llmCalls: number | null;
    opusCalls: number;
    sonnetCalls: number;
    haikuCalls: number;
    otherCalls: number;
    deterministicPhases: number;
    escalations: number;
    learnedSkills: number;
    learnedEventSkills: number;
    promotions: number;
    refusals: number;
    compileErrors: number;
    demotions: number;
    dispatchFallbacks: number;
    trace: string;
    provider: string;
  }[];
  csvPath: string;
} {
  if (!existsSync(BURNIN_CSV)) return { rows: [], csvPath: BURNIN_CSV };
  const lines = readFileSync(BURNIN_CSV, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    if (c.length < 14) continue;
    const num = (s: string | undefined): number | null => {
      const n = Number(s);
      return s !== undefined && s !== '' && Number.isFinite(n) ? n : null;
    };
    rows.push({
      ts: c[0]!,
      taskId: c[1]!,
      family: c[2]!,
      outcome: c[3]!,
      costUsd: num(c[4]),
      durationS: num(c[5]),
      llmCalls: num(c[6]),
      opusCalls: num(c[7]) ?? 0,
      sonnetCalls: num(c[8]) ?? 0,
      haikuCalls: num(c[9]) ?? 0,
      otherCalls: num(c[19]) ?? 0,
      deterministicPhases: num(c[10]) ?? 0,
      escalations: num(c[11]) ?? 0,
      learnedSkills: num(c[12]) ?? 0,
      learnedEventSkills: num(c[20]) ?? 0,
      // Lifecycle columns appended later — older rows simply lack them.
      promotions: num(c[13]) ?? 0,
      refusals: num(c[14]) ?? 0,
      compileErrors: num(c[21]) ?? 0,
      demotions: num(c[15]) ?? 0,
      dispatchFallbacks: num(c[16]) ?? 0,
      trace: (c.length > 17 ? c[17] : c[13]) ?? '',
      provider: c[18] ?? '',
    });
  }
  return { rows, csvPath: BURNIN_CSV };
}
const SKILLS_DIR = resolve(skillsDirPath(cli.skillsDir));
const skillRegistry = new SkillRegistry(SKILLS_DIR);

/**
 * Resolve the list of DB paths we'll serve: the explicit `--db` flags if any
 * (the flag repeats, so an archived store can be inspected alongside a live
 * one), otherwise the one store `storeDbPath()` resolves.
 *
 * IT USED TO GUESS TWO. The candidate list carried `./atoma.db` and
 * `./atoma-build.db` plus an `ATOMA_BUILD_DB_PATH` env branch, so the UI
 * rendered a store picker over one populated DB and one that had held zero
 * rows since `research-brief.ts` was deleted — presenting an artefact of a
 * dead split as a choice the operator had to understand. The list survives
 * because `--db` legitimately repeats; the guessing does not.
 *
 * Duplicates (same resolved path) are collapsed; a missing file is kept in the
 * list so the UI can still show it as empty rather than vanishing.
 */
function resolveDbs(): { id: string; label: string; path: string; exists: boolean }[] {
  const candidates: string[] = cli.dbs.length > 0 ? [...cli.dbs] : [storeDbPath()];
  const seen = new Set<string>();
  const out: { id: string; label: string; path: string; exists: boolean }[] = [];
  for (const c of candidates) {
    const abs = resolve(c);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const label = basename(abs).replace(/\.db$/, '');
    out.push({ id: label, label, path: abs, exists: existsSync(abs) });
  }
  // Dedup by id: if two paths happen to share the basename, keep the first.
  const byId = new Map<string, typeof out[number]>();
  for (const d of out) if (!byId.has(d.id)) byId.set(d.id, d);
  return [...byId.values()];
}

const DBS = resolveDbs();

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLIENT_DIR = join(HERE, 'client');
const UI_HTML_PATH = join(CLIENT_DIR, 'index.html');

function assetContentType(file: string): string {
  switch (extname(file)) {
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function send(res: import('node:http').ServerResponse, code: number, body: string | Buffer, type: string): void {
  res.writeHead(code, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendJson(res: import('node:http').ServerResponse, code: number, obj: unknown): void {
  send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function listIndex(): unknown {
  if (!existsSync(RUNS_DIR)) return [];
  const indexFile = join(RUNS_DIR, 'index.json');
  if (existsSync(indexFile)) {
    try {
      return JSON.parse(readFileSync(indexFile, 'utf8'));
    } catch {
      // fall through to scanning directly
    }
  }
  // Fallback: scan for *.json (excluding index.json) and return lightweight
  // summaries — useful if the recorder crashed before writing the index.
  const files = readdirSync(RUNS_DIR).filter(
    (f) => f.endsWith('.json') && f !== 'index.json'
  );
  const entries = files
    .map((f) => {
      const p = join(RUNS_DIR, f);
      try {
        const run = JSON.parse(readFileSync(p, 'utf8')) as {
          id: string;
          label: string;
          startedAt: string;
          endedAt?: string;
          durationMs?: number;
          error?: string;
          totals?: { calls: number; costUsd: number };
        };
        return {
          id: run.id,
          label: run.label,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          durationMs: run.durationMs,
          hasError: !!run.error,
          calls: run.totals?.calls,
          costUsd: run.totals?.costUsd,
          mtime: statSync(p).mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => b.mtime - a.mtime);
  return entries.map(({ mtime: _mtime, ...rest }) => rest);
}

interface RegistryHistoryEntry {
  version: number;
  systemPrompt: string;
  tools: string[];
  params: Record<string, unknown>;
  modifiedBy: string;
  modifiedAt: string;
  reason: string | null;
}

interface RegistryType {
  tier: 1 | 2 | 3;
  ordinal: number;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  params: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  version: number;
  successes: number;
  failures: number;
  /** Archived versions, oldest first. Does NOT include the current version. */
  history: RegistryHistoryEntry[];
}

interface RegistrySummary {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  counts: { 1: number; 2: number; 3: number; total: number };
}

function safeParseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function toolNames(toolsJson: string): string[] {
  const parsed = safeParseJson<Array<{ name?: string }>>(toolsJson, []);
  return parsed.map((t) => (typeof t?.name === 'string' ? t.name : '?'));
}

function openReadOnly(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

function countsOf(path: string): { 1: number; 2: number; 3: number; total: number } {
  const zero = { 1: 0, 2: 0, 3: 0, total: 0 };
  if (!existsSync(path)) return zero;
  let db: Database.Database | null = null;
  try {
    db = openReadOnly(path);
    const rows = db
      .prepare('SELECT tier, COUNT(*) as n FROM atom_types GROUP BY tier')
      .all() as { tier: number; n: number }[];
    const out = { ...zero };
    for (const r of rows) {
      if (r.tier === 1 || r.tier === 2 || r.tier === 3) out[r.tier] = r.n;
    }
    out.total = out[1] + out[2] + out[3];
    return out;
  } catch {
    return zero;
  } finally {
    db?.close();
  }
}

function listRegistries(): RegistrySummary[] {
  return DBS.map((d) => ({
    id: d.id,
    label: d.label,
    path: d.path,
    exists: d.exists && existsSync(d.path),
    counts: countsOf(d.path),
  }));
}

function dumpRegistry(id: string): { registry: RegistrySummary; types: RegistryType[] } | null {
  const entry = DBS.find((d) => d.id === id);
  if (!entry) return null;
  if (!existsSync(entry.path)) {
    return {
      registry: { id: entry.id, label: entry.label, path: entry.path, exists: false, counts: { 1: 0, 2: 0, 3: 0, total: 0 } },
      types: [],
    };
  }
  const db = openReadOnly(entry.path);
  try {
    const rows = db
      .prepare('SELECT * FROM atom_types ORDER BY tier ASC, ordinal ASC')
      .all() as Array<{
        tier: number;
        ordinal: number;
        name: string;
        description: string;
        system_prompt: string;
        tools_json: string;
        params_json: string;
        created_by: string;
        created_at: string;
        version: number;
        successes: number;
        failures: number;
      }>;

    const versions = db
      .prepare(
        'SELECT tier, ordinal, version, system_prompt, tools_json, params_json, modified_by, modified_at, reason FROM atom_type_versions ORDER BY version ASC'
      )
      .all() as Array<{
        tier: number;
        ordinal: number;
        version: number;
        system_prompt: string;
        tools_json: string;
        params_json: string;
        modified_by: string;
        modified_at: string;
        reason: string | null;
      }>;

    const histByKey = new Map<string, RegistryHistoryEntry[]>();
    for (const v of versions) {
      const key = `${v.tier}:${v.ordinal}`;
      const arr = histByKey.get(key) ?? [];
      arr.push({
        version: v.version,
        systemPrompt: v.system_prompt,
        tools: toolNames(v.tools_json),
        params: safeParseJson<Record<string, unknown>>(v.params_json, {}),
        modifiedBy: v.modified_by,
        modifiedAt: v.modified_at,
        reason: v.reason,
      });
      histByKey.set(key, arr);
    }

    const types: RegistryType[] = rows.map((r) => ({
      tier: r.tier as 1 | 2 | 3,
      ordinal: r.ordinal,
      name: r.name,
      description: r.description,
      systemPrompt: r.system_prompt,
      tools: toolNames(r.tools_json),
      params: safeParseJson<Record<string, unknown>>(r.params_json, {}),
      createdBy: r.created_by,
      createdAt: r.created_at,
      version: r.version,
      successes: r.successes ?? 0,
      failures: r.failures ?? 0,
      history: histByKey.get(`${r.tier}:${r.ordinal}`) ?? [],
    }));

    const counts = { 1: 0, 2: 0, 3: 0, total: types.length };
    for (const t of types) counts[t.tier]++;
    return {
      registry: { id: entry.id, label: entry.label, path: entry.path, exists: true, counts },
      types,
    };
  } finally {
    db.close();
  }
}

interface SkillNamespaceSummary {
  l1Name: string;
  count: number;
}

interface SkillSummary {
  id: string;
  description: string;
  whenToUse: string;
  kind: 'llm' | 'script';
  language?: 'node' | 'python' | 'bash';
  successes: number;
  failures: number;
  updatedAt: string;
}

/**
 * List the L1 namespaces that have at least one skill on disk. The viz UI
 * uses this for the top-level "Skills" tab to render a per-L1 breakdown
 * before drilling into individual recipes. Returns an empty array if the
 * skills root doesn't exist (fresh repo / skills feature off).
 */
function listSkillNamespaces(): SkillNamespaceSummary[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const out: SkillNamespaceSummary[] = [];
  for (const entry of readdirSync(SKILLS_DIR)) {
    const p = join(SKILLS_DIR, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(entry)) continue;
    let count = 0;
    try {
      count = skillRegistry.loadFor(entry).length;
    } catch {
      count = 0;
    }
    if (count > 0) out.push({ l1Name: entry, count });
  }
  out.sort((a, b) => a.l1Name.localeCompare(b.l1Name));
  return out;
}

function listSkillsForL1(l1Name: string): SkillSummary[] {
  const skills = skillRegistry.loadFor(l1Name);
  return skills.map((s) => ({
    id: s.id,
    description: s.description,
    whenToUse: s.whenToUse,
    kind: s.kind,
    ...(s.language ? { language: s.language } : {}),
    successes: s.successes,
    failures: s.failures,
    updatedAt: s.updatedAt,
  }));
}

/**
 * Tools the named atom declares, read from whichever exposed registry holds
 * it. Needed to judge a skill body's scope; absent DB → empty, which makes
 * the shareability check skip its tool findings rather than invent them.
 */
function toolNamesForAtom(atomName: string): string[] {
  for (const reg of listRegistries()) {
    if (!reg.exists) continue;
    let db: Database.Database | null = null;
    try {
      db = new Database(reg.path, { readonly: true, fileMustExist: true });
      const row = db.prepare('SELECT tools_json FROM atom_types WHERE name = ?').get(atomName) as
        | { tools_json: string }
        | undefined;
      if (row) return (JSON.parse(row.tools_json) as { name: string }[]).map((t) => t.name);
    } catch {
      /* unreadable registry — try the next one */
    } finally {
      db?.close();
    }
  }
  return [];
}

function getSkillById(
  l1Name: string,
  skillId: string
): (SkillSummary & { body: string; shareability: ShareAssessment }) | null {
  const skills = skillRegistry.loadFor(l1Name);
  const found = skills.find((s) => s.id === skillId);
  if (!found) return null;
  return {
    id: found.id,
    description: found.description,
    whenToUse: found.whenToUse,
    kind: found.kind,
    ...(found.language ? { language: found.language } : {}),
    successes: found.successes,
    failures: found.failures,
    updatedAt: found.updatedAt,
    body: found.body,
    // The cross-org review criterion, at the point where a human actually
    // reads a skill. Same data as `npm run skills -- review`; surfacing the
    // verdict here follows the viz's own rule that a card should show the
    // DECISION, not just the artefact.
    shareability: assessShareability({ skill: found, ownerToolNames: toolNamesForAtom(l1Name) }),
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    if (!existsSync(UI_HTML_PATH)) {
      send(res, 500, 'viz client missing at ' + UI_HTML_PATH, 'text/plain; charset=utf-8');
      return;
    }
    const html = readFileSync(UI_HTML_PATH);
    send(res, 200, html, 'text/html; charset=utf-8');
    return;
  }

  if (pathname === '/api/runs') {
    sendJson(res, 200, listIndex());
    return;
  }

  if (pathname.startsWith('/api/runs/')) {
    const id = decodeURIComponent(pathname.slice('/api/runs/'.length));
    if (!/^[A-Za-z0-9_.:-]+$/.test(id)) {
      sendJson(res, 400, { error: 'bad id' });
      return;
    }
    const file = join(RUNS_DIR, id + '.json');
    if (!existsSync(file)) {
      sendJson(res, 404, { error: 'not found', file });
      return;
    }
    const body = readFileSync(file);
    // DELTA MODE (?after=<n>): the live poll re-fetched the WHOLE run every
    // second, so a long run re-shipped a growing payload ~60×/minute to
    // learn about a handful of new events. With `after`, the response
    // carries the run header (totals, endedAt, result…) plus ONLY the
    // events past index n, and `eventsFrom` tells the client where the
    // slice starts. Absent the param the full run is served byte-for-byte
    // as before — first load, non-live runs, and any other consumer are
    // untouched.
    const afterRaw = url.searchParams.get('after');
    if (afterRaw !== null) {
      const after = Number(afterRaw);
      if (!Number.isInteger(after) || after < 0) {
        sendJson(res, 400, { error: 'bad after' });
        return;
      }
      const run = safeParseJson<{ events?: unknown[] } | null>(body.toString('utf8'), null);
      if (!run || !Array.isArray(run.events)) {
        // Unparseable or shapeless on disk (a torn partial write): fall
        // back to the full body rather than inventing a delta.
        send(res, 200, body, 'application/json; charset=utf-8');
        return;
      }
      const total = run.events.length;
      // A shrunken event list means this is a DIFFERENT run than the one
      // the client is diffing against (id reuse / rewritten trace) — send
      // everything and let the client resync from scratch.
      const from = after <= total ? after : 0;
      sendJson(res, 200, { ...run, events: run.events.slice(from), eventsFrom: from, eventsTotal: total });
      return;
    }
    send(res, 200, body, 'application/json; charset=utf-8');
    return;
  }

  if (pathname === '/api/registries') {
    sendJson(res, 200, listRegistries());
    return;
  }

  if (pathname === '/api/burnin') {
    sendJson(res, 200, loadBurnin());
    return;
  }

  if (pathname === '/api/skills') {
    sendJson(res, 200, listSkillNamespaces());
    return;
  }

  if (pathname.startsWith('/api/skills/')) {
    const rest = decodeURIComponent(pathname.slice('/api/skills/'.length));
    const parts = rest.split('/').filter(Boolean);
    // Validate every component up-front so a malformed segment can't
    // slip past the SkillRegistry path-component check (which throws
    // on unsafe chars but produces a less friendly HTTP response).
    if (parts.length === 0 || parts.some((p) => !/^[A-Za-z0-9._-]+$/.test(p))) {
      sendJson(res, 400, { error: 'bad skill path' });
      return;
    }
    if (parts.length === 1) {
      try {
        sendJson(res, 200, listSkillsForL1(parts[0]!));
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return;
    }
    if (parts.length === 2) {
      try {
        const skill = getSkillById(parts[0]!, parts[1]!);
        if (!skill) {
          sendJson(res, 404, { error: 'skill not found', l1: parts[0], id: parts[1] });
          return;
        }
        sendJson(res, 200, skill);
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return;
    }
    sendJson(res, 400, { error: 'bad skill path' });
    return;
  }

  if (pathname.startsWith('/api/registry/')) {
    const id = decodeURIComponent(pathname.slice('/api/registry/'.length));
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
      sendJson(res, 400, { error: 'bad id' });
      return;
    }
    try {
      const dump = dumpRegistry(id);
      if (!dump) {
        sendJson(res, 404, { error: 'unknown registry id', id });
        return;
      }
      sendJson(res, 200, dump);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  if (pathname === '/api/profiles') {
    // READ-ONLY, and deliberately so: it returns compile-time constants and
    // the command to copy, NOT a way to start anything. The server stays what
    // it is — no writeFileSync, no child_process, SQLite readonly — so this
    // adds zero attack surface. Launching from the browser is a separate,
    // opt-in decision documented in AGENTS.md; the reason it is not here is
    // that a run can call BACK into this server (`fetch_url` has no URL
    // allowlist by design, and run_shell's is "STEERING, not a boundary"),
    // so any secret served over HTTP would be readable by the very code it
    // is meant to gate.
    //
    // `defaults.dbPath` / `defaults.workspace` are NOT exposed: the run
    // resolves `process.env[...] ?? default` against ITS OWN environment, so
    // publishing the static default would state a fact that may be false.
    sendJson(res, 200, {
      launchEnabled: false,
      profiles: LAUNCHABLE_PROFILES.map(({ profile: p, npmScript }) => ({
        id: p.id,
        npmScript,
        label: p.guidance.label,
        help: p.guidance.help,
        examples: [...p.guidance.examples],
      })),
    });
    return;
  }

  const assetPath = resolve(CLIENT_DIR, `.${pathname}`);
  const assetRelative = relative(CLIENT_DIR, assetPath);
  if (
    assetRelative !== '' &&
    !assetRelative.startsWith('..') &&
    !assetRelative.startsWith('/') &&
    existsSync(assetPath) &&
    statSync(assetPath).isFile()
  ) {
    send(res, 200, readFileSync(assetPath), assetContentType(assetPath));
    return;
  }

  send(res, 404, 'not found', 'text/plain; charset=utf-8');
});

server.listen(cli.port, cli.host, () => {
  console.log(`atoma viz server — http://${cli.host}:${cli.port}/`);
  console.log(`serving runs from: ${RUNS_DIR}`);
  if (!existsSync(RUNS_DIR)) {
    console.log(`(directory does not exist yet — it will be created when a run is recorded)`);
  }
  console.log('registries exposed:');
  for (const d of DBS) {
    const mark = existsSync(d.path) ? '✓' : '✗';
    console.log(`  [${mark}] ${d.id}  ${d.path}`);
  }
  const skillsMark = existsSync(SKILLS_DIR) ? '✓' : '✗';
  console.log(`skills root: [${skillsMark}] ${SKILLS_DIR}`);
});
