import { describe, it, expect } from 'vitest';
import type { ToolInvocationInfo } from '../src/core/types.js';
import {
  ValidationLedger,
  internalValidationFailureDetail,
} from '../src/atoms/validationLedger.js';
import {
  SMOKE_PREFLIGHT_REFUSAL_PREFIX,
  isPreflightRefusal,
} from '../src/contracts/attestation.js';

/**
 * The L1 validation ledger, exercised with the RESULT SHAPES the seeded
 * counter run produced on 2026-09-14 (trace `6f81b406`, preserved under
 * docs/incidents/recovery-live-2026-09-14/). The document digest is the one
 * the tool bound to index.html; it never moved after the edit phase, and the
 * run still replayed its verification twice because the LAST call was a
 * pre-flight refusal. Every disposition that failed a result before still
 * fails it here; the one that fired on a refusal over standing evidence
 * does not.
 */

const DOC_SHA = '9fd27f6482ce10f3cc3fc91c53e20ea75625c3fc18253bf5dd8f950f13a2ad7b';
const ERASED_STATE =
  'interactions repeat a state-changing control and then reset BEFORE smoke runs, so the intermediate state has been erased. Drive the exposed API inside one smoke IIFE, capture a milestone/beforeReset snapshot, reset, capture the final snapshot, and include both in ok.';

const call = (
  name: string,
  args: Record<string, unknown>,
  result: unknown
): ToolInvocationInfo => ({ name, args, result, durationMs: 5, startedAt: 0 });

/** #62 in the trace: self-driving smoke, page opened, document bound, ok. */
const executedOk = () =>
  call('validate_html', { url: 'http://localhost:41849/index.html', interactions: [] }, {
    ok: true,
    url: 'http://localhost:41849/index.html',
    title: 'Counter',
    errors: [],
    warnings: [],
    failedRequests: [],
    interactionLog: [],
    requestedInteractions: 0,
    ignoredInteractions: 0,
    document: { path: 'index.html', sha256: DOC_SHA },
    smokeResult: { ok: true, checks: { afterReset: true }, final: { value: '1', count: 1 } },
  });

/** #63: three real clicks, executed and logged, ok. */
const executedClicksOk = () =>
  call(
    'validate_html',
    {
      url: 'http://localhost:41849/index.html',
      interactions: [{ type: 'click', selector: '#increment' }],
    },
    {
      ok: true,
      errors: [],
      warnings: [],
      failedRequests: [],
      interactionLog: ['click at (340.1, 380.4) on #increment'],
      requestedInteractions: 3,
      ignoredInteractions: 0,
      document: { path: 'index.html', sha256: DOC_SHA },
      smokeResult: { ok: true, value: '3' },
    }
  );

/** #64 / #74: the erased-intermediate-state refusal — no browser, no document. */
const refused = () =>
  call(
    'validate_html',
    {
      url: 'http://localhost:41849/index.html',
      interactions: [
        { type: 'click', selector: '#increment' },
        { type: 'click', selector: '#reset' },
      ],
    },
    {
      ok: false,
      url: 'http://localhost:41849/index.html',
      errors: [`${SMOKE_PREFLIGHT_REFUSAL_PREFIX}${ERASED_STATE}`],
      warnings: [],
      failedRequests: [],
      interactionLog: [],
      requestedInteractions: 4,
      ignoredInteractions: 0,
      smokeResult: { error: ERASED_STATE },
    }
  );

/** An EXECUTED failure: the page opened and a subresource 404ed. */
const executedFailed = () =>
  call('validate_html', { url: 'http://localhost:41849/index.html' }, {
    ok: false,
    errors: [],
    warnings: [],
    failedRequests: [{ url: 'http://localhost:41849/style.css', reason: 'net::ERR_ABORTED' }],
    interactionLog: [],
    requestedInteractions: 0,
    ignoredInteractions: 0,
    document: { path: 'index.html', sha256: DOC_SHA },
  });

const edit = (path: string, ok = true) =>
  call(
    'edit_file',
    { path, old_string: 'a', new_string: 'b' },
    ok ? { ok: true, path, replacements: 1, bytes: 2825 } : { ok: false, error: 'old_string not found' }
  );

function ledgerOf(...events: ToolInvocationInfo[]): ValidationLedger {
  const ledger = new ValidationLedger();
  for (const event of events) ledger.observe(event);
  return ledger;
}

describe('isPreflightRefusal', () => {
  it('recognises the tool refusal shape and nothing else', () => {
    expect(isPreflightRefusal(refused().result)).toBe(true);
    expect(isPreflightRefusal(executedOk().result)).toBe(false);
    expect(isPreflightRefusal(executedFailed().result)).toBe(false);
    // A mixed error list is an executed observation that ALSO carries a
    // refusal-shaped string — not a refusal; the browser ran.
    expect(
      isPreflightRefusal({ ok: false, errors: [`${SMOKE_PREFLIGHT_REFUSAL_PREFIX}x`, 'pageerror: y'] })
    ).toBe(false);
    expect(isPreflightRefusal({ ok: false, errors: [] })).toBe(false);
    expect(isPreflightRefusal(null)).toBe(false);
  });
});

describe('ValidationLedger', () => {
  it('starts with no disposition and no banner', () => {
    const d = ledgerOf().disposition();
    expect(d).toEqual({ kind: 'none' });
    expect(internalValidationFailureDetail(d)).toBeNull();
  });

  it('the seeded counter sequence: an ok observation of the unchanged document STANDS through a later refusal', () => {
    // #61 refused, #62 ok, #63 ok with clicks, #64 refused — the real order.
    const d = ledgerOf(refused(), executedOk(), executedClicksOk(), refused()).disposition();
    expect(d).toMatchObject({
      kind: 'standing',
      document: { path: 'index.html', sha256: DOC_SHA },
      observations: 2,
      refusals: 2,
    });
    expect(internalValidationFailureDetail(d)).toBeNull();
  });

  it('a refusal alone establishes nothing: refused-only fails the result', () => {
    const d = ledgerOf(refused(), refused()).disposition();
    expect(d).toMatchObject({ kind: 'refused-only', refusals: 2 });
    // The refusal's one fact is the guard message — never "console error(s)":
    // no browser ran.
    expect(internalValidationFailureDetail(d)).toMatch(
      /validate_html never executed: 2 call\(s\) refused pre-flight, last: interactions repeat a state-changing control/
    );
    expect(internalValidationFailureDetail(d)).not.toMatch(/console error/);
  });

  it('an EXECUTED failure after an ok observation is a real failure, refusal or not in between', () => {
    const d = ledgerOf(executedOk(), refused(), executedFailed()).disposition();
    expect(d).toEqual({ kind: 'failed', summary: '1 failed request(s)' });
    expect(internalValidationFailureDetail(d)).toBe('last validate_html: 1 failed request(s)');
  });

  it('a refusal after an executed failure does not launder it', () => {
    const d = ledgerOf(executedFailed(), refused()).disposition();
    expect(d.kind).toBe('failed');
  });

  it('writing the observed document after its last ok observation retires the evidence (stale)', () => {
    const d = ledgerOf(executedOk(), edit('./index.html')).disposition();
    expect(d).toEqual({ kind: 'stale', path: 'index.html' });
    expect(internalValidationFailureDetail(d)).toBe(
      'index.html was modified after its last successful validate_html and not re-validated'
    );
  });

  it('a fresh ok observation after the write supersedes the staleness', () => {
    const d = ledgerOf(executedOk(), edit('index.html'), executedOk()).disposition();
    expect(d.kind).toBe('standing');
  });

  it('a write to ANOTHER path, or a failed write, does not retire the evidence', () => {
    expect(ledgerOf(executedOk(), edit('README.md')).disposition().kind).toBe('standing');
    expect(ledgerOf(executedOk(), edit('index.html', false)).disposition().kind).toBe('standing');
    expect(
      ledgerOf(
        executedOk(),
        call('write_file', { path: 'notes.txt', content: 'x' }, { ok: true, path: 'notes.txt', bytes: 1 })
      ).disposition().kind
    ).toBe('standing');
  });

  it('an ok observation without a document binding cannot be shown stale', () => {
    const unbound = call('validate_html', { url: 'http://localhost:41849/' }, {
      ok: true,
      errors: [],
      failedRequests: [],
      interactionLog: [],
      requestedInteractions: 0,
      ignoredInteractions: 0,
    });
    const d = ledgerOf(unbound, edit('index.html')).disposition();
    expect(d).toMatchObject({ kind: 'standing', document: null });
  });

  it('ignores tool events it does not own and results it cannot read', () => {
    const d = ledgerOf(
      call('read_file', { path: 'index.html' }, { path: 'index.html', content: '<html>' }),
      call('validate_html', { url: 'x' }, 'not an object'),
      { name: 'validate_html', args: { url: 'x' }, error: 'executor threw', durationMs: 1, startedAt: 0 }
    ).disposition();
    expect(d).toEqual({ kind: 'none' });
  });
});
