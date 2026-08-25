import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  TUNING_IDENTITY,
  TUNING_KEYS,
  TUNING_RANGE,
  clampTuningValue,
  isIdentityTuning,
  normalizeTuning,
  trackXFromTuningValue,
  tuningValueFromTrack,
  type VizTuning,
} from '../src/viz/client-gl/tuning.js';
import {
  CAST_SHADOW_IDENTITY_DEPTH,
  CAST_SHADOW_REACH_PX,
  castShadowOffset,
  surfaceDepthScale,
} from '../src/viz/client-gl/renderer/cast-shadow.js';
import { POINTER_LIGHT_RADIUS_PX } from '../src/viz/client-gl/pointer-light.js';
import {
  POINTER_LIGHT_GLSL,
  POINTER_LIGHT_WGSL,
} from '../src/viz/client-gl/renderer/shaders.js';
import {
  ATOMA_MARK_CRYSTAL_LIFT,
  ATOMA_MARK_CRYSTAL_LIFT_MAX,
  ATOMA_MARK_CRYSTAL_SIZE,
  ATOMA_MARK_CRYSTAL_SIZE_MAX,
  ATOMA_MARK_CRYSTAL_SIZE_MIN,
} from '../src/viz/client-gl/brand-mark.js';

describe('the tuning identity is the shipped look', () => {
  // This is the property the first version of this panel got wrong: it
  // declared buttonDepth 2 against an effective depth of 1, so merely wiring
  // the sliders up would have doubled every button's shadow offset and called
  // that "the default".
  it('matches the depth each surface class actually renders with', () => {
    expect(TUNING_IDENTITY.buttonDepth).toBe(CAST_SHADOW_IDENTITY_DEPTH.button);
    expect(TUNING_IDENTITY.controlFrameDepth).toBe(CAST_SHADOW_IDENTITY_DEPTH.frame);
    expect(TUNING_IDENTITY.columnDepth).toBe(CAST_SHADOW_IDENTITY_DEPTH.column);
    expect(TUNING_IDENTITY.crystalLift).toBe(ATOMA_MARK_CRYSTAL_LIFT);
    expect(TUNING_IDENTITY.crystalSize).toBe(ATOMA_MARK_CRYSTAL_SIZE);
  });

  it('scales every surface class by exactly 1 at the identity', () => {
    for (const surface of ['button', 'frame', 'column', 'card'] as const) {
      expect(surfaceDepthScale(surface, TUNING_IDENTITY), surface).toBe(1);
    }
  });

  it('leaves the cast offset untouched at identity light height', () => {
    const input = {
      left: 400, top: 300, width: 120, height: 40,
      lightX: 420, lightY: 260, strength: 1,
    };
    const before = castShadowOffset(input);
    const after = castShadowOffset({ ...input, lightHeight: TUNING_IDENTITY.lightHeight });
    expect(after).toEqual(before);
  });

  it('is inside every declared range, so no knob starts pinned to an end', () => {
    for (const key of TUNING_KEYS) {
      const range = TUNING_RANGE[key];
      expect(TUNING_IDENTITY[key], key).toBeGreaterThan(range.min);
      expect(TUNING_IDENTITY[key], key).toBeLessThan(range.max);
    }
  });

  it('leaves wide experimental headroom above the shipped crystal lift', () => {
    expect(TUNING_RANGE.crystalLift.max).toBe(ATOMA_MARK_CRYSTAL_LIFT_MAX);
    expect(TUNING_RANGE.crystalLift.step).toBeLessThanOrEqual(0.1);
    expect(TUNING_RANGE.crystalSize.min).toBe(ATOMA_MARK_CRYSTAL_SIZE_MIN);
    expect(TUNING_RANGE.crystalSize.max).toBe(ATOMA_MARK_CRYSTAL_SIZE_MAX);
  });

  it('recognises itself', () => {
    expect(isIdentityTuning({ ...TUNING_IDENTITY })).toBe(true);
    expect(isIdentityTuning({ ...TUNING_IDENTITY, lightHue: 40 })).toBe(false);
  });
});

describe('light height moves the pool and the shadows together', () => {
  // INSIDE the pool at every height under test. This matters and the first
  // version of this test got it wrong: for a surface far outside the pool,
  // LOWERING the light shortens its shadow rather than lengthening it, because
  // shrinking the pool drops the surface out of the light entirely and it
  // falls back to the ambient offset. Both behaviours are correct; only the
  // near one is what "a lower lamp rakes longer shadows" means.
  const base = {
    left: 340, top: 400, width: 100, height: 30,
    lightX: 300, lightY: 400, strength: 1,
  };

  it('shortens shadows as the light rises, and lengthens them as it drops', () => {
    const high = castShadowOffset({ ...base, lightHeight: 2 });
    const low = castShadowOffset({ ...base, lightHeight: 0.5 });
    const neutral = castShadowOffset({ ...base, lightHeight: 1 });
    expect(Math.hypot(high.x, high.y)).toBeLessThan(Math.hypot(neutral.x, neutral.y));
    expect(Math.hypot(low.x, low.y)).toBeGreaterThan(Math.hypot(neutral.x, neutral.y));
  });

  it('widens the pool so a surface out of reach at rest comes into it', () => {
    // 300px away: outside the 150px radius at height 1, inside it at height 3.
    const far = { ...base, left: 300 + POINTER_LIGHT_RADIUS_PX * 1.6 };
    const atRest = castShadowOffset({ ...far, lightHeight: 1 });
    const lifted = castShadowOffset({ ...far, lightHeight: 3 });
    // At rest the surface is unlit, so it keeps the ambient offset.
    const ambient = castShadowOffset({ ...far, strength: 0 });
    expect(atRest.x).toBeCloseTo(ambient.x, 1);
    expect(lifted.x).not.toBeCloseTo(ambient.x, 1);
  });

  it('never divides by a zero or negative height', () => {
    for (const lightHeight of [0, -1, Number.NaN]) {
      const offset = castShadowOffset({ ...base, lightHeight });
      expect(Number.isFinite(offset.x), String(lightHeight)).toBe(true);
      expect(Number.isFinite(offset.y), String(lightHeight)).toBe(true);
    }
  });

  it('keeps the reach constant used by the identity', () => {
    // Pins the direction of the height mapping against a silent inversion.
    const lifted = castShadowOffset({ ...base, lightHeight: 2, depth: 1 });
    expect(Math.hypot(lifted.x, lifted.y)).toBeLessThan(CAST_SHADOW_REACH_PX);
  });
});

describe('surfaceDepthScale lifts one stack without lifting the others', () => {
  it('scales only the class asked for', () => {
    const tuning: VizTuning = { ...TUNING_IDENTITY, buttonDepth: 2 };
    expect(surfaceDepthScale('button', tuning)).toBe(2);
    expect(surfaceDepthScale('frame', tuning)).toBe(1);
    expect(surfaceDepthScale('column', tuning)).toBe(1);
  });

  it('is a ratio, so the frame knob is neutral at its own 0.8', () => {
    expect(surfaceDepthScale('frame', { ...TUNING_IDENTITY, controlFrameDepth: 0.8 })).toBe(1);
    expect(surfaceDepthScale('frame', { ...TUNING_IDENTITY, controlFrameDepth: 1.6 })).toBe(2);
  });

  it('leaves cards alone whatever the panel says', () => {
    const extreme: VizTuning = {
      lightHeight: 3, lightIntensity: 2, lightHue: 180,
      crystalLift: 4, crystalSize: 2,
      buttonDepth: 4, controlFrameDepth: 4, columnDepth: 4,
    };
    expect(surfaceDepthScale('card', extreme)).toBe(1);
  });
});

describe('the drag maps a pointer to a value', () => {
  it('puts the ends of the track at the ends of the range', () => {
    expect(tuningValueFromTrack('lightHue', 100, 100, 200)).toBe(TUNING_RANGE.lightHue.min);
    expect(tuningValueFromTrack('lightHue', 300, 100, 200)).toBe(TUNING_RANGE.lightHue.max);
  });

  it('clamps rather than running off either end', () => {
    expect(tuningValueFromTrack('lightHue', -900, 100, 200)).toBe(TUNING_RANGE.lightHue.min);
    expect(tuningValueFromTrack('lightHue', 9000, 100, 200)).toBe(TUNING_RANGE.lightHue.max);
  });

  it('ROUND-TRIPS through the thumb position — the mapping the drag reverses', () => {
    // The defect this guards: the old slider compared a window clientX against
    // a Pixi local position.x. With a non-zero track origin those disagree, so
    // a track that does NOT start at 0 is the discriminating case.
    for (const trackX of [0, 137, 981.5]) {
      for (const key of TUNING_KEYS) {
        const value = clampTuningValue(key, TUNING_IDENTITY[key]);
        const x = trackXFromTuningValue(key, value, trackX, 220);
        expect(tuningValueFromTrack(key, x, trackX, 220), `${key}@${trackX}`).toBe(value);
      }
    }
  });

  it('is sensitive to the track origin, so an offset pane cannot be ignored', () => {
    const atOrigin = tuningValueFromTrack('lightHue', 150, 0, 200);
    const offset = tuningValueFromTrack('lightHue', 150, 100, 200);
    expect(atOrigin).not.toBe(offset);
  });

  it('degrades to the identity on a degenerate track instead of NaN', () => {
    expect(tuningValueFromTrack('lightHeight', 10, 0, 0)).toBe(TUNING_IDENTITY.lightHeight);
    expect(tuningValueFromTrack('lightHeight', Number.NaN, 0, 100))
      .toBe(TUNING_IDENTITY.lightHeight);
  });
});

describe('clampTuningValue', () => {
  it('snaps to the step without leaving float dust the panel would print', () => {
    const value = clampTuningValue('lightHeight', 1.234567);
    expect(String(value)).toMatch(/^\d+(\.\d{1,2})?$/);
  });

  it('holds the range', () => {
    for (const key of TUNING_KEYS) {
      const range = TUNING_RANGE[key];
      expect(clampTuningValue(key, -1e6), key).toBe(range.min);
      expect(clampTuningValue(key, 1e6), key).toBe(range.max);
    }
  });

  it('falls back to the identity for a non-number rather than to zero', () => {
    // Zero would be a silent restyle: several of these knobs read "off" at 0.
    expect(clampTuningValue('buttonDepth', Number.NaN)).toBe(TUNING_IDENTITY.buttonDepth);
  });
});

describe('normalizeTuning', () => {
  it('repairs a partial or hostile persisted value per key', () => {
    const repaired = normalizeTuning({
      lightHue: 9999,
      buttonDepth: Number.NaN,
    });
    expect(repaired.lightHue).toBe(TUNING_RANGE.lightHue.max);
    expect(repaired.buttonDepth).toBe(TUNING_IDENTITY.buttonDepth);
    expect(repaired.crystalLift).toBe(TUNING_IDENTITY.crystalLift);
    expect(repaired.columnDepth).toBe(TUNING_IDENTITY.columnDepth);
  });

  it('returns the identity for nothing at all', () => {
    expect(normalizeTuning(null)).toEqual(TUNING_IDENTITY);
    expect(normalizeTuning(undefined)).toEqual(TUNING_IDENTITY);
  });
});

describe('both shader backends carry the tuning uniforms', () => {
  // A GPU-lifetime defect is invisible to this suite, but a uniform that
  // exists in one backend and not the other is not: the WebGL fallback would
  // silently ignore the light knobs while WebGPU honoured them.
  it('declares uRadiusScale and uHueShift in GLSL and WGSL alike', () => {
    for (const source of [POINTER_LIGHT_GLSL, POINTER_LIGHT_WGSL]) {
      expect(source).toContain('uRadiusScale');
      expect(source).toContain('uHueShift');
      expect(source).toContain('rotateHue');
    }
  });

  it('no longer divides by a hardcoded radius in either backend', () => {
    for (const source of [POINTER_LIGHT_GLSL, POINTER_LIGHT_WGSL]) {
      expect(source).not.toMatch(/distancePx \/ 150\.0/);
      expect(source).not.toMatch(/distancePx \/ 34\.0/);
    }
  });

  it('lights filled UI from the pointer, never the crystal', () => {
    // Interior wash is what makes cards and buttons read as lit. It is also
    // a disc on any filled mesh, so the arrival gem must not sit under this
    // filter — the shell shader does that reflection.
    for (const source of [POINTER_LIGHT_GLSL, POINTER_LIGHT_WGSL]) {
      expect(source).toMatch(/halo \* \(0\.075 \+ edgeResponse \* \(0\.24 \+ facing \* 0\.36\)\)/);
    }
  });

  it('lands the crystal cast on the UI, gated by surface and strength', () => {
    // The cast used to stop at the backdrop: the far-field mesh drew it and
    // the UI in front of it was untouched, so the diamond vanished under
    // every button it crossed. This filter covers the whole stage, so the
    // same polygon reaches the surfaces themselves.
    for (const source of [POINTER_LIGHT_GLSL, POINTER_LIGHT_WGSL]) {
      expect(source).toContain('causticField');
      expect(source).toContain('uCaustic0');
      expect(source).toContain('uCaustic5');
      expect(source).toContain('uCausticColor');
      // Alpha-gated for the same reason the wash is: a transparent pixel has
      // no surface to light. Strength-gated so it fades with the pointer.
      expect(source).toMatch(/uStrength \* sampleColor\.a/);
    }
  });

  it('declares the cast slots in the ONE order the WGSL struct restates', () => {
    // Pixi derives the UBO layout from the declaration order in `resources`;
    // the WGSL struct writes that order out by hand. A field inserted on one
    // side only shifts every offset after it, silently.
    const struct = POINTER_LIGHT_WGSL.split('struct PointerLightUniforms')[1]
      ?.split('};')[0] ?? '';
    const order = [...struct.matchAll(/(u[A-Za-z0-9]+):/g)].map((match) => match[1]);
    expect(order).toEqual([
      'uLightPx',
      'uStrength',
      'uRadiusScale',
      'uHueShift',
      'uCaustic0',
      'uCaustic1',
      'uCaustic2',
      'uCaustic3',
      'uCaustic4',
      'uCaustic5',
      'uCausticColor',
    ]);
    const renderer = readFileSync(
      new URL('../src/viz/client-gl/gpu-renderer.ts', import.meta.url),
      'utf8'
    );
    const resources =
      renderer.split('pointerLight: {')[1]?.split('\n        },')[0] ?? '';
    const declared = [...resources.matchAll(/^\s{10}(u[A-Za-z0-9]+):/gm)].map(
      (match) => match[1]
    );
    expect(declared).toEqual(order);
  });
});

describe('the live sample', () => {
  // Imported lazily so each test gets the module's own state deterministically.
  beforeEach(async () => {
    const { resetTuning } = await import('../src/viz/client-gl/tuning-live.js');
    resetTuning();
  });

  it('reports whether a write actually moved the value', async () => {
    const { setTuningValue, readTuning } = await import('../src/viz/client-gl/tuning-live.js');
    expect(setTuningValue('lightHue', 40)).toBe(true);
    expect(readTuning().lightHue).toBe(40);
    expect(setTuningValue('lightHue', 40)).toBe(false);
  });

  it('bumps a revision so a per-frame reader can skip unchanged frames', async () => {
    const { setTuningValue, readTuning } = await import('../src/viz/client-gl/tuning-live.js');
    const before = readTuning().revision;
    setTuningValue('columnDepth', 2);
    expect(readTuning().revision).toBeGreaterThan(before);
  });

  it('clamps on the way in, so no reader has to defend itself', async () => {
    const { setTuningValue, readTuning } = await import('../src/viz/client-gl/tuning-live.js');
    setTuningValue('lightIntensity', 1e6);
    expect(readTuning().lightIntensity).toBe(TUNING_RANGE.lightIntensity.max);
  });

  it('resets to the identity', async () => {
    const { setTuningValue, resetTuning, readTuning } =
      await import('../src/viz/client-gl/tuning-live.js');
    setTuningValue('lightHue', 90);
    setTuningValue('buttonDepth', 3);
    resetTuning();
    for (const key of TUNING_KEYS) expect(readTuning()[key], key).toBe(TUNING_IDENTITY[key]);
  });

  it('forgets the persisted sample so the next visit is the identity', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    });
    const { setTuningValue, resetTuning } = await import('../src/viz/client-gl/tuning-live.js');
    setTuningValue('lightHue', 90);
    expect(store.has('atoma.viz.tuning')).toBe(true);
    resetTuning();
    expect(store.has('atoma.viz.tuning')).toBe(false);
    vi.unstubAllGlobals();
  });
});
