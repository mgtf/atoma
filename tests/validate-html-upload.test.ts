import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { parseInteractions, startStaticServerTool, validateHtmlTool, type ServedOrigins } from '../src/tools/builtin.js';
import { validateProbeManifest } from '../src/contracts/probeManifest.js';

/**
 * "Upload a CSV" is the README's own example, and until 2026-09-26 no run
 * could observe it: a click on a file input opens a native chooser a headless
 * page cannot answer. Production run 74fe5cec spent its whole 30-minute
 * budget re-trying to prove an upload and recorded `failed`. The `upload`
 * interaction attaches a workspace file the way a person picking it would —
 * input and change events included — through a real browser here.
 */

const PAGE = `<!doctype html><title>upload</title>
<input type="file" id="csv" accept=".csv">
<button id="plain">not a file input</button>
<p id="rows">none</p>
<script>
  document.getElementById('csv').addEventListener('change', (event) => {
    const reader = new FileReader();
    reader.onload = () => {
      const lines = String(reader.result).trim().split(/\\r?\\n/).slice(1);
      document.getElementById('rows').textContent = String(lines.length);
    };
    reader.readAsText(event.target.files[0]);
  });
</script>`;

const sandboxes: ToolSandbox[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await sandbox.cleanup().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): { sandbox: ToolSandbox; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-upload-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'index.html'), PAGE);
  writeFileSync(join(dir, 'sample.csv'), 'date,product,region,revenue\n2026-01-02,A,North,10\n2026-01-03,B,South,20\n2026-02-01,A,East,30\n');
  const sandbox = new ToolSandbox(dir);
  sandboxes.push(sandbox);
  return { sandbox, dir };
}

async function serve(sandbox: ToolSandbox) {
  const origins: ServedOrigins = new Map();
  const served = (await startStaticServerTool({ sandbox, servedOrigins: origins }).execute({})) as { ok: boolean; url: string };
  expect(served.ok, JSON.stringify(served)).toBe(true);
  return { url: served.url, validate: validateHtmlTool({ sandbox, servedOrigins: origins }) };
}

type Validation = { ok: boolean; errors: string[]; interactionLog: string[]; smokeResult?: unknown };

describe('validate_html upload interaction', () => {
  it('attaches a workspace file to a file input and fires its change event', async () => {
    const { sandbox } = workspace();
    const { url, validate } = await serve(sandbox);
    const result = (await validate.execute({
      url,
      interactions: [{ type: 'upload', selector: '#csv', file: 'sample.csv' }],
      smoke: "(() => ({ ok: document.getElementById('rows').textContent === '3', rows: document.getElementById('rows').textContent }))()",
    })) as Validation;
    expect(result.errors).toEqual([]);
    expect(result.interactionLog).toEqual(['upload sample.csv into #csv']);
    expect(result.smokeResult).toMatchObject({ ok: true, rows: '3' });
    expect(result.ok).toBe(true);
  }, 60_000);

  it('refuses a file outside the workspace, a symlink, a missing file and a non-file input', async () => {
    const { sandbox, dir } = workspace();
    const outside = mkdtempSync(join(tmpdir(), 'atoma-upload-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'host secret');
    let linked = true;
    try { symlinkSync(join(outside, 'secret.txt'), join(dir, 'linked.csv')); } catch { linked = false; }
    const { url, validate } = await serve(sandbox);
    const attempt = async (interaction: Record<string, unknown>) =>
      ((await validate.execute({ url, interactions: [interaction] })) as Validation).errors.join(' ');
    expect(await attempt({ type: 'upload', selector: '#csv', file: '../secret.txt' })).toMatch(/escapes sandbox/);
    expect(await attempt({ type: 'upload', selector: '#csv', file: 'missing.csv' })).toMatch(/not a regular file in the workspace/);
    expect(await attempt({ type: 'upload', selector: '#plain', file: 'sample.csv' })).toMatch(/is not an <input type="file">/);
    expect(await attempt({ type: 'upload', selector: '#csv' })).toMatch(/requires "file"/);
    if (linked) expect(await attempt({ type: 'upload', selector: '#csv', file: 'linked.csv' })).toMatch(/escapes sandbox|not a regular file/);
  }, 60_000);

  it('parses the upload interaction and admits it in a probe manifest', () => {
    expect(parseInteractions([{ type: 'upload', selector: '#csv', file: 'sample.csv' }]))
      .toEqual([{ type: 'upload', selector: '#csv', file: 'sample.csv' }]);
    const manifest = (interactions: unknown[]) => ({ version: 1, entries: [{ probe: 'web', file: 'index.html', interactions,
      smoke: "document.getElementById('rows').textContent === '3'", expected: 'true', consoleErrors: 0 }] });
    const problems = (interactions: unknown[]) => validateProbeManifest(JSON.stringify(manifest(interactions))).join(' ');
    expect(problems([{ type: 'upload', selector: '#csv', file: 'sample.csv' }])).not.toMatch(/interaction/);
    expect(problems([{ type: 'upload', selector: '#csv' }])).toMatch(/upload requires string selector and file/);
  });
});
