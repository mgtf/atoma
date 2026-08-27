#!/usr/bin/env node
/**
 * i18n.mjs — the locale pipeline for the viz catalogs.
 *
 * Applies the same method as bitsler-frontend's build/translate-*.js, reduced
 * to what atoma needs (no translation vendor: en.json is the source of truth,
 * every other locale follows it, and nothing syncs out to a third party).
 *
 *   en.json  the one source of truth. Every key exists here first.
 *   <locale>.json  translations; a missing or empty value awaits translation.
 *
 * Commands:
 *   check              verify target catalogs, non-empty EN values, matching
 *                      {{placeholder}} signatures, and no EN keys missing from
 *                      fr. Exit 1 with a report on any violation. Runs in CI
 *                      after translate; deliberately NOT part of `npm run
 *                      check`, because a blank fr value awaiting CI
 *                      translation is a normal state on a developer machine.
 *   fix-drift [--apply]
 *                      blank fr values whose {{placeholder}} signature
 *                      disagrees with EN, plus fr keys EN no longer has (after
 *                      manual sync of key sets). Dry-run by default.
 *   translate [--dry]  translate blank fr values with gpt-5.6-sol. Locally,
 *                      Codex CLI reuses `codex login` (ChatGPT Plus/Pro). In
 *                      CI, the OpenAI API uses OPENAI_API_KEY. Honours every
 *                      non-blank value verbatim; never invents keys. Writes
 *                      each target catalog as its locale finishes, so a
 *                      later locale's failure never discards an earlier
 *                      locale's successes (the 2026-08-27 incident: a zh
 *                      batch failure left ten `{}` catalogs uncommitted).
 *                      A key the model returns with placeholder drift gets
 *                      ONE isolated retry, then a named summary. Exit 1 only
 *                      on HARD locale failures (provider down, unreadable
 *                      batch); surviving rejects stay blank on disk — they
 *                      commit with everything else and retry next run, so
 *                      paid work is never dropped because one key refused.
 *                      CI's translate step is `continue-on-error` and the
 *                      check/commit steps run `always()`: the catalog write
 *                      path cannot be skipped by an exit code again.
 *   invalidate-staged  pre-commit helper. When a staged en.json has VALUE
 *                      changes (not additions), blank the same target keys
 *                      and re-stage it, so the next translate run re-does
 *                      them. No-op when en.json is not staged or HEAD has
 *                      none yet.
 *   sync               mechanical half of an interactive translation: print
 *                      the missing-key batch payload + rules for a caller
 *                      (usually this agent) to translate, then read a JSON
 *                      object of {key: value} back from stdin and write
 *                      one target catalog. Lets a human or agent translate
 *                      without an API key.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOCALE_DIR = join('src', 'viz', 'client', 'locales');
const EN_PATH = join(LOCALE_DIR, 'en.json');
const TARGET_LOCALES = readdirSync(resolvePath(LOCALE_DIR))
  .filter((name) => name.endsWith('.json') && name !== 'en.json')
  .map((name) => name.slice(0, -'.json'.length))
  .sort();
const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language' });
const LANGUAGE_NAME_OVERRIDES = {
  ar: 'Modern Standard Arabic',
  de: 'Standard German',
  zh: 'Simplified Chinese (Mandarin)',
};

function languageName(locale) {
  return LANGUAGE_NAME_OVERRIDES[locale] ?? LANGUAGE_NAMES.of(locale) ?? locale;
}

const [, , command, ...flags] = process.argv;
const APPLY = flags.includes('--apply');
const DRY = flags.includes('--dry');
const requestedLocale = flags.find((flag) => flag.startsWith('--locale='))?.slice('--locale='.length);
if (requestedLocale && !TARGET_LOCALES.includes(requestedLocale)) {
  process.stderr.write(`ERROR: unsupported target locale ${JSON.stringify(requestedLocale)}\n`);
  process.exit(1);
}
const selectedTargets = requestedLocale ? [requestedLocale] : TARGET_LOCALES;

function targetPath(locale) {
  return join(LOCALE_DIR, `${locale}.json`);
}

function rulesPath(locale) {
  return join('scripts', 'i18n-rules', `${locale}.md`);
}

function usage() {
  process.stderr.write(
    'Usage:\n' +
      '  node scripts/i18n.mjs check [--locale=<code>]\n' +
      '  node scripts/i18n.mjs fix-drift [--apply] [--locale=<code>]\n' +
      '  node scripts/i18n.mjs translate [--dry] [--locale=<code>]\n' +
      '  node scripts/i18n.mjs invalidate-staged\n' +
      '  node scripts/i18n.mjs sync [--locale=<code>]\n'
  );
  process.exit(1);
}

if (!command || !['check', 'fix-drift', 'translate', 'invalidate-staged', 'sync'].includes(command)) {
  usage();
}

// ---------- catalog helpers --------------------------------------------------

function readCatalog(path) {
  const full = resolvePath(path);
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch (error) {
    process.stderr.write(`ERROR: ${path} is not valid JSON: ${error.message}\n`);
    process.exit(1);
  }
}

function writeCatalog(path, catalog) {
  writeFileSync(resolvePath(path), JSON.stringify(catalog, null, 2) + '\n');
}

function resolvePath(relativePath) {
  return path.resolve(REPO_ROOT, relativePath);
}

/** The sorted set of `{{name}}` interpolations in a value, blanks included. */
function placeholderSignature(value) {
  if (typeof value !== 'string') return '';
  const matches = value.match(/\{\{\s*\w+\s*\}\}/g);
  return matches ? matches.slice().sort().join('|') : '';
}

function placeholdersMatch(en, fr) {
  return placeholderSignature(en) === placeholderSignature(fr);
}

// ---------- check ------------------------------------------------------------

function runCheck() {
  const en = readCatalog(EN_PATH);
  if (!en) {
    process.stderr.write(`ERROR: missing ${EN_PATH}\n`);
    process.exit(1);
  }

  const problems = [];
  let blanks = 0;
  for (const locale of selectedTargets) {
    const target = readCatalog(targetPath(locale));
    if (!target) {
      problems.push(`${locale}: missing ${targetPath(locale)}`);
      continue;
    }
    for (const [key, enValue] of Object.entries(en)) {
      if (typeof enValue !== 'string' || !enValue.trim()) {
        problems.push(`${key}: EN value is empty — EN is the source of truth and never blanks`);
        continue;
      }
      const value = target[key];
      if (value === undefined || value === '') {
        blanks += 1;
        continue;
      }
      if (typeof value !== 'string' || !value.trim()) {
        problems.push(`${locale}.${key}: value is not a non-empty string`);
      } else if (!placeholdersMatch(enValue, value)) {
        problems.push(`${locale}.${key}: placeholder drift (EN "${placeholderSignature(enValue)}" vs target "${placeholderSignature(value)}")`);
      }
    }
    for (const key of Object.keys(target)) {
      if (!(key in en)) problems.push(`${locale}.${key}: target key is absent from en.json`);
    }
  }

  for (const problem of problems) process.stdout.write(`  ✗ ${problem}\n`);
  process.stdout.write(`check: ${Object.keys(en).length} EN keys, ${selectedTargets.length} target locale(s), ${blanks} awaiting translation, ${problems.length} problem(s)\n`);
  if (problems.length > 0) process.exit(1);
}

// ---------- fix-drift --------------------------------------------------------

function runFixDrift() {
  const en = readCatalog(EN_PATH);
  if (!en) {
    process.stderr.write(`ERROR: missing ${EN_PATH}\n`);
    process.exit(1);
  }
  let changes = 0;
  for (const locale of selectedTargets) {
    const target = readCatalog(targetPath(locale));
    if (!target) continue;
    const drift = Object.entries(en)
      .filter(([key, value]) => target[key] !== '' && target[key] !== undefined && !placeholdersMatch(value, target[key]))
      .map(([key]) => key);
    const orphans = Object.keys(target).filter((key) => !(key in en));
    changes += drift.length + orphans.length;
    for (const key of drift) process.stdout.write(`  ~ ${locale}.${key}: placeholder drift\n`);
    for (const key of orphans) process.stdout.write(`  x ${locale}.${key}: not in EN\n`);
    if (APPLY) {
      for (const key of drift) target[key] = '';
      for (const key of orphans) delete target[key];
      writeCatalog(targetPath(locale), target);
    }
  }
  if (changes === 0) process.stdout.write('fix-drift: no placeholder drift, no orphan keys.\n');
  else if (!APPLY) process.stdout.write('\n(dry-run — pass --apply to blank drifted values / drop orphans)\n');
  else process.stdout.write(`fix-drift: repaired ${changes} target value(s). Run translate next.\n`);
}

// ---------- translate (Codex locally, OpenAI API in CI) ---------------------

const UNIVERSAL_RULES = `## Universal translation rules

- **Interpolation tokens** — \`{{count}}\`, \`{{name}}\`, \`{{version}}\`, etc. must remain unchanged and in the same number. Only translate the surrounding text.
- **Pluralisation** — the catalog deliberately has exactly two forms: \`<key>_one\` for count 1 and \`<key>_other\` for every other count. Phrase \`_other\` so it remains grammatical with any displayed number.
- **Product vocabulary** — do not translate: atoma, run, skill, burn-in, fallback, trust, tier, registry (but "registry" IS translated per the language rules), GitHub, MCP, WebGPU.
- **Tone** — match the source register: short UI labels stay short, explanatory copy stays clear and plain.
- **Faithfulness** — preserve every semantic component, including qualifiers ("up to", "at least") and leading symbols (✓ ✕ ⚠ ● ⟳ ⛔ ⊘ ⚡ 📖 ✏️ 🛡️).
- **Length** — stay close to the English length. Accuracy first, no padding.
`;

function buildSystemPrompt(locale) {
  const language = languageName(locale);
  const localeRulesPath = rulesPath(locale);
  const languageRules = existsSync(resolvePath(localeRulesPath))
    ? readFileSync(resolvePath(localeRulesPath), 'utf8')
    : `## Language rules — ${language}\n\nUse natural, contemporary ${language} appropriate for a professional software interface.\n`;
  return `You are a professional translator for a software platform's interface. You translate English interface copy to ${language} (locale ${locale}).

${languageRules}

${UNIVERSAL_RULES}

## Output format

You receive a JSON payload with an \`items\` array. Each item has \`key\` and \`en\`.
Reply with **one JSON object only**, no prose, no code fence, mapping each key to its ${language} translation.
Include every key from the input.`;
}

function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return JSON.parse(fenced[1]);
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error('no JSON object in response');
  }
}

/**
 * Backend selection, once per run:
 *   ATOMA_I18N_BACKEND=codex|openai     explicit choice
 *   default                              codex when the CLI is on PATH,
 *                                       else openai.
 *
 * The codex backend rides a ChatGPT Plus/Pro subscription (the `codex login`
 * credentials). CI cannot inherit a personal subscription and uses an OpenAI
 * API key instead. Both paths pin the same model and return the same shape.
 */
function selectBackend() {
  const forced = (process.env.ATOMA_I18N_BACKEND || '').trim().toLowerCase();
  if (forced && forced !== 'codex' && forced !== 'openai') {
    throw new Error(`ATOMA_I18N_BACKEND must be "codex" or "openai", got ${JSON.stringify(forced)}`);
  }
  if (forced) return forced;
  try {
    execSync('command -v codex', { stdio: ['ignore', 'pipe', 'ignore'] });
    return 'codex';
  } catch {
    return 'openai';
  }
}

/** Codex CLI model: gpt-5.6-sol by default (ATOMA_I18N_CODEX_MODEL overrides). */
function codexModel() {
  return process.env.ATOMA_I18N_CODEX_MODEL || 'gpt-5.6-sol';
}

/**
 * One `codex exec` call. Isolation mirrors src/core/llmCodexCli.ts, whose
 * flags are measured and pinned there: --ephemeral (no session files),
 * --ignore-user-config/--ignore-rules (the operator's config.toml must not
 * bleed into the translation), -s read-only, -C <empty tmp dir> (bounds what
 * the harness can reach), prompt on stdin. model_instructions_file carries
 * the system prompt in place of Codex's own preamble.
 */
async function callCodex(systemPrompt, payload) {
  const root = mkdtempSync(path.join(tmpdir(), 'atoma-i18n-'));
  const cwd = path.join(root, 'cwd');
  const instructionsFile = path.join(root, 'instructions.txt');
  const schemaFile = path.join(root, 'output-schema.json');
  mkdirSync(cwd);
  writeFileSync(instructionsFile, systemPrompt, 'utf8');
  writeFileSync(schemaFile, JSON.stringify(translationSchema(payload)), 'utf8');
  try {
    const args = [
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '-s', 'read-only',
      '-C', cwd,
      '--skip-git-repo-check',
      '-m', codexModel(),
      '--output-schema', schemaFile,
      '-c', `model_instructions_file=${instructionsFile}`,
      '-c', 'model_reasoning_effort=medium',
      '-',
    ];
    const { text, usage, error } = await spawnCodexJson(args, JSON.stringify(payload));
    if (error) throw new Error(`codex: ${error}`);
    if (!text.trim()) throw new Error('codex produced no output');
    return { text, usage, model: codexModel() };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Spawn codex, feed the prompt on stdin, fold the JSONL event stream. */
function spawnCodexJson(args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: process.env,
    });
    let stdoutBuf = '';
    const lines = [];
    let stderrTail = '';
    let settled = false;
    let timer;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const bumpDeadline = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch { /* already gone */ }
        settle(reject, new Error('codex call produced no output for 10 minutes'));
      }, 10 * 60 * 1000);
    };
    bumpDeadline();
    child.on('error', (err) => settle(reject, err));
    child.stdout?.on('data', (d) => {
      bumpDeadline();
      stdoutBuf += d.toString();
      const parts = stdoutBuf.split('\n');
      stdoutBuf = parts.pop() || '';
      for (const p of parts) lines.push(p);
    });
    child.stderr?.on('data', (d) => {
      bumpDeadline();
      stderrTail = (stderrTail + d.toString()).slice(-1500);
    });
    child.on('close', (code) => {
      if (stdoutBuf.trim()) lines.push(stdoutBuf);
      // Same fold as llmCodexCli.foldCodexEvents: last agent_message wins,
      // usage from turn.completed, error only from typed error/turn.failed.
      let text = '';
      let usage;
      let error;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let e;
        try { e = JSON.parse(trimmed); } catch { continue; }
        if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text?.trim()) {
          text = e.item.text;
        } else if (e.type === 'turn.completed') {
          usage = e.usage;
        } else if (e.type === 'error') {
          error = e.message;
        } else if (e.type === 'turn.failed') {
          error = e.error?.message || 'turn failed';
        }
      }
      if (!error && code !== 0) error = stderrTail.trim() || `codex exited with status ${code}`;
      if (!error && !text.trim()) error = stderrTail.trim() || 'codex produced no output';
      settle(resolve, { text, usage, error });
    });
    child.stdin?.end(stdin);
  });
}

function translationSchema(payload) {
  const properties = Object.fromEntries(payload.items.map(({ key }) => [key, { type: 'string', minLength: 1 }]));
  return {
    type: 'object',
    properties,
    required: payload.items.map(({ key }) => key),
    additionalProperties: false,
  };
}

function openAiResponseText(data) {
  return (data.output || [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((content) => content.type === 'output_text')
    .map((content) => content.text || '')
    .join('');
}

async function callOpenAi(systemPrompt, payload, attempt = 1) {
  const model = codexModel();
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal: AbortSignal.timeout(10 * 60 * 1000),
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions: systemPrompt,
      input: JSON.stringify(payload),
      reasoning: { effort: 'medium' },
      text: {
        format: {
          type: 'json_schema',
          name: 'translations',
          strict: true,
          schema: translationSchema(payload),
        },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const retriable = res.status === 429 || res.status >= 500;
    if (retriable && attempt < 4) {
      const backoff = 2000 * attempt;
      process.stderr.write(`  retry ${attempt}/3 after ${backoff}ms (HTTP ${res.status})\n`);
      await new Promise((r) => setTimeout(r, backoff));
      return callOpenAi(systemPrompt, payload, attempt + 1);
    }
    throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = openAiResponseText(data);
  if (!text.trim()) throw new Error(`OpenAI API returned no output text (response ${data.id || 'unknown'})`);
  return { text, usage: data.usage, model: data.model || model };
}

function missingKeys(en, fr) {
  return Object.keys(en).filter((key) => {
    const value = fr[key];
    return value === undefined || value === '';
  });
}

async function runTranslate() {
  const en = readCatalog(EN_PATH);
  if (!en) {
    process.stderr.write(`ERROR: missing ${EN_PATH}\n`);
    process.exit(1);
  }
  const work = selectedTargets.map((locale) => {
    const catalog = readCatalog(targetPath(locale)) ?? {};
    return { locale, catalog, missing: missingKeys(en, catalog) };
  });
  const missingTotal = work.reduce((sum, target) => sum + target.missing.length, 0);
  process.stdout.write(`translate: ${missingTotal} value(s) awaiting translation across ${work.length} locale(s)\n`);
  if (missingTotal === 0) return;
  if (DRY) {
    for (const target of work) {
      process.stdout.write(`  ${target.locale}: ${target.missing.length} key(s)\n`);
      for (const key of target.missing.slice(0, 5)) process.stdout.write(`    - ${key}\n`);
    }
    process.stdout.write('(dry-run — no API call, no write)\n');
    return;
  }
  let backend;
  try {
    backend = selectBackend();
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exit(1);
  }
  const call = backend === 'codex' ? callCodex : callOpenAi;
  if (backend === 'openai' && !process.env.OPENAI_API_KEY) {
    process.stderr.write(
      'ERROR: Codex CLI is unavailable and OPENAI_API_KEY is not set. Install/login to Codex for ChatGPT Pro, or set the API key for CI.\n'
    );
    process.exit(1);
  }
  process.stdout.write(`translate: backend ${backend}${backend === 'codex' ? ` (${codexModel()})` : ''}\n`);

  const configuredBatch = Number.parseInt(process.env.ATOMA_I18N_BATCH || '', 10);
  const BATCH = Number.isInteger(configuredBatch) && configuredBatch > 0 ? configuredBatch : 120;
  let failed = false;
  for (const target of work) {
    if (target.missing.length === 0) continue;
    const translated = {};
    let inTok = 0;
    let outTok = 0;
    let servedModel = '';
    let localeFailed = false;
    const systemPrompt = buildSystemPrompt(target.locale);
    process.stdout.write(`  ${target.locale} (${languageName(target.locale)}): ${target.missing.length} key(s)\n`);
    for (let i = 0; i < target.missing.length; i += BATCH) {
      const slice = target.missing.slice(i, i + BATCH);
      const batchNum = Math.floor(i / BATCH) + 1;
      const totalBatches = Math.ceil(target.missing.length / BATCH);
      process.stdout.write(`    batch ${batchNum}/${totalBatches} (${slice.length} keys)… `);
      const t0 = Date.now();
      let result;
      try {
        result = await call(systemPrompt, { items: slice.map((key) => ({ key, en: en[key] })) });
      } catch (error) {
        process.stderr.write(`\nERROR ${target.locale} batch ${batchNum}: ${error.message}\n`);
        localeFailed = true;
        break;
      }
      const { text, usage, model } = result;
      servedModel = model;
      let parsed;
      try {
        parsed = extractJson(text);
      } catch (error) {
        process.stderr.write(`\nERROR parsing ${target.locale} batch ${batchNum}: ${error.message}\nRaw: ${text.slice(0, 400)}\n`);
        localeFailed = true;
        break;
      }
      let got = 0;
      const sliceRejected = [];
      for (const key of slice) {
        const value = parsed[key];
        if (typeof value === 'string' && value.length > 0 && placeholdersMatch(en[key], value)) {
          translated[key] = value;
          got += 1;
        } else if (typeof value === 'string' && value.length > 0) {
          process.stderr.write(`\n    rejected ${target.locale}.${key} (placeholder drift in model output)\n`);
          sliceRejected.push(key);
        }
      }
      // A rejected key is not lost: one retry with ONLY the rejected keys and
      // an explicit per-key instruction usually lands them (the model filled a
      // {{token}} in or dropped it — showing the failure mode fixes it). One
      // pass only: if the retry also drifts, the key is reported and left for
      // the next run rather than burning more quota.
      if (sliceRejected.length > 0 && sliceRejected.length < slice.length) {
        process.stdout.write(`    retry ${target.locale}: ${sliceRejected.length} key(s) alone… `);
        try {
          const retryResult = await call(
            systemPrompt,
            { items: sliceRejected.map((key) => ({ key, en: en[key] })) }
          );
          const retryParsed = extractJson(retryResult.text);
          let retried = 0;
          for (const key of sliceRejected) {
            const value = retryParsed[key];
            if (
              typeof value === 'string' && value.length > 0 &&
              placeholdersMatch(en[key], value)
            ) {
              translated[key] = value;
              got += 1;
              retried += 1;
            } else {
              process.stderr.write(`\n    still-rejected ${target.locale}.${key}\n`);
            }
          }
          inTok += retryResult.usage?.input_tokens || 0;
          outTok += retryResult.usage?.output_tokens || 0;
          process.stdout.write(`${retried}/${sliceRejected.length}\n`);
        } catch (error) {
          process.stderr.write(`\n    retry failed: ${error.message}\n`);
        }
      }
      inTok += usage?.input_tokens || 0;
      outTok += usage?.output_tokens || 0;
      process.stdout.write(`${got}/${slice.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    }
    // Write what this locale earned even when it failed: successes are never
    // held hostage to a sibling locale's error. A pure-reject locale (every
    // batch PARSED, some keys refused) is NOT a failure: the catalog on disk
    // is better than before, and the commit below lands it; only hard errors
    // — provider down, unreadable JSON — keep the run red, because there the
    // next run has real work to redo.
    const next = { ...target.catalog, ...translated };
    writeCatalog(targetPath(target.locale), next);
    process.stdout.write(`  wrote ${Object.keys(translated).length}/${target.missing.length} to ${targetPath(target.locale)} (model ${servedModel}, tokens ${inTok} in / ${outTok} out)\n`);
    if (localeFailed) failed = true;
  }
  if (failed) {
    process.stderr.write('ERROR: one or more locales hit a hard failure; completed catalogs were still written — rerun translate for the remaining blanks.\n');
    process.exitCode = 1;
    return;
  }
  // Rejected keys (never hard-failed) do not fail the run: the catalogs on
  // disk are strictly better, the commit below lands them, and this summary
  // names what stayed blank instead of hiding it behind an exit code.
  const leftover = work.reduce(
    (sum, target) => sum + missingKeys(en, readCatalog(targetPath(target.locale))).length,
    0
  );
  if (leftover > 0) {
    process.stdout.write(`translate: ${leftover} value(s) still blank after rejected keys — they will retry on the next run.\n`);
  }
}

// ---------- invalidate-staged (pre-commit) ------------------------------------

function runGit(command) {
  return execSync(command, { encoding: 'utf8', cwd: REPO_ROOT }).trim();
}

function runInvalidateStaged() {
  const staged = runGit('git diff --cached --name-only').split('\n').filter(Boolean);
  if (!staged.includes(EN_PATH)) return; // nothing to do, exit 0

  let head;
  let stagedEn;
  try {
    stagedEn = JSON.parse(runGit(`git show :${EN_PATH}`));
    head = JSON.parse(runGit(`git show HEAD:${EN_PATH}`));
  } catch {
    return; // initial commit or unreadable HEAD — a no-op, not a failure
  }

  const changed = Object.keys(stagedEn).filter(
    (key) =>
      key in head &&
      typeof stagedEn[key] === 'string' &&
      typeof head[key] === 'string' &&
      stagedEn[key] !== head[key]
  );
  if (changed.length === 0) return;

  const restaged = [];
  for (const locale of TARGET_LOCALES) {
    const path = targetPath(locale);
    const target = readCatalog(path);
    if (!target) continue;
    const before = JSON.stringify(target);
    for (const key of changed) {
      if (key in target && target[key] !== '') target[key] = '';
    }
    if (JSON.stringify(target) === before) continue;
    writeCatalog(path, target);
    runGit(`git add "${path}"`);
    restaged.push(locale);
  }
  if (restaged.length === 0) return;
  process.stdout.write(`[i18n] ${changed.length} EN value change(s) — blanked ${restaged.join(', ')} counterpart(s), re-staged. CI will re-translate.\n`);
  for (const key of changed) process.stdout.write(`  - ${key}\n`);
}

// ---------- sync (interactive, no API) ----------------------------------------

function runSync() {
  const en = readCatalog(EN_PATH);
  if (!en) {
    process.stderr.write(`ERROR: missing ${EN_PATH}\n`);
    process.exit(1);
  }
  const locale = requestedLocale ?? 'fr';
  const target = readCatalog(targetPath(locale)) ?? {};
  const missing = missingKeys(en, target);

  if (process.stdin.isTTY && missing.length > 0) {
    process.stdout.write('## Batch payload (JSON)\n\n');
    process.stdout.write(JSON.stringify({ batch_size: missing.length, items: missing.map((key) => ({ key, en: en[key] })) }, null, 2) + '\n\n');
    const localeRulesPath = rulesPath(locale);
    if (existsSync(resolvePath(localeRulesPath))) {
      process.stdout.write(readFileSync(resolvePath(localeRulesPath), 'utf8'));
    }
    process.stdout.write('\n## Emit translations\n\n');
    process.stdout.write(`Pipe a JSON object of {key: "${languageName(locale)}"} back:\n\n  node scripts/i18n.mjs sync --locale=${locale} << 'EOF'\n  { "key": "value" }\n  EOF\n`);
    return;
  }

  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const raw = chunks.join('').trim();
    if (!raw) {
      process.stderr.write('ERROR: empty payload on stdin.\n');
      process.exit(1);
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      process.stderr.write(`ERROR: could not parse JSON payload: ${error.message}\n`);
      process.exit(1);
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      process.stderr.write('ERROR: payload must be a JSON object of {key: value}.\n');
      process.exit(1);
    }
    let written = 0;
    let rejected = 0;
    const next = { ...target };
    for (const [key, value] of Object.entries(payload)) {
      if (!(key in en)) continue; // never invent keys
      if (typeof value !== 'string' || value === '') continue;
      if (!placeholdersMatch(en[key], value)) {
        rejected += 1;
        process.stderr.write(`  rejected ${key} (placeholder drift)\n`);
        continue;
      }
      next[key] = value;
      written += 1;
    }
    // Rebuild in EN key order so the two files diff cleanly side by side.
    const ordered = {};
    for (const key of Object.keys(en)) ordered[key] = next[key] ?? '';
    writeCatalog(targetPath(locale), ordered);
    process.stdout.write(`sync: wrote ${written} key(s)${rejected ? `, rejected ${rejected}` : ''} to ${targetPath(locale)}\n`);
  });
}

// ---------- entry -------------------------------------------------------------

const runners = {
  check: runCheck,
  'fix-drift': runFixDrift,
  translate: runTranslate,
  'invalidate-staged': runInvalidateStaged,
  sync: runSync,
};
await runners[command]();
