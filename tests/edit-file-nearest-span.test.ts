import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { editFileTool, findNearestSpan } from '../src/tools/builtin.js';

/**
 * MEASURED MOTIVATION, and the honest limit of it.
 *
 * Across 122 archived traces there were 50 `edit_file` "old_string not found"
 * failures. The double-escape branch fired on only SEVEN: in the other 43 the
 * argument un-escapes to something still absent, so the model was not
 * mis-escaping a span it had — it was reconstructing one it half-remembered.
 * 31 of those 43 were `.atoma-probes.json`, a file the model merges into and
 * which compiled verification scripts also rewrite behind its back, so any
 * remembered span goes stale.
 *
 * Those historical calls CANNOT be replayed as a regression suite: the file
 * state at the time depended on shell side effects the trace does not record
 * (a `node _skill_*.mjs` run rewriting the manifest). An attempt to replay
 * them reported an implausible 50/50 and was discarded rather than quoted.
 * These cases are therefore constructed to match the failure SHAPES observed
 * in those traces, not lifted from them.
 */
describe('findNearestSpan — hand back real bytes instead of "go read the file"', () => {
  it('recovers the true span when only indentation differs', () => {
    const file = 'function a() {\n    return 1;\n}\n';
    // The model remembers two-space indentation; the file has four.
    const got = findNearestSpan(file, 'function a() {\n  return 1;\n}');
    expect(got?.how).toBe('whitespace');
    expect(got?.span).toContain('    return 1;');
  });

  it('recovers real bytes when the remembered span diverges partway', () => {
    const file = 'const cfg = {\n  "name": "csvstat",\n  "version": "2.0.0"\n};\n';
    // Right opening, wrong version — the classic half-remembered edit.
    const got = findNearestSpan(file, 'const cfg = {\n  "name": "csvstat",\n  "version": "1.0.0"\n}');
    expect(got?.how).toBe('anchor');
    expect(got?.span).toContain('"version": "2.0.0"');
  });

  it('returns null when nothing in the file resembles the span', () => {
    // Guards against confidently echoing an irrelevant region: a wrong-file
    // edit must say so, not hand back unrelated bytes.
    expect(findNearestSpan('completely unrelated content here\n', 'export function zzz() { return 42; }')).toBeNull();
  });

  it('refuses an anchor too short to mean anything', () => {
    // "const " occurs, but six characters is not evidence of intent.
    expect(findNearestSpan('const x = 1;\n', 'const somethingEntirelyDifferentAndLong = 99;')).toBeNull();
  });

  it('does not guess when the whitespace-insensitive match is ambiguous', () => {
    const file = 'a = 1;\nb = 2;\na = 1;\n';
    const got = findNearestSpan(file, 'a  =  1;');
    // Two candidate regions — falls through to the anchor path or nothing,
    // but must never claim the unique-whitespace diagnosis.
    expect(got?.how).not.toBe('whitespace');
  });

  it('handles an empty span without throwing', () => {
    expect(findNearestSpan('anything', '')).toBeNull();
  });
});

describe('edit_file error messages carry bytes, not instructions', () => {
  const withFile = async (content: string, fn: (t: ReturnType<typeof editFileTool>) => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-edit-'));
    try {
      writeFileSync(join(root, 'f.txt'), content);
      await fn(editFileTool({ sandbox: new ToolSandbox(root) }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('echoes the real region when the span is misremembered', async () => {
    await withFile('const cfg = {\n  "version": "2.0.0"\n};\n', async (t) => {
      await expect(
        t.execute({ path: 'f.txt', old_string: 'const cfg = {\n  "version": "1.0.0"\n}', new_string: 'x' })
      ).rejects.toThrow(/REAL bytes[\s\S]*2\.0\.0/);
    });
  });

  it('names indentation specifically when that is the whole problem', async () => {
    await withFile('function a() {\n\t\treturn 1;\n}\n', async (t) => {
      await expect(
        t.execute({ path: 'f.txt', old_string: 'function a() {\n  return 1;\n}', new_string: 'x' })
      ).rejects.toThrow(/ignoring whitespace/);
    });
  });

  it('says "wrong file or stale content" when nothing resembles the span', async () => {
    // The one case where telling the model to re-read is the right answer.
    await withFile('totally different\n', async (t) => {
      await expect(
        t.execute({ path: 'f.txt', old_string: 'export function alpha() { return 1; }', new_string: 'x' })
      ).rejects.toThrow(/no region of the file resembles it/);
    });
  });

  it('still prefers the double-escape diagnosis when that is provable', async () => {
    await withFile('line one\nline two\n', async (t) => {
      await expect(
        t.execute({ path: 'f.txt', old_string: 'line one\\nline two', new_string: 'x' })
      ).rejects.toThrow(/DOUBLE-ESCAPED/);
    });
  });

  it('a successful edit is unaffected by any of this', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-edit-ok-'));
    try {
      writeFileSync(join(root, 'f.txt'), 'alpha\nbeta\n');
      const t = editFileTool({ sandbox: new ToolSandbox(root) });
      await t.execute({ path: 'f.txt', old_string: 'beta', new_string: 'gamma' });
      expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('alpha\ngamma\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the probe manifest is not hand-editable', () => {
  it('refuses edit_file on it and names record_probe', async () => {
    // 31 of the 50 archived failures were this one file: a merged JSON record
    // that compiled scripts also rewrite, so a remembered span is stale by
    // construction. Made impossible rather than diagnosed.
    const root = mkdtempSync(join(tmpdir(), 'atoma-edit-man-'));
    try {
      writeFileSync(join(root, '.atoma-probes.json'), '{"version":1,"entries":[]}');
      const t = editFileTool({ sandbox: new ToolSandbox(root) });
      await expect(
        t.execute({ path: '.atoma-probes.json', old_string: '[]', new_string: '[{}]' })
      ).rejects.toThrow(/record_probe/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves every other json file editable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-edit-pkg-'));
    try {
      writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}');
      const t = editFileTool({ sandbox: new ToolSandbox(root) });
      await t.execute({ path: 'package.json', old_string: '1.0.0', new_string: '2.0.0' });
      expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('2.0.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
