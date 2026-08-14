export const ATOMA_MARK_TURN_MS = 10_000;

type Tier = 1 | 2 | 3;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface AtomaMarkPoint {
  x: number;
  y: number;
}

export interface AtomaMarkFace {
  id: string;
  tier: Tier;
  points: readonly [AtomaMarkPoint, AtomaMarkPoint, AtomaMarkPoint];
  centroid: AtomaMarkPoint;
  depth: number;
  fillColor: number;
  edgeColor: number;
  glowAlpha: number;
  sheenAlpha: number;
}

export interface AtomaMarkFrame {
  faces: AtomaMarkFace[];
  pulse: number;
  scale: number;
  yaw: number;
}

const CENTER = { x: 14, y: 14 } as const;
const PROJECTION_SCALE = 9.8;
const BRAND_COLORS: Record<Tier, number> = {
  1: 0x0f9f92,
  2: 0xf59e0b,
  3: 0x8b5cf6,
};

const VERTICES: readonly Vec3[] = [
  { x: 0, y: 1.2, z: 0 },
  { x: 1.05, y: 0.12, z: 0.72 },
  { x: -1.05, y: 0.12, z: 0.72 },
  { x: 0.15, y: 0.12, z: -1.15 },
  { x: 0, y: -1.15, z: 0 },
];

const FACES: ReadonlyArray<{
  id: string;
  indices: readonly [number, number, number];
  tier: Tier;
  underside: boolean;
}> = [
  { id: 'cell-top', indices: [0, 1, 2], tier: 2, underside: false },
  { id: 'tissue-top', indices: [0, 3, 1], tier: 3, underside: false },
  { id: 'molecule-top', indices: [0, 2, 3], tier: 1, underside: false },
  { id: 'cell-bottom', indices: [4, 2, 1], tier: 2, underside: true },
  { id: 'tissue-bottom', indices: [4, 1, 3], tier: 3, underside: true },
  { id: 'molecule-bottom', indices: [4, 3, 2], tier: 1, underside: true },
];

function clamp(value: number, low = 0, high = 1) {
  return Math.max(low, Math.min(high, value));
}

function dot(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(value.x, value.y, value.z) || 1;
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function scaleColor(color: number, amount: number) {
  const red = clamp(Math.round((color >> 16 & 0xff) * amount), 0, 255);
  const green = clamp(Math.round((color >> 8 & 0xff) * amount), 0, 255);
  const blue = clamp(Math.round((color & 0xff) * amount), 0, 255);
  return red << 16 | green << 8 | blue;
}

function mixColor(from: number, to: number, amount: number) {
  const t = clamp(amount);
  const channel = (shift: number) => Math.round(
    (from >> shift & 0xff) * (1 - t) + (to >> shift & 0xff) * t
  );
  return channel(16) << 16 | channel(8) << 8 | channel(0);
}

function rotate(vertex: Vec3, yaw: number, pitch: number, roll: number): Vec3 {
  const yawCos = Math.cos(yaw);
  const yawSin = Math.sin(yaw);
  const yawX = vertex.x * yawCos - vertex.z * yawSin;
  const yawZ = vertex.x * yawSin + vertex.z * yawCos;

  const pitchCos = Math.cos(pitch);
  const pitchSin = Math.sin(pitch);
  const pitchY = vertex.y * pitchCos - yawZ * pitchSin;
  const pitchZ = vertex.y * pitchSin + yawZ * pitchCos;

  const rollCos = Math.cos(roll);
  const rollSin = Math.sin(roll);
  return {
    x: yawX * rollCos - pitchY * rollSin,
    y: yawX * rollSin + pitchY * rollCos,
    z: pitchZ,
  };
}

function project(vertex: Vec3): AtomaMarkPoint {
  const perspective = 1 + vertex.z * 0.055;
  return {
    x: CENTER.x + vertex.x * PROJECTION_SCALE * perspective,
    y: CENTER.y - vertex.y * PROJECTION_SCALE * perspective,
  };
}

/**
 * Builds one deterministic frame of the header crystal. Keeping projection,
 * depth ordering and lighting pure makes the tiny animated mark testable
 * without coupling its contract to a screenshot or a particular GPU backend.
 */
export function buildAtomaMarkFrame(elapsedMs: number): AtomaMarkFrame {
  const seconds = Math.max(0, elapsedMs) / 1000;
  const yaw =
    0.42 +
    seconds * Math.PI * 2 / (ATOMA_MARK_TURN_MS / 1000) +
    Math.sin(seconds * 0.95) * 0.045;
  const pitch = -0.2 + Math.sin(seconds * 1.22) * 0.085;
  const roll = 0.08 + Math.cos(seconds * 0.72) * 0.032;
  const pulse = 0.5 + Math.sin(seconds * 3.35) * 0.5;
  const transformed = VERTICES.map((vertex) => rotate(vertex, yaw, pitch, roll));
  const projected = transformed.map(project);
  const light = normalize({ x: -0.38, y: 0.72, z: 1.05 });
  const camera = { x: 0, y: 0, z: 1 };
  const halfVector = normalize({
    x: light.x + camera.x,
    y: light.y + camera.y,
    z: light.z + camera.z,
  });

  const faces = FACES.map((face): AtomaMarkFace => {
    const [aIndex, bIndex, cIndex] = face.indices;
    const a = transformed[aIndex]!;
    const b = transformed[bIndex]!;
    const c = transformed[cIndex]!;
    const center3 = {
      x: (a.x + b.x + c.x) / 3,
      y: (a.y + b.y + c.y) / 3,
      z: (a.z + b.z + c.z) / 3,
    };
    let normal = normalize(cross(subtract(b, a), subtract(c, a)));
    if (dot(normal, center3) < 0) {
      normal = { x: -normal.x, y: -normal.y, z: -normal.z };
    }
    const diffuse = clamp(dot(normal, light));
    const viewFacing = clamp(Math.abs(dot(normal, camera)));
    const rim = (1 - viewFacing) ** 1.7;
    const specular = clamp(dot(normal, halfVector)) ** 18;
    const materialShade = (face.underside ? 0.72 : 0.86) + diffuse * 0.46;
    const shaded = scaleColor(BRAND_COLORS[face.tier], materialShade);
    const fillColor = mixColor(shaded, 0xf5fbff, specular * 0.68 + rim * 0.07);
    const points = face.indices.map((index) => projected[index]!) as unknown as readonly [
      AtomaMarkPoint,
      AtomaMarkPoint,
      AtomaMarkPoint,
    ];
    const centroid = {
      x: (points[0].x + points[1].x + points[2].x) / 3,
      y: (points[0].y + points[1].y + points[2].y) / 3,
    };
    return {
      id: face.id,
      tier: face.tier,
      points,
      centroid,
      depth: center3.z,
      fillColor,
      edgeColor: mixColor(BRAND_COLORS[face.tier], 0xf5fbff, 0.38 + specular * 0.42),
      glowAlpha: 0.045 + rim * 0.12 + specular * 0.1,
      sheenAlpha: 0.018 + diffuse * 0.025 + specular * 0.24,
    };
  }).sort((left, right) => left.depth - right.depth);

  return {
    faces,
    pulse,
    scale: 0.99 + Math.sin(seconds * 1.58) * 0.012,
    yaw,
  };
}
