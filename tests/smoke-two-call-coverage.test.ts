import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DISCARDED_INTERACTIONS_WARNING,
  detectBrittleComputedStyleLiteral,
  detectResetErasedIntermediateEvidence,
  detectSmokeStatementError,
  parseInteractions,
  preflightSmokeRefusals,
  SMOKE_SELF_DRIVEN_EXAMPLE,
  smokeDrivesOwnState,
  validateHtmlTool,
} from '../src/tools/builtin.js';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { SMOKE_TWO_CALL_LINES, SMOKE_TWO_CALL_SHAPE } from '../src/contracts/probeManifest.js';
import {
  SMOKE_PREFLIGHT_REFUSAL_PREFIX,
  establishesDomInteraction,
} from '../src/contracts/attestation.js';
import { SMOKE_DESIGN_GUIDANCE } from '../src/atoms/prompts.js';
import { proofObligationLines } from '../src/atoms/L1Atom.js';
import { checkProofCoverage } from '../src/atoms/proofCoverage.js';
import { ValidationLedger } from '../src/atoms/validationLedger.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { makeCtx } from './helpers.js';
import type { RunContext, ToolExecutor } from '../src/core/types.js';

/**
 * MEASURED 2026-09-15, seeded counter (docs/incidents/verification-replay-2026-09-15.md,
 * events 24–25 and 52–54): the erased-intermediate-state refusal fired, the
 * model adopted the ONE accepted shape it was handed — a self-driving IIFE with
 * `interactions: []` — which passed, executed zero real interactions, left the
 * declared `dom-interaction` obligation uncovered (credit withheld, event 30),
 * and the L3 planned a second verification phase: 62.3 s, 7 of 16 LLM calls,
 * 0.0758 USD. The model then found on its own the shape that satisfies BOTH
 * the guards and the obligation: real clicks up to the milestone under a
 * read-only smoke, then the reset under a read-only smoke.
 *
 * The refusal and the shared guidance now TEACH that shape from one constant.
 * Not one assertion here adds or relaxes a refusal, a predicate or a coverage
 * rule: for every (smoke, interactions) pair the refused set is byte-identical
 * to the previous source. What changed is text — and this file proves the
 * text hands out only what the guards accept, and that what it hands out
 * actually covers, through the same seams production crosses: raw tool
 * result → `attestingExecutor` (via `forkBranch`) → `checkProofCoverage`.
 */

const MILESTONE = SMOKE_TWO_CALL_SHAPE.milestone;
const RESET = SMOKE_TWO_CALL_SHAPE.reset;
const URL = 'http://localhost:5050/index.html';
const HTML =
  '<!doctype html><button id="controlFromSource"></button>' +
  '<button id="resetFromSource"></button><output id="readout">0</output>';
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Both taught calls squeezed into one list — the shape the guard refuses. */
const COLLAPSED = [...MILESTONE.interactions, ...RESET.interactions];
/** What the model actually sent on 14 and 15 September (events 64 and 52). */
const TRACE_SHAPE = [
  { type: 'click', selector: '#increment' },
  { type: 'click', selector: '#increment' },
  { type: 'click', selector: '#increment' },
  { type: 'click', selector: '#reset' },
];
const FINAL_STATE_ONLY = 'document.querySelector("#readout").textContent === "0"';

/**
 * `validate_html` WITHOUT a browser. The REQUEST side is the production order
 * built from the tool's own exported predicates — parse, discard when the
 * smoke drives its own state, pre-flight refusal envelope — so this stub
 * cannot disagree with the tool about what is refused or discarded. Only the
 * PAGE is fabricated: one `interactionLog` entry per surviving interaction and
 * the served document bound by the digest of the file bytes, as
 * `bindObservedDocument` does. The smoke is never evaluated — the taught
 * smokes carry placeholders read from source, by design.
 */
class BrowserlessValidateHtml implements ToolExecutor {
  readonly files: Record<string, string> = { 'index.html': HTML };
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  has(name: string): boolean {
    return name === 'validate_html' || name === 'read_file';
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    if (name === 'read_file') {
      const path = String(args['path']);
      if (!(path in this.files)) throw new Error(`ENOENT: ${path}`);
      return { path, content: this.files[path] };
    }
    let interactions = parseInteractions(args['interactions']);
    const requestedInteractions = interactions.length;
    const smoke =
      typeof args['smoke'] === 'string' && args['smoke'].trim().length > 0
        ? args['smoke']
        : undefined;
    const ignoredInteractions =
      smoke !== undefined && smokeDrivesOwnState(smoke) ? interactions.length : 0;
    if (ignoredInteractions > 0) interactions = [];
    const warnings =
      ignoredInteractions > 0 ? [DISCARDED_INTERACTIONS_WARNING(ignoredInteractions)] : [];
    if (smoke !== undefined) {
      const refusals = preflightSmokeRefusals(smoke, interactions);
      if (refusals.length > 0) {
        return {
          ok: false,
          url: args['url'],
          errors: refusals.map((r) => `${SMOKE_PREFLIGHT_REFUSAL_PREFIX}${r.message}`),
          warnings,
          failedRequests: [],
          interactionLog: [],
          requestedInteractions,
          ignoredInteractions,
          smokeResult: { error: refusals.map((r) => r.message).join(' ALSO: ') },
        };
      }
    }
    return {
      ok: true,
      url: args['url'],
      title: 'fixture',
      errors: [],
      warnings,
      failedRequests: [],
      interactionLog: interactions.map((i) => `click at (0, 0) on ${i.selector ?? ''}`),
      requestedInteractions,
      ignoredInteractions,
      document: { path: 'index.html', sha256: sha(this.files['index.html']!) },
      smokeResult: { ok: true },
    };
  }
}

function phaseCtx(): { root: RunContext; phase: RunContext; stub: BrowserlessValidateHtml } {
  const stub = new BrowserlessValidateHtml();
  const root: RunContext = { ...makeCtx(), tools: stub };
  return { root, phase: forkBranch(root, 'phase-1'), stub };
}

async function validate(
  phase: RunContext,
  call: { interactions: readonly unknown[]; smoke: string }
): Promise<Record<string, unknown>> {
  return (await phase.tools!.execute('validate_html', {
    url: URL,
    interactions: [...call.interactions],
    smoke: call.smoke,
  })) as Record<string, unknown>;
}

describe('the two-call shape the refusal teaches', () => {
  it('passes every real pre-flight guard, half by half, and keeps its interactions', () => {
    for (const [name, call] of Object.entries(SMOKE_TWO_CALL_SHAPE)) {
      const interactions = parseInteractions([...call.interactions]);
      expect(interactions, name).toHaveLength(call.interactions.length);
      expect(detectSmokeStatementError(call.smoke), name).toBeNull();
      expect(detectBrittleComputedStyleLiteral(call.smoke), name).toBeNull();
      expect(detectResetErasedIntermediateEvidence(interactions, call.smoke), name).toBeNull();
      expect(preflightSmokeRefusals(call.smoke, interactions), name).toEqual([]);
      // A read-only smoke: nothing is discarded, so the clicks are executed.
      expect(smokeDrivesOwnState(call.smoke), name).toBe(false);
    }
  });

  it('is rendered by the refusal beside the self-driving shape, which still says it covers nothing', () => {
    const message = detectResetErasedIntermediateEvidence(
      parseInteractions(COLLAPSED),
      FINAL_STATE_ONLY
    );
    expect(message).not.toBeNull();
    // The ledger summarises a refusal by its first sentence: byte-identical.
    expect(message).toMatch(
      /^interactions repeat a state-changing control and then reset BEFORE smoke runs, so the intermediate state has been erased\./
    );
    expect(message).toContain(SMOKE_TWO_CALL_LINES.join(' '));
    expect(message).toContain(SMOKE_SELF_DRIVEN_EXAMPLE);
    expect(message).toMatch(/executes NO real interaction/);
    expect(message).toMatch(/does not cover a "dom-interaction" obligation/);
    // The covering shape comes FIRST: a small model copies the first concrete shape it reads.
    expect(message!.indexOf(SMOKE_TWO_CALL_LINES[0]!)).toBeLessThan(
      message!.indexOf(SMOKE_SELF_DRIVEN_EXAMPLE)
    );
  });

  it('relaxes nothing: the collapsed list and the traces’ own shape are still refused', () => {
    const [collapsed, ...others] = preflightSmokeRefusals(RESET.smoke, parseInteractions(COLLAPSED));
    expect(others).toEqual([]);
    expect(collapsed!.message).toMatch(/^interactions repeat a state-changing control and then reset BEFORE smoke runs/);
    expect(preflightSmokeRefusals(FINAL_STATE_ONLY, parseInteractions(TRACE_SHAPE))).toHaveLength(1);
    expect(
      detectResetErasedIntermediateEvidence(parseInteractions(TRACE_SHAPE), FINAL_STATE_ONLY)
    ).toMatch(/intermediate state has been erased/);
  });

  it('summarises identically in the L1 validation ledger: the live refusal, not a frozen copy', () => {
    // The ledger slices the first 80 characters after the prefix. The
    // ledger suite pins that summary against a 2026-09-14 trace fixture;
    // this feeds it the LIVE guard output so a reworded first sentence
    // cannot pass unnoticed.
    const live = preflightSmokeRefusals(FINAL_STATE_ONLY, parseInteractions(TRACE_SHAPE))[0]!;
    const ledger = new ValidationLedger();
    ledger.observe({
      name: 'validate_html',
      args: { url: URL, interactions: TRACE_SHAPE, smoke: FINAL_STATE_ONLY },
      result: {
        ok: false,
        url: URL,
        errors: [`${SMOKE_PREFLIGHT_REFUSAL_PREFIX}${live.message}`],
        warnings: [],
        failedRequests: [],
        interactionLog: [],
        requestedInteractions: TRACE_SHAPE.length,
        ignoredInteractions: 0,
        smokeResult: { error: live.message },
      },
      durationMs: 1,
      startedAt: 0,
    });
    expect(ledger.disposition()).toMatchObject({
      kind: 'refused-only',
      refusals: 1,
      lastRefusal: 'interactions repeat a state-changing control and then reset BEFORE smoke runs, s',
    });
  });

  it('reaches the tier that writes the smoke: guidance and the obligation lines render it', () => {
    for (const line of SMOKE_TWO_CALL_LINES) {
      expect(SMOKE_DESIGN_GUIDANCE).toContain(line);
    }
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/executes NO real interaction/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/"dom-interaction" proof obligation/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/in TWO calls/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/changes state ONCE, resets/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/The shape below is the SELF-DRIVING call/);
    // The FIRST call of a phase that declares the obligation hears it too,
    // before any refusal — the 14 September trace framed reset-in-interactions
    // as impossible for lack of exactly this sentence.
    const lines = proofObligationLines({
      description: 'x',
      proofObligations: ['dom-interaction'],
    }).join('\n');
    expect(lines).toMatch(/TWO validate_html calls/);
    expect(lines).toMatch(/one change plus the reset/);
    expect(proofObligationLines({ description: 'x' })).toEqual([]);
  });
});

describe('what the taught calls prove, through the production seam', () => {
  it('COVERS dom-interaction: two executed observations bound to the unchanged document', async () => {
    const { root, phase } = phaseCtx();
    const first = await validate(phase, MILESTONE);
    const second = await validate(phase, RESET);
    expect(first['ok']).toBe(true);
    expect(second['ok']).toBe(true);
    expect((first['interactionLog'] as string[]).length).toBe(3);
    expect((second['interactionLog'] as string[]).length).toBe(2);
    expect(first['ignoredInteractions']).toBe(0);

    const records = root.attestations!.forBranch('phase-1');
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.observation.kind === 'browser' && r.observation.executedInteractions.length > 0)).toBe(true);

    const coverage = await checkProofCoverage({ ctx: phase, obligations: ['dom-interaction'] });
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.covered).toBe(true);
    expect(coverage[0]!.eventIds).toEqual(records.map((r) => r.eventId));
    expect(coverage[0]!.reason).toMatch(/covered by 2 transport-observed interaction\(s\)/);
  });

  it('necessary but not sufficient: the same non-empty logs stop covering once the document moved', async () => {
    const { root, phase, stub } = phaseCtx();
    await validate(phase, MILESTONE);
    await validate(phase, RESET);
    stub.files['index.html'] = `${HTML}<!-- edited after the probes -->`;
    const records = root.attestations!.forBranch('phase-1');
    // The NECESSARY half still holds — both records carry executed clicks —
    // and the verdict rests on both of them, yet neither covers any more.
    expect(records).toHaveLength(2);
    expect(records.every(establishesDomInteraction)).toBe(true);
    const coverage = await checkProofCoverage({ ctx: phase, obligations: ['dom-interaction'] });
    expect(coverage[0]!.covered).toBe(false);
    expect(coverage[0]!.eventIds).toEqual(records.map((r) => r.eventId));
    expect(coverage[0]!.reason.match(/MUTATED after the observation/g)).toHaveLength(2);
  });

  it('the self-driving shape alone never covers — as taught, and as the traces sent it', async () => {
    // As taught: interactions: [] — nothing executed.
    const taught = phaseCtx();
    const asTaught = await validate(taught.phase, {
      interactions: [],
      smoke: SMOKE_SELF_DRIVEN_EXAMPLE,
    });
    expect(asTaught['ok']).toBe(true);
    const c1 = await checkProofCoverage({ ctx: taught.phase, obligations: ['dom-interaction'] });
    expect(c1[0]!.covered).toBe(false);
    expect(c1[0]!.reason).toMatch(/none with an executed interaction/);

    // As sent beside real clicks: the clicks are DISCARDED, not refused — the
    // documented hole — and nothing is executed either.
    const beside = phaseCtx();
    const besideClicks = await validate(beside.phase, {
      interactions: COLLAPSED,
      smoke: SMOKE_SELF_DRIVEN_EXAMPLE,
    });
    expect(besideClicks['ok']).toBe(true);
    expect((besideClicks['warnings'] as string[])[0]).toMatch(/DISCARDED and never ran/);
    expect(besideClicks['ignoredInteractions']).toBe(COLLAPSED.length);
    const c2 = await checkProofCoverage({ ctx: beside.phase, obligations: ['dom-interaction'] });
    expect(c2[0]!.covered).toBe(false);
    expect(c2[0]!.reason).toMatch(/filtered because the smoke drives its own state/);
  });
});

describe('the real tool hands the shape out', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('on a refused call, before any browser opens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-twocall-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), HTML, 'utf8');
    const res = (await validateHtmlTool({ sandbox: new ToolSandbox(dir) }).execute({
      // An unreachable port: a refusal returns before `getBrowser()`.
      url: 'http://127.0.0.1:1/index.html',
      interactions: COLLAPSED,
      smoke: FINAL_STATE_ONLY,
    })) as { ok: boolean; errors: string[]; smokeResult: { error: string }; document?: unknown };
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.startsWith(SMOKE_PREFLIGHT_REFUSAL_PREFIX)).toBe(true);
    expect(res.errors[0]).toContain(SMOKE_TWO_CALL_LINES[0]);
    expect(res.errors[0]).toContain(SMOKE_TWO_CALL_LINES[1]);
    expect(res.smokeResult.error).toContain('window.__app');
    expect(res.document).toBeUndefined();
  });
});
