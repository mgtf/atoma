import {
  Buffer,
  BufferUsage,
  Geometry,
  Graphics,
  Mesh,
  Shader,
  Sprite,
  Texture,
  type Container,
  type Ticker,
} from 'pixi.js';
import { GPU_COLORS } from '../theme.js';
import { prefersReducedMotion } from './motion.js';
import { AVATAR_ORB_GLSL, AVATAR_ORB_GLSL_VERTEX, AVATAR_ORB_WGSL } from './shaders.js';

/**
 * THE ACCOUNT ORB — the viewer's picture inside a faceted glass sphere.
 *
 * One quad, one program (see AVATAR_ORB_WGSL for what the fragment shader
 * actually builds), attached once and RETAINED across renders the way the
 * brand crystal is: `renderScene` destroys the scene every frame, so a mesh
 * rebuilt each time would re-upload its geometry and re-create its texture
 * binding sixty times a second.
 *
 * Motion, by design:
 * - IDLE: a slow facet drift plus a light parallax read from the shared
 *   pointer sample. Nothing here touches React or Zustand.
 * - HOVER: the drift accelerates threefold and the rim ramps teal -> amber.
 * - REDUCED MOTION: no ticker at all. The orb JUMPS to its resting angle and
 *   hover changes only the rim colour, which is information, not motion.
 */

/** Wedges around the shell. Nine reads as cut glass without looking like a gear. */
export const AVATAR_ORB_FACETS = 9;
/** Radians per millisecond at rest — a full turn in a little under two minutes. */
export const AVATAR_ORB_IDLE_RATE = 0.00006;
/** Hover multiplies the drift by this. */
export const AVATAR_ORB_HOVER_RATE = 3;
/** Resting angle under reduced motion: a facet seam off-axis, not aligned. */
export const AVATAR_ORB_STATIC_SPIN = 0.42;

export interface AvatarOrbHandle {
  readonly container: Container;
  /** Re-parent and re-register the paint ticker after `renderScene` cleared it. */
  resume(parent: Container, addTicker: (callback: (ticker: Ticker) => void) => void): void;
  /**
   * Drive the hover ramp from OUTSIDE.
   *
   * The orb lives on `markRoot`, which is `eventMode = 'none'` by design — the
   * brand crystal must not eat pointer events, and that decision covers every
   * child of that layer. So the mesh cannot hear its own pointerover: the
   * renderer draws an invisible hit rect on the interactive layer over the orb
   * and forwards hover and activation through here.
   */
  setHover(on: boolean): void;
  destroy(): void;
}

export interface AvatarOrbOptions {
  /** Top-left of the orb's box, in renderer screen pixels. */
  readonly x: number;
  readonly y: number;
  /** Diameter in pixels. */
  readonly size: number;
  /** Same-origin avatar URL, or null for the procedural interior. */
  readonly photoUrl: string | null;
  /** Stable per-account string (the principal id) behind the fallback colours. */
  readonly seed: string;
  /** Pointer position in renderer screen pixels, for the light parallax. */
  readonly pointerAt?: () => { x: number; y: number } | null;
  /** Hold the hover state on: the menu this orb opens is open. */
  readonly active?: boolean;
}

interface OrbUniformValues {
  uAccentA: Float32Array;
  uAccentB: Float32Array;
  uAccentC: Float32Array;
  uSeedA: Float32Array;
  uSeedB: Float32Array;
  uLight: Float32Array;
  uSpin: number;
  uHover: number;
  uHasPhoto: number;
  uFacets: number;
  uRadiusPx: number;
}

const ORB_UNIFORM_TYPES = [
  { name: 'uAccentA', type: 'vec3<f32>' },
  { name: 'uAccentB', type: 'vec3<f32>' },
  { name: 'uAccentC', type: 'vec3<f32>' },
  { name: 'uSeedA', type: 'vec3<f32>' },
  { name: 'uSeedB', type: 'vec3<f32>' },
  { name: 'uLight', type: 'vec2<f32>' },
  { name: 'uSpin', type: 'f32' },
  { name: 'uHover', type: 'f32' },
  { name: 'uHasPhoto', type: 'f32' },
  { name: 'uFacets', type: 'f32' },
  { name: 'uRadiusPx', type: 'f32' },
] as const;

function rgb(color: number): Float32Array {
  return new Float32Array([
    ((color >> 16) & 0xff) / 255,
    ((color >> 8) & 0xff) / 255,
    (color & 0xff) / 255,
  ]);
}

/** FNV-1a: a stable 32-bit hash, so an account's fallback colours never move. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hslToRgbArray(hue: number, saturation: number, lightness: number): Float32Array {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (hue % 360) / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const base = lightness - chroma / 2;
  const table: Array<[number, number, number]> = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ];
  const [r, g, b] = table[Math.floor(sector) % 6]!;
  return new Float32Array([r + base, g + base, b + base]);
}

/**
 * Two colours for an account with no provider picture, derived from the
 * principal id. Hues are pulled into the product's teal..violet arc rather
 * than spread over the whole wheel: an identity colour should still look like
 * it belongs to this UI.
 */
export function fallbackOrbColors(seed: string): { a: Float32Array; b: Float32Array } {
  const hash = hashSeed(seed);
  const hue = 168 + ((hash >>> 8) % 120);
  // Enough range between the two that the gradient reads as a lit solid
  // rather than one flat tint: the shader's diffuse term shapes it further.
  return {
    a: hslToRgbArray(hue, 0.55, 0.42),
    b: hslToRgbArray((hue + 46) % 360, 0.50, 0.13),
  };
}

/**
 * Loaded avatar textures, keyed by URL and kept for the session.
 *
 * A `null` entry is a REMEMBERED FAILURE: without it, an unreachable or
 * corrupt avatar would be re-fetched on every retain, which is every scene
 * rebuild. The bitmap decode happens once per URL either way.
 */
const textureCache = new Map<string, Texture | null | Promise<Texture | null>>();

async function loadTexture(url: string): Promise<Texture | null> {
  try {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'default' });
    if (!response.ok) return null;
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    return Texture.from(bitmap);
  } catch {
    return null;
  }
}

/** Resolve now if cached, otherwise start one load and share its promise. */
function avatarTexture(url: string): Texture | null | Promise<Texture | null> {
  const cached = textureCache.get(url);
  if (cached !== undefined) return cached;
  const pending = loadTexture(url).then((texture) => {
    textureCache.set(url, texture);
    return texture;
  });
  textureCache.set(url, pending);
  return pending;
}

/** Test seam: forget every cached texture so a suite can re-arm the loader. */
export function clearAvatarTextureCacheForTests(): void {
  textureCache.clear();
}

/**
 * A small static face for a LIST — the org member table, where nine animated
 * glass orbs would be nine meshes and nine shaders for rows the eye scans past.
 *
 * Rebuilt with the scene (a Sprite is cheap; the decoded texture is cached by
 * URL), so no retain dance. A texture that is still loading resolves onto the
 * live sprite rather than waiting for the next render — nothing else would
 * trigger one.
 */
export function attachAvatarChip(
  parent: Container,
  options: { x: number; y: number; size: number; photoUrl: string | null; seed: string }
): void {
  const { size } = options;
  const radius = size / 2;
  const fallback = fallbackOrbColors(options.seed);
  const disc = new Graphics();
  disc.circle(options.x + radius, options.y + radius, radius);
  disc.fill({
    color:
      (Math.round(fallback.a[0]! * 255) << 16) |
      (Math.round(fallback.a[1]! * 255) << 8) |
      Math.round(fallback.a[2]! * 255),
  });
  disc.circle(options.x + radius, options.y + radius, radius);
  disc.stroke({ color: GPU_COLORS.border, width: 1 });
  disc.eventMode = 'none';
  parent.addChild(disc);
  if (!options.photoUrl) return;

  const mask = new Graphics();
  mask.circle(options.x + radius, options.y + radius, radius - 0.5);
  mask.fill(0xffffff);
  mask.eventMode = 'none';
  parent.addChild(mask);
  const sprite = new Sprite();
  sprite.position.set(options.x, options.y);
  sprite.width = size;
  sprite.height = size;
  sprite.mask = mask;
  sprite.eventMode = 'none';
  parent.addChild(sprite);

  const apply = (texture: Texture | null): void => {
    if (!texture || sprite.destroyed) return;
    sprite.texture = texture;
    sprite.width = size;
    sprite.height = size;
  };
  const resolved = avatarTexture(options.photoUrl);
  if (resolved instanceof Promise) void resolved.then(apply);
  else apply(resolved);
}

export function attachAvatarOrb(
  parent: Container,
  addTicker: (callback: (ticker: Ticker) => void) => void,
  options: AvatarOrbOptions
): AvatarOrbHandle {
  const { size } = options;
  const radius = size / 2;
  const positions = new Float32Array([0, 0, size, 0, size, size, 0, size]);
  const uvs = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
  const geometry = new Geometry({
    attributes: {
      aPosition: { buffer: new Buffer({ data: positions, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }), format: 'float32x2' },
      aUv: { buffer: new Buffer({ data: uvs, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }), format: 'float32x2' },
    },
    indexBuffer: new Buffer({
      data: new Uint32Array([0, 1, 2, 0, 2, 3]),
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    }),
    topology: 'triangle-list',
  });

  const fallback = fallbackOrbColors(options.seed);
  const initial: OrbUniformValues = {
    uAccentA: rgb(GPU_COLORS.tiers[1]),
    uAccentB: rgb(GPU_COLORS.tiers[2]),
    uAccentC: rgb(GPU_COLORS.tiers[3]),
    uSeedA: fallback.a,
    uSeedB: fallback.b,
    uLight: new Float32Array([0, 0]),
    uSpin: prefersReducedMotion() ? AVATAR_ORB_STATIC_SPIN : 0,
    uHover: 0,
    uHasPhoto: 0,
    uFacets: AVATAR_ORB_FACETS,
    uRadiusPx: radius,
  };

  const shader = Shader.from({
    gl: { vertex: AVATAR_ORB_GLSL_VERTEX, fragment: AVATAR_ORB_GLSL },
    gpu: {
      vertex: { source: AVATAR_ORB_WGSL, entryPoint: 'mainVertex' },
      fragment: { source: AVATAR_ORB_WGSL, entryPoint: 'mainFragment' },
    },
    resources: {
      orbUniforms: Object.fromEntries(
        ORB_UNIFORM_TYPES.map(({ name, type }) => [
          name,
          { value: initial[name], type },
        ])
      ),
    },
  });
  // Declared from the first draw even with no picture: a texture resource that
  // appeared later would change the bind-group layout mid-life, which WebGPU
  // refuses. Empty keeps the layout fixed and `uHasPhoto = 0` keeps the sample
  // out of the result.
  shader.resources['uPhoto'] = Texture.EMPTY.source;
  shader.resources['uPhotoSampler'] = Texture.EMPTY.source.style;

  const uniforms = shader.resources['orbUniforms'].uniforms as OrbUniformValues;
  const mesh = new Mesh({ geometry, shader });
  mesh.label = 'avatar-orb';
  mesh.position.set(options.x, options.y);

  const applyTexture = (texture: Texture | null): void => {
    if (!texture || mesh.destroyed) return;
    shader.resources['uPhoto'] = texture.source;
    shader.resources['uPhotoSampler'] = texture.source.style;
    uniforms.uHasPhoto = 1;
  };
  if (options.photoUrl) {
    const resolved = avatarTexture(options.photoUrl);
    if (resolved instanceof Promise) void resolved.then(applyTexture);
    else applyTexture(resolved);
  }

  mesh.eventMode = 'none';

  let hover = options.active ? 1 : 0;
  let target = options.active ? 1 : 0;
  uniforms.uHover = hover;
  const setHover = (on: boolean): void => {
    target = on || options.active === true ? 1 : 0;
    // Reduced motion does not slow the ramp down, it removes it: the rim
    // colour still reports hover, which is information, not motion.
    if (prefersReducedMotion()) {
      hover = target;
      uniforms.uHover = target;
    }
  };

  let bufferPinned = false;
  const paint = (ticker: Ticker): void => {
    if (mesh.destroyed) return;
    // PIN THE UNIFORM BUFFER against Pixi's WebGPU GC. Under reduced motion
    // this ticker writes nothing for minutes at a time, which is precisely the
    // shape that gets a retained buffer unloaded while a cached bind group
    // still points at it (see the pointer-light note in gpu-renderer.ts and
    // pixijs#12080). Cheap insurance, and it survives GC being re-enabled.
    if (!bufferPinned) {
      const group = shader.resources['orbUniforms'] as unknown as {
        buffer?: { autoGarbageCollect: boolean };
      };
      if (group.buffer) {
        group.buffer.autoGarbageCollect = false;
        bufferPinned = true;
      }
    }
    if (prefersReducedMotion()) return;
    const response = 1 - Math.exp(-Math.max(0, ticker.deltaMS) * 0.014);
    hover += (target - hover) * response;
    uniforms.uHover = hover;
    uniforms.uSpin +=
      ticker.deltaMS * AVATAR_ORB_IDLE_RATE * (1 + hover * (AVATAR_ORB_HOVER_RATE - 1));
    const pointer = options.pointerAt?.() ?? null;
    if (pointer) {
      // Parallax, clamped: past a couple of diameters the light stops moving
      // rather than swinging to a grazing angle from across the viewport.
      const light = uniforms.uLight;
      light[0] = clamp((pointer.x - (options.x + radius)) / (radius * 6), -1, 1);
      light[1] = clamp((pointer.y - (options.y + radius)) / (radius * 6), -1, 1);
    }
  };
  if (prefersReducedMotion()) {
    // One pass to pin the buffer and settle the resting state, then nothing.
    uniforms.uSpin = AVATAR_ORB_STATIC_SPIN;
    uniforms.uHover = target;
  }
  parent.addChild(mesh);
  addTicker(paint);

  return {
    container: mesh,
    resume(nextParent, nextAddTicker) {
      if (mesh.destroyed) return;
      nextParent.addChild(mesh);
      nextAddTicker(paint);
    },
    setHover,
    destroy() {
      if (mesh.destroyed) return;
      mesh.destroy({ children: true, context: true });
      geometry.destroy(true);
      shader.destroy();
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
