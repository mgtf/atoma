import { describe, expect, it } from 'vitest';
import {
  compactModelName,
  fmtTokenCount,
  gpuEventCardCopy,
  llmUsageLabel,
  modelPairLabel,
  stopReasonLabel,
} from '../src/viz/client-gl/renderer/copy.js';
import { translate } from '../src/viz/client/i18n.js';
import type { VizEvent } from '../src/viz/client/types.js';

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
    expect(body).toContain('Skill');
    expect(body).toContain('web-build');
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
