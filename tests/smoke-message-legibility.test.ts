import { describe, it, expect } from 'vitest';
import {
  DISCARDED_INTERACTIONS_WARNING,
  FALSE_FIELD_LIMIT,
  falseBooleanFields,
  renderSmokeFailure,
  renderStylingAggregateOverride,
  validateHtmlTool,
} from '../src/tools/builtin.js';
import {
  smokeOkIncludesStyling,
  smokeResultIncludesStyling,
  stylingFieldPaths,
} from '../src/contracts/probeManifest.js';
import { SMOKE_DESIGN_GUIDANCE } from '../src/atoms/prompts.js';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach } from 'vitest';

/**
 * MEASURED 2026-08-23, project run `a786358a`: 25 `validate_html` calls, 14
 * failures, and the six-agent review of that trace
 * (`docs/decided-not-built-2026-08-23.md`) found that the expensive modes were
 * not refusals but MESSAGES — a gate reporting a finding the code never made,
 * a discard reported only as a fact with no consequence, and the one piece of
 * new information placed at the tail of the longest string in the error.
 *
 * Every test here pins a MESSAGE. Not one of them asserts a new refusal:
 * for any (smoke, interactions, page) triple the set of refused calls and the
 * value of `ok` are byte-identical to HEAD before this commit.
 */

const sandboxes: ToolSandbox[] = [];
const dirs: string[] = [];

function workspace(): ToolSandbox {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-smokemsg-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'index.html'), '<!doctype html><h1>x</h1>', 'utf8');
  const sandbox = new ToolSandbox(dir);
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(async () => {
  for (const s of sandboxes.splice(0)) await s.cleanup().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Call #2's payload, reduced to what the two predicates actually read. */
const CALL_2_SMOKE =
  '(async () => { const w = window.__test; const initialColors = w.getComputedColors();' +
  ' w.toggleTheme(); await new Promise((r) => requestAnimationFrame(r));' +
  ' const colorsAfter = w.getComputedColors();' +
  ' const allChecks = { themeChanged: true, colorsDifferent: colorsAfter.bgColor !== initialColors.bgColor };' +
  ' const ok = Object.values(allChecks).every(Boolean);' +
  ' return { ok, checks: allChecks, colorChange: { before: initialColors, after: colorsAfter } } })()';

const CALL_2_RESULT = {
  ok: true,
  checks: { themeChanged: true, colorsDifferent: true },
  colorChange: {
    before: { bgColor: 'rgb(255, 255, 255)', textColor: 'rgb(0, 0, 0)' },
    after: { bgColor: 'rgb(30, 30, 30)', textColor: 'rgb(255, 255, 255)' },
  },
};

describe('stylingFieldPaths — one walk, two consumers', () => {
  it('derives the gate boolean, so message and gate cannot disagree', () => {
    expect(smokeResultIncludesStyling(CALL_2_RESULT)).toBe(true);
    expect(stylingFieldPaths(CALL_2_RESULT).length).toBeGreaterThan(0);
    // Same semantics as the boolean-only walk it replaces: a key match
    // short-circuits before recursion, and arrays are visited elementwise.
    expect(stylingFieldPaths({ a: { colour: { nested: 1 } } })).toEqual(['a.colour']);
    expect(stylingFieldPaths({ rows: [{ className: 'x' }] })).toEqual(['rows[0].className']);
    expect(smokeResultIncludesStyling({ count: 1 })).toBe(false);
    expect(stylingFieldPaths({ count: 1 })).toEqual([]);
    expect(smokeResultIncludesStyling(null)).toBe(false);
    expect(smokeResultIncludesStyling(7)).toBe(false);
  });

  it('is bounded', () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 20; i++) wide[`color${i}`] = 'x';
    expect(stylingFieldPaths(wide).length).toBe(8);
  });
});

describe('renderStylingAggregateOverride — the gate states the finding it actually made', () => {
  it('names the evidence, the unreadable aggregate, and both accepted spellings', () => {
    // The predicate's verdict on the measured payload, unchanged by this commit.
    expect(smokeOkIncludesStyling(CALL_2_SMOKE)).toBe(false);
    const msg = renderStylingAggregateOverride(CALL_2_SMOKE, CALL_2_RESULT);

    // `colorChange` matches the key regex itself, so the walk stops there and
    // never descends to `.before` — the short-circuit the predicate has always
    // had, now visible in the message.
    expect(msg).toContain('checks.colorsDifferent, colorChange');
    expect(msg).toMatch(/NOTHING/);
    expect(msg).toMatch(/const ok = \.\.\./);
    expect(msg).toContain('Object.values(checks).every(Boolean)');
    // It must NOT repeat the old claim, which the trace shows the model acting
    // on rationally and uselessly: it strengthened an assertion it was already
    // making, which cannot move a name-based predicate.
    expect(msg).not.toMatch(/does not assert them$/);
    expect(msg).toMatch(/not a claim that your comparison is wrong/);
  });

  it('a pure rename satisfies the predicate — which is why the message says so', () => {
    const renamed = CALL_2_SMOKE.replace(/allChecks/g, 'checks');
    expect(smokeOkIncludesStyling(renamed)).toBe(true);
    expect(smokeOkIncludesStyling(CALL_2_SMOKE)).toBe(false);
  });

  it('quotes the clause when there is one to quote', () => {
    const inline = "(() => ({ ok: getComputedStyle(b).color !== initial.color }))()";
    expect(renderStylingAggregateOverride(inline, CALL_2_RESULT)).not.toMatch(/NOTHING/);
  });
});

describe('renderSmokeFailure — the names lead', () => {
  it('puts the false fields BEFORE the truncated paste', () => {
    const rendered = renderSmokeFailure({
      ok: false,
      checks: { beforeResetElapsedGreaterThanZero: false },
      beforeReset: { bgColor: 'x'.repeat(600) },
    });
    const namesAt = rendered.indexOf('FALSE field(s)');
    const pasteAt = rendered.indexOf('Full result');
    expect(namesAt).toBeGreaterThanOrEqual(0);
    expect(namesAt).toBeLessThan(pasteAt);
    expect(rendered).toContain('checks.beforeResetElapsedGreaterThanZero');
    expect(rendered).toMatch(/TRUNCATED at 500 chars and possibly cut mid-token/);
  });

  it('says something honest when no false boolean is present', () => {
    expect(renderSmokeFailure({ ok: false, count: 0 })).toMatch(
      /No false boolean field is present/
    );
  });

  it('names the limit when it truncates the field list', () => {
    const wide: Record<string, boolean> = {};
    for (let i = 0; i < 40; i++) wide[`f${i}`] = false;
    expect(falseBooleanFields(wide).length).toBe(FALSE_FIELD_LIMIT);
    expect(renderSmokeFailure(wide)).toContain(`(first ${FALSE_FIELD_LIMIT} shown)`);
  });
});

describe('the discard warning states its consequence', () => {
  it('says the interactions never ran and what the before-snapshot really is', () => {
    const w = DISCARDED_INTERACTIONS_WARNING(4);
    expect(w).toMatch(/^4 of your interaction\(s\) were DISCARDED and never ran/);
    expect(w).toMatch(/INITIAL state/);
    expect(w).toMatch(/interactions: \[\]/);
  });

  it('reaches a REFUSED call too, together with the rest of the attestation', async () => {
    const sandbox = workspace();
    const res = (await validateHtmlTool({ sandbox }).execute({
      url: 'http://127.0.0.1:1/index.html',
      // A self-driving smoke: the interactions are emptied before the page
      // opens. It also fails pre-flight on the rgb() literal.
      smoke: `(() => { window.__test.reset(); return getComputedStyle(b).color === 'rgb(1, 2, 3)' })()`,
      interactions: [{ type: 'click', selector: '#a' }, { type: 'click', selector: '#b' }],
    })) as {
      ok: boolean;
      errors: string[];
      warnings: string[];
      requestedInteractions: number;
      ignoredInteractions: number;
      document?: { path: string; sha256: string };
    };

    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/smoke rejected pre-flight/);
    // Pre-fix: warnings [], no requested/ignored split, no digest — a refusal
    // was indistinguishable from a call that sent no interactions at all.
    expect(res.warnings[0]).toMatch(/DISCARDED and never ran/);
    expect(res.requestedInteractions).toBe(2);
    expect(res.ignoredInteractions).toBe(2);
    expect(res.document?.path).toBe('index.html');
    expect(res.document?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the descriptions no longer contradict the runtime', () => {
  const declaration = validateHtmlTool({ sandbox: new ToolSandbox(tmpdir()) }).declaration;
  const props = (
    declaration.inputSchema as {
      properties: Record<string, { description?: string }>;
    }
  ).properties;

  it('stops teaching that every boolean field is an assertion', () => {
    // isSmokeOk reads `ok` ALONE, and its own comment records 22 false smoke
    // failures caused by exactly the belief the old sentence taught.
    expect(props['smoke']!.description).not.toMatch(/every boolean field is an assertion/);
    expect(props['smoke']!.description).toMatch(/the explicit `ok` is the ONLY verdict/);
    expect(props['smoke']!.description).toMatch(/may legitimately be false/);
  });

  it('states the async capability the runtime always had', () => {
    expect(props['smoke']!.description).toMatch(/MAY be async/);
  });

  it('widens the erased-state trigger to what the detector actually matches', () => {
    expect(props['smoke']!.description).toMatch(/toggle then toggle back/);
  });

  it('states the ordering and the mutual exclusivity where the caller fills it in', () => {
    expect(props['interactions']!.description).toMatch(/COMPLETELY BEFORE `smoke`/);
    expect(props['interactions']!.description).toMatch(/MUTUALLY EXCLUSIVE/);
    expect(props['interactions']!.description).toMatch(/DISCARDED/);
  });

  it('pays for it: the tool description stops restating its own parameters', () => {
    expect(declaration.description).not.toMatch(/absolute page coordinates/);
    expect(declaration.description).not.toMatch(/interactions \+ smoke/);
    expect(declaration.description.length).toBeLessThan(400);
  });
});

describe('SMOKE_DESIGN_GUIDANCE reaches the tier that writes the smoke', () => {
  it('carries the mutual exclusivity, which lived only in the planning prompts', () => {
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/MUTUALLY EXCLUSIVE/);
  });

  it('teaches the DOM-click variant for a control with no exposed method', () => {
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/document\.getElementById\(idFromSource\)\.click\(\)/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/interaction array must be empty/);
  });
});

describe('interaction errors carry the remedy — measured on run 949ecd5d', () => {
  it('the url description names both server tools and forbids guessed ports', () => {
    const props = (
      validateHtmlTool({ sandbox: new ToolSandbox(tmpdir()) }).declaration.inputSchema as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;
    expect(props['url']!.description).toMatch(/start_static_server or start_node_server/);
    expect(props['url']!.description).toMatch(/Never a guessed port/);
  });

  it('an Unknown key failure explains chords, through the real handler', async () => {
    const sandbox = workspace();
    const { startStaticServerTool } = await import('../src/tools/builtin.js');
    const served = (await startStaticServerTool({ sandbox }).execute({})) as {
      ok: boolean;
      url: string;
    };
    expect(served.ok).toBe(true);
    const res = (await validateHtmlTool({ sandbox }).execute({
      url: `${served.url}index.html`,
      interactions: [{ type: 'keypress', key: 'Control+A' }],
    })) as { ok: boolean; errors: string[] };
    expect(res.ok).toBe(false);
    const err = res.errors.find((e) => /Unknown key/i.test(e));
    expect(err).toMatch(/chords like "Control\+A" are not supported/);
    expect(err).toMatch(/keydown "Control"/);
  }, 60_000);
});
