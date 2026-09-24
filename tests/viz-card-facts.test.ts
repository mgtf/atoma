import { describe, expect, it } from 'vitest';
import {
  buildLlmStartDetail,
  compactModelName,
  fmtTokenCount,
  gpuEventCardCopy,
  llmUsageLabel,
  modelPairLabel,
  stopReasonLabel,
} from '../src/viz/client-gl/renderer/copy.js';
import { buildSkillEventDetail } from '../src/viz/client/structured-detail.js';
import { translate } from '../src/viz/client/i18n-catalog.js';
import type { VizEvent, VizRun } from '../src/viz/client/types.js';

const t = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);

describe('compactModelName', () => {
  it('drops the release date a card has no room for', () => {
    expect(compactModelName('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
  });

  it('leaves an alias or a dateless id alone', () => {
    expect(compactModelName('haiku')).toBe('haiku');
    expect(compactModelName('claude-opus-5')).toBe('claude-opus-5');
    expect(compactModelName(undefined)).toBe('');
  });
});

describe('modelPairLabel', () => {
  it('shows one name when the transport served what was pinned', () => {
    expect(modelPairLabel('claude-opus-5', 'claude-opus-5')).toBe('claude-opus-5');
  });

  it('shows BOTH when the transport rewrote the pin', () => {
    // The case that made this necessary: cost is priced from the served model,
    // so a card showing only the pin misreports what was billed.
    expect(modelPairLabel('claude-haiku-4-5-20251001', 'haiku'))
      .toBe('claude-haiku-4-5 ⇢ haiku');
  });

  it('degrades to whichever it has', () => {
    expect(modelPairLabel(undefined, 'haiku')).toBe('haiku');
    expect(modelPairLabel('claude-opus-5', undefined)).toBe('claude-opus-5');
    expect(modelPairLabel(undefined, undefined)).toBe('');
  });
});

describe('fmtTokenCount', () => {
  it('keeps small counts exact and abbreviates the rest', () => {
    expect(fmtTokenCount(106)).toBe('106');
    expect(fmtTokenCount(5842)).toBe('5.8k');
    expect(fmtTokenCount(827_777)).toBe('828k');
  });

  it('returns nothing rather than a misleading zero for a missing count', () => {
    expect(fmtTokenCount(undefined)).toBe('');
    expect(fmtTokenCount(Number.NaN)).toBe('');
    expect(fmtTokenCount(-5)).toBe('');
  });
});

describe('llmUsageLabel', () => {
  it('surfaces the cache read, which dwarfs the fresh input', () => {
    const label = llmUsageLabel(
      { inputTokens: 106, outputTokens: 5842, cacheReadInputTokens: 827_777 },
      t
    );
    expect(label).toBe('in 106 out 5.8k cache 828k');
  });

  it('omits parts that are absent instead of printing zeros', () => {
    expect(llmUsageLabel({ inputTokens: 40 }, t)).toBe('in 40');
    expect(llmUsageLabel(undefined, t)).toBe('');
    expect(llmUsageLabel({}, t)).toBe('');
  });
});

describe('stopReasonLabel', () => {
  it('says nothing when the model simply finished', () => {
    expect(stopReasonLabel('end_turn', t)).toBe('');
    expect(stopReasonLabel(undefined, t)).toBe('');
  });

  it('flags a truncated answer, which is otherwise invisible on the card', () => {
    expect(stopReasonLabel('max_tokens', t)).toContain('max_tokens');
    expect(stopReasonLabel('max_tokens', t)).toContain('⚠');
  });
});

describe('gpuEventCardCopy for an LLM call', () => {
  const event = (over: Partial<VizEvent> = {}): VizEvent => ({
    id: 'e1',
    ts: Date.parse('2026-08-16T10:00:00.000Z'),
    kind: 'llm',
    role: 'execute',
    model: 'claude-haiku-4-5-20251001',
    servedModel: 'haiku',
    durationMs: 89_718,
    costUsd: 0.1306662,
    stopReason: 'end_turn',
    usage: { inputTokens: 106, outputTokens: 5842, cacheReadInputTokens: 827_777 },
    ...over,
  });

  it('carries the served model, the token split and the cache read', () => {
    const { footer } = gpuEventCardCopy(event(), t);
    expect(footer).toContain('⇢ haiku');
    expect(footer).toContain('cache 828k');
    expect(footer).toContain('out 5.8k');
  });

  it('keeps the duration and cost it always had', () => {
    const { footer } = gpuEventCardCopy(event(), t);
    expect(footer).toContain('$');
    expect(footer).toMatch(/\d/);
  });

  it('stays quiet about a normal stop and loud about a truncated one', () => {
    expect(gpuEventCardCopy(event(), t).footer).not.toContain('⚠');
    expect(gpuEventCardCopy(event({ stopReason: 'max_tokens' }), t).footer).toContain('⚠');
  });

  it('names the inject sources on the card body', () => {
    const { body } = gpuEventCardCopy(
      event({
        context: [
          { id: 'c1', source: 'skill', chars: 20, preview: 'STEP 1', skillId: 'web-build' },
          { id: 'c2', source: 'coaching', chars: 12, preview: 'fix the harness' },
        ],
      }),
      t
    );
    expect(body).toBe('Skill · Coaching');
  });

  it('lets an ERROR outrank the inject labels on the card body', () => {
    // A skill-injected execute that timed out used to show "Skill · Coaching"
    // instead of its error — the llm branch lacked the tool branch's guard.
    const { body } = gpuEventCardCopy(
      event({
        error: 'aborted: deadline exceeded',
        context: [
          { id: 'c1', source: 'skill', chars: 20, preview: 'STEP 1', skillId: 'web-build' },
        ],
      }),
      t
    );
    expect(body).toBe('aborted: deadline exceeded');
  });

  it('renders a context inject as its own card', () => {
    const { title, body, footer } = gpuEventCardCopy(
      {
        id: 'c1',
        ts: Date.parse('2026-08-16T10:00:00.000Z'),
        kind: 'context',
        source: 'skill',
        skillId: 'web-build',
        chars: 42,
        preview: 'STEP 1: write_file',
      },
      t
    );
    expect(title).toContain('context');
    // The body is the INJECT and nothing else: the source and the skill id
    // are the footer's own first members, and on the one-line card that
    // duplication spent the body budget restating them.
    expect(body).toBe('STEP 1: write_file');
    expect(footer).toContain('Skill');
    expect(footer).toContain('web-build');
    expect(footer).toContain('42c');
  });

  it('does not invent facts for a call that reported none', () => {
    const bare = gpuEventCardCopy(
      { id: 'e', ts: 0, kind: 'llm', role: 'plan' },
      t
    );
    expect(bare.footer).not.toContain('undefined');
    expect(bare.footer).not.toContain('NaN');
  });
});

describe('gpuEventCardCopy for registry counters', () => {
  it('shows the credited type version when the event carries it', () => {
    const { footer } = gpuEventCardCopy({
      id: 'registry-success',
      ts: Date.parse('2026-08-16T10:00:00.000Z'),
      kind: 'registry',
      op: 'recordSuccess',
      name: 'Water',
      version: 2,
    }, t);
    expect(footer).toContain('v2');
    expect(footer).not.toContain('v?');
  });

  it('omits a version that an irrecoverable legacy event never recorded', () => {
    const { footer } = gpuEventCardCopy({
      id: 'legacy-registry-success',
      ts: Date.parse('2026-08-16T10:00:00.000Z'),
      kind: 'registry',
      op: 'recordSuccess',
      name: 'Water',
    }, t);
    expect(footer).not.toContain('v?');
    expect(footer).not.toMatch(/(^| · )v\d/);
  });
});


describe('skill card locale', () => {
  it('does not attribute missing proof to a recipe violation', () => {
    const reasoning = 'success NOT credited — a declared proof obligation has no transport-observed attestation';
    const event: VizEvent = { id: 'missing-proof', ts: 0, kind: 'skill', op: 'credit-withheld', reasoning };
    const copy = gpuEventCardCopy(event, t);
    expect(copy.title).toBe('Counters not changed');
    expect(copy.body).toBe(reasoning);
    expect(JSON.stringify(buildSkillEventDetail(event, null, t))).toContain(reasoning);
    expect(event.reasoning).toBe(reasoning);
  });

  it('localizes legacy credit messages in the card and detail without changing evidence', () => {
    const reasoning = "succès NON crédité — le validateur a observé que le run n'a pas suivi la recette";
    const event: VizEvent = { id: 'legacy', ts: 0, kind: 'skill', op: 'credit-withheld', reasoning };
    const copy = gpuEventCardCopy(event, t);
    expect(copy.title).toBe(t('skillOp.creditWithheld'));
    expect(copy.body).toBe(t('skillReason.successNotFollowed'));
    expect(JSON.stringify(buildSkillEventDetail(event, null, t))).toContain(copy.body);
    expect(event.reasoning).toBe(reasoning);
    const alternate = (key: string) => `translated:${key}`;
    expect(gpuEventCardCopy(event, alternate).body).toBe('translated:skillReason.successNotFollowed');
    const failure = { ...event, reasoning: "échec NON imputé — le validateur a observé que le run n'a pas suivi la recette" };
    expect(gpuEventCardCopy(failure, t).body).toBe(t('skillReason.failureNotFollowed'));
    const custom = { ...event, reasoning: 'Une observation libre du modèle' };
    expect(gpuEventCardCopy(custom, t).body).toBe(custom.reasoning);
  });
});

describe('buildLlmStartDetail', () => {
  const NOW = Date.parse('2026-09-24T10:00:30.000Z');
  const started = NOW - 12_000;
  const start: VizEvent = {
    id: 'start-1',
    ts: started,
    kind: 'llm-start',
    llmEventId: 'call-1',
    role: 'execute',
    model: 'own:openai:gpt-5.6-luna',
    actor: { tier: 1, name: 'CarbonDioxide' },
    branchId: 'branch-1',
  };
  const branch: VizEvent = {
    id: 'branch-1-start',
    ts: started - 10,
    kind: 'branch',
    op: 'start',
    branchId: 'branch-1',
    label: 'Write flags.mjs: a Node HTTP JSON feature-flag service using only built-in modules.',
  };
  const tool = (id: string, name: string, args: Record<string, unknown>, error?: string): VizEvent => ({
    id,
    ts: started + 1_000,
    kind: 'tool',
    llmEventId: 'call-1',
    name,
    args,
    durationMs: 40,
    ...(error ? { error } : {}),
  });
  const run = (events: VizEvent[], overrides: Partial<VizRun> = {}): VizRun => ({
    id: 'run-1',
    label: 'build-app: flags',
    task: { description: 'Build a feature-flag service' },
    startedAt: new Date(started - 60_000).toISOString(),
    endedAt: undefined,
    durationMs: undefined,
    events,
    totals: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    ...overrides,
  });
  const fields = (nodes: ReturnType<typeof buildLlmStartDetail>['nodes']) => {
    const out = new Map<string, string>();
    const walk = (list: typeof nodes) => {
      for (const node of list) {
        if (node.kind === 'field') out.set(node.key, node.value);
        else walk(node.children);
      }
    };
    walk(nodes);
    return out;
  };

  it('says what the step is doing, what it was asked, and what it has done so far', () => {
    const detail = buildLlmStartDetail(
      start,
      run([branch, start, tool('t1', 'write_file', { path: 'flags.mjs' }), tool('t2', 'run_shell', { cmd: 'node flags.mjs --check' })]),
      t,
      NOW
    );
    expect(detail.description).toBe(t('now.doing.execute', { actor: 'CarbonDioxide', child: '?' }));
    const value = fields(detail.nodes);
    expect(value.get('status')).toBe('In flight — no response yet');
    expect(value.get('elapsed')).toBe('12.00s');
    expect(value.get('instruction')).toContain('Write flags.mjs');
    // Newest first, so the reader sees the latest element without scrolling.
    expect(value.get('lastElements')).toBe('B · run_shell · node flags.mjs --check\nH · write_file · flags.mjs');
    expect(value.has('elementErrors')).toBe(false);
    const elements = detail.nodes.find((node) => node.kind === 'section' && node.key === 'elements');
    expect(elements).toMatchObject({ count: 2 });
    // The identifiers are the joins, so they stay — last.
    expect(detail.nodes.at(-1)).toMatchObject({ kind: 'section', key: 'identifiers' });
    expect(value.get('llmEventId')).toBe('call-1');
    expect(value.get('branchId')).toBe('branch-1');
  });

  it('states the absence when nothing has streamed out yet', () => {
    const value = fields(buildLlmStartDetail(start, run([start]), t, NOW).nodes);
    expect(value.get('noElements')).toBe(t('now.activity.none'));
    expect(value.has('instruction')).toBe(false);
  });

  it('counts failed element calls and marks them', () => {
    const value = fields(
      buildLlmStartDetail(start, run([start, tool('t1', 'run_shell', { cmd: 'npm test' }, 'exit 1')]), t, NOW).nodes
    );
    expect(value.get('elementErrors')).toBe('1');
    expect(value.get('lastElements')).toContain('✕');
  });

  it('reads as interrupted once the run has ended without the paired call', () => {
    const ended = run([start], { endedAt: new Date(NOW).toISOString(), durationMs: 90_000 });
    const detail = buildLlmStartDetail(start, ended, t, NOW);
    expect(detail.description).toBe(t('detail.llmStart.interruptedExplain'));
    const value = fields(detail.nodes);
    expect(value.get('status')).toBe(t('event.interrupted'));
    expect(value.has('elapsed')).toBe(false);
  });

  it('points at the paired call once it has returned', () => {
    const completion: VizEvent = {
      id: 'call-1',
      ts: started + 8_000,
      kind: 'llm',
      role: 'execute',
      model: 'own:openai:gpt-5.6-luna',
      durationMs: 8_000,
      response: 'done',
    };
    const detail = buildLlmStartDetail(start, run([start, completion]), t, NOW);
    expect(detail.description).toBe(t('detail.llmStart.completedExplain'));
    const value = fields(detail.nodes);
    expect(value.get('status')).toBe(t('detail.llmStart.status.completed'));
    expect(value.get('elapsed')).toBe('8.00s');
  });
});
