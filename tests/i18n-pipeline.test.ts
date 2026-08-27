import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * THE TRANSLATION PIPELINE ISOLATES LOCALES. On 2026-08-27 the CI job died in
 * the middle of the zh catalog with `process.exit(1)`: fr had succeeded, but
 * nothing was written, so ten catalogs stayed `{}` and the successes were
 * never committed. The fix has two halves, and this file pins both:
 *
 * 1. A locale's failure — provider error or unreadable batch — ends THAT
 *    locale, never the run: every catalog keeps what it earned, and the exit
 *    code still turns CI red so the remaining blanks are retried.
 * 2. The translation job is a step of the CI workflow, not a second workflow
 *    racing it on its own runner: the shape assertions below fail if i18n
 *    drifts back out of ci.yml or regains a self-triggering push trigger.
 *
 * The behavioral half runs the real `scripts/i18n.mjs translate` in a
 * temporary copy of the repository with a fake `codex` binary first on PATH —
 * the script discovers the backend with `command -v codex`, so this exercises
 * the production path (backend selection, spawning, JSONL folding, JSON
 * extraction, placeholder validation, catalog writing, exit code) with no
 * paid call and no script modification.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALE_DIR = join('src', 'viz', 'client', 'locales');
const EN_KEYS = { greetings_one: 'one greeting', greetings_other: '{{count}} greetings', farewell: 'goodbye' };
const TARGETS = ['ar', 'de', 'es'] as const;

let workdir: string;
let binDir: string;

/** The fake `codex` the pipeline must discover and drive. Fails per locale on demand. */
const FAKE_CODEX = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
let stdin = '';
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', () => {
  const arg = process.argv.find((a) => a.startsWith('model_instructions_file='));
  const instructions = arg ? readFileSync(arg.slice('model_instructions_file='.length), 'utf8') : '';
  const locale = ['ar', 'de', 'es'].find((l) => instructions.includes('(locale ' + l + ')'));
  if (process.env.STUB_FAIL_LOCALES?.split(',').includes(locale)) {
    process.stderr.write('stub: upstream unavailable for ' + locale);
    process.exit(1);
  }
  const items = JSON.parse(stdin).items;
  const translations = {};
  for (const item of items) translations[item.key] = '[' + locale + '] ' + item.en;
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(translations) } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }) + '\\n');
});
`;

function writeFixtureCatalogs() {
  rmSync(join(workdir, LOCALE_DIR), { recursive: true, force: true });
  mkdirSync(join(workdir, LOCALE_DIR), { recursive: true });
  writeFileSync(join(workdir, LOCALE_DIR, 'en.json'), JSON.stringify(EN_KEYS) + '\n');
  for (const locale of TARGETS) {
    const blanks = Object.fromEntries(Object.keys(EN_KEYS).map((key) => [key, '']));
    writeFileSync(join(workdir, LOCALE_DIR, `${locale}.json`), JSON.stringify(blanks) + '\n');
  }
}

function runTranslate(env: Record<string, string>) {
  try {
    const stdout = execFileSync('node', ['scripts/i18n.mjs', 'translate'], {
      cwd: workdir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...env },
    });
    return { status: 0, stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '' };
  }
}

function readCatalog(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(join(workdir, LOCALE_DIR, `${locale}.json`), 'utf8'));
}

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'atoma-i18n-pipeline-'));
  cpSync(join(REPO_ROOT, 'scripts'), join(workdir, 'scripts'), { recursive: true });
  cpSync(join(REPO_ROOT, 'src', 'viz', 'client', 'locales'), join(workdir, LOCALE_DIR), { recursive: true });
  binDir = join(workdir, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'codex'), FAKE_CODEX);
  chmodSync(join(binDir, 'codex'), 0o755);
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('translate isolates locale failures', () => {
  it('writes the catalogs that succeeded and exits 1 when one locale fails', () => {
    writeFixtureCatalogs();
    const { status, stdout } = runTranslate({ STUB_FAIL_LOCALES: 'ar' });

    expect(status).toBe(1);
    expect(stdout).toContain('wrote 3/3');
    expect(stdout).toContain('wrote 0/3');

    // The sibling that failed keeps its blanks (nothing invented)…
    expect(readCatalog('ar')).toEqual(Object.fromEntries(Object.keys(EN_KEYS).map((key) => [key, ''])));
    // …while the successes are on disk — the 2026-08-27 incident lost exactly these.
    expect(readCatalog('de')).toEqual({
      greetings_one: '[de] one greeting',
      greetings_other: '[de] {{count}} greetings',
      farewell: '[de] goodbye',
    });
    expect(readCatalog('es')).toEqual({
      greetings_one: '[es] one greeting',
      greetings_other: '[es] {{count}} greetings',
      farewell: '[es] goodbye',
    });
  });

  it('exits 0 and writes every locale when all succeed', () => {
    writeFixtureCatalogs();
    const { status } = runTranslate({});

    expect(status).toBe(0);
    for (const locale of TARGETS) {
      expect(readCatalog(locale)).toEqual({
        greetings_one: `[${locale}] one greeting`,
        greetings_other: `[${locale}] {{count}} greetings`,
        farewell: `[${locale}] goodbye`,
      });
    }
  });
});

describe('the translation job is one step of CI', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('lives in ci.yml, gated to main pushes, with job-scoped write permission', () => {
    expect(workflow).toContain('  i18n:');
    expect(workflow).toMatch(/if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
    // contents: write belongs to the i18n job only; the workflow stays read-only.
    const i18nJob = workflow.slice(workflow.indexOf('  i18n:'), workflow.indexOf('  worker:'));
    expect(i18nJob).toContain('contents: write');
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    // The bot's commit must never re-trigger CI.
    expect(workflow).toContain('[skip ci]');
  });

  it('the standalone self-pushing i18n workflow is gone', () => {
    expect(existsSync(join(REPO_ROOT, '.github', 'workflows', 'i18n.yml'))).toBe(false);
  });
});
