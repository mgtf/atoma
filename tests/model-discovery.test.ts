import { describe, it, expect } from 'vitest';
import { modelSupportsSamplingParams, modelSupportsEffort } from '../src/core/models.js';
import { FALLBACK_OPUS, PIN_SONNET, PIN_HAIKU } from './tier-pins.js';
import { parseModelSelector } from '../src/contracts/modelSelector.js';

/** The vendor's model id inside a test selector — what the transports see. */
const bare = (selector: string): string => parseModelSelector(selector).model;

describe('modelSupportsSamplingParams', () => {
  it('rejects sampling params on Opus 4.7+', () => {
    expect(modelSupportsSamplingParams('claude-opus-4-7')).toBe(false);
    expect(modelSupportsSamplingParams('claude-opus-4-8')).toBe(false);
    expect(modelSupportsSamplingParams(bare(FALLBACK_OPUS))).toBe(false);
  });

  it('rejects sampling params on real GA suffix-less Opus 5+ aliases', () => {
    // GA aliases are suffix-less — the regexes must match them without a
    // trailing `-N` (regression: claude-opus-5 slipped through and every L3
    // plan 400ed on `temperature`).
    expect(modelSupportsSamplingParams('claude-opus-5')).toBe(false);
    expect(modelSupportsSamplingParams('claude-opus-5-0')).toBe(false);
    expect(modelSupportsSamplingParams('claude-opus-6')).toBe(false);
  });

  it('rejects sampling params on Sonnet 5+ and Fable/Mythos tiers', () => {
    expect(modelSupportsSamplingParams('claude-sonnet-5')).toBe(false);
    expect(modelSupportsSamplingParams('claude-fable-5')).toBe(false);
    expect(modelSupportsSamplingParams('claude-mythos-5')).toBe(false);
  });

  it('keeps sampling params on Haiku and older sonnet/opus', () => {
    // Haiku 4.5 is the only pin that still accepts sampling params.
    // PIN_SONNET / FALLBACK_OPUS are now 5-series (reject them).
    expect(modelSupportsSamplingParams(bare(PIN_HAIKU))).toBe(true);
    expect(modelSupportsSamplingParams('claude-opus-4-6')).toBe(true);
    expect(modelSupportsSamplingParams('claude-sonnet-4-5')).toBe(true);
  });

  it('current pins (Sonnet 5 / Opus 5) reject sampling params', () => {
    expect(modelSupportsSamplingParams(bare(PIN_SONNET))).toBe(false);
    expect(modelSupportsSamplingParams(bare(FALLBACK_OPUS))).toBe(false);
  });
});

describe('modelSupportsEffort', () => {
  it('true for Sonnet 4.6+/5, Opus 4.5+/5, Fable/Mythos', () => {
    expect(modelSupportsEffort('claude-sonnet-4-6')).toBe(true);
    expect(modelSupportsEffort('claude-sonnet-5')).toBe(true);
    expect(modelSupportsEffort('claude-opus-4-5')).toBe(true);
    expect(modelSupportsEffort('claude-opus-5')).toBe(true);
    expect(modelSupportsEffort('claude-fable-5')).toBe(true);
    // The current pins qualify.
    expect(modelSupportsEffort(bare(PIN_SONNET))).toBe(true);
    expect(modelSupportsEffort(bare(FALLBACK_OPUS))).toBe(true);
  });

  it('false for Haiku 4.5 and Sonnet <=4.5 (the param errors there)', () => {
    expect(modelSupportsEffort(bare(PIN_HAIKU))).toBe(false);
    expect(modelSupportsEffort('claude-sonnet-4-5')).toBe(false);
    expect(modelSupportsEffort('claude-sonnet-4-0')).toBe(false);
  });
});
