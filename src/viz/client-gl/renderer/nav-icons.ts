import { Container, Sprite, Texture } from 'pixi.js';
import type { Group, WebGLRenderer } from 'three';
import { pointerLightFalloff } from '../pointer-light.js';

type ThreeModule = typeof import('./nav-icon-three-runtime.js');

export type NavIconKind =
  | 'projects'
  | 'runs'
  | 'docs'
  | 'registry'
  | 'skills'
  | 'burnin'
  | 'admin'
  | 'journal'
  | 'ledger'
  | 'sentinel'
  | 'announce'
  | 'tuning';

const CONTROL_ICON: Readonly<Record<string, NavIconKind>> = {
  'nav.projects': 'projects',
  'nav.runs': 'runs',
  'nav.docs': 'docs',
  'nav.registry': 'registry',
  'nav.skills': 'skills',
  'nav.burnin': 'burnin',
  'nav.admin': 'admin',
  'nav.journal': 'journal',
  'nav.ledger': 'ledger',
  'nav.sentinel': 'sentinel',
  'nav.announce': 'announce',
  'tuning.toggle': 'tuning',
};

const MODEL_FILE: Readonly<Record<NavIconKind, string>> = {
  projects: 'folder',
  runs: 'play',
  docs: 'file-text',
  registry: 'cube',
  skills: 'puzzle',
  burnin: 'fire',
  admin: 'boy',
  journal: 'notebook',
  ledger: '3d-coin',
  sentinel: 'shield',
  announce: 'megaphone',
  tuning: 'setting',
};

export const NAV_ICON_RENDER_SIZE = 34;
export const NAV_ICON_OUTSIDE_GAP = 10;
export const NAV_ICON_SOURCE_SIZE = 128;
export const NAV_ICON_SPIN_RADIANS_PER_MS = 0.00155;
export const NAV_ICON_MATERIAL = {
  color: 0xd3a126,
  roughness: 0.3,
  metalness: 0.38,
} as const;
export const NAV_FOLDER_PAPER_MATERIAL = {
  color: 0xdbe7f5,
  roughness: 0.46,
  metalness: 0.08,
} as const;
export const NAV_ICON_ASSET_PATHS = Object.values(MODEL_FILE).map(
  (file) => `src/viz/public/models/navigation/${file}.glb`
);

export interface NavIconLighting {
  /** Key-light direction in the icon's local 3D plane. */
  readonly keyX: number;
  readonly keyY: number;
  readonly light: number;
}

export interface NavIconMesh {
  readonly texture: Texture;
  /** White RGB + the live mesh alpha, so Pixi tint paints a clean shadow. */
  readonly shadowTexture: Texture;
  render(rotationY: number, lighting: NavIconLighting, now: number, animated: boolean): void;
}

export interface NavIconMeshes {
  readonly icons: Readonly<Record<NavIconKind, NavIconMesh>>;
  destroy(): void;
}

export interface NavIconHandle {
  readonly root: Container;
  readonly face: Sprite;
  readonly mesh: NavIconMesh;
}

export interface NavIconSpinState {
  readonly rotation: number;
  readonly target: number;
}

export function navIconKind(id: string): NavIconKind | null {
  return CONTROL_ICON[id] ?? null;
}

/** Folder reads best like its familiar front-facing silhouette; other meshes keep the set angle. */
export function navIconRestPose(kind: NavIconKind): Readonly<{ x: number; y: number; z: number }> {
  return kind === 'projects'
    ? { x: -0.06, y: -0.08, z: 0 }
    : { x: -0.24, y: -0.42, z: 0.04 };
}

/**
 * Keep spinning while hovered, then finish the current revolution so an icon
 * never stops crooked. Reduced-motion users always get the stable rest pose.
 */
export function advanceNavIconSpin(
  state: NavIconSpinState,
  deltaMs: number,
  reduceMotion: boolean
): NavIconSpinState {
  if (reduceMotion) return { rotation: 0, target: 0 };
  const step = Math.max(0, deltaMs) * NAV_ICON_SPIN_RADIANS_PER_MS;
  return {
    rotation: Math.min(state.target, state.rotation + step),
    target: state.target,
  };
}

/** Queue exactly one full Y-axis revolution for one explicit click. */
export function queueNavIconSpin(
  state: NavIconSpinState,
  reduceMotion: boolean
): NavIconSpinState {
  if (reduceMotion) return { rotation: 0, target: 0 };
  return { rotation: state.rotation, target: state.target + Math.PI * 2 };
}

/** Pure pointer-to-key-light projection, shared by every navigation mesh. */
export function navIconLighting(
  fromLightX: number,
  fromLightY: number,
  strength: number
): NavIconLighting {
  const distance = Math.hypot(fromLightX, fromLightY);
  const directionX = distance > 0.001 ? fromLightX / distance : 0;
  const directionY = distance > 0.001 ? fromLightY / distance : 1;
  return {
    // `fromLight` points light → icon; the lamp sits in the inverse direction.
    keyX: -directionX,
    // Screen y grows downward while Three's y grows upward.
    keyY: directionY,
    light: pointerLightFalloff(distance) * Math.min(1.4, Math.max(0, strength)),
  };
}

function polishMaterials(model: Group, three: ThreeModule, kind: NavIconKind): void {
  model.traverse((child) => {
    if (!(child instanceof three.Mesh)) return;
    // The source meshes carry artist-authored normals for their rounded faces
    // and bevels. Recomputing them smears the bevel normals across broad flat
    // panels (most visibly as a dark blotch on the folder front).
    if (!child.geometry.getAttribute('normal')) child.geometry.computeVertexNormals();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!(material instanceof three.MeshStandardMaterial)) continue;
      const isFolderPaper =
        kind === 'projects' && /(?:clay\s*white|white|paper)/i.test(material.name);
      const palette = isFolderPaper ? NAV_FOLDER_PAPER_MATERIAL : NAV_ICON_MATERIAL;
      material.color.setHex(palette.color);
      material.roughness = palette.roughness;
      material.metalness = palette.metalness;
      material.emissive.setHex(isFolderPaper ? 0x0a1018 : 0x161006);
      material.emissiveIntensity = isFolderPaper ? 0.12 : 0.2;
      material.needsUpdate = true;
    }
  });
}

export function navIconOpticalScale(
  opaquePixels: number,
  boundsWidth: number,
  boundsHeight: number
): number {
  if (opaquePixels <= 0 || boundsWidth <= 0 || boundsHeight <= 0) return 1;
  const span = Math.max(boundsWidth, boundsHeight);
  const spanScale = 112 / span;
  // Dense solids (cube/book) read heavier than equally tall open shapes
  // (folder/fire). Area therefore participates alongside the outer bounds.
  const areaScale = Math.sqrt(4200 / opaquePixels);
  return Math.min(1.25, Math.max(0.68, Math.min(spanScale, areaScale)));
}

function measureSilhouette(context: CanvasRenderingContext2D): {
  opaquePixels: number;
  width: number;
  height: number;
} {
  const { data } = context.getImageData(0, 0, NAV_ICON_SOURCE_SIZE, NAV_ICON_SOURCE_SIZE);
  let minX = NAV_ICON_SOURCE_SIZE;
  let minY = NAV_ICON_SOURCE_SIZE;
  let maxX = -1;
  let maxY = -1;
  let opaquePixels = 0;
  for (let y = 0; y < NAV_ICON_SOURCE_SIZE; y += 1) {
    for (let x = 0; x < NAV_ICON_SOURCE_SIZE; x += 1) {
      if ((data[(y * NAV_ICON_SOURCE_SIZE + x) * 4 + 3] ?? 0) < 8) continue;
      opaquePixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    opaquePixels,
    width: maxX >= minX ? maxX - minX + 1 : 0,
    height: maxY >= minY ? maxY - minY + 1 : 0,
  };
}

function fitModel(model: Group, three: ThreeModule): void {
  const box = new three.Box3().setFromObject(model);
  const size = box.getSize(new three.Vector3());
  const center = box.getCenter(new three.Vector3());
  const extent = Math.max(size.x, size.y, size.z, 0.001);
  const scale = 1.72 / extent;
  model.scale.setScalar(scale);
  model.position.copy(center).multiplyScalar(-scale);
}

function createMeshTexture(
  three: ThreeModule,
  renderer: WebGLRenderer,
  model: Group,
  kind: NavIconKind
): NavIconMesh {
  polishMaterials(model, three, kind);
  fitModel(model, three);

  const scene = new three.Scene();
  const pivot = new three.Group();
  const opticalSize = new three.Group();
  const restPose = navIconRestPose(kind);
  pivot.rotation.set(restPose.x, restPose.y, restPose.z);
  opticalSize.add(model);
  pivot.add(opticalSize);
  scene.add(pivot);

  // Tiny recessed/back-facing polygons become unreadable black chips at 34px
  // without a frontal fill. Ambient keeps them gold; the two directional
  // lights still provide the volume, specular response and pointer movement.
  const ambient = new three.AmbientLight(0xffe2a5, 2.15);
  const hemisphere = new three.HemisphereLight(0xffdf9b, 0x8a6a2d, 0.72);
  const key = new three.DirectionalLight(0xffe7b2, 2.4);
  key.position.set(-2.5, 3, 4);
  const rim = new three.DirectionalLight(0x76a9ff, 1.15);
  rim.position.set(3, -1.5, 2.5);
  scene.add(ambient, hemisphere, key, rim);

  const camera = new three.PerspectiveCamera(24, 1, 0.1, 20);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);

  const output = document.createElement('canvas');
  output.width = NAV_ICON_SOURCE_SIZE;
  output.height = NAV_ICON_SOURCE_SIZE;
  const context = output.getContext('2d', { alpha: true });
  if (!context) throw new Error(`Could not create the ${kind} navigation mesh canvas`);
  const texture = Texture.from(output);
  texture.label = `nav-mesh-${kind}`;
  const shadowOutput = document.createElement('canvas');
  shadowOutput.width = NAV_ICON_SOURCE_SIZE;
  shadowOutput.height = NAV_ICON_SOURCE_SIZE;
  const shadowContext = shadowOutput.getContext('2d', { alpha: true });
  if (!shadowContext) throw new Error(`Could not create the ${kind} shadow-mask canvas`);
  const shadowTexture = Texture.from(shadowOutput);
  shadowTexture.label = `nav-mesh-shadow-${kind}`;

  let lastAt = Number.NEGATIVE_INFINITY;
  let lastRotation = Number.NaN;
  let lastLight = Number.NaN;
  let lastKeyX = Number.NaN;
  let lastKeyY = Number.NaN;
  const render = (
    rotationY: number,
    lighting: NavIconLighting,
    now: number,
    animated: boolean
  ) => {
    const interval = animated ? 32 : 90;
    const changed =
      !Number.isFinite(lastRotation) ||
      Math.abs(rotationY - lastRotation) > 0.002 ||
      Math.abs(lighting.light - lastLight) > 0.025 ||
      Math.abs(lighting.keyX - lastKeyX) > 0.04 ||
      Math.abs(lighting.keyY - lastKeyY) > 0.04;
    if (!changed || now - lastAt < interval) return;

    pivot.rotation.y = restPose.y + rotationY;
    key.position.set(lighting.keyX * 3.2, lighting.keyY * 3.2, 4);
    key.intensity = 2.1 + lighting.light * 3.2;
    renderer.render(scene, camera);
    context.clearRect(0, 0, NAV_ICON_SOURCE_SIZE, NAV_ICON_SOURCE_SIZE);
    context.drawImage(renderer.domElement, 0, 0);
    texture.source.update();
    // A tint MULTIPLIES RGB; tinting the coloured face made its blue/gold
    // regions turn into unrelated black slabs. The shared shadow painter gets
    // a neutral white silhouette instead, so only alpha describes the mesh.
    shadowContext.clearRect(0, 0, NAV_ICON_SOURCE_SIZE, NAV_ICON_SOURCE_SIZE);
    shadowContext.drawImage(output, 0, 0);
    shadowContext.globalCompositeOperation = 'source-in';
    shadowContext.fillStyle = '#ffffff';
    shadowContext.fillRect(0, 0, NAV_ICON_SOURCE_SIZE, NAV_ICON_SOURCE_SIZE);
    shadowContext.globalCompositeOperation = 'source-over';
    shadowTexture.source.update();
    lastAt = now;
    lastRotation = rotationY;
    lastLight = lighting.light;
    lastKeyX = lighting.keyX;
    lastKeyY = lighting.keyY;
  };

  // The first frame exists before Pixi builds any sprites or silhouettes.
  render(0, { keyX: -0.35, keyY: 0.8, light: 0 }, 0, true);
  const silhouette = measureSilhouette(context);
  opticalSize.scale.setScalar(
    navIconOpticalScale(silhouette.opaquePixels, silhouette.width, silhouette.height)
  );
  lastAt = Number.NEGATIVE_INFINITY;
  lastRotation = Number.NaN;
  render(0, { keyX: -0.35, keyY: 0.8, light: 0 }, 1, true);
  return { texture, shadowTexture, render };
}

/** Load, light and rasterise the actual GLB meshes through one shared renderer. */
export async function loadNavIconMeshes(): Promise<NavIconMeshes> {
  const three = await import('./nav-icon-three-runtime.js');
  const { GLTFLoader } = three;
  const renderer = new three.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(NAV_ICON_SOURCE_SIZE, NAV_ICON_SOURCE_SIZE, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = three.SRGBColorSpace;
  renderer.toneMapping = three.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;

  const loader = new GLTFLoader();
  const entries = await Promise.all(
    Object.entries(MODEL_FILE).map(async ([kind, file]) => {
      const gltf = await loader.loadAsync(`/models/navigation/${file}.glb`);
      const mesh = createMeshTexture(three, renderer, gltf.scene, kind as NavIconKind);
      return [kind, mesh] as const;
    })
  );
  const icons = Object.fromEntries(entries) as unknown as Readonly<
    Record<NavIconKind, NavIconMesh>
  >;
  return {
    icons,
    destroy: () => renderer.dispose(),
  };
}

export function drawNavIcon(
  parent: Container,
  id: string,
  meshes: NavIconMeshes,
  x: number,
  y: number,
  active: boolean
): NavIconHandle | null {
  const kind = navIconKind(id);
  if (!kind) return null;
  const mesh = meshes.icons[kind];
  const root = new Container();
  root.position.set(x, y);
  root.label = `nav-icon-${kind}`;
  root.eventMode = 'none';

  const face = new Sprite(mesh.texture);
  face.width = NAV_ICON_RENDER_SIZE;
  face.height = NAV_ICON_RENDER_SIZE;
  face.eventMode = 'none';
  root.addChild(face);

  root.alpha = active ? 1 : 0.9;
  parent.addChild(root);
  return { root, face, mesh };
}
