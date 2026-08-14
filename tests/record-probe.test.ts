import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { ToolSandbox } from '../src/tools/sandbox.js';
import {
  appendHttpProbe,
  commandLineNeedsShell,
  fetchUrlTool,
  mergeProbeManifestWrite,
  mergeShellProbe,
  recordProbeTool,
  renderProbeCmd,
  splitCommandLine,
} from '../src/tools/builtin.js';
import {
  PROBE_MANIFEST_FILENAME,
  appendHttpProbe as contractAppendHttpProbe,
  matchesShellIdentity,
  matchesWebIdentity,
  mergeProbeManifestWrite as contractMergeProbeManifestWrite,
  mergeShellProbe as contractMergeShellProbe,
  validateProbeManifest,
} from '../src/contracts/probeManifest.js';

/**
 * record_probe exists because the model was measured ABRIDGING long output
 * when it transcribed probe results by hand: the recorded stdout was a strict
 * prefix of the real one (371 chars against 2008), so the compiled verifier
 * that replays the manifest byte-for-byte could never match and demoted itself
 * on false mismatches. The tool records what the command actually produced.
 * The first test below is the one that matters — everything else guards a
 * contract the manifest already had.
 */
describe('record_probe', () => {
  let root: string;
  let sandbox: ToolSandbox;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atoma-probe-'));
    sandbox = new ToolSandbox(root);
  });
  afterEach(async () => {
    await sandbox.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  const manifest = (): { version: number; entries: Record<string, unknown>[] } =>
    JSON.parse(readFileSync(join(root, PROBE_MANIFEST_FILENAME), 'utf8'));

  it('records LONG output in full — the defect it was built for', async () => {
    // 2000+ characters, well past what a model abridges to.
    writeFileSync(
      join(root, 'chatty.js'),
      "for (let i = 0; i < 200; i++) console.log('line ' + i + ' xxxxxxxxxx');"
    );
    const t = recordProbeTool({ sandbox });
    const res = (await t.execute({ command: 'node', args: ['chatty.js'] })) as {
      exitCode: number;
      stdout: string;
    };
    const recorded = String(manifest().entries[0]!['stdout']);
    expect(res.stdout.length).toBeGreaterThan(2000);
    // The whole point: byte-identical to what the process emitted.
    expect(recorded).toBe(res.stdout);
    expect(recorded.split('\n').filter(Boolean)).toHaveLength(200);
  });

  it('records the REAL exit code, including a non-zero error case', async () => {
    writeFileSync(join(root, 'boom.js'), "console.error('nope'); process.exit(2);");
    const t = recordProbeTool({ sandbox });
    await t.execute({ command: 'node', args: ['boom.js'] });
    const e = manifest().entries[0]!;
    expect(e['exitCode']).toBe(2);
    expect(String(e['stderr'])).toContain('nope');
  });

  it('writes a manifest the project\'s own health check accepts', async () => {
    writeFileSync(join(root, 'ok.js'), "console.log('fine');");
    const t = recordProbeTool({ sandbox });
    await t.execute({ command: 'node', args: ['ok.js'] });
    expect(validateProbeManifest(readFileSync(join(root, PROBE_MANIFEST_FILENAME), 'utf8'))).toEqual(
      []
    );
  });

  it('merges by command — a re-run after a fix replaces its record', async () => {
    writeFileSync(join(root, 'v.js'), "console.log('before');");
    const t = recordProbeTool({ sandbox });
    await t.execute({ command: 'node', args: ['v.js'] });
    writeFileSync(join(root, 'v.js'), "console.log('after');");
    await t.execute({ command: 'node', args: ['v.js'] });
    const entries = manifest().entries;
    expect(entries).toHaveLength(1);
    expect(String(entries[0]!['stdout'])).toContain('after');
  });

  it('can supersede one accidental probe when the corrected command differs', async () => {
    writeFileSync(join(root, 'old.js'), "console.log('broken probe'); process.exit(1);");
    writeFileSync(join(root, 'fixed.js'), "console.log('verified');");
    const t = recordProbeTool({ sandbox });
    await t.execute({ cmd: 'node old.js', note: 'accidental attempt' });
    const result = (await t.execute({
      cmd: 'node fixed.js',
      supersedes: 'node old.js',
      note: 'corrected finite probe',
    })) as { superseded?: string };

    expect(result.superseded).toBe('node old.js');
    expect(manifest().entries.map((entry) => entry['cmd'])).toEqual(['node fixed.js']);
  });

  it('preserves entries written by earlier phases', async () => {
    writeFileSync(
      join(root, PROBE_MANIFEST_FILENAME),
      JSON.stringify({ version: 1, entries: [{ cmd: 'node earlier.js', exitCode: 0 }] })
    );
    writeFileSync(join(root, 'now.js'), "console.log('now');");
    const t = recordProbeTool({ sandbox });
    await t.execute({ command: 'node', args: ['now.js'] });
    const cmds = manifest().entries.map((e) => e['cmd']);
    expect(cmds).toContain('node earlier.js');
    expect(cmds).toContain('node now.js');
  });

  it('omits stdout when it embeds a bound port — recording it guarantees a false replay', async () => {
    writeFileSync(join(root, 'srv.js'), "console.log('LISTENING_ON_PORT=' + 54321);");
    const t = recordProbeTool({ sandbox });
    const res = (await t.execute({ command: 'node', args: ['srv.js'] })) as {
      recordedStdoutOmitted: boolean;
    };
    expect(res.recordedStdoutOmitted).toBe(true);
    expect(manifest().entries[0]).not.toHaveProperty('stdout');
    expect(manifest().entries[0]!['exitCode']).toBe(0);
  });

  it('refuses an exit-code echo decoration instead of recording echo\'s status', async () => {
    // A decorated cmd once auto-demoted a 30-success compiled verifier: the
    // recorded exitCode became echo's, always 0.
    const t = recordProbeTool({ sandbox });
    await expect(
      t.execute({ command: 'bash', args: ['-c', 'node x.js ; echo EXIT=$?'] })
    ).rejects.toThrow(/exit-code echo/);
  });

  it('carries an optional note through to the entry', async () => {
    writeFileSync(join(root, 'ok.js'), 'console.log(1);');
    const t = recordProbeTool({ sandbox });
    await t.execute({ command: 'node', args: ['ok.js'], note: 'happy path' });
    expect(manifest().entries[0]!['note']).toBe('happy path');
  });

  it('inherits run_shell\'s allowlist rather than opening a second door', async () => {
    const t = recordProbeTool({ sandbox, shellAllowlist: ['echo'] });
    await expect(t.execute({ command: 'node', args: ['x.js'] })).rejects.toThrow(/not in allowlist/);
  });

  it('refuses a long-running server before spending the shell timeout', async () => {
    writeFileSync(
      join(root, 'server.js'),
      "require('http').createServer((_q,r)=>r.end('ok')).listen(0,()=>console.log('LISTENING_ON_PORT=1'));"
    );
    const t = recordProbeTool({ sandbox, shellTimeoutMs: 50 });
    await expect(t.execute({ cmd: 'node server.js' })).rejects.toThrow(
      /start_node_server.*fetch_url.*record=true/
    );
    expect(() => manifest()).toThrow();
  });

  it('refuses a Node server even when it carries runtime arguments', async () => {
    writeFileSync(
      join(root, 'server.mjs'),
      "import http from 'node:http'; http.createServer((_q,r)=>r.end('ok')).listen(0,()=>console.log('LISTENING_ON_PORT=1'));"
    );
    const t = recordProbeTool({ sandbox, shellTimeoutMs: 50 });
    await expect(t.execute({ cmd: 'node server.mjs --port 3000' })).rejects.toThrow(
      /long-running server/
    );
    expect(() => manifest()).toThrow();
  });

  it('refuses a server hidden behind an env assignment and shell execution', async () => {
    writeFileSync(
      join(root, 'server.js'),
      "require('http').createServer((_q,r)=>r.end('ok')).listen(process.env.PORT,()=>console.log('LISTENING_ON_PORT=' + process.env.PORT));"
    );
    const t = recordProbeTool({ sandbox, shellTimeoutMs: 50 });
    await expect(t.execute({ cmd: 'PORT=3000 node server.js --port 3000' })).rejects.toThrow(
      /long-running server/
    );
    expect(() => manifest()).toThrow();
  });

  it('checks the entrypoint after Node preload flags', async () => {
    writeFileSync(join(root, 'setup.js'), "globalThis.ready = true;");
    writeFileSync(
      join(root, 'server.js'),
      "require('http').createServer((_q,r)=>r.end('ok')).listen(0,()=>console.log('LISTENING_ON_PORT=1'));"
    );
    const t = recordProbeTool({ sandbox, shellTimeoutMs: 50 });
    await expect(t.execute({ cmd: 'node --require setup.js server.js' })).rejects.toThrow(
      /long-running server/
    );
    expect(() => manifest()).toThrow();
  });

  it('allows a finite Node harness that closes the listener it opened', async () => {
    writeFileSync(
      join(root, 'finite.js'),
      [
        "const server = require('http').createServer((_q,r)=>r.end('ok'));",
        "server.listen(0, () => { console.log('LISTENING_ON_PORT=ephemeral'); server.close(); });",
      ].join('\n')
    );
    const t = recordProbeTool({ sandbox, shellTimeoutMs: 1_000 });
    const result = (await t.execute({ cmd: 'node finite.js' })) as { exitCode: number };
    expect(result.exitCode).toBe(0);
    expect(manifest().entries).toHaveLength(1);
  });

  it('refuses a Python server before trying to import its framework', async () => {
    writeFileSync(
      join(root, 'app.py'),
      "from flask import Flask\napp = Flask(__name__)\napp.run(port=3000)\n"
    );
    const t = recordProbeTool({ sandbox, shellTimeoutMs: 50 });
    await expect(t.execute({ cmd: 'python3 app.py --port 3000' })).rejects.toThrow(
      /long-running server/
    );
    expect(() => manifest()).toThrow();
  });

  it('routes HTTP evidence to fetch_url even when curl is hidden in bash', async () => {
    const t = recordProbeTool({ sandbox });
    await expect(t.execute({ cmd: 'curl http://localhost:3000/health' })).rejects.toThrow(
      /fetch_url with record=true/
    );
    await expect(
      t.execute({
        command: 'bash',
        args: ['-c', 'sleep 1 && curl http://localhost:3000/health'],
      })
    ).rejects.toThrow(/fetch_url with record=true/);
  });
});

describe('fetch_url record=true — machine-written HTTP evidence', () => {
  let root: string;
  let sandbox: ToolSandbox;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atoma-http-probe-'));
    sandbox = new ToolSandbox(root);
  });
  afterEach(async () => {
    await sandbox.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  it('appends ordered success and error responses without curl or transcription', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.statusCode = req.url === '/missing' ? 404 : 200;
      res.end(JSON.stringify({ path: req.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    try {
      const tool = fetchUrlTool({ sandbox });
      await tool.execute({
        url: `http://127.0.0.1:${address.port}/ok`,
        record: true,
        note: 'happy path',
      });
      await tool.execute({
        url: `http://127.0.0.1:${address.port}/missing`,
        record: true,
        note: 'expected missing case',
      });
      const raw = readFileSync(join(root, PROBE_MANIFEST_FILENAME), 'utf8');
      const doc = JSON.parse(raw) as { entries: Record<string, unknown>[] };
      expect(doc.entries).toEqual([
        {
          probe: 'http',
          method: 'GET',
          path: '/ok',
          status: 200,
          body: '{"path":"/ok"}',
          note: 'happy path',
        },
        {
          probe: 'http',
          method: 'GET',
          path: '/missing',
          status: 404,
          body: '{"path":"/missing"}',
          note: 'expected missing case',
        },
      ]);
      expect(validateProbeManifest(raw)).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });
});

describe('renderProbeCmd — the recorded command must be replayable', () => {
  it('quotes an argument containing spaces', () => {
    // A compiled verifier's command regex once dropped quotes, amputating
    // `node index.js "Hello World"` to `node index.js` and failing a correct
    // deliverable.
    expect(renderProbeCmd('node', ['index.js', 'Hello World'])).toBe(
      'node index.js "Hello World"'
    );
  });

  it('leaves ordinary arguments unquoted', () => {
    expect(renderProbeCmd('node', ['csvstat.js', '--format', 'json', 'a/b.csv'])).toBe(
      'node csvstat.js --format json a/b.csv'
    );
  });

  it('escapes embedded quotes', () => {
    expect(renderProbeCmd('node', ['x.js', 'say "hi"'])).toContain('\\"hi\\"');
  });

  it('handles an empty argument', () => {
    expect(renderProbeCmd('node', ['x.js', ''])).toBe('node x.js ""');
  });
});

describe('mergeShellProbe — pure merge semantics', () => {
  const e = (cmd: string, stdout: string) => ({ cmd, exitCode: 0, stdout });

  it('creates a version-1 manifest from nothing', () => {
    const out = JSON.parse(mergeShellProbe(null, e('node a.js', 'x')));
    expect(out.version).toBe(1);
    expect(out.entries).toHaveLength(1);
  });

  it('replaces an entry with the same cmd rather than duplicating it', () => {
    const first = mergeShellProbe(null, e('node a.js', 'old'));
    const out = JSON.parse(mergeShellProbe(first, e('node a.js', 'new')));
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].stdout).toBe('new');
  });

  it('appends a different cmd', () => {
    const first = mergeShellProbe(null, e('node a.js', 'a'));
    const out = JSON.parse(mergeShellProbe(first, e('node b.js', 'b')));
    expect(out.entries).toHaveLength(2);
  });

  it('removes only an explicitly superseded cmd before appending the replacement', () => {
    const first = mergeShellProbe(null, e('node accidental.js', 'bad'));
    const withKeep = mergeShellProbe(first, e('node keep.js', 'keep'));
    const out = JSON.parse(
      mergeShellProbe(withKeep, e('node corrected.js', 'good'), 'node accidental.js')
    );
    expect(out.entries.map((entry: { cmd: string }) => entry.cmd)).toEqual([
      'node keep.js',
      'node corrected.js',
    ]);
  });

  it('replaces a corrupt manifest rather than appending to half a document', () => {
    const out = JSON.parse(mergeShellProbe('{"version":1,"entries":[{"cmd"', e('node a.js', 'x')));
    expect(out.entries).toHaveLength(1);
  });

  it('leaves foreign entry shapes untouched — http entries share the file', () => {
    const withHttp = JSON.stringify({
      version: 1,
      entries: [{ probe: 'http', method: 'GET', path: '/x', status: 200 }],
    });
    const out = JSON.parse(mergeShellProbe(withHttp, e('node a.js', 'x')));
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0].probe).toBe('http');
  });
});

describe('mergeProbeManifestWrite — cross-phase manifest preservation', () => {
  it('keeps an earlier shell probe when a web phase writes its own entry', () => {
    const existing = JSON.stringify({
      version: 1,
      entries: [{ cmd: 'node test-api.js', exitCode: 0 }],
    });
    const incoming = JSON.stringify({
      version: 1,
      entries: [
        {
          probe: 'web',
          file: 'server.js',
          interactions: [{ type: 'click', selector: '#submit' }],
          smoke: 'window.__test.entryCount === 1',
          expected: 'true',
        },
      ],
    });
    const merged = JSON.parse(mergeProbeManifestWrite(existing, incoming));
    expect(merged.entries).toHaveLength(2);
    expect(merged.entries[0]).toEqual({ cmd: 'node test-api.js', exitCode: 0 });
    expect(merged.entries[1].probe).toBe('web');
  });

  it('does not silently sanitize malformed incoming entries', () => {
    const merged = JSON.parse(
      mergeProbeManifestWrite(
        JSON.stringify({ version: 1, entries: [{ cmd: 'node ok.js', exitCode: 0 }] }),
        JSON.stringify({ version: 1, entries: ['broken-entry'] })
      )
    );
    expect(merged.entries).toEqual([
      { cmd: 'node ok.js', exitCode: 0 },
      'broken-entry',
    ]);
    expect(validateProbeManifest(JSON.stringify(merged)).join('\n')).toMatch(
      /entry #1 is not an object/
    );
  });
});

describe('appendHttpProbe — sequence semantics', () => {
  it('always appends repeated routes because state and status may differ', () => {
    const first = appendHttpProbe(null, {
      probe: 'http',
      method: 'POST',
      path: '/items',
      status: 201,
      body: '{"id":1}',
    });
    const out = JSON.parse(
      appendHttpProbe(first, {
        probe: 'http',
        method: 'POST',
        path: '/items',
        status: 400,
        body: '{"error":"blank"}',
      })
    ) as { entries: Record<string, unknown>[] };
    expect(out.entries.map((entry) => entry['status'])).toEqual([201, 400]);
  });
});

describe('one merge contract — all three consumers share src/contracts/probeManifest.ts', () => {
  it('builtin re-exports ARE the contract functions, not copies', () => {
    expect(mergeProbeManifestWrite).toBe(contractMergeProbeManifestWrite);
    expect(mergeShellProbe).toBe(contractMergeShellProbe);
    expect(appendHttpProbe).toBe(contractAppendHttpProbe);
  });

  it('the same shell entry lands identically via write_file merge and record_probe merge', () => {
    const existing = JSON.stringify({
      version: 1,
      entries: [
        { cmd: 'node cli.js data.csv', exitCode: 0, stdout: 'old' },
        { probe: 'http', method: 'GET', path: '/status', status: 200 },
      ],
    });
    const entry = { cmd: 'node cli.js data.csv', exitCode: 0, stdout: 'new' };
    const viaWrite = JSON.parse(
      mergeProbeManifestWrite(existing, JSON.stringify({ version: 1, entries: [entry] }))
    ) as { entries: unknown[] };
    const viaRecord = JSON.parse(mergeShellProbe(existing, entry)) as { entries: unknown[] };
    expect(viaWrite.entries).toEqual(viaRecord.entries);
    expect(viaWrite.entries).toHaveLength(2);
  });

  it('shell identity is `cmd` alone — an http entry echoing the text elsewhere never matches', () => {
    expect(matchesShellIdentity({ cmd: 'node a.js', exitCode: 0 }, 'node a.js')).toBe(true);
    expect(matchesShellIdentity({ cmd: 'node b.js', exitCode: 0 }, 'node a.js')).toBe(false);
    expect(matchesShellIdentity(null, 'node a.js')).toBe(false);
    expect(
      matchesShellIdentity(
        { probe: 'http', method: 'GET', path: 'node a.js', status: 200 },
        'node a.js'
      )
    ).toBe(false);
  });

  it('web identity is file+smoke — the same pair replaces, a different smoke stays distinct', () => {
    const web = (smoke: string, expected: string) => ({
      probe: 'web',
      file: 'index.html',
      smoke,
      expected,
    });
    const existing = JSON.stringify({
      version: 1,
      entries: [web('window.__test.ok === true', 'true')],
    });
    const replaced = JSON.parse(
      mergeProbeManifestWrite(
        existing,
        JSON.stringify({ version: 1, entries: [web('window.__test.ok === true', 'false')] })
      )
    ) as { entries: Record<string, unknown>[] };
    expect(replaced.entries).toHaveLength(1);
    expect(replaced.entries[0]!['expected']).toBe('false');
    const appended = JSON.parse(
      mergeProbeManifestWrite(
        existing,
        JSON.stringify({ version: 1, entries: [web('window.__test.count === 3', 'true')] })
      )
    ) as { entries: Record<string, unknown>[] };
    expect(appended.entries).toHaveLength(2);
    expect(
      matchesWebIdentity(
        web('window.__test.ok === true', 'true'),
        'index.html',
        'window.__test.ok === true'
      )
    ).toBe(true);
    expect(
      matchesWebIdentity(
        web('window.__test.ok === true', 'true'),
        'index.html',
        'window.__test.count === 3'
      )
    ).toBe(false);
  });

  it('supersedes removes exactly the stale SHELL entry and can never touch http/web entries', () => {
    const existing = JSON.stringify({
      version: 1,
      entries: [
        { probe: 'http', method: 'GET', path: 'node stale.js', status: 200 },
        { probe: 'web', file: 'node stale.js', smoke: 'window.__test.ok === true', expected: 'true' },
        { cmd: 'node stale.js', exitCode: 1, stdout: 'oops' },
      ],
    });
    const out = JSON.parse(
      mergeShellProbe(existing, { cmd: 'node fixed.js', exitCode: 0, stdout: 'ok' }, 'node stale.js')
    ) as { entries: Record<string, unknown>[] };
    expect(out.entries).toHaveLength(3);
    expect(out.entries[0]!['probe']).toBe('http');
    expect(out.entries[1]!['probe']).toBe('web');
    expect(out.entries[2]!['cmd']).toBe('node fixed.js');
  });

  it('PRESERVED DIVERGENCE: write_file dedupes an exact-duplicate http entry, the machine append keeps it (SEQUENCE)', () => {
    const httpEntry = {
      probe: 'http' as const,
      method: 'POST',
      path: '/items',
      status: 201,
      body: '{"id":1}',
    };
    const existing = JSON.stringify({ version: 1, entries: [httpEntry] });
    const viaWrite = JSON.parse(
      mergeProbeManifestWrite(existing, JSON.stringify({ version: 1, entries: [httpEntry] }))
    ) as { entries: unknown[] };
    const viaFetch = JSON.parse(appendHttpProbe(existing, httpEntry)) as { entries: unknown[] };
    expect(viaWrite.entries).toHaveLength(1);
    expect(viaFetch.entries).toHaveLength(2);
  });
});

describe('record_probe accepts a whole command line — the round-3 defect', () => {
  let root: string;
  let sandbox: ToolSandbox;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atoma-probe-line-'));
    sandbox = new ToolSandbox(root);
  });
  afterEach(async () => {
    await sandbox.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const manifest = (): { entries: Record<string, unknown>[] } =>
    JSON.parse(readFileSync(join(root, PROBE_MANIFEST_FILENAME), 'utf8'));

  it('records the BARE line, never a bash -c wrapper', async () => {
    // Round 3: the first version demanded {command,args}, so the model worked
    // around the rejection with `bash -c "node x.js a"`. Every entry gained a
    // wrapper, and the compiled verifier's `node <entry>\s*(.*)$` regex then
    // captured the closing quote — running `node x.js a"` and reporting a
    // mismatch until the script demoted itself.
    writeFileSync(join(root, 'x.js'), "console.log('ok ' + process.argv[2]);");
    const t = recordProbeTool({ sandbox });
    await t.execute({ cmd: 'node x.js sample.csv' });
    const e = manifest().entries[0]!;
    expect(e['cmd']).toBe('node x.js sample.csv');
    expect(String(e['cmd'])).not.toContain('bash');
    expect(String(e['cmd'])).not.toContain('"');
    expect(String(e['stdout'])).toContain('ok sample.csv');
  });

  it('the recorded cmd survives the extraction regex that broke in round 3', async () => {
    writeFileSync(join(root, 'x.js'), 'console.log(process.argv.slice(2).join("|"));');
    const t = recordProbeTool({ sandbox });
    await t.execute({ cmd: 'node x.js a b' });
    const cmd = String(manifest().entries[0]!['cmd']);
    const m = cmd.match(new RegExp('node\\s+x\\.js\\s*(.*)$'));
    expect(m?.[1]).toBe('a b'); // and NOT 'a b"'
  });

  it('still runs a line that genuinely needs a shell, and records it bare', async () => {
    writeFileSync(join(root, 'x.js'), "console.error('boom'); process.exit(3);");
    const t = recordProbeTool({ sandbox });
    const res = (await t.execute({ cmd: 'node x.js 2>&1' })) as { ranThroughShell: boolean };
    expect(res.ranThroughShell).toBe(true);
    expect(manifest().entries[0]!['cmd']).toBe('node x.js 2>&1');
  });

  it('honours quoted arguments containing spaces', async () => {
    writeFileSync(join(root, 'x.js'), 'console.log(process.argv[2]);');
    const t = recordProbeTool({ sandbox });
    await t.execute({ cmd: 'node x.js "Hello World"' });
    expect(String(manifest().entries[0]!['stdout']).trim()).toBe('Hello World');
  });

  it('executes shell expansions exactly as the recorded line will replay them', async () => {
    writeFileSync(join(root, 'a.probe.txt'), 'a');
    writeFileSync(join(root, 'b.probe.txt'), 'b');
    const t = recordProbeTool({ sandbox });
    const res = (await t.execute({ cmd: 'printf "%s\\n" *.probe.txt' })) as {
      ranThroughShell: boolean;
      stdout: string;
    };
    expect(res.ranThroughShell).toBe(true);
    expect(res.stdout.trim().split('\n').sort()).toEqual(['a.probe.txt', 'b.probe.txt']);
    expect(manifest().entries[0]!['cmd']).toBe('printf "%s\\n" *.probe.txt');
  });

  it('keeps the {command,args} shape working for existing callers', async () => {
    writeFileSync(join(root, 'x.js'), "console.log('legacy');");
    const t = recordProbeTool({ sandbox });
    await t.execute({ command: 'node', args: ['x.js'] });
    expect(manifest().entries[0]!['cmd']).toBe('node x.js');
  });

  it('does not create two entries for the same invocation', async () => {
    writeFileSync(join(root, 'x.js'), "console.log('one');");
    const t = recordProbeTool({ sandbox });
    await t.execute({ cmd: 'node x.js' });
    await t.execute({ command: 'node', args: ['x.js'] });
    expect(manifest().entries).toHaveLength(1);
  });
});

describe('splitCommandLine', () => {
  it('keeps a quoted argument whole', () => {
    expect(splitCommandLine('node x.js "Hello World" --flag')).toEqual([
      'node', 'x.js', 'Hello World', '--flag',
    ]);
  });
  it('handles single quotes', () => {
    expect(splitCommandLine("node x.js 'a b'")).toEqual(['node', 'x.js', 'a b']);
  });
  it('collapses repeated whitespace', () => {
    expect(splitCommandLine('node   x.js    a')).toEqual(['node', 'x.js', 'a']);
  });
  it('preserves an intentionally empty argument', () => {
    expect(splitCommandLine('node x.js ""')).toEqual(['node', 'x.js', '']);
  });
  it('rejects an unterminated quote instead of executing different argv', () => {
    expect(() => splitCommandLine('node x.js "unfinished')).toThrow(/unterminated quote/);
  });
});

describe('commandLineNeedsShell', () => {
  it('recognises expansion and environment syntax a local argv split cannot preserve', () => {
    for (const line of [
      'node --test tests/*.test.js',
      'cat ~/input.txt',
      'printf "%s" file?.txt',
      'NODE_ENV=test node index.js',
      'echo file\\ name',
      'echo {a,b}',
    ]) {
      expect(commandLineNeedsShell(line), line).toBe(true);
    }
  });

  it('keeps an ordinary quoted argv line on the direct allowlisted path', () => {
    expect(commandLineNeedsShell('node x.js "Hello World" --flag')).toBe(false);
  });
});
