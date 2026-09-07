import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolSandbox } from '../src/tools/sandbox.js';
import {
  validateHtmlTool,
  startStaticServerTool,
  isSpeculativeFaviconRequest,
  mergeConsoleErrors,
  interactionPhaseBudgetMs,
  INTERACTION_PHASE_BUDGET_MS,
  MAX_HOLD_MS,
} from '../src/tools/builtin.js';

/**
 * `validate_html` had three UNBOUNDED quantities, each measured turning a
 * model slip into minutes of dead wall-clock or a false failure. Audit over
 * the 208 archived calls in the last 40 runs:
 *
 *   - 3 calls (1.4%) consumed 831s of the 1186s total browser wall-clock:
 *     one held a key for 270_500ms to "advance" an in-page timer (273s), one
 *     batched 31 interactions into a wedged CDP command (546s, failed anyway).
 *   - 10 calls (4.8%) returned `ok: false` with Chrome's own speculative
 *     /favicon.ico 404 as their ONLY error — 13% of every failure the tool
 *     reported, on pages that worked.
 *
 * Each test below fails against the pre-fix tool: the favicon cases returned
 * ok:false, and the hold case took a full minute.
 */

const sandboxes: ToolSandbox[] = [];
const dirs: string[] = [];

function makeWorkspace(files: Record<string, string>): ToolSandbox {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-vhtml-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  const sandbox = new ToolSandbox(dir);
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(async () => {
  delete process.env['ATOMA_VALIDATE_INTERACTION_BUDGET_MS'];
  for (const s of sandboxes.splice(0)) await s.cleanup().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function serve(sandbox: ToolSandbox): Promise<string> {
  const res = (await startStaticServerTool({ sandbox }).execute({})) as {
    ok: boolean;
    url: string;
  };
  expect(res.ok, `static server failed to boot: ${JSON.stringify(res)}`).toBe(true);
  return res.url;
}

describe('validate_html form input', () => {
  it('replaces existing text before submitting through the page control', async () => {
    const sandbox = makeWorkspace({
      'index.html': '<input id="note" value="old text"><button id="add" onclick="document.getElementById(\'result\').textContent=document.getElementById(\'note\').value">Add</button><p id="result"></p>',
    });
    const url = await serve(sandbox);
    const result = await validateHtmlTool({ sandbox }).execute({
      url,
      interactions: [
        { type: 'type', selector: '#note', text: 'new note' },
        { type: 'click', selector: '#add' },
      ],
      smoke: '(() => ({ok: document.getElementById("result").textContent === "new note", value: document.getElementById("note").value}))()',
    });
    expect(result).toMatchObject({
      ok: true,
      errors: [],
      requestedInteractions: 2,
      smokeResult: { ok: true, value: 'new note' },
    });
  });
});

describe('isSpeculativeFaviconRequest — narrow by construction', () => {
  const page = 'http://localhost:8123/index.html';

  it('suppresses the browser auto-request when the document declares no icon', () => {
    expect(isSpeculativeFaviconRequest('http://localhost:8123/favicon.ico', page, false)).toBe(true);
  });

  it('KEEPS it when the document declares an icon — that is a real broken artefact', () => {
    expect(isSpeculativeFaviconRequest('http://localhost:8123/favicon.ico', page, true)).toBe(false);
  });

  it('keeps a genuinely missing asset', () => {
    expect(isSpeculativeFaviconRequest('http://localhost:8123/app.js', page, false)).toBe(false);
  });

  it('keeps a cross-origin favicon — not our page, not our auto-request', () => {
    expect(isSpeculativeFaviconRequest('http://evil.example/favicon.ico', page, false)).toBe(false);
  });

  it('keeps a favicon-looking path that is not the root request', () => {
    expect(
      isSpeculativeFaviconRequest('http://localhost:8123/assets/favicon.ico', page, false)
    ).toBe(false);
  });

  it('does not throw on unparseable urls', () => {
    expect(isSpeculativeFaviconRequest('not a url', page, false)).toBe(false);
    expect(isSpeculativeFaviconRequest('http://localhost:8123/favicon.ico', 'nope', false)).toBe(
      false
    );
  });
});

describe('mergeConsoleErrors', () => {
  const page = 'http://localhost:8123/index.html';

  it('renders the source suffix and drops only the speculative favicon', () => {
    const merged = mergeConsoleErrors(
      [
        { text: '404', loc: 'http://localhost:8123/favicon.ico' },
        { text: 'boom', loc: 'http://localhost:8123/app.js' },
      ],
      page,
      false
    );
    expect(merged).toEqual(['boom [source: http://localhost:8123/app.js]']);
  });

  it('ALWAYS keeps an error with no source — absent evidence, report it', () => {
    expect(mergeConsoleErrors([{ text: 'unattributable' }], page, false)).toEqual([
      'unattributable',
    ]);
  });
});

describe('interactionPhaseBudgetMs — a typo must not disable the guard', () => {
  it('defaults, and falls back to the default on invalid/zero/negative', () => {
    expect(interactionPhaseBudgetMs()).toBe(INTERACTION_PHASE_BUDGET_MS);
    for (const bad of ['nonsense', '0', '-1', '']) {
      process.env['ATOMA_VALIDATE_INTERACTION_BUDGET_MS'] = bad;
      expect(interactionPhaseBudgetMs(), `"${bad}" must fall back`).toBe(
        INTERACTION_PHASE_BUDGET_MS
      );
    }
    process.env['ATOMA_VALIDATE_INTERACTION_BUDGET_MS'] = '1500';
    expect(interactionPhaseBudgetMs()).toBe(1500);
  });
});

describe('validate_html — the bounds, against a real browser', () => {
  it('a working page with NO favicon is ok:true (it used to fail on the browser auto-404)', async () => {
    const sandbox = makeWorkspace({
      'index.html': '<!doctype html><title>Clean</title><h1 id="h">hello</h1>',
    });
    const url = await serve(sandbox);
    const res = (await validateHtmlTool({ sandbox }).execute({
      url: `${url}index.html`,
      smoke: 'document.getElementById("h").textContent === "hello"',
    })) as { ok: boolean; errors: string[] };

    expect(res.errors, `errors should be empty: ${JSON.stringify(res.errors)}`).toEqual([]);
    expect(res.ok).toBe(true);
  }, 60_000);

  it('a page that DECLARES a missing icon still fails — the filter stays narrow', async () => {
    const sandbox = makeWorkspace({
      'index.html':
        '<!doctype html><title>Declared</title><link rel="icon" href="/favicon.ico"><h1>hi</h1>',
    });
    const url = await serve(sandbox);
    const res = (await validateHtmlTool({ sandbox }).execute({
      url: `${url}index.html`,
    })) as { ok: boolean; errors: string[] };

    expect(res.errors.some((e) => /favicon\.ico/.test(e))).toBe(true);
    expect(res.ok).toBe(false);
  }, 60_000);

  it('clamps an absurd holdMs and SAYS SO instead of stalling for a minute', async () => {
    const sandbox = makeWorkspace({
      'index.html': '<!doctype html><title>Hold</title><h1>hi</h1>',
    });
    const url = await serve(sandbox);
    const started = Date.now();
    const res = (await validateHtmlTool({ sandbox }).execute({
      url: `${url}index.html`,
      interactions: [{ type: 'keypress', key: 'a', holdMs: 60_000 }],
    })) as { warnings: string[]; interactionLog: string[] };
    const elapsed = Date.now() - started;

    // Pre-fix this waited the full 60s.
    expect(elapsed, `took ${elapsed}ms — the clamp did not apply`).toBeLessThan(30_000);
    expect(res.interactionLog.join(' ')).toContain(`(${MAX_HOLD_MS}ms)`);
    expect(res.warnings.some((w) => /clamped to/.test(w))).toBe(true);
    // The warning must carry the technique that actually works.
    expect(res.warnings.some((w) => /window\.__test/.test(w))).toBe(true);
  }, 60_000);

  it('stops the interaction phase at its budget and reports the skipped tail as an error', async () => {
    process.env['ATOMA_VALIDATE_INTERACTION_BUDGET_MS'] = '1000';
    const sandbox = makeWorkspace({
      // Each click blocks the page for 400ms, so the budget bites part-way.
      'index.html': [
        '<!doctype html><title>Slow</title><button id="b">go</button>',
        '<script>document.getElementById("b").addEventListener("click",()=>{',
        'const end=Date.now()+400;while(Date.now()<end){}});</script>',
      ].join(''),
    });
    const url = await serve(sandbox);
    const interactions = Array.from({ length: 12 }, () => ({
      type: 'click' as const,
      selector: '#b',
    }));
    const res = (await validateHtmlTool({ sandbox }).execute({
      url: `${url}index.html`,
      interactions,
    })) as { ok: boolean; errors: string[]; interactionLog: string[] };

    const budgetErr = res.errors.find((e) => /interaction budget exhausted/.test(e));
    expect(budgetErr, `no budget error. errors=${JSON.stringify(res.errors)}`).toBeTruthy();
    expect(budgetErr).toMatch(/of 12 interactions were SKIPPED/);
    expect(res.interactionLog.length).toBeLessThan(12);
    // A truncated sequence must FAIL the call — the smoke would be judging
    // a state the caller never reached.
    expect(res.ok).toBe(false);
  }, 60_000);
});

/**
 * The pre-flight refusals cross the PRODUCTION handler, not just the pure
 * detectors: the handler is where they used to return one at a time.
 *
 * The URL here is deliberately unreachable — a refusal that still names both
 * problems proves the tool answered without opening a page, which is the
 * whole point of a pre-flight.
 */
describe('validate_html — every applicable pre-flight refusal, in one call', () => {
  it('reports both refusals without opening a browser', async () => {
    const sandbox = makeWorkspace({ 'index.html': '<!doctype html><h1>x</h1>' });
    const started = Date.now();
    const res = (await validateHtmlTool({ sandbox }).execute({
      url: 'http://127.0.0.1:1/',
      interactions: [
        { type: 'click', selector: '#add' },
        { type: 'click', selector: '#add' },
        { type: 'click', selector: '#add' },
        { type: 'click', selector: '#reset' },
      ],
      smoke: `getComputedStyle(document.body).color === 'rgb(0, 0, 0)'`,
    })) as { ok: boolean; errors: string[]; smokeResult: { error: string; hint?: string } };
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(false);
    expect(res.errors).toHaveLength(2);
    expect(res.errors.every((e) => e.startsWith('smoke rejected pre-flight: '))).toBe(true);
    expect(res.errors[0]).toMatch(/getComputedStyle/);
    expect(res.errors[1]).toMatch(/intermediate state has been erased/);
    // Both reasons reach the smokeResult channel too, and the accepted shape
    // is quoted so the next attempt does not have to be guessed.
    expect(res.smokeResult.error).toContain(' ALSO: ');
    expect(res.smokeResult.error).toContain('window.__app');
    expect(res.smokeResult.hint).toBeUndefined();
    expect(elapsed, `took ${elapsed}ms — a browser was opened`).toBeLessThan(2_000);
  });

  it('a syntax refusal still carries the expression hint', async () => {
    const sandbox = makeWorkspace({ 'index.html': '<!doctype html><h1>x</h1>' });
    const res = (await validateHtmlTool({ sandbox }).execute({
      url: 'http://127.0.0.1:1/',
      smoke: 'const x = document.title; x.length > 0',
    })) as { errors: string[]; smokeResult: { hint?: string } };

    expect(res.errors).toHaveLength(1);
    expect(res.smokeResult.hint).toMatch(/must be a JS EXPRESSION/);
  });
});
