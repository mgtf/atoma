import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { mergeShellProbe, recordProbeTool, renderProbeCmd } from '../src/tools/builtin.js';
import {
  PROBE_MANIFEST_FILENAME,
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
