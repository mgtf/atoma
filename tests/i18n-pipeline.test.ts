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
import { readFileSync, writeFileSync } from 'node:fs';
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
  // STUB_DRIFT_KEYS="ar:key" mimics the 2026-08-27 CI failures: in a FULL
  // batch (more than one item) the named key comes back with its {{token}}
  // filled in (placeholder drift). The lone-item RETRY call translates
  // correctly — showing the failure mode fixes it, which is the contract.
  const driftKeys = (process.env.STUB_DRIFT_KEYS ?? '')
    .split(',')
    .filter((entry) => entry.startsWith(locale + ':'))
    .map((entry) => entry.slice(locale.length + 1));
  // STUB_BLANK_KEYS="ar:key" returns a WHITESPACE-ONLY value for the named key:
  // the shape translate used to accept (value.length > 0) and check refused
  // (value.trim()), which is what made the i18n job permanently red.
  const blankKeys = (process.env.STUB_BLANK_KEYS ?? '')
    .split(',')
    .filter((entry) => entry.startsWith(locale + ':'))
    .map((entry) => entry.slice(locale.length + 1));
  // STUB_DRIFT_ONCE="ar:key" drifts the FIRST time a key is asked for and
  // answers correctly afterwards, whatever the batch size — the shape needed to
  // observe a WHOLLY rejected batch being retried (a batch of one always is).
  // State on disk because each call is a fresh process.
  const onceKeys = (process.env.STUB_DRIFT_ONCE ?? '')
    .split(',')
    .filter((entry) => entry.startsWith(locale + ':'))
    .map((entry) => entry.slice(locale.length + 1));
  const seenPath = process.env.STUB_STATE_FILE;
  let seen = [];
  if (seenPath) {
    try { seen = JSON.parse(readFileSync(seenPath, 'utf8')); } catch { seen = []; }
  }
  const translations = {};
  for (const item of items) {
    if (blankKeys.includes(item.key)) {
      translations[item.key] = '   ';
      continue;
    }
    if (onceKeys.includes(item.key) && !seen.includes(locale + ':' + item.key)) {
      seen.push(locale + ':' + item.key);
      translations[item.key] = '[' + locale + '] ' + item.en.replace(/\\{\\{\\w+\\}\\}/g, '').trim();
      continue;
    }
    if (items.length > 1 && driftKeys.includes(item.key)) {
      translations[item.key] = '[' + locale + '] ' + item.en.replace(/\\{\\{\\w+\\}\\}/g, '').trim();
    } else {
      translations[item.key] = '[' + locale + '] ' + item.en;
    }
  }
  if (seenPath) writeFileSync(seenPath, JSON.stringify(seen));
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

function runI18nCheck() {
  try {
    const stdout = execFileSync('node', ['scripts/i18n.mjs', 'check'], {
      cwd: workdir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
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

  it('rejects drifting keys, retries them alone, and still exits 0', () => {
    writeFixtureCatalogs();
    const { status, stdout } = runTranslate({
      STUB_DRIFT_KEYS: 'ar:greetings_other',
    });

    // Pure rejects are not a failure — the retry lands the drifted key.
    expect(status).toBe(0);
    expect(stdout).toContain('retry ar');
    expect(readCatalog('ar').greetings_other).toBe('[ar] {{count}} greetings');
    expect(readCatalog('ar').farewell).toBe('[ar] goodbye');
  });

  it('retries a WHOLLY rejected batch — the case a batch of one always is', () => {
    // 2026-08-27, finding 3.11. The retry was gated on
    // `sliceRejected.length < slice.length`, so it was skipped exactly when
    // every key of the batch drifted; with ATOMA_I18N_BATCH=1 that is every
    // rejection there can be, which is the one case the file's own doc
    // promised was covered. The key used to stay blank and cost a whole run.
    writeFixtureCatalogs();
    const { status, stdout } = runTranslate({
      ATOMA_I18N_BATCH: '1',
      STUB_DRIFT_ONCE: 'ar:greetings_other',
      STUB_STATE_FILE: join(workdir, 'stub-state.json'),
    });

    expect(status).toBe(0);
    expect(stdout).toContain('retry ar');
    expect(readCatalog('ar').greetings_other).toBe('[ar] {{count}} greetings');
  });

  it('never writes a whitespace-only value, whatever the model answers', () => {
    // 2026-08-27, finding 2.6. `translate` accepted `value.length > 0` and
    // `check` demanded `value.trim()`: this value was written, committed under
    // the pinned always() commit step, then invisible to `missingKeys` and
    // `fix-drift` alike — a red job that no later pass could repair.
    writeFixtureCatalogs();
    const { status } = runTranslate({ STUB_BLANK_KEYS: 'ar:farewell' });

    expect(status).toBe(0);
    // Left blank, so the NEXT run asks for it again…
    expect(readCatalog('ar').farewell).toBe('');
    // …and its siblings in the same batch are untouched by the refusal.
    expect(readCatalog('ar').greetings_one).toBe('[ar] one greeting');
    expect(readCatalog('de').farewell).toBe('[de] goodbye');

    // The gate that used to disagree now agrees, on the very catalogs the run
    // just wrote: this is the end-to-end shape of the hole.
    const check = runI18nCheck();
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('awaiting translation');
  });
});

describe('semantic drift is invalidated by a push, not only by a commit', () => {
  /**
   * 2026-08-27, finding 2.7. A reworded EN value keeps its placeholder
   * signature, so `check` and `fix-drift` are both blind to it: the pre-commit
   * hook was the ONLY guard, and it is skipped under CI=true, bypassed by
   * --no-verify, and absent from the GitHub web editor. Runs the real script
   * against a real git repository — the range logic IS git, so a mocked one
   * would prove nothing.
   */
  function gitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-i18n-range-'));
    cpSync(join(REPO_ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, LOCALE_DIR), { recursive: true });
    const git = (args: string) =>
      execFileSync('git', args.split(' '), { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    git('init -q -b main');
    git('config user.email test@example.com');
    git('config user.name test');
    return dir;
  }

  it('blanks a translation whose EN source was reworded without changing placeholders', () => {
    const dir = gitRepo();
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
      const write = (name: string, value: unknown) =>
        writeFileSync(join(dir, LOCALE_DIR, name), JSON.stringify(value, null, 2) + '\n');

      write('en.json', { farewell: 'goodbye', greetings_other: '{{count}} greetings' });
      write('fr.json', { farewell: 'au revoir', greetings_other: '{{count}} salutations' });
      git(['add', '-A']);
      git(['commit', '-qm', 'base']);
      const base = git(['rev-parse', 'HEAD']).trim();

      // The rewrite: same placeholders, different meaning. Committed WITHOUT
      // the hook, exactly as a web edit or a --no-verify commit would be.
      write('en.json', { farewell: 'see you soon', greetings_other: '{{count}} greetings' });
      git(['add', '-A']);
      git(['commit', '-qm', 'reword']);

      execFileSync('node', ['scripts/i18n.mjs', 'invalidate-range', `--since=${base}`], {
        cwd: dir,
        encoding: 'utf8',
      });

      const fr = JSON.parse(readFileSync(join(dir, LOCALE_DIR, 'fr.json'), 'utf8'));
      // The stale translation is blanked, so CI re-translates it…
      expect(fr.farewell).toBe('');
      // …and the value whose EN source did NOT change is left alone: this
      // must not blank a catalog wholesale and re-spend the whole run.
      expect(fr.greetings_other).toBe('{{count}} salutations');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('covers EVERY commit of a batched push, not just the last', () => {
    // With --since=HEAD^ a push carrying two commits would replay only the
    // second, silently leaving the first commit's rewording live.
    const dir = gitRepo();
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
      const write = (name: string, value: unknown) =>
        writeFileSync(join(dir, LOCALE_DIR, name), JSON.stringify(value, null, 2) + '\n');

      write('en.json', { a: 'first', b: 'second' });
      write('fr.json', { a: 'premier', b: 'deuxième' });
      git(['add', '-A']);
      git(['commit', '-qm', 'base']);
      const pushedFrom = git(['rev-parse', 'HEAD']).trim();

      write('en.json', { a: 'FIRST reworded', b: 'second' });
      git(['add', '-A']);
      git(['commit', '-qm', 'one']);
      write('en.json', { a: 'FIRST reworded', b: 'SECOND reworded' });
      git(['add', '-A']);
      git(['commit', '-qm', 'two']);

      execFileSync('node', ['scripts/i18n.mjs', 'invalidate-range', `--since=${pushedFrom}`], {
        cwd: dir,
        encoding: 'utf8',
      });

      const fr = JSON.parse(readFileSync(join(dir, LOCALE_DIR, 'fr.json'), 'utf8'));
      expect(fr).toEqual({ a: '', b: '' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when the baseline sha is unusable, rather than a failed job', () => {
    // A force push or a first push gives an all-zero `github.event.before`.
    const dir = gitRepo();
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
      writeFileSync(join(dir, LOCALE_DIR, 'en.json'), JSON.stringify({ a: 'one' }) + '\n');
      writeFileSync(join(dir, LOCALE_DIR, 'fr.json'), JSON.stringify({ a: 'un' }) + '\n');
      git(['add', '-A']);
      git(['commit', '-qm', 'root']);

      const stdout = execFileSync(
        'node',
        ['scripts/i18n.mjs', 'invalidate-range', '--since=0000000000000000000000000000000000000000'],
        { cwd: dir, encoding: 'utf8' }
      );
      expect(stdout).toContain('no readable baseline');
      // Nothing touched: a root commit has no "before" to compare against.
      expect(JSON.parse(readFileSync(join(dir, LOCALE_DIR, 'fr.json'), 'utf8'))).toEqual({ a: 'un' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

  it('translate failing never skips check or the commit step', () => {
    const i18nJob = workflow.slice(workflow.indexOf('  i18n:'), workflow.indexOf('  worker:'));
    // The translate step absorbs its own hard failures…
    expect(i18nJob).toMatch(/continue-on-error: true/);
    // …and both remaining steps run regardless, so nothing earned is dropped:
    expect(i18nJob).toMatch(/if: always\(\)\n {8}run: node scripts\/i18n\.mjs check/);
    const commitStep = i18nJob.slice(i18nJob.indexOf('Commit translated locale files'));
    // The comment sits between the name and the `if`; the guard must follow
    // within the step header, before its run block.
    expect(commitStep.split('run:')[0]).toContain('if: always()');
    // A push landing mid-run is rebased over, not a failed job.
    expect(commitStep).toContain('--rebase');
    // …and a rebase that STOPS on a conflict is aborted before the next
    // attempt (2026-08-27, 3.10). Without it attempts 2 and 3 could only fail:
    // `pull --rebase` refuses outright inside an unfinished rebase, so the
    // retry loop was decorative and the run's paid translations were re-spent.
    expect(commitStep).toContain('git rebase --abort');
  });

  it('replays the semantic-drift invalidation the pre-commit hook cannot guarantee', () => {
    // 2026-08-27, 2.7. The hook is skipped under CI=true, bypassed by
    // --no-verify, and absent from the web editor; nothing else in the pipeline
    // can see a rewording that keeps its placeholders.
    const i18nJob = workflow.slice(workflow.indexOf('  i18n:'), workflow.indexOf('  worker:'));
    expect(i18nJob).toContain('node scripts/i18n.mjs invalidate-range');
    // It must run BEFORE translate, or the run pays to translate values it is
    // about to blank.
    expect(i18nJob.indexOf('invalidate-range')).toBeLessThan(i18nJob.indexOf('i18n.mjs translate'));
    // The range is the whole push, so a batched push does not skip every
    // commit but its last — which is what a depth of 2 would have forced.
    expect(i18nJob).toContain('--since=${{ github.event.before }}');
    expect(i18nJob).toContain('fetch-depth: 0');
  });

  it('translates the branch tip and queues concurrent runs instead of cancelling', () => {
    const i18nJob = workflow.slice(workflow.indexOf('  i18n:'), workflow.indexOf('  worker:'));
    // 2026-08-28, run 33130929613: checked out at the trigger sha, the job
    // could not see the translation commit a re-run had landed 31 seconds
    // earlier, re-translated six already-filled catalogs (paid twice), and
    // produced a commit that could never rebase past main — same lines,
    // different model output — so the push retry loop exhausted every time.
    // The job's subject is the BRANCH's catalogs, so it checks out the tip:
    expect(i18nJob).toContain('ref: ${{ github.ref_name }}');
    // Queueing is what makes the tip checkout sufficient — the running job
    // lands its commit before the next one reads the tip — and cancelling an
    // in-flight translate could drop paid work besides.
    expect(i18nJob).toContain('cancel-in-progress: false');
  });

  it('the standalone self-pushing i18n workflow is gone', () => {
    expect(existsSync(join(REPO_ROOT, '.github', 'workflows', 'i18n.yml'))).toBe(false);
  });
});
