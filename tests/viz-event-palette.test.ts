import { describe, expect, it } from 'vitest';
import {
  EVENT_KIND_COLOR,
  LLM_FAMILY_COLOR,
  LLM_ROLE_COLOR,
  LLM_ROLE_ORDER,
  eventKindColor,
  llmRoleColor,
} from '../src/viz/client-gl/renderer/event-palette.js';
import { eventAccent } from '../src/viz/client-gl/renderer/copy.js';
import { EVENT_KIND_FILTERS } from '../src/viz/client/run-utils.js';
import type { VizEvent } from '../src/viz/client/types.js';

/** Perceptual-ish luminance, enough to tell "readable on near-black" apart. */
function luminance(color: number): number {
  const r = (color >> 16 & 0xff) / 255;
  const g = (color >> 8 & 0xff) / 255;
  const b = (color & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hue(color: number): number {
  const r = (color >> 16 & 0xff) / 255;
  const g = (color >> 8 & 0xff) / 255;
  const b = (color & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? (g - b) / d % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('event kind palette', () => {
  it('covers every filter the runs view can offer', () => {
    // A kind with no colour falls back to blue and silently joins `all`.
    for (const kind of EVENT_KIND_FILTERS) {
      expect(EVENT_KIND_COLOR[kind], kind).toBeDefined();
    }
  });

  it('separates the categories by hue rather than merely by value', () => {
    const categories = EVENT_KIND_FILTERS.filter((kind) => kind !== 'all');
    const hues = categories.map((kind) => ({ kind, h: hue(eventKindColor(kind)) }));
    for (const a of hues) {
      for (const b of hues) {
        if (a.kind === b.kind) continue;
        const gap = Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h));
        expect(gap, `${a.kind} vs ${b.kind}`).toBeGreaterThan(12);
      }
    }
  });

  it('stays legible on the near-black panel', () => {
    for (const kind of EVENT_KIND_FILTERS) {
      expect(luminance(eventKindColor(kind)), kind).toBeGreaterThan(0.3);
    }
  });

  it('is neutral for an unknown kind rather than loud', () => {
    expect(eventKindColor('not-a-kind')).toBe(EVENT_KIND_COLOR['all']);
  });
});

describe('LLM role ramp', () => {
  it('gives every role its own step', () => {
    const seen = new Set(LLM_ROLE_ORDER.map((role) => llmRoleColor(role)));
    expect(seen.size).toBe(LLM_ROLE_ORDER.length);
  });

  it('is one warm family — every step reads as yellow through orange', () => {
    for (const role of LLM_ROLE_ORDER) {
      const h = hue(llmRoleColor(role));
      expect(h, role).toBeGreaterThanOrEqual(20);
      expect(h, role).toBeLessThanOrEqual(60);
    }
  });

  it('darkens along the lifecycle, so the ramp reads as an order', () => {
    const path = LLM_ROLE_ORDER.map((role) => luminance(llmRoleColor(role)));
    expect(path[0]).toBeGreaterThan(path[path.length - 1]!);
  });

  it('falls back to the family anchor for an unknown or absent role', () => {
    expect(llmRoleColor(undefined)).toBe(LLM_FAMILY_COLOR);
    expect(llmRoleColor('not-a-role')).toBe(LLM_FAMILY_COLOR);
  });

  it('has a colour for every role the palette declares', () => {
    for (const role of LLM_ROLE_ORDER) expect(LLM_ROLE_COLOR[role]).toBeDefined();
  });
});

describe('eventAccent', () => {
  const event = (over: Partial<VizEvent>): VizEvent =>
    ({ id: 'e', ts: 0, kind: 'llm', ...over });

  it('colours an LLM card by its ROLE, not by the actor tier', () => {
    const l1Execute = event({ kind: 'llm', role: 'execute', actor: { tier: 1, name: 'A' } });
    const l3Execute = event({ kind: 'llm', role: 'execute', actor: { tier: 3, name: 'M' } });
    expect(eventAccent(l1Execute)).toBe(llmRoleColor('execute'));
    expect(eventAccent(l1Execute)).toBe(eventAccent(l3Execute));
  });

  it('treats a started-but-unfinished call as the same family', () => {
    expect(eventAccent(event({ kind: 'llm-start', role: 'plan' }))).toBe(llmRoleColor('plan'));
  });

  it('matches the chip for every non-LLM kind', () => {
    for (const kind of ['tool', 'trust', 'cache', 'registry']) {
      expect(eventAccent(event({ kind }))).toBe(eventKindColor(kind));
    }
  });

  it('lets a quarantine outrank its family, because the outcome matters more', () => {
    const quarantined = eventAccent(event({ kind: 'skill', op: 'quarantine' }));
    expect(quarantined).not.toBe(eventKindColor('skill'));
  });
});
