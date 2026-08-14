import {
  Application,
  Container,
  Filter,
  Graphics,
  Rectangle,
  RendererType,
  Text,
  TextStyle,
  Ticker,
} from 'pixi.js';
import {
  buildAtomMap,
  coerceEventFilters,
  fmtCost,
  fmtMs,
  isRunLive,
  toolArgSummary,
  tryParseJson,
  visibleEventKindFilters,
} from '../client/run-utils.js';
import {
  atomSearchText,
  matchesSearchQuery,
  runSearchText,
  skillSearchText,
} from '../client/search.js';
import {
  buildTimelineLayout,
  timelineBranchHeading,
  type TimelineBranch,
} from '../client/timeline-layout.js';
import type {
  BurninRow,
  LaunchProfile,
  RegistrySummary,
  RegistryType,
  RunIndexEntry,
  SkillNamespace,
  SkillSummary,
  VizEvent,
  VizRun,
} from '../client/types.js';
import { taxonomyForTier } from '../../core/taxonomy.js';
import { elementForTool } from '../../contracts/toolTaxonomy.js';
import { currentDisplayName } from '../../registry/taxonomyNames.js';
import {
  ATOMA_MARK_CORE_RADIUS,
  ATOMA_MARK_CORE_RADIUS_PULSE,
  ATOMA_MARK_CORE_STROKE_WIDTH,
  buildAtomaMarkFrame,
  type AtomaMarkPoint,
} from './brand-mark.js';
import type { GpuUiState, ViewName } from './store.js';
import { GPU_COLORS, GPU_LAYOUT } from './theme.js';
import {
  buildSkillEventDetail,
  buildStructuredDetail,
  eventRoleLabel,
  filePathFromArgs,
  skillEventSubtitle,
  skillEventTitle,
  type DetailTone,
  type StructuredDetailNode,
} from '../client/structured-detail.js';

export interface GpuDataSnapshot {
  runs: RunIndexEntry[];
  run: VizRun | null;
  registries: RegistrySummary[];
  registry: { registry: RegistrySummary; types: RegistryType[] } | null;
  skillNamespaces: SkillNamespace[];
  skillsByNamespace: Record<string, SkillSummary[]>;
  skillDetail: SkillSummary | null;
  burnin: { rows: BurninRow[]; csvPath: string } | null;
  profiles: LaunchProfile[];
  loading: boolean;
  error: string | null;
}

export interface GpuHitTarget {
  id: string;
  role: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FilterVisualTarget extends GpuHitTarget {
  active: boolean;
  accent: number;
}

export interface GpuTimelineViewport {
  left: number;
  top: number;
  width: number;
  height: number;
  railBaseX: number;
  laneSpacing: number;
  cardBaseX: number;
  cardBaseWidth: number;
  branchCardOffset: number;
  contentTopPadding: number;
  contentBottomPadding: number;
  rowHeight: number;
  totalHeight: number;
  scrollY: number;
}

export interface GpuRenderMetrics {
  backend: 'webgpu' | 'webgl' | 'unknown';
  objectCount: number;
  runCollapseOffset: number;
  visibleLabels: string[];
  hitTargets: GpuHitTarget[];
  timelineViewport?: GpuTimelineViewport;
}

export interface GpuRenderSnapshot {
  state: GpuUiState;
  data: GpuDataSnapshot;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onActivate: (id: string) => void;
  onScroll: (view: ViewName, delta: number) => void;
  onRunPickerScroll: (delta: number) => void;
}

interface TextOptions {
  size?: number;
  color?: number;
  weight?: '400' | '500' | '600' | '700';
  width?: number;
  mono?: boolean;
  alpha?: number;
}

const PAGE_SIZE = 50;

function scalar(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === undefined || value === null) return fallback;
  return JSON.stringify(value) ?? fallback;
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function gpuFilterButtonWidth(label: string) {
  // Uppercase filter labels use the 11px semibold face, whose wide glyphs
  // average closer to 7px than the 6px estimate used for ordinary chips.
  // Add enough horizontal padding that the generic button renderer never
  // applies ellipsis to a semantic control.
  return Math.max(52, Math.ceil(label.length * 7.2 + 24));
}

const CONTROL_HOVER_GAP = 14;
const NAV_HOVER_GAP = 20;

export const FILTER_BLOCK_PAD = 8;
export const FILTER_BLOCK_GAP = 12;
export const FILTER_BUTTON_HEIGHT = 27;
export const ATOM_BUTTON_HEIGHT = 28;

export function gpuLaneLabelWidth(label: string) {
  return Math.min(132, Math.max(72, Math.ceil(label.length * 6 + 18)));
}

export interface FilterChipSpec {
  id: string;
  label: string;
}

export interface FilterChipLayout extends FilterChipSpec {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FilterBlockLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  chips: FilterChipLayout[];
}

function placeChipBlock(
  chips: readonly FilterChipSpec[],
  originX: number,
  originY: number,
  maxRow: number,
  widthOf: (label: string) => number,
  buttonH: number,
  insetX = 0
): FilterBlockLayout {
  const pad = FILTER_BLOCK_PAD;
  const gap = CONTROL_HOVER_GAP;
  let x = 0;
  let y = 0;
  let innerW = insetX;
  const placed: FilterChipLayout[] = [];
  for (const chip of chips) {
    const width = widthOf(chip.label);
    if (x > 0 && insetX + x + width > maxRow) {
      x = 0;
      y += buttonH + gap;
    }
    placed.push({
      ...chip,
      x: originX + pad + insetX + x,
      y: originY + pad + y,
      width,
      height: buttonH,
    });
    x += width + gap;
    innerW = Math.max(innerW, insetX + x - gap);
  }
  return {
    x: originX,
    y: originY,
    width: Math.max(innerW, insetX) + pad * 2,
    height: (chips.length ? y + buttonH : 0) + pad * 2,
    chips: placed,
  };
}

export function layoutFilterChipBlock(
  originX: number,
  originY: number,
  maxWidth: number,
  chips: readonly FilterChipSpec[]
): FilterBlockLayout {
  return placeChipBlock(
    chips,
    originX,
    originY,
    Math.max(FILTER_BUTTON_HEIGHT, maxWidth - FILTER_BLOCK_PAD * 2),
    gpuFilterButtonWidth,
    FILTER_BUTTON_HEIGHT
  );
}

export function layoutRunFilterBlocks(options: {
  originX: number;
  originY: number;
  maxWidth: number;
  kinds: readonly FilterChipSpec[];
  roles: readonly FilterChipSpec[] | null;
}): { kinds: FilterBlockLayout; roles: FilterBlockLayout | null; bottom: number } {
  const pad = FILTER_BLOCK_PAD;
  const buttonH = FILTER_BUTTON_HEIGHT;
  const maxInner = Math.max(buttonH, options.maxWidth - pad * 2);
  const kinds = placeChipBlock(
    options.kinds,
    options.originX,
    options.originY,
    maxInner,
    gpuFilterButtonWidth,
    buttonH
  );
  if (!options.roles?.length) {
    return { kinds, roles: null, bottom: kinds.y + kinds.height };
  }

  const stackedRoles = placeChipBlock(
    options.roles,
    options.originX,
    options.originY + kinds.height + FILTER_BLOCK_GAP,
    maxInner,
    gpuFilterButtonWidth,
    buttonH
  );
  const inlineRoles = placeChipBlock(
    options.roles,
    options.originX + kinds.width + FILTER_BLOCK_GAP,
    options.originY,
    maxInner,
    gpuFilterButtonWidth,
    buttonH
  );
  const singleRow =
    kinds.height === buttonH + pad * 2 &&
    inlineRoles.height === buttonH + pad * 2 &&
    inlineRoles.x + inlineRoles.width <= options.originX + options.maxWidth;
  const roles = singleRow ? inlineRoles : stackedRoles;
  return { kinds, roles, bottom: Math.max(kinds.y + kinds.height, roles.y + roles.height) };
}

export interface AtomLaneSpec {
  tier: 1 | 2 | 3;
  label: string;
  names: readonly string[];
}

export interface AtomLaneBlockLayout extends FilterBlockLayout {
  tier: 1 | 2 | 3;
  label: string;
  labelX: number;
  labelY: number;
}

export function layoutAtomLaneBlocks(options: {
  originX: number;
  originY: number;
  maxWidth: number;
  lanes: readonly AtomLaneSpec[];
}): { lanes: AtomLaneBlockLayout[]; bottom: number } {
  const pad = FILTER_BLOCK_PAD;
  const buttonH = ATOM_BUTTON_HEIGHT;
  const maxInner = Math.max(buttonH, options.maxWidth - pad * 2);

  const measure = (lane: AtomLaneSpec, originX: number, originY: number, maxRow: number) => {
    const labelW = gpuLaneLabelWidth(lane.label);
    const block = placeChipBlock(
      lane.names.map((name) => ({ id: `atom.${name}`, label: name })),
      originX,
      originY,
      maxRow,
      gpuAtomButtonWidth,
      buttonH,
      labelW
    );
    return {
      ...block,
      tier: lane.tier,
      label: lane.label,
      labelX: originX + pad,
      labelY: originY + pad + 7,
    };
  };

  const natural = options.lanes.map((lane) => measure(lane, 0, 0, Number.POSITIVE_INFINITY));
  const inlineWidth =
    natural.reduce((sum, lane) => sum + lane.width, 0) +
    FILTER_BLOCK_GAP * Math.max(0, options.lanes.length - 1);
  const inline =
    options.lanes.length > 0 &&
    inlineWidth <= options.maxWidth &&
    natural.every((lane) => lane.height === buttonH + pad * 2);

  const lanes: AtomLaneBlockLayout[] = [];
  if (inline) {
    let x = options.originX;
    for (const lane of options.lanes) {
      const block = measure(lane, x, options.originY, Number.POSITIVE_INFINITY);
      lanes.push(block);
      x += block.width + FILTER_BLOCK_GAP;
    }
  } else {
    let y = options.originY;
    for (const lane of options.lanes) {
      const block = measure(lane, options.originX, y, maxInner);
      lanes.push(block);
      y += block.height + FILTER_BLOCK_GAP;
    }
  }
  const bottom = lanes.length
    ? Math.max(...lanes.map((lane) => lane.y + lane.height))
    : options.originY;
  return { lanes, bottom };
}

export function gpuAtomButtonWidth(label: string) {
  // 28px particle zone + 8px separation + 12px right padding.
  return Math.min(160, Math.max(80, Math.ceil(label.length * 6.4 + 48)));
}

function quantile(values: number[], percentile: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1))]!;
}

function eventAccent(event: VizEvent): number {
  if (event.kind === 'tool') return 0x38bdf8;
  if (event.kind === 'trust') return GPU_COLORS.warning;
  if (event.kind === 'cache') return GPU_COLORS.cyan;
  if (event.kind === 'skill') return event.op === 'quarantine' ? GPU_COLORS.error : GPU_COLORS.magenta;
  if (event.kind === 'registry') return 0xa78bfa;
  return GPU_COLORS.tiers[(event.actor?.tier ?? 1) as 1 | 2 | 3] ?? GPU_COLORS.primary;
}

function detailToneColor(tone: DetailTone): number {
  if (tone === 'success') return GPU_COLORS.success;
  if (tone === 'error') return GPU_COLORS.error;
  if (tone === 'warning') return GPU_COLORS.warning;
  if (tone === 'info') return GPU_COLORS.cyan;
  return GPU_COLORS.muted;
}

const BRANCH_COLORS = [
  0x22d3ee,
  0xe879f9,
  0x4ade80,
  0xfbbf24,
  0x6ea8ff,
  0xfb7185,
  0xa78bfa,
  0x2dd4bf,
] as const;

function timelineBranchColor(branch: TimelineBranch): number {
  return BRANCH_COLORS[branch.colorIndex % BRANCH_COLORS.length]!;
}

function timelineBranchLabel(
  branch: TimelineBranch,
  t: (key: string, vars?: Record<string, unknown>) => string
): string {
  const heading = timelineBranchHeading(branch, t);
  if (heading.title === heading.eyebrow) return heading.eyebrow;
  return `${heading.eyebrow} · ${truncate(heading.title, 28)}`;
}

export function gpuCardShaderMode(event: VizEvent): number {
  if (event.kind === 'llm') return 0;
  if (event.kind === 'tool') return 1;
  if (event.kind === 'trust') return 2;
  if (event.kind === 'skill') return 3;
  if (event.kind === 'cache') return 4;
  if (event.kind === 'registry') return 5;
  return 6;
}

export const CARD_FILTER_GLSL_VERTEX = /* glsl */ `
  in vec2 aPosition;
  out vec2 vTextureCoord;
  uniform vec4 uInputSize;
  uniform vec4 uOutputFrame;
  uniform vec4 uOutputTexture;

  void main() {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y =
      position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) -
      uOutputTexture.z;
    gl_Position = vec4(position, 0.0, 1.0);
    vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
  }
`;

export const CARD_FILTER_GLSL = /* glsl */ `
  in vec2 vTextureCoord;
  out vec4 finalColor;
  uniform sampler2D uTexture;
  uniform float uTime;
  uniform float uMode;
  uniform float uHover;
  uniform float uSelected;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    vec2 uv = vTextureCoord;
    vec4 sampleColor = texture(uTexture, uv);
    float edge = 1.0 - smoothstep(0.0, 0.11, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
    float t = uTime;
    float fx = 0.0;
    vec3 tint = vec3(0.22, 0.55, 1.0);

    if (uMode < 0.5) {
      // LLM: travelling reasoning waves and token bands.
      float wave = sin(uv.x * 28.0 - t * 2.4 + sin(uv.y * 10.0 + t));
      float band = pow(max(0.0, sin((uv.x + uv.y * 0.35) * 42.0 - t * 3.2)), 16.0);
      fx = 0.055 * wave + 0.22 * band + edge * 0.08;
      tint = vec3(0.28, 0.48, 1.0);
    } else if (uMode < 1.5) {
      // Tool: terminal grid, packet scan and deterministic digital noise.
      vec2 gridUv = abs(fract(uv * vec2(36.0, 9.0)) - 0.5);
      float grid = step(gridUv.x, 0.025) + step(gridUv.y, 0.035);
      float packet = pow(max(0.0, sin(uv.x * 70.0 - t * 5.0)), 24.0);
      float noise = hash(floor(uv * 120.0) + floor(t * 8.0));
      fx = grid * 0.07 + packet * 0.24 + (noise - 0.5) * 0.025;
      tint = vec3(0.05, 0.82, 0.96);
    } else if (uMode < 2.5) {
      // Trust: shield-like radial pulse with a stable gold edge.
      vec2 p = uv - 0.5;
      float ring = pow(max(0.0, sin(length(p) * 46.0 - t * 1.8)), 18.0);
      float shield = 1.0 - smoothstep(0.08, 0.5, abs(abs(p.x) + p.y * 0.55 - 0.24));
      fx = ring * 0.16 + shield * 0.08 + edge * 0.11;
      tint = vec3(1.0, 0.68, 0.12);
    } else if (uMode < 3.5) {
      // Skill: magenta plasma, deliberately organic rather than gridded.
      float plasma =
        sin(uv.x * 18.0 + t * 1.9) +
        sin(uv.y * 15.0 - t * 1.5) +
        sin((uv.x + uv.y) * 13.0 + t);
      fx = plasma * 0.035 + edge * 0.09;
      tint = vec3(0.92, 0.22, 0.82);
    } else if (uMode < 4.5) {
      // Cache: crystalline diagonals and a fast replay glint.
      float crystal = pow(max(0.0, sin((uv.x - uv.y) * 58.0 + t * 2.8)), 22.0);
      float replay = pow(max(0.0, sin(uv.x * 22.0 - t * 6.0)), 32.0);
      fx = crystal * 0.12 + replay * 0.28 + edge * 0.07;
      tint = vec3(0.08, 0.9, 0.92);
    } else if (uMode < 5.5) {
      // Registry: violet circuit traces with stable node intersections.
      vec2 circuitUv = abs(fract(uv * vec2(24.0, 8.0)) - 0.5);
      float traces = step(circuitUv.x, 0.028) * step(0.17, circuitUv.y);
      float nodes = step(length(circuitUv), 0.075);
      fx = traces * 0.11 + nodes * (0.16 + 0.08 * sin(t * 2.0)) + edge * 0.08;
      tint = vec3(0.62, 0.35, 1.0);
    } else {
      // Lifecycle/other: restrained state pulse.
      fx = sin((uv.x + uv.y) * 24.0 - t * 1.4) * 0.035 + edge * 0.06;
      tint = vec3(0.45, 0.62, 0.92);
    }

    float intensity = 0.46 + uHover * 0.72 + uSelected * 0.58;
    sampleColor.rgb += tint * fx * intensity * sampleColor.a;
    sampleColor.rgb += tint * edge * (uHover * 0.055 + uSelected * 0.065) * sampleColor.a;
    finalColor = sampleColor;
  }
`;

export const CARD_FILTER_WGSL = /* wgsl */ `
  struct GlobalFilterUniforms {
    uInputSize: vec4<f32>,
    uInputPixel: vec4<f32>,
    uInputClamp: vec4<f32>,
    uOutputFrame: vec4<f32>,
    uGlobalFrame: vec4<f32>,
    uOutputTexture: vec4<f32>,
  };

  struct CardUniforms {
    uTime: f32,
    uMode: f32,
    uHover: f32,
    uSelected: f32,
  };

  @group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
  @group(0) @binding(1) var uTexture: texture_2d<f32>;
  @group(0) @binding(2) var uSampler: sampler;
  @group(1) @binding(0) var<uniform> cardUniforms: CardUniforms;

  struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
  };

  fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
    var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
    position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
  }

  fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
    return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
  }

  @vertex
  fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
    return VSOutput(filterVertexPosition(aPosition), filterTextureCoord(aPosition));
  }

  fn hash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  @fragment
  fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    var sampleColor = textureSample(uTexture, uSampler, uv);
    let edgeDistance = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    let edge = 1.0 - smoothstep(0.0, 0.11, edgeDistance);
    let t = cardUniforms.uTime;
    var fx = 0.0;
    var tint = vec3(0.22, 0.55, 1.0);

    if (cardUniforms.uMode < 0.5) {
      let wave = sin(uv.x * 28.0 - t * 2.4 + sin(uv.y * 10.0 + t));
      let band = pow(max(0.0, sin((uv.x + uv.y * 0.35) * 42.0 - t * 3.2)), 16.0);
      fx = 0.055 * wave + 0.22 * band + edge * 0.08;
      tint = vec3(0.28, 0.48, 1.0);
    } else if (cardUniforms.uMode < 1.5) {
      let gridUv = abs(fract(uv * vec2(36.0, 9.0)) - vec2(0.5));
      let grid = select(0.0, 1.0, gridUv.x <= 0.025) + select(0.0, 1.0, gridUv.y <= 0.035);
      let packet = pow(max(0.0, sin(uv.x * 70.0 - t * 5.0)), 24.0);
      let digitalNoise = hash(floor(uv * 120.0) + floor(vec2(t * 8.0)));
      fx = grid * 0.07 + packet * 0.24 + (digitalNoise - 0.5) * 0.025;
      tint = vec3(0.05, 0.82, 0.96);
    } else if (cardUniforms.uMode < 2.5) {
      let p = uv - vec2(0.5);
      let ring = pow(max(0.0, sin(length(p) * 46.0 - t * 1.8)), 18.0);
      let shield = 1.0 - smoothstep(0.08, 0.5, abs(abs(p.x) + p.y * 0.55 - 0.24));
      fx = ring * 0.16 + shield * 0.08 + edge * 0.11;
      tint = vec3(1.0, 0.68, 0.12);
    } else if (cardUniforms.uMode < 3.5) {
      let plasma =
        sin(uv.x * 18.0 + t * 1.9) +
        sin(uv.y * 15.0 - t * 1.5) +
        sin((uv.x + uv.y) * 13.0 + t);
      fx = plasma * 0.035 + edge * 0.09;
      tint = vec3(0.92, 0.22, 0.82);
    } else if (cardUniforms.uMode < 4.5) {
      let crystal = pow(max(0.0, sin((uv.x - uv.y) * 58.0 + t * 2.8)), 22.0);
      let replay = pow(max(0.0, sin(uv.x * 22.0 - t * 6.0)), 32.0);
      fx = crystal * 0.12 + replay * 0.28 + edge * 0.07;
      tint = vec3(0.08, 0.9, 0.92);
    } else if (cardUniforms.uMode < 5.5) {
      let circuitUv = abs(fract(uv * vec2(24.0, 8.0)) - vec2(0.5));
      let traces = select(0.0, 1.0, circuitUv.x <= 0.028) * select(0.0, 1.0, circuitUv.y >= 0.17);
      let nodes = select(0.0, 1.0, length(circuitUv) <= 0.075);
      fx = traces * 0.11 + nodes * (0.16 + 0.08 * sin(t * 2.0)) + edge * 0.08;
      tint = vec3(0.62, 0.35, 1.0);
    } else {
      fx = sin((uv.x + uv.y) * 24.0 - t * 1.4) * 0.035 + edge * 0.06;
      tint = vec3(0.45, 0.62, 0.92);
    }

    let intensity = 0.46 + cardUniforms.uHover * 0.72 + cardUniforms.uSelected * 0.58;
    sampleColor.r += tint.r * fx * intensity * sampleColor.a;
    sampleColor.g += tint.g * fx * intensity * sampleColor.a;
    sampleColor.b += tint.b * fx * intensity * sampleColor.a;
    sampleColor.r += tint.r * edge * (cardUniforms.uHover * 0.055 + cardUniforms.uSelected * 0.065) * sampleColor.a;
    sampleColor.g += tint.g * edge * (cardUniforms.uHover * 0.055 + cardUniforms.uSelected * 0.065) * sampleColor.a;
    sampleColor.b += tint.b * edge * (cardUniforms.uHover * 0.055 + cardUniforms.uSelected * 0.065) * sampleColor.a;
    return sampleColor;
  }
`;

function eventDecision(event: VizEvent): string {
  if (event.kind !== 'llm') return '';
  const parsed = tryParseJson(event.response) as Record<string, unknown> | undefined;
  if (!parsed || Array.isArray(parsed)) return '';
  if (event.role === 'prefilter') {
    const target = scalar(parsed['target'], 'reuse');
    const isSkillPrefilter = event.systemPrompt?.includes(
      'You match a subtask against a catalog of learned skills'
    );
    const childTier =
      !isSkillPrefilter && (event.actor?.tier === 2 || event.actor?.tier === 3)
        ? event.actor.tier - 1
        : undefined;
    return parsed['outcome'] === 'reuse'
      ? `→ ${currentDisplayName(childTier, target) ?? target}`
      : parsed['outcome'] === 'escalate'
        ? '↑ escalate'
        : '';
  }
  if (event.role === 'validate-plan' || event.role === 'validate-result') {
    return parsed['approved'] === true ? '✓ approved' : parsed['approved'] === false ? '✕ rejected' : '';
  }
  return '';
}

export interface GpuEventCardCopy {
  title: string;
  meta: string;
  body: string;
  footer: string;
  decision: string;
}

function resultFacts(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
  const value = result as Record<string, unknown>;
  const facts = [
    typeof value['ok'] === 'boolean' ? `ok=${value['ok']}` : '',
    typeof value['exitCode'] === 'number' ? `exit=${value['exitCode']}` : '',
    typeof value['status'] === 'number' ? `status=${value['status']}` : '',
    value['recorded'] === true ? 'recorded' : '',
  ];
  return facts.filter(Boolean).join(' · ');
}

export function gpuEventCardCopy(event: VizEvent): GpuEventCardCopy {
  const toolElement = event.kind === 'tool' && event.name
    ? elementForTool(event.name)
    : undefined;
  const title =
    event.kind === 'llm'
      ? event.role ?? 'llm'
      : event.kind === 'tool'
        ? toolElement
          ? `${toolElement.symbol} · ${event.name}`
          : event.name ?? 'tool'
        : event.kind === 'skill'
          ? event.op ?? 'skill'
          : `${event.kind}${event.op ? ` · ${event.op}` : ''}`;
  const meta = [
    event.actor?.name ? `L${event.actor.tier ?? '?'} ${event.actor.name}` : '',
    event.child?.name ? `→ ${event.child.name}` : '',
    event.subject ?? '',
    event.branchId ? `⑂ ${event.branchId.slice(0, 6)}` : '',
  ].filter(Boolean).join(' · ');
  let body = event.error ?? event.reasoning ?? '';
  if (event.kind === 'tool' && !event.error) {
    body = [toolArgSummary(event.args), resultFacts(event.result)].filter(Boolean).join(' · ');
  } else if (event.kind === 'cache') {
    body = [scalar(event.outcome), event.reasoning].filter(Boolean).join(' · ');
  } else if (event.kind === 'registry' && !body) {
    body = [
      event.snapshot?.name ?? event.name,
      event.snapshot?.description,
    ].filter(Boolean).join(' · ');
  }
  const time = Number.isFinite(event.ts)
    ? new Date(event.ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    : '';
  const footer =
    event.kind === 'llm'
      ? [event.model, fmtMs(event.durationMs), fmtCost(event.costUsd), time].filter(Boolean).join(' · ')
      : event.kind === 'tool'
        ? [fmtMs(event.durationMs), time].filter(Boolean).join(' · ')
        : event.kind === 'trust'
          ? [`✓${scalar(event['successes'], '0')}/✗${scalar(event['failures'], '0')}`, time].filter(Boolean).join(' · ')
          : event.kind === 'skill'
            ? [`${event.l1Name ?? '?'}/${event.skillId ?? '?'}`, time].filter(Boolean).join(' · ')
            : event.kind === 'registry'
              ? [`v${event.snapshot?.version ?? scalar(event.version, '?')}`, time].filter(Boolean).join(' · ')
              : [event.model, time].filter(Boolean).join(' · ');
  return { title, meta, body, footer, decision: eventDecision(event) };
}

function nowDescription(
  t: GpuRenderSnapshot['t'],
  event: VizEvent
): string {
  const vars = { actor: event.actor?.name ?? '?', child: event.child?.name ?? '?' };
  switch (event.role) {
    case 'plan':
      return t('now.doing.plan', vars);
    case 'execute':
      return t('now.doing.execute', vars);
    case 'prefilter':
      return t('now.doing.prefilter', vars);
    case 'validate-plan':
      return t('now.doing.validatePlan', vars);
    case 'validate-result':
      return t('now.doing.validateResult', vars);
    case 'fallback-plan':
    case 'fallback-execute':
      return t('now.doing.fallback', vars);
    case 'skill':
      return t('now.doing.skill', vars);
    default:
      return t('now.doing.unknown', vars);
  }
}

export class GpuRenderer {
  app = new Application();
  readonly root = new Container();
  private host: HTMLElement | null = null;
  private initialized = false;
  private snapshot: GpuRenderSnapshot | null = null;
  private readonly scrollMax: Partial<Record<ViewName, number>> = {};
  private readonly tickerCallbacks = new Set<(ticker: Ticker) => void>();
  private readonly frameFilters = new Set<Filter>();
  private previousFilterBounds = new Map<string, FilterVisualTarget>();
  private currentFilterBounds = new Map<string, FilterVisualTarget>();
  private handledExitIds = new Set<string>();
  private roleRowTransition: {
    phase: 'exit' | 'enter';
    targets: FilterVisualTarget[];
    distance: number;
    startedAt: number;
  } | null = null;
  private readonly seenAnimatedControls = new Set<string>();
  private previousView: ViewName | null = null;
  private activeViewTransition: {
    from: ViewName;
    to: ViewName;
    startedAt: number;
  } | null = null;
  private previousEventIds = new Set<string>();
  private currentEventIds = new Set<string>();
  private runPickerBounds: Rectangle | null = null;
  private runPickerScrollMax = 0;
  private detailBounds: Rectangle | null = null;
  private detailScrollY = 0;
  private detailScrollMax = 0;
  private detailKey: string | null = null;
  private metrics: GpuRenderMetrics = {
    backend: 'unknown',
    objectCount: 0,
    runCollapseOffset: 0,
    visibleLabels: [],
    hitTargets: [],
  };
  private readonly wheel = (event: WheelEvent) => {
    if (!this.snapshot) return;
    event.preventDefault();
    if (
      this.snapshot.state.focusedInput === 'run' &&
      this.runPickerBounds
    ) {
      const bounds = this.app.canvas.getBoundingClientRect();
      const localX =
        (event.clientX - bounds.left) * this.app.screen.width / Math.max(1, bounds.width);
      const localY =
        (event.clientY - bounds.top) * this.app.screen.height / Math.max(1, bounds.height);
      if (this.runPickerBounds.contains(localX, localY)) {
        const current = this.snapshot.state.runPickerScrollY;
        const next = Math.max(
          0,
          Math.min(this.runPickerScrollMax, current + event.deltaY)
        );
        this.snapshot.onRunPickerScroll(next - current);
        return;
      }
    }
    if (this.snapshot.state.view === 'runs' && this.detailBounds) {
      const bounds = this.app.canvas.getBoundingClientRect();
      const localX =
        (event.clientX - bounds.left) * this.app.screen.width / Math.max(1, bounds.width);
      const localY =
        (event.clientY - bounds.top) * this.app.screen.height / Math.max(1, bounds.height);
      if (this.detailBounds.contains(localX, localY)) {
        const next = Math.max(
          0,
          Math.min(this.detailScrollMax, this.detailScrollY + event.deltaY)
        );
        if (next !== this.detailScrollY) {
          this.detailScrollY = next;
          this.render(this.snapshot);
        }
        return;
      }
    }
    const view = this.snapshot.state.view;
    const current = this.snapshot.state.scrollY[view];
    const maximum = this.scrollMax[view] ?? Number.POSITIVE_INFINITY;
    const next = Math.max(0, Math.min(maximum, current + event.deltaY));
    this.snapshot.onScroll(view, next - current);
  };

  async init(host: HTMLElement) {
    this.host = host;
    const forceWebGl = new URLSearchParams(location.search).get('renderer') === 'webgl';
    try {
      await this.app.init({
        resizeTo: host,
        preference: forceWebGl ? ['webgl'] : ['webgpu', 'webgl'],
        antialias: true,
        autoDensity: true,
        resolution: Math.min(devicePixelRatio || 1, 2),
        backgroundAlpha: 0,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      console.warn('[viz:gpu] WebGPU init failed; retrying WebGL', error);
      this.app.destroy();
      this.app = new Application();
      await this.app.init({
        resizeTo: host,
        preference: ['webgl'],
        antialias: true,
        autoDensity: true,
        resolution: Math.min(devicePixelRatio || 1, 2),
        backgroundAlpha: 0,
      });
    }
    const rendererType = Number(this.app.renderer.type);
    this.metrics.backend =
      rendererType === Number(RendererType.WEBGPU)
        ? 'webgpu'
        : rendererType === Number(RendererType.WEBGL)
          ? 'webgl'
          : 'unknown';
    this.app.stage.addChild(this.root);
    this.app.canvas.className = 'gpu-ui-canvas';
    this.app.canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(this.app.canvas);
    this.app.canvas.addEventListener('wheel', this.wheel, { passive: false });
    this.initialized = true;
  }

  destroy() {
    if (!this.initialized) return;
    for (const filter of this.frameFilters) filter.destroy();
    this.frameFilters.clear();
    this.app.canvas.removeEventListener('wheel', this.wheel);
    this.app.destroy(true, { children: true });
    this.initialized = false;
    this.host = null;
  }

  getMetrics() {
    return this.metrics;
  }

  render(snapshot: GpuRenderSnapshot) {
    this.snapshot = snapshot;
    for (const callback of this.tickerCallbacks) this.app.ticker.remove(callback);
    this.tickerCallbacks.clear();
    for (const filter of this.frameFilters) filter.destroy();
    this.frameFilters.clear();
    for (const child of this.root.removeChildren()) child.destroy({ children: true });
    this.metrics.visibleLabels = [];
    this.metrics.hitTargets = [];
    this.metrics.runCollapseOffset = 0;
    delete this.metrics.timelineViewport;
    this.currentFilterBounds = new Map();
    this.handledExitIds = new Set();
    this.currentEventIds = new Set();
    this.runPickerBounds = null;
    this.runPickerScrollMax = 0;
    const nextDetailKey =
      snapshot.state.view === 'runs'
        ? snapshot.state.selectedEventId
          ? `event:${snapshot.state.selectedEventId}`
          : snapshot.state.selectedAtomName
            ? `agent:${snapshot.state.selectedAtomName}`
            : null
        : null;
    if (nextDetailKey !== this.detailKey) this.detailScrollY = 0;
    this.detailKey = nextDetailKey;
    this.detailBounds = null;
    this.detailScrollMax = 0;
    this.scrollMax.runs = 0;

    const hostWidth = this.host?.clientWidth ?? this.app.screen.width;
    const hostHeight = this.host?.clientHeight ?? this.app.screen.height;
    if (
      Math.abs(this.app.screen.width - hostWidth) > 1 ||
      Math.abs(this.app.screen.height - hostHeight) > 1
    ) {
      this.app.renderer.resize(hostWidth, hostHeight);
    }
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    this.drawAmbientGrid(width, height);
    this.drawHeader(snapshot, width);

    if (snapshot.data.loading) {
      this.text(this.root, snapshot.t('common.loading'), 24, 84, { size: 16 });
    } else if (snapshot.data.error) {
      this.text(this.root, snapshot.data.error, 24, 84, {
        size: 14,
        color: GPU_COLORS.error,
        width: width - 48,
      });
    } else {
      switch (snapshot.state.view) {
        case 'runs':
          this.drawRuns(snapshot, width, height);
          break;
        case 'registry':
          this.drawRegistry(snapshot, width, height);
          break;
        case 'skills':
          this.drawSkills(snapshot, width, height);
          break;
        case 'burnin':
          this.drawBurnin(snapshot, width, height);
          break;
        case 'launch':
          this.drawLaunch(snapshot, width, height);
          break;
      }
    }
    this.drawOverlays(snapshot, width, height);
    this.drawRemovedFilterEffects();
    if (this.previousView && this.previousView !== snapshot.state.view) {
      this.activeViewTransition = {
        from: this.previousView,
        to: snapshot.state.view,
        startedAt: performance.now(),
      };
    }
    this.previousView = snapshot.state.view;
    this.drawViewTransition(width, height);
    this.previousFilterBounds = this.currentFilterBounds;
    if (snapshot.state.view !== 'runs') this.roleRowTransition = null;
    this.previousEventIds = this.currentEventIds;
    this.metrics.objectCount = this.countObjects(this.root);
  }

  private countObjects(container: Container): number {
    let count = 1;
    for (const child of container.children) {
      count += child instanceof Container ? this.countObjects(child) : 1;
    }
    return count;
  }

  private drawAmbientGrid(width: number, height: number) {
    const graphics = new Graphics();
    graphics.alpha = 0.18;
    for (let x = 0; x < width; x += 48) {
      graphics.moveTo(x, GPU_LAYOUT.headerHeight).lineTo(x, height);
    }
    for (let y = GPU_LAYOUT.headerHeight; y < height; y += 48) {
      graphics.moveTo(0, y).lineTo(width, y);
    }
    graphics.stroke({ color: 0x26334a, width: 1, alpha: 0.25 });
    this.root.addChild(graphics);
  }

  private panel(
    parent: Container,
    x: number,
    y: number,
    width: number,
    height: number,
    fill: number = GPU_COLORS.panel,
    border: number = GPU_COLORS.border,
    radius: number = GPU_LAYOUT.radius
  ) {
    const graphics = new Graphics();
    graphics.roundRect(x, y, Math.max(0, width), Math.max(0, height), radius);
    graphics.fill({ color: fill, alpha: 0.84 });
    if (border !== fill) graphics.stroke({ color: border, width: 1, alpha: 0.9 });
    graphics.eventMode = 'none';
    parent.addChild(graphics);
    return graphics;
  }

  private filterBlockFrame(
    parent: Container,
    block: Pick<FilterBlockLayout, 'x' | 'y' | 'width' | 'height'>
  ) {
    const graphics = new Graphics();
    graphics.roundRect(block.x, block.y, block.width, block.height, 10);
    graphics.stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.72 });
    graphics.eventMode = 'none';
    parent.addChild(graphics);
    return graphics;
  }

  private collapseCaret(
    parent: Container,
    right: number,
    top: number,
    expanded: boolean,
    color: number
  ) {
    const size = 12;
    const graphics = new Graphics();
    if (expanded) {
      graphics.poly([0, 2, size, 2, size / 2, size]);
    } else {
      graphics.poly([2, 0, size, size / 2, 2, size]);
    }
    graphics.fill({ color, alpha: 0.95 });
    graphics.eventMode = 'none';
    graphics.position.set(right - size, top);
    parent.addChild(graphics);
    return graphics;
  }

  private text(parent: Container, value: string, x: number, y: number, options: TextOptions = {}) {
    const label = new Text({
      text: value,
      style: new TextStyle({
        fill: options.color ?? GPU_COLORS.text,
        fontFamily: options.mono
          ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
          : '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
        fontSize: options.size ?? 12,
        fontWeight: options.weight ?? '400',
        wordWrap: options.width !== undefined,
        wordWrapWidth: options.width ?? 0,
        breakWords: true,
        lineHeight: (options.size ?? 12) * 1.35,
      }),
    });
    label.position.set(x, y);
    label.alpha = options.alpha ?? 1;
    label.eventMode = 'none';
    parent.addChild(label);
    this.metrics.visibleLabels.push(value);
    return label;
  }

  private button(
    parent: Container,
    id: string,
    role: string,
    label: string,
    x: number,
    y: number,
    width: number,
    height: number,
    active: boolean,
    onActivate: (id: string) => void,
    accent: number = GPU_COLORS.primary,
    centerLabel = false
  ) {
    const container = new Container();
    container.position.set(x, y);
    const graphics = new Graphics();
    graphics.roundRect(0, 0, width, height, 7);
    graphics.fill({
      color: active ? accent : GPU_COLORS.panelRaised,
      alpha: active ? 0.28 : 0.82,
    });
    graphics.stroke({ color: active ? accent : GPU_COLORS.border, width: active ? 1.5 : 1 });
    container.addChild(graphics);
    const labelText = this.text(
      container,
      truncate(label, Math.max(1, Math.floor((width - 16) / 6.2))),
      centerLabel ? width / 2 : 10,
      Math.max(5, (height - 16) / 2),
      {
        size: 11,
        color: active ? GPU_COLORS.text : GPU_COLORS.muted,
        weight: active ? '700' : '600',
      }
    );
    if (centerLabel) labelText.anchor.x = 0.5;
    labelText.eventMode = 'none';
    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.hitArea = new Rectangle(0, 0, width, height);
    container.on('pointertap', () => onActivate(id));
    container.on('pointerover', () => {
      graphics.tint = 0xbfd6ff;
    });
    container.on('pointerout', () => {
      graphics.tint = 0xffffff;
    });
    parent.addChild(container);
    this.metrics.hitTargets.push({ id, role, label, x, y, width, height });
    return container;
  }

  private addTicker(callback: (ticker: Ticker) => void) {
    this.tickerCallbacks.add(callback);
    this.app.ticker.add(callback);
  }

  private filterButton(
    parent: Container,
    id: string,
    label: string,
    x: number,
    y: number,
    width: number,
    height: number,
    active: boolean,
    onActivate: (id: string) => void,
    accent = GPU_COLORS.primary
  ) {
    const target: FilterVisualTarget = {
      id,
      role: 'button',
      label,
      x,
      y,
      width,
      height,
      active,
      accent,
    };
    const wasVisible = this.previousFilterBounds.has(id);
    const appearanceDelay = this.currentFilterBounds.size * 14;
    this.currentFilterBounds.set(id, target);
    this.metrics.hitTargets.push(target);

    const container = new Container();
    container.position.set(x, y);
    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.hitArea = new Rectangle(0, 0, width, height);

    const aura = new Graphics();
    aura.roundRect(-3, -3, width + 6, height + 6, 10);
    aura.stroke({ color: accent, width: 2.5, alpha: 0.8 });
    aura.alpha = active ? 0.32 : 0;
    container.addChild(aura);

    const base = new Graphics();
    base.roundRect(0, 0, width, height, 8);
    base.fill({
      color: active ? accent : 0x111b2c,
      alpha: active ? 0.27 : 0.9,
    });
    base.stroke({
      color: active ? accent : 0x30405d,
      width: active ? 1.8 : 1,
      alpha: active ? 1 : 0.85,
    });
    container.addChild(base);

    const inner = new Graphics();
    inner.roundRect(3, 3, width - 6, height - 6, 6);
    inner.stroke({ color: active ? 0xd9e8ff : 0x6f86ad, width: 0.7, alpha: active ? 0.35 : 0.12 });
    container.addChild(inner);

    const scanline = new Graphics();
    scanline.rect(0, 3, 2, height - 6).fill({ color: 0xffffff, alpha: 0.7 });
    scanline.alpha = active ? 0.15 : 0.035;
    container.addChild(scanline);

    const corner = new Graphics();
    corner
      .moveTo(4, 9)
      .lineTo(4, 4)
      .lineTo(9, 4)
      .moveTo(width - 9, height - 4)
      .lineTo(width - 4, height - 4)
      .lineTo(width - 4, height - 9)
      .stroke({ color: accent, width: 1.2, alpha: active ? 0.9 : 0.25 });
    container.addChild(corner);

    const sparkles = Array.from({ length: 4 }, (_, index) => {
      const sparkle = new Graphics();
      sparkle.circle(0, 0, index % 2 === 0 ? 1.4 : 1).fill({
        color: index % 2 === 0 ? accent : 0xffffff,
      });
      sparkle.alpha = active ? 0.55 : 0;
      container.addChild(sparkle);
      return sparkle;
    });

    const labelText = this.text(container, label, width / 2, Math.max(5, (height - 16) / 2), {
      size: 11,
      color: active ? GPU_COLORS.text : 0xa9b5ca,
      weight: active ? '700' : '600',
    });
    labelText.anchor.x = 0.5;
    labelText.eventMode = 'none';

    let hovered = false;
    let pressed = false;
    let elapsed = wasVisible ? performance.now() : -appearanceDelay;
    let currentLabelColor = active ? GPU_COLORS.text : 0xa9b5ca;
    container.alpha = wasVisible ? 1 : 0;
    const animate = (ticker: Ticker) => {
      elapsed += ticker.deltaMS;
      const entrance = Math.max(0, Math.min(1, elapsed / 260));
      const easedEntrance = 1 - (1 - entrance) ** 3;
      const targetScale = pressed ? 0.955 : hovered ? 1.035 : 1;
      const scale = easedEntrance * targetScale;
      container.alpha = easedEntrance;
      container.scale.set(scale);
      container.position.set(
        x + width * (1 - scale) / 2,
        y + height * (1 - scale) / 2 + (pressed ? 1.5 : 0)
      );
      const pulse = 0.5 + 0.5 * Math.sin(elapsed / 170);
      aura.alpha = active
        ? 0.2 + pulse * 0.22
        : hovered
          ? 0.12 + pulse * 0.16
          : 0;
      scanline.x = 4 + (Math.max(0, elapsed) * (hovered ? 0.12 : 0.045)) % Math.max(8, width - 10);
      scanline.alpha = active ? 0.12 + pulse * 0.12 : hovered ? 0.08 + pulse * 0.1 : 0.025;
      base.tint = pressed ? 0xb8d7ff : hovered ? 0xd6e7ff : 0xffffff;
      const nextLabelColor = pressed || hovered || active ? GPU_COLORS.text : 0xa9b5ca;
      if (nextLabelColor !== currentLabelColor) {
        currentLabelColor = nextLabelColor;
        labelText.style.fill = nextLabelColor;
      }
      sparkles.forEach((sparkle, index) => {
        const phase = elapsed / 430 + index * Math.PI / 2;
        sparkle.position.set(
          width / 2 + Math.cos(phase) * (width / 2 - 8),
          height / 2 + Math.sin(phase * 1.35) * (height / 2 - 5)
        );
        sparkle.alpha = active
          ? 0.28 + pulse * 0.42
          : hovered
            ? 0.18 + pulse * 0.35
            : 0;
      });
    };
    this.addTicker(animate);

    container.on('pointerover', () => {
      hovered = true;
    });
    container.on('pointerout', () => {
      hovered = false;
      pressed = false;
    });
    container.on('pointerdown', () => {
      pressed = true;
    });
    container.on('pointerup', () => {
      pressed = false;
    });
    container.on('pointerupoutside', () => {
      pressed = false;
    });
    container.on('pointertap', () => onActivate(id));
    parent.addChild(container);
    return container;
  }

  private navButton(
    parent: Container,
    id: string,
    label: string,
    x: number,
    y: number,
    width: number,
    height: number,
    active: boolean,
    onActivate: (id: string) => void
  ) {
    const firstAppearance = !this.seenAnimatedControls.has(id);
    this.seenAnimatedControls.add(id);
    const container = new Container();
    container.position.set(x, y);
    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.hitArea = new Rectangle(0, 0, width, height);

    const glow = new Graphics();
    glow.roundRect(-4, -3, width + 8, height + 6, 11);
    glow.stroke({ color: GPU_COLORS.primary, width: 2.5, alpha: 0.85 });
    glow.alpha = active ? 0.28 : 0;
    container.addChild(glow);

    const base = new Graphics();
    base.roundRect(0, 0, width, height, 8);
    base.fill({ color: active ? 0x183259 : 0x111b2c, alpha: 0.9 });
    base.stroke({
      color: active ? GPU_COLORS.primary : 0x2d3d59,
      width: active ? 1.6 : 1,
    });
    container.addChild(base);

    const scanline = new Graphics();
    scanline.rect(0, 3, 2, height - 6).fill({ color: 0xffffff, alpha: 0.7 });
    scanline.alpha = active ? 0.12 : 0.025;
    container.addChild(scanline);

    const underline = new Graphics();
    underline.roundRect(0, 0, Math.max(12, width - 18), 2.2, 1.1);
    underline.fill(GPU_COLORS.primary);
    underline.position.set(9, height - 4);
    underline.alpha = active ? 0.9 : 0;
    container.addChild(underline);

    const labelText = this.text(container, label, width / 2, Math.max(5, (height - 16) / 2), {
      size: 11,
      color: active ? GPU_COLORS.text : 0xa9b5ca,
      weight: active ? '700' : '600',
    });
    labelText.anchor.x = 0.5;

    const sparks = Array.from({ length: 3 }, (_, index) => {
      const spark = new Graphics();
      spark.circle(0, 0, 1.2 - index * 0.18).fill(index === 1 ? 0xffffff : GPU_COLORS.primary);
      spark.alpha = active ? 0.5 : 0;
      container.addChild(spark);
      return spark;
    });

    let hovered = false;
    let pressed = false;
    let elapsed = firstAppearance ? -Math.max(0, x - 112) * 0.35 : performance.now();
    container.alpha = firstAppearance ? 0 : 1;
    let currentLabelColor = active ? GPU_COLORS.text : 0xa9b5ca;
    const animate = (ticker: Ticker) => {
      elapsed += ticker.deltaMS;
      const entrance = Math.max(0, Math.min(1, elapsed / 280));
      const easedEntrance = 1 - (1 - entrance) ** 3;
      const targetScale = pressed ? 0.95 : hovered ? 1.045 : 1;
      const scale = easedEntrance * targetScale;
      container.alpha = easedEntrance;
      container.scale.set(scale);
      container.position.set(
        x + width * (1 - scale) / 2,
        y + height * (1 - scale) / 2 + (pressed ? 1.5 : hovered ? -1 : 0)
      );
      const pulse = 0.5 + Math.sin(elapsed / 155) * 0.5;
      glow.alpha = active
        ? 0.18 + pulse * 0.22
        : hovered
          ? 0.1 + pulse * 0.18
          : 0;
      scanline.x = 4 + (Math.max(0, elapsed) * (hovered ? 0.16 : 0.05)) % Math.max(8, width - 10);
      scanline.alpha = active ? 0.11 + pulse * 0.08 : hovered ? 0.09 : 0.02;
      // The selected tab's rail is a stable positional anchor. Surrounding
      // glow/sparks can move, but the bar itself must not breathe or drift.
      underline.alpha = active ? 0.95 : hovered ? 0.42 : 0;
      underline.scale.x = active ? 1 : hovered ? 0.65 + pulse * 0.15 : 0.2;
      base.tint = pressed ? 0xafd1ff : hovered ? 0xd7e8ff : 0xffffff;
      const nextLabelColor = pressed || hovered || active ? GPU_COLORS.text : 0xa9b5ca;
      if (nextLabelColor !== currentLabelColor) {
        currentLabelColor = nextLabelColor;
        labelText.style.fill = nextLabelColor;
      }
      sparks.forEach((spark, index) => {
        const phase = elapsed / 350 + index * 2.1;
        spark.position.set(10 + (Math.sin(phase) * 0.5 + 0.5) * (width - 20), height - 3 - Math.abs(Math.cos(phase)) * 4);
        spark.alpha = active ? 0.25 + pulse * 0.5 : hovered ? 0.18 + pulse * 0.3 : 0;
      });
    };
    this.addTicker(animate);

    container.on('pointerover', () => { hovered = true; });
    container.on('pointerout', () => {
      hovered = false;
      pressed = false;
    });
    container.on('pointerdown', () => { pressed = true; });
    container.on('pointerup', () => { pressed = false; });
    container.on('pointerupoutside', () => { pressed = false; });
    container.on('pointertap', () => onActivate(id));
    parent.addChild(container);
    this.metrics.hitTargets.push({ id, role: 'tab', label, x, y, width, height });
    return container;
  }

  private statCard(
    parent: Container,
    id: string,
    label: string,
    value: string,
    x: number,
    y: number,
    width: number,
    height: number,
    accent: number
  ) {
    const firstAppearance = !this.seenAnimatedControls.has(id);
    this.seenAnimatedControls.add(id);
    const container = new Container();
    container.position.set(x, y);

    const glow = new Graphics();
    glow.roundRect(-2, -2, width + 4, height + 4, 10);
    glow.stroke({ color: accent, width: 1.8, alpha: 0.7 });
    glow.alpha = 0.12;
    container.addChild(glow);

    const base = new Graphics();
    base.roundRect(0, 0, width, height, 8);
    base.fill({ color: 0x111a2b, alpha: 0.92 });
    base.stroke({ color: 0x293956, width: 1, alpha: 0.88 });
    container.addChild(base);

    const topRail = new Graphics();
    topRail.roundRect(8, 0, width - 16, 1.6, 0.8).fill(accent);
    topRail.alpha = 0.48;
    container.addChild(topRail);

    const scanline = new Graphics();
    scanline.rect(5, 0, width - 10, 1).fill({ color: accent, alpha: 0.55 });
    scanline.alpha = 0.05;
    container.addChild(scanline);

    const labelText = this.text(container, label, 10, 7, {
      size: 9,
      color: GPU_COLORS.muted,
      weight: '500',
    });
    const valueText = this.text(container, value, 10, 25, {
      size: 14,
      color: GPU_COLORS.text,
      weight: '700',
    });

    const telemetry = Array.from({ length: 9 }, (_, index) => {
      const bar = new Graphics();
      bar.roundRect(0, 0, 2.2, 4, 1).fill(accent);
      bar.position.set(width - 38 + index * 3.5, height - 8);
      bar.alpha = 0.22;
      container.addChild(bar);
      return bar;
    });

    let elapsed = firstAppearance ? -Number(id.replace(/\D/g, '').slice(-1) || 0) * 35 : performance.now();
    container.alpha = firstAppearance ? 0 : 1;
    const animate = (ticker: Ticker) => {
      elapsed += ticker.deltaMS;
      const entrance = Math.max(0, Math.min(1, elapsed / 320));
      const eased = 1 - (1 - entrance) ** 3;
      container.alpha = eased;
      container.position.y = y + (1 - eased) * 7;
      const pulse = 0.5 + Math.sin(elapsed / 330) * 0.5;
      glow.alpha = 0.06 + pulse * 0.11;
      topRail.alpha = 0.34 + pulse * 0.28;
      scanline.y = 4 + (Math.max(0, elapsed) * 0.025) % Math.max(8, height - 8);
      scanline.alpha = 0.025 + pulse * 0.045;
      valueText.alpha = 0.9 + pulse * 0.1;
      labelText.alpha = 0.72 + pulse * 0.18;
      telemetry.forEach((bar, index) => {
        const level = 2 + (Math.sin(elapsed / 210 + index * 1.37) * 0.5 + 0.5) * 7;
        bar.height = level;
        bar.y = height - 5 - level;
        bar.alpha = 0.13 + level / 12;
      });
    };
    this.addTicker(animate);
    parent.addChild(container);
    return container;
  }

  private atomButton(
    parent: Container,
    id: string,
    label: string,
    tier: 1 | 2 | 3,
    x: number,
    y: number,
    width: number,
    height: number,
    active: boolean,
    onActivate: (id: string) => void
  ) {
    const accent = GPU_COLORS.tiers[tier];
    const particleCenterX = 16;
    const firstAppearance = !this.seenAnimatedControls.has(id);
    this.seenAnimatedControls.add(id);
    const container = new Container();
    container.position.set(x, y);
    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.hitArea = new Rectangle(0, 0, width, height);

    const aura = new Graphics();
    aura.roundRect(-3, -3, width + 6, height + 6, 10);
    aura.stroke({ color: accent, width: 2, alpha: 0.75 });
    aura.alpha = active ? 0.28 : 0;
    container.addChild(aura);

    const base = new Graphics();
    base.roundRect(0, 0, width, height, 8);
    base.fill({ color: active ? accent : 0x121c2d, alpha: active ? 0.22 : 0.9 });
    base.stroke({ color: active ? accent : 0x30405d, width: active ? 1.5 : 1 });
    container.addChild(base);

    const nucleus = new Graphics();
    nucleus.circle(particleCenterX, height / 2, active ? 3 : 2.3).fill(accent);
    nucleus.alpha = active ? 0.95 : 0.5;
    container.addChild(nucleus);

    const orbit = new Graphics();
    orbit
      .ellipse(0, 0, 7, 4)
      .stroke({ color: accent, width: 0.8, alpha: 0.35 });
    orbit.position.set(particleCenterX, height / 2);
    container.addChild(orbit);

    const electrons = Array.from({ length: tier }, (_, index) => {
      const electron = new Graphics();
      electron.circle(0, 0, 1.1).fill(index % 2 ? 0xffffff : accent);
      electron.alpha = active ? 0.7 : 0;
      container.addChild(electron);
      return electron;
    });

    this.text(
      container,
      truncate(label, Math.max(1, Math.floor((width - 44) / 6.2))),
      34,
      Math.max(5, (height - 16) / 2),
      {
        size: 10,
        color: active ? GPU_COLORS.text : 0xa9b5ca,
        weight: active ? '700' : '600',
      }
    );

    let hovered = false;
    let pressed = false;
    let elapsed = firstAppearance ? -(x % 120) * 1.2 : performance.now();
    container.alpha = firstAppearance ? 0 : 1;
    const animate = (ticker: Ticker) => {
      elapsed += ticker.deltaMS;
      const entrance = Math.max(0, Math.min(1, elapsed / 300));
      const eased = 1 - (1 - entrance) ** 3;
      const targetScale = pressed ? 0.95 : hovered ? 1.04 : 1;
      const scale = eased * targetScale;
      container.alpha = eased;
      container.scale.set(scale);
      container.position.set(
        x + width * (1 - scale) / 2,
        y + height * (1 - scale) / 2 + (pressed ? 1 : hovered ? -1 : 0)
      );
      const pulse = 0.5 + Math.sin(elapsed / 180) * 0.5;
      aura.alpha = active
        ? 0.16 + pulse * 0.25
        : hovered
          ? 0.08 + pulse * 0.16
          : 0;
      base.tint = pressed ? 0xbad9ff : hovered ? 0xdcecff : 0xffffff;
      nucleus.scale.set(active ? 1 + pulse * 0.25 : hovered ? 1.15 : 1);
      orbit.rotation = elapsed * (tier % 2 ? 0.0012 : -0.001);
      orbit.alpha = active ? 0.75 : hovered ? 0.5 : 0.28;
      electrons.forEach((electron, index) => {
        const phase =
          elapsed / (370 + tier * 45) +
          index * Math.PI * 2 / Math.max(1, tier);
        electron.position.set(
          particleCenterX + Math.cos(phase) * 7,
          height / 2 + Math.sin(phase) * 4
        );
        electron.alpha = active ? 0.5 + pulse * 0.4 : hovered ? 0.55 : 0;
      });
    };
    this.addTicker(animate);

    container.on('pointerover', () => { hovered = true; });
    container.on('pointerout', () => {
      hovered = false;
      pressed = false;
    });
    container.on('pointerdown', () => { pressed = true; });
    container.on('pointerup', () => { pressed = false; });
    container.on('pointerupoutside', () => { pressed = false; });
    container.on('pointertap', () => onActivate(id));
    parent.addChild(container);
    this.metrics.hitTargets.push({ id, role: 'button', label, x, y, width, height });
    return container;
  }

  private createCardFilter(mode: number) {
    const filter = Filter.from({
      gl: {
        vertex: CARD_FILTER_GLSL_VERTEX,
        fragment: CARD_FILTER_GLSL,
      },
      gpu: {
        vertex: {
          source: CARD_FILTER_WGSL,
          entryPoint: 'mainVertex',
        },
        fragment: {
          source: CARD_FILTER_WGSL,
          entryPoint: 'mainFragment',
        },
      },
      resources: {
        cardUniforms: {
          uTime: { value: 0, type: 'f32' },
          uMode: { value: mode, type: 'f32' },
          uHover: { value: 0, type: 'f32' },
          uSelected: { value: 0, type: 'f32' },
        },
      },
      padding: 12,
      resolution: 'inherit',
      antialias: 'inherit',
    });
    this.frameFilters.add(filter);
    return {
      filter,
      uniforms: filter.resources['cardUniforms'].uniforms as {
        uTime: number;
        uMode: number;
        uHover: number;
        uSelected: number;
      },
    };
  }

  private eventCard(
    parent: Container,
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
    accent: number,
    shaderMode: number,
    selected: boolean,
    onActivate: (id: string) => void,
    zDepth = 0
  ) {
    const wasVisible = this.previousEventIds.has(id);
    const entranceDelay = this.currentEventIds.size * 18;
    this.currentEventIds.add(id);
    const container = new Container();
    container.position.set(x, y);
    container.skew.x = -zDepth * 0.007;
    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.hitArea = new Rectangle(0, 0, width, height);
    const cardShader = this.createCardFilter(shaderMode);
    container.filters = [cardShader.filter];

    const extrusion = new Graphics();
    const extrusionX = 5 + zDepth * 7;
    const extrusionY = 5 + zDepth * 5;
    extrusion.roundRect(extrusionX, extrusionY, width, height, 8);
    extrusion.fill({ color: 0x02050b, alpha: 0.38 + zDepth * 0.14 });
    extrusion.stroke({
      color: accent,
      width: 1,
      alpha: 0.14 + zDepth * 0.16,
    });
    container.addChild(extrusion);

    const middleExtrusion = new Graphics();
    middleExtrusion.roundRect(
      extrusionX * 0.52,
      extrusionY * 0.52,
      width,
      height,
      8
    );
    middleExtrusion.fill({ color: 0x08111f, alpha: 0.34 + zDepth * 0.1 });
    middleExtrusion.stroke({
      color: accent,
      width: 0.8,
      alpha: 0.1 + zDepth * 0.13,
    });
    container.addChild(middleExtrusion);

    const aura = new Graphics();
    aura.roundRect(-3, -3, width + 6, height + 6, 10);
    aura.stroke({ color: accent, width: 2.4, alpha: 0.72 });
    aura.alpha = selected ? 0.28 : 0;
    container.addChild(aura);

    const base = new Graphics();
    base.roundRect(0, 0, width, height, 8);
    base.fill({ color: selected ? 0x172a49 : 0x111a2b, alpha: 0.9 });
    base.stroke({ color: selected ? GPU_COLORS.primary : accent, width: selected ? 1.7 : 1.05, alpha: 0.9 });
    container.addChild(base);

    const depth = new Graphics();
    depth.roundRect(4, 4, width - 8, height - 8, 6);
    depth.stroke({ color: 0x9cb8e8, width: 0.65, alpha: selected ? 0.22 : 0.08 });
    container.addChild(depth);

    const rail = new Graphics();
    rail.roundRect(0, 7, 2.5, height - 14, 1.2).fill(accent);
    rail.alpha = 0.72;
    container.addChild(rail);

    const scan = new Graphics();
    scan.rect(5, 0, width - 10, 1.4).fill({ color: accent, alpha: 0.65 });
    scan.alpha = selected ? 0.15 : 0.035;
    container.addChild(scan);

    const content = new Container();
    container.addChild(content);

    const sparks = Array.from({ length: 3 }, (_, index) => {
      const spark = new Graphics();
      spark.circle(0, 0, 1.25 - index * 0.15).fill(index === 1 ? 0xffffff : accent);
      spark.alpha = selected ? 0.4 : 0;
      container.addChild(spark);
      return spark;
    });

    let hovered = false;
    let pressed = false;
    let shaderHover = 0;
    let shaderSelected = selected ? 1 : 0;
    let elapsed = wasVisible ? performance.now() : -entranceDelay;
    container.alpha = wasVisible ? 1 : 0;
    const animate = (ticker: Ticker) => {
      elapsed += ticker.deltaMS;
      const entrance = Math.max(0, Math.min(1, elapsed / 300));
      const easedEntrance = 1 - (1 - entrance) ** 3;
      const targetScale = pressed ? 0.992 : hovered ? 1.008 : 1;
      const scale = easedEntrance * targetScale;
      const depthScaleX = 1 - zDepth * 0.018;
      container.alpha = easedEntrance;
      container.scale.set(scale * depthScaleX, scale);
      container.position.set(
        x + width * (1 - scale * depthScaleX) / 2,
        y + height * (1 - scale) / 2 + (pressed ? 1.4 : hovered ? -1.2 : 0)
      );
      const pulse = 0.5 + Math.sin(elapsed / 190) * 0.5;
      shaderHover += ((hovered ? 1 : 0) - shaderHover) * Math.min(1, ticker.deltaMS * 0.014);
      shaderSelected += ((selected ? 1 : 0) - shaderSelected) * Math.min(1, ticker.deltaMS * 0.014);
      cardShader.uniforms.uTime = elapsed / 1000;
      cardShader.uniforms.uHover = shaderHover;
      cardShader.uniforms.uSelected = shaderSelected;
      aura.alpha = selected
        ? 0.16 + pulse * 0.22
        : hovered
          ? 0.08 + pulse * 0.15
          : 0;
      base.tint = pressed ? 0xb8d8ff : hovered ? 0xd8e9ff : 0xffffff;
      depth.alpha = hovered || selected ? 1 : 0.65;
      extrusion.alpha = hovered ? 0.82 : selected ? 0.75 : 0.58;
      middleExtrusion.alpha = hovered ? 0.92 : selected ? 0.82 : 0.66;
      rail.alpha = selected ? 0.72 + pulse * 0.25 : hovered ? 0.9 : 0.62;
      scan.y = 5 + (Math.max(0, elapsed) * (hovered ? 0.075 : 0.025)) % Math.max(8, height - 10);
      scan.alpha = selected ? 0.08 + pulse * 0.12 : hovered ? 0.09 : 0.025;
      sparks.forEach((spark, index) => {
        const phase = elapsed / 460 + index * 2.1;
        spark.position.set(
          8 + (Math.sin(phase) * 0.5 + 0.5) * (width - 16),
          5 + (Math.cos(phase * 1.4) * 0.5 + 0.5) * (height - 10)
        );
        spark.alpha = selected ? 0.18 + pulse * 0.42 : hovered ? 0.12 + pulse * 0.28 : 0;
      });
    };
    this.addTicker(animate);

    container.on('pointerover', () => { hovered = true; });
    container.on('pointerout', () => {
      hovered = false;
      pressed = false;
    });
    container.on('pointerdown', () => { pressed = true; });
    container.on('pointerup', () => { pressed = false; });
    container.on('pointerupoutside', () => { pressed = false; });
    container.on('pointertap', () => onActivate(`event.${id}`));
    parent.addChild(container);
    this.metrics.hitTargets.push({
      id: `event.${id}`,
      role: 'button',
      label: '',
      x,
      y,
      width,
      height,
    });
    return content;
  }

  private easeOutBack(progress: number, overshoot = 1.35) {
    const shifted = Math.min(1, Math.max(0, progress)) - 1;
    return 1 + (overshoot + 1) * shifted ** 3 + overshoot * shifted ** 2;
  }

  private drawExitingFilterButtons(
    targets: FilterVisualTarget[],
    collapsingLayer: Container,
    collapseDistance: number,
    startedAt = performance.now()
  ) {
    if (!targets.length) return;
    const snapshotAtStart = this.snapshot;
    const exitDuration = 460 + (targets.length - 1) * 18;
    const collapseDuration = 390;
    let elapsed = Math.max(0, performance.now() - startedAt);
    let completed = elapsed >= exitDuration + collapseDuration;
    let groupsRemoved = elapsed >= exitDuration;
    collapsingLayer.y = groupsRemoved
      ? collapseDistance * (1 - this.easeOutBack((elapsed - exitDuration) / collapseDuration))
      : collapseDistance;
    this.metrics.runCollapseOffset = collapsingLayer.y;
    if (completed) {
      collapsingLayer.y = 0;
      this.metrics.runCollapseOffset = 0;
      this.roleRowTransition = null;
      return;
    }
    const groups = groupsRemoved
      ? []
      : targets.map((target, targetIndex) => {
      this.handledExitIds.add(target.id);
      const container = new Container();
      container.position.set(target.x, target.y);

      const aura = new Graphics();
      aura.roundRect(-3, -3, target.width + 6, target.height + 6, 10);
      aura.stroke({ color: target.accent, width: 2, alpha: 0.75 });
      aura.alpha = target.active ? 0.32 : 0.12;
      container.addChild(aura);

      const base = new Graphics();
      base.roundRect(0, 0, target.width, target.height, 8);
      base.fill({
        color: target.active ? target.accent : 0x111b2c,
        alpha: target.active ? 0.27 : 0.9,
      });
      base.stroke({
        color: target.active ? target.accent : 0x30405d,
        width: target.active ? 1.8 : 1,
      });
      container.addChild(base);

      const label = this.text(
        container,
        target.label,
        target.width / 2,
        Math.max(5, (target.height - 16) / 2),
        {
          size: 11,
          color: target.active ? GPU_COLORS.text : 0xa9b5ca,
          weight: target.active ? '700' : '600',
        }
      );
      label.anchor.x = 0.5;

      const fragments = Array.from({ length: 10 }, (_, index) => {
        const fragment = new Graphics();
        const column = index % 5;
        const row = Math.floor(index / 5);
        fragment.rect(0, 0, 2 + index % 2, 1.4).fill({
          color: index % 3 === 0 ? 0xffffff : target.accent,
        });
        fragment.position.set(
          7 + column / 4 * (target.width - 14),
          6 + row * (target.height - 12)
        );
        fragment.alpha = 0;
        container.addChild(fragment);
        return {
          fragment,
          originX: fragment.x,
          originY: fragment.y,
          vx: (column - 2) * 0.035 + Math.sin(index * 4.1) * 0.02,
          vy: (row ? 1 : -1) * 0.045 - index * 0.001,
        };
      });
      this.root.addChild(container);
      return { container, aura, base, label, fragments, delay: targetIndex * 18 };
    });
    for (const id of targets.map((target) => target.id)) this.handledExitIds.add(id);

    const applyDissolve = (deltaMS: number) => {
      if (groupsRemoved) return;
      for (const group of groups) {
        const local = Math.max(0, elapsed - group.delay);
        const progress = Math.min(1, local / 460);
        const dissolveProgress = Math.max(0, (progress - 0.16) / 0.84);
        group.container.alpha = 1 - dissolveProgress ** 1.45;
        const scale = 1 - dissolveProgress * 0.12;
        group.container.scale.set(scale);
        group.container.position.set(
          group.container.position.x,
          group.container.position.y - deltaMS * 0.008 * dissolveProgress
        );
        group.aura.alpha = (0.18 + Math.sin(local / 55) * 0.12) * (1 - dissolveProgress);
        group.base.tint = 0xffffff - Math.floor(dissolveProgress * 0x202000);
        group.label.alpha = 1 - dissolveProgress * 1.25;
        for (const fragment of group.fragments) {
          fragment.fragment.alpha = Math.sin(Math.PI * dissolveProgress) * 0.9;
          fragment.fragment.x =
            fragment.originX + fragment.vx * local * dissolveProgress;
          fragment.fragment.y =
            fragment.originY + fragment.vy * local * dissolveProgress;
          fragment.fragment.rotation += deltaMS * 0.004;
        }
      }
    };

    const applyCollapse = () => {
      const collapseProgress = Math.max(
        0,
        Math.min(1, (elapsed - exitDuration) / collapseDuration)
      );
      if (collapseProgress > 0) {
        collapsingLayer.y = collapseDistance * (1 - this.easeOutBack(collapseProgress));
        this.metrics.runCollapseOffset = collapsingLayer.y;
      }
      return collapseProgress;
    };

    applyDissolve(0);
    applyCollapse();

    const dissolve = (ticker: Ticker) => {
      elapsed = Math.max(0, performance.now() - startedAt);
      applyDissolve(ticker.deltaMS);
      if (!groupsRemoved && elapsed >= exitDuration) {
        groupsRemoved = true;
        for (const group of groups) {
          group.container.removeFromParent();
          group.container.destroy({ children: true });
        }
      }
      const collapseProgress = applyCollapse();
      if (!completed && collapseProgress >= 1) {
        completed = true;
        collapsingLayer.y = 0;
        this.metrics.runCollapseOffset = 0;
        this.roleRowTransition = null;
        this.app.ticker.remove(dissolve);
        this.tickerCallbacks.delete(dissolve);
        requestAnimationFrame(() => {
          if (snapshotAtStart && this.snapshot === snapshotAtStart) {
            this.render(snapshotAtStart);
          }
        });
      }
    };
    this.addTicker(dissolve);
  }

  private animateEnteringFilterSpace(
    layer: Container,
    distance: number,
    startedAt = performance.now()
  ) {
    if (distance <= 0) return;
    const duration = 390;
    const apply = (elapsed: number) => {
      const progress = Math.min(1, elapsed / duration);
      layer.y = -distance * (1 - this.easeOutBack(progress));
      this.metrics.runCollapseOffset = layer.y;
      return progress;
    };
    if (apply(Math.max(0, performance.now() - startedAt)) >= 1) {
      layer.y = 0;
      this.metrics.runCollapseOffset = 0;
      this.roleRowTransition = null;
      return;
    }
    const expand = () => {
      const progress = apply(Math.max(0, performance.now() - startedAt));
      if (progress >= 1) {
        layer.y = 0;
        this.metrics.runCollapseOffset = 0;
        this.roleRowTransition = null;
        this.app.ticker.remove(expand);
        this.tickerCallbacks.delete(expand);
      }
    };
    this.addTicker(expand);
  }

  private drawRemovedFilterEffects() {
    for (const [id, target] of this.previousFilterBounds) {
      if (this.currentFilterBounds.has(id)) continue;
      if (this.handledExitIds.has(id)) continue;
      const particles = new Container();
      const centerX = target.x + target.width / 2;
      const centerY = target.y + target.height / 2;
      const sprites = Array.from({ length: 14 }, (_, index) => {
        const particle = new Graphics();
        const angle = index / 14 * Math.PI * 2;
        const color = index % 3 === 0 ? 0xffffff : GPU_COLORS.primary;
        particle.circle(0, 0, index % 2 === 0 ? 1.8 : 1.1).fill(color);
        particle.position.set(centerX, centerY);
        particles.addChild(particle);
        return {
          particle,
          vx: Math.cos(angle) * (0.045 + index % 4 * 0.012),
          vy: Math.sin(angle) * (0.035 + index % 3 * 0.014) - 0.018,
        };
      });
      this.root.addChild(particles);
      let elapsed = 0;
      const dissolve = (ticker: Ticker) => {
        elapsed += ticker.deltaMS;
        const progress = Math.min(1, elapsed / 420);
        for (const sprite of sprites) {
          sprite.particle.x += sprite.vx * ticker.deltaMS;
          sprite.particle.y += sprite.vy * ticker.deltaMS;
          sprite.particle.alpha = (1 - progress) ** 1.7;
          sprite.particle.scale.set(1 + progress * 0.8);
        }
        if (progress >= 1) {
          this.app.ticker.remove(dissolve);
          this.tickerCallbacks.delete(dissolve);
          particles.removeFromParent();
          particles.destroy({ children: true });
        }
      };
      this.addTicker(dissolve);
    }
  }

  private drawViewTransition(width: number, height: number) {
    const transition = this.activeViewTransition;
    if (!transition) return;
    const initialElapsed = performance.now() - transition.startedAt;
    if (initialElapsed >= 560) {
      this.activeViewTransition = null;
      return;
    }
    const layer = new Container();
    layer.eventMode = 'none';
    const bars = Array.from({ length: 16 }, (_, index) => {
      const bar = new Graphics();
      const barWidth = 42;
      bar.poly([
        0, 0,
        barWidth, 0,
        barWidth - 80, height,
        -80, height,
      ]);
      bar.fill({
        color:
          index % 3 === 0
            ? GPU_COLORS.primary
            : index % 3 === 1
              ? GPU_COLORS.tiers[3]
              : GPU_COLORS.cyan,
        alpha: 0.075,
      });
      layer.addChild(bar);
      return bar;
    });
    const beam = new Graphics();
    beam.rect(0, 0, 3, height).fill({ color: 0xd9ecff, alpha: 0.9 });
    layer.addChild(beam);
    const particles = Array.from({ length: 22 }, (_, index) => {
      const particle = new Graphics();
      particle.circle(0, 0, 1 + index % 3 * 0.4).fill(
        index % 2 ? GPU_COLORS.primary : GPU_COLORS.cyan
      );
      layer.addChild(particle);
      return particle;
    });
    const label = this.text(
      layer,
      transition.to.toUpperCase(),
      0,
      height * 0.18,
      { size: 11, color: 0xd9ecff, weight: '700' }
    );
    this.root.addChild(layer);

    let elapsed = initialElapsed;
    const animate = (ticker: Ticker) => {
      elapsed += ticker.deltaMS;
      const progress = Math.min(1, elapsed / 560);
      const eased = 1 - (1 - progress) ** 3;
      const sweepX = -width * 0.42 + eased * width * 1.55;
      bars.forEach((bar, index) => {
        bar.position.set(sweepX + index * 34, 0);
        bar.alpha = Math.sin(Math.PI * progress) * (0.34 - index * 0.008);
      });
      beam.position.x = sweepX + 15 * 34;
      beam.alpha = Math.sin(Math.PI * progress) * 0.65;
      label.position.set(beam.x - 84, height * 0.18);
      label.alpha = Math.sin(Math.PI * progress) * 0.75;
      particles.forEach((particle, index) => {
        const phase = index * 1.71 + elapsed / 190;
        particle.position.set(
          beam.x - 20 - Math.abs(Math.sin(phase)) * 110,
          index / particles.length * height + Math.sin(phase * 1.4) * 24
        );
        particle.alpha = Math.sin(Math.PI * progress) * (0.2 + index % 3 * 0.12);
      });
      if (progress >= 1) {
        this.activeViewTransition = null;
        this.app.ticker.remove(animate);
        this.tickerCallbacks.delete(animate);
        layer.removeFromParent();
        layer.destroy({ children: true });
      }
    };
    this.addTicker(animate);
  }

  private drawAtomaMark(x: number, y: number) {
    const container = new Container();
    container.position.set(x, y);
    container.eventMode = 'none';
    const crystal = new Container();
    crystal.position.set(14, 14);
    crystal.pivot.set(14, 14);
    const aura = new Graphics();
    const shadow = new Graphics();
    const faceGlow = new Graphics();
    const facets = new Graphics();
    const clearcoat = new Graphics();
    const core = new Graphics();
    crystal.addChild(aura, shadow, faceGlow, facets, clearcoat, core);
    container.addChild(crystal);

    const traceFace = (
      graphics: Graphics,
      points: readonly [AtomaMarkPoint, AtomaMarkPoint, AtomaMarkPoint]
    ) => graphics
      .moveTo(points[0].x, points[0].y)
      .lineTo(points[1].x, points[1].y)
      .lineTo(points[2].x, points[2].y)
      .closePath();

    const paint = (elapsedMs: number) => {
      const frame = buildAtomaMarkFrame(elapsedMs);
      crystal.scale.set(frame.scale * 1.12);
      aura
        .clear()
        .circle(14, 14, 12.6 + frame.pulse * 0.65)
        .fill({ color: 0x4169e1, alpha: 0.018 + frame.pulse * 0.014 })
        .circle(14, 14, 9.6 + frame.pulse * 0.4)
        .fill({ color: GPU_COLORS.cyan, alpha: 0.018 + frame.pulse * 0.012 });
      shadow
        .clear()
        .ellipse(14.4, 25.2, 6.6, 1.35)
        .fill({ color: 0x020817, alpha: 0.34 });
      faceGlow.clear();
      facets.clear();
      clearcoat.clear();

      for (const face of frame.faces) {
        traceFace(faceGlow, face.points).stroke({
          color: face.edgeColor,
          width: 2.4,
          alpha: face.glowAlpha,
        });
        traceFace(facets, face.points)
          .fill({ color: face.fillColor, alpha: 0.985 })
          .stroke({
            color: face.edgeColor,
            width: 0.82,
            alpha: 0.48 + face.sheenAlpha * 0.9,
          });

        const inset = face.points.map((point) => ({
          x: point.x + (face.centroid.x - point.x) * 0.22,
          y: point.y + (face.centroid.y - point.y) * 0.22,
        })) as [AtomaMarkPoint, AtomaMarkPoint, AtomaMarkPoint];
        traceFace(clearcoat, inset).fill({
          color: 0xffffff,
          alpha: face.sheenAlpha,
        });
        const highPoint = face.points.reduce((highest, point) =>
          point.y < highest.y ? point : highest
        );
        clearcoat
          .moveTo(highPoint.x, highPoint.y)
          .lineTo(
            highPoint.x + (face.centroid.x - highPoint.x) * 0.58,
            highPoint.y + (face.centroid.y - highPoint.y) * 0.58
          )
          .stroke({ color: 0xffffff, width: 0.72, alpha: face.sheenAlpha * 1.25 });
      }

      const { x: coreX, y: coreY } = frame.corePosition;
      core.clear();
      core
        .circle(coreX, coreY, 4.4 + frame.pulse * 0.55)
        .fill({ color: GPU_COLORS.cyan, alpha: 0.035 + frame.pulse * 0.025 })
        .circle(coreX, coreY, 2.8 + frame.pulse * 0.2)
        .fill({ color: 0x6ea8ff, alpha: 0.09 + frame.pulse * 0.055 })
        .circle(
          coreX,
          coreY,
          ATOMA_MARK_CORE_RADIUS + frame.pulse * ATOMA_MARK_CORE_RADIUS_PULSE
        )
        .fill({ color: 0xf8fbff, alpha: 0.98 })
        .stroke({
          color: GPU_COLORS.cyan,
          width: ATOMA_MARK_CORE_STROKE_WIDTH,
          alpha: 0.96,
        })
        .circle(coreX - 0.45, coreY - 0.5, 0.45)
        .fill({ color: 0xffffff, alpha: 0.96 });
    };

    const reducedMotion =
      typeof matchMedia !== 'undefined' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    paint(reducedMotion ? 0 : performance.now());
    if (!reducedMotion) {
      this.addTicker(() => {
        paint(performance.now());
      });
    }
    this.root.addChild(container);
  }

  private drawHeader(snapshot: GpuRenderSnapshot, width: number) {
    this.panel(
      this.root,
      0,
      0,
      width,
      GPU_LAYOUT.headerHeight,
      0x0b111e,
      GPU_COLORS.border,
      0
    );
    this.drawAtomaMark(10, 12);
    this.text(this.root, 'Atoma', 49, 17.5, {
      size: 16,
      color: 0x263f68,
      weight: '700',
      alpha: 0.72,
    });
    this.text(this.root, 'Atoma', 48, 16, {
      size: 16,
      color: GPU_COLORS.text,
      weight: '700',
    });

    const views: ViewName[] = ['runs', 'registry', 'skills', 'burnin', 'launch'];
    let x = 160;
    for (const view of views) {
      const label = snapshot.t(`nav.${view}`).toUpperCase();
      this.navButton(
        this.root,
        `nav.${view}`,
        label,
        x,
        10,
        Math.max(66, label.length * 7 + 22),
        32,
        snapshot.state.view === view,
        snapshot.onActivate
      );
      x += Math.max(66, label.length * 7 + 22) + NAV_HOVER_GAP;
    }

    this.button(
      this.root,
      'locale.toggle',
      'button',
      snapshot.state.locale === 'en' ? 'EN' : 'FR',
      width - 104,
      10,
      42,
      32,
      false,
      snapshot.onActivate,
      GPU_COLORS.primary,
      true
    );
    this.button(
      this.root,
      'refresh',
      'button',
      '↻',
      width - 54,
      10,
      42,
      32,
      false,
      snapshot.onActivate,
      GPU_COLORS.primary,
      true
    );
  }

  private drawOverlays(snapshot: GpuRenderSnapshot, width: number, height: number) {
    if (snapshot.state.view !== 'runs' || snapshot.state.focusedInput !== 'run') return;
    const x = Math.max(480, width * 0.42);
    const popupWidth = Math.max(260, width - x - 120);
    const popupY = GPU_LAYOUT.headerHeight - 2;
    const rowHeight = 43;
    const headerHeight = 30;
    const query = snapshot.state.search.run;
    const matching = snapshot.data.runs
      .filter((run) => matchesSearchQuery(runSearchText(run), query));
    const maximumPopupHeight = Math.min(500, height - popupY - 10);
    const listViewportHeight = Math.max(
      rowHeight,
      maximumPopupHeight - headerHeight - 7
    );
    const contentHeight = matching.length * rowHeight;
    this.runPickerScrollMax = Math.max(0, contentHeight - listViewportHeight);
    const scrollY = Math.max(
      0,
      Math.min(this.runPickerScrollMax, snapshot.state.runPickerScrollY)
    );
    const visibleListHeight = Math.min(listViewportHeight, Math.max(rowHeight, contentHeight));
    const popupHeight = headerHeight + visibleListHeight + 7;
    this.runPickerBounds = new Rectangle(x, popupY, popupWidth, popupHeight);
    this.panel(
      this.root,
      x,
      popupY,
      popupWidth,
      popupHeight,
      0x0c1321,
      GPU_COLORS.primary
    );
    this.text(
      this.root,
      `${matching.length} / ${snapshot.data.runs.length} RUNS`,
      x + 12,
      popupY + 8,
      { size: 9, color: GPU_COLORS.muted, weight: '700' }
    );

    const listY = popupY + headerHeight;
    const listMask = new Graphics();
    listMask
      .rect(x + 4, listY, popupWidth - 8, visibleListHeight)
      .fill(0xffffff);
    this.root.addChild(listMask);
    const listLayer = new Container();
    listLayer.mask = listMask;
    this.root.addChild(listLayer);

    const start = Math.max(0, Math.floor(scrollY / rowHeight));
    const visibleCount = Math.ceil(visibleListHeight / rowHeight) + 2;
    matching.slice(start, start + visibleCount).forEach((run, visibleIndex) => {
      const index = start + visibleIndex;
      const rowY = listY + index * rowHeight - scrollY;
      const keyboardActive = index === snapshot.state.runPickerActiveIndex;
      const selected = snapshot.state.selectedRunId === run.id;
      const status = run.cancelled
        ? '✕'
        : run.hasError
          ? '!'
          : run.inFlight
            ? '●'
            : selected
              ? '◆'
              : '';
      this.button(
        listLayer,
        `run.select.${run.id}`,
        'option',
        `${status ? `${status} ` : ''}${truncate(
          run.label.replace(/^(?:build-app|baseline):\s*/i, ''),
          82
        )}`,
        x + 5,
        rowY + 2,
        popupWidth - 18,
        38,
        keyboardActive,
        snapshot.onActivate,
        run.hasError
          ? GPU_COLORS.error
          : run.inFlight
            ? GPU_COLORS.success
            : selected
              ? GPU_COLORS.tiers[3]
              : GPU_COLORS.primary
      );
    });

    if (this.runPickerScrollMax > 0) {
      const track = new Graphics();
      track.roundRect(0, 0, 3, visibleListHeight - 8, 1.5);
      track.fill({ color: 0x2c3c58, alpha: 0.65 });
      track.position.set(x + popupWidth - 8, listY + 4);
      this.root.addChild(track);
      const thumbHeight = Math.max(
        24,
        (visibleListHeight / contentHeight) * (visibleListHeight - 8)
      );
      const thumb = new Graphics();
      thumb.roundRect(0, 0, 3, thumbHeight, 1.5);
      thumb.fill({ color: GPU_COLORS.primary, alpha: 0.9 });
      thumb.position.set(
        x + popupWidth - 8,
        listY +
          4 +
          (scrollY / this.runPickerScrollMax) *
            (visibleListHeight - 8 - thumbHeight)
      );
      this.root.addChild(thumb);
    }
    if (!matching.length) {
      this.text(this.root, snapshot.t('runs.none'), x + 14, listY + 12, {
        size: 11,
        color: GPU_COLORS.muted,
      });
    }
  }

  private drawRuns(snapshot: GpuRenderSnapshot, width: number, height: number) {
    const run = snapshot.data.run;
    if (!run) {
      this.text(this.root, snapshot.t('runs.none'), 18, 76, { size: 14 });
      return;
    }
    const top = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
    const twoPane = width >= 1050;
    const rightWidth = twoPane ? Math.min(GPU_LAYOUT.rightWidth, width * 0.4) : 0;
    const leftWidth = width - rightWidth - GPU_LAYOUT.gap * (twoPane ? 3 : 2);
    const leftX = GPU_LAYOUT.gap;
    const rightX = leftX + leftWidth + GPU_LAYOUT.gap;

    this.panel(this.root, leftX, top, leftWidth, height - top - GPU_LAYOUT.gap);
    this.text(this.root, truncate(run.label, 95), leftX + 14, top + 12, {
      size: 14,
      weight: '700',
      width: leftWidth - 28,
    });
    this.text(this.root, truncate(run.task?.description ?? '', 180), leftX + 14, top + 34, {
      size: 11,
      color: GPU_COLORS.muted,
      width: leftWidth - 28,
    });
    if (isRunLive(run)) {
      this.text(this.root, snapshot.t('runs.flag.live'), leftX + leftWidth - 72, top + 12, {
        size: 11,
        color: GPU_COLORS.success,
        weight: '700',
      });
    }

    const statsY = top + 76;
    const stats = [
      [snapshot.t('summary.duration'), fmtMs(run.durationMs)],
      [snapshot.t('summary.llmCalls'), scalar(run.totals?.calls, '0')],
      [snapshot.t('summary.tokens'), `${run.totals?.inputTokens ?? 0}/${run.totals?.outputTokens ?? 0}`],
      [snapshot.t('summary.cost'), fmtCost(run.totals?.costUsd)],
    ];
    const statAccents = [
      GPU_COLORS.cyan,
      GPU_COLORS.tiers[3],
      GPU_COLORS.primary,
      GPU_COLORS.success,
    ];
    const statWidth = (leftWidth - 28 - GPU_LAYOUT.gap * 3) / 4;
    stats.forEach(([label, value], index) => {
      const x = leftX + 14 + index * (statWidth + GPU_LAYOUT.gap);
      this.statCard(
        this.root,
        `runs.stat.${index}`,
        label!,
        value!,
        x,
        statsY,
        statWidth,
        55,
        statAccents[index] ?? GPU_COLORS.primary
      );
    });

    const atoms = buildAtomMap(run);
    const atomLayout = layoutAtomLaneBlocks({
      originX: leftX + 14,
      originY: statsY + 55 + FILTER_BLOCK_GAP,
      maxWidth: leftWidth - 28,
      lanes: ([3, 2, 1] as const).flatMap((tier) => {
        const entries = [...atoms.values()].filter((value) => value.snapshot.tier === tier);
        if (!entries.length) return [];
        return [{
          tier,
          label: snapshot.t(`lanes.l${tier}`),
          names: entries.map((entry) => entry.snapshot.name),
        }];
      }),
    });
    for (const lane of atomLayout.lanes) {
      this.filterBlockFrame(this.root, lane);
      this.text(this.root, lane.label, lane.labelX, lane.labelY, {
        size: 10,
        color: GPU_COLORS.tiers[lane.tier],
        weight: '700',
      });
      for (const chip of lane.chips) {
        this.atomButton(
          this.root,
          chip.id,
          chip.label,
          lane.tier,
          chip.x,
          chip.y,
          chip.width,
          chip.height,
          snapshot.state.selectedAtomName === chip.label,
          snapshot.onActivate
        );
      }
    }

    const filterY = atomLayout.bottom + FILTER_BLOCK_GAP;
    const runFilters = coerceEventFilters(run.events, snapshot.state.runFilters);
    const kinds = visibleEventKindFilters(run.events);
    const rolesVisible =
      runFilters.kind === 'all' ||
      runFilters.kind === 'llm';
    const roleNames = rolesVisible
      ? [...new Set(run.events.flatMap((event) => event.role ? [event.role] : []))]
      : [];
    const filterLayout = layoutRunFilterBlocks({
      originX: leftX + 14,
      originY: filterY,
      maxWidth: leftWidth - 28,
      kinds: kinds.map((kind) => ({
        id: `run.filter.kind.${kind}`,
        label: kind === 'tool' ? snapshot.t('filters.tools').toUpperCase() : kind.toUpperCase(),
      })),
      roles: roleNames.length
        ? ['all', ...roleNames].map((role) => ({
            id: `run.filter.role.${role}`,
            label: role === 'all' ? 'ALL ROLES' : role.toUpperCase(),
          }))
        : null,
    });
    this.filterBlockFrame(this.root, filterLayout.kinds);
    for (const chip of filterLayout.kinds.chips) {
      this.filterButton(
        this.root,
        chip.id,
        chip.label,
        chip.x,
        chip.y,
        chip.width,
        chip.height,
        runFilters.kind === chip.id.slice('run.filter.kind.'.length),
        snapshot.onActivate
      );
    }
    if (filterLayout.roles) {
      this.filterBlockFrame(this.root, filterLayout.roles);
      for (const chip of filterLayout.roles.chips) {
        this.filterButton(
          this.root,
          chip.id,
          chip.label,
          chip.x,
          chip.y,
          chip.width,
          chip.height,
          runFilters.role === chip.id.slice('run.filter.role.'.length),
          snapshot.onActivate
        );
      }
    }

    const controlsBottomWithoutRoles = filterLayout.kinds.y + filterLayout.kinds.height + FILTER_BLOCK_GAP;
    let controlsBottom = filterLayout.bottom + FILTER_BLOCK_GAP;
    const roleWasVisible = [...this.previousFilterBounds.keys()].some((id) =>
      id.startsWith('run.filter.role.')
    );
    const exitingRoleFilters = !rolesVisible
      ? [...this.previousFilterBounds.values()].filter((target) =>
          target.id.startsWith('run.filter.role.')
        )
      : [];
    const enterDistance = Math.max(0, controlsBottom - controlsBottomWithoutRoles);
    if (rolesVisible) {
      if (this.roleRowTransition?.phase === 'exit') this.roleRowTransition = null;
      if (enterDistance > 0 && !roleWasVisible && this.roleRowTransition?.phase !== 'enter') {
        this.roleRowTransition = {
          phase: 'enter',
          targets: [],
          distance: enterDistance,
          startedAt: performance.now(),
        };
      }
    } else if (exitingRoleFilters.length && this.roleRowTransition?.phase !== 'exit') {
      const previousRoleBottom = Math.max(
        ...exitingRoleFilters.map((target) => target.y + target.height + 4)
      );
      this.roleRowTransition = {
        phase: 'exit',
        targets: exitingRoleFilters,
        distance: Math.max(0, previousRoleBottom - controlsBottom),
        startedAt: performance.now(),
      };
    } else if (this.roleRowTransition?.phase === 'enter') {
      this.roleRowTransition = null;
    }
    const lowerControlsLayer = new Container();
    this.root.addChild(lowerControlsLayer);
    const roleRowTransition = this.roleRowTransition;
    if (roleRowTransition?.phase === 'exit') {
      this.drawExitingFilterButtons(
        roleRowTransition.targets,
        lowerControlsLayer,
        roleRowTransition.distance,
        roleRowTransition.startedAt
      );
    } else if (roleRowTransition?.phase === 'enter') {
      this.animateEnteringFilterSpace(
        lowerControlsLayer,
        roleRowTransition.distance,
        roleRowTransition.startedAt
      );
    }
    const branchOverview = buildTimelineLayout(run.events, {
      ...runFilters,
      branchId: 'all',
    });
    const overviewById = new Map(
      branchOverview.branches.map((branch) => [branch.id, branch])
    );
    const branchIds = branchOverview.branches.map((branch) => branch.id);
    const shownBranchIds = branchIds.slice(0, 6);
    if (
      runFilters.branchId !== 'all' &&
      !shownBranchIds.includes(runFilters.branchId)
    ) {
      shownBranchIds.push(runFilters.branchId);
    }
    if (branchIds.length > 1) {
      const branchBlock = layoutFilterChipBlock(
        leftX + 14,
        controlsBottom,
        leftWidth - 28,
        ['all', ...shownBranchIds].map((branchId) => {
          const branch = overviewById.get(branchId);
          return {
            id: `run.filter.branch.${branchId}`,
            label:
              branchId === 'all'
                ? snapshot.t('timeline.allBranches').toUpperCase()
                : branch
                  ? timelineBranchLabel(branch, snapshot.t).toUpperCase()
                  : `⑂ ${branchId.slice(0, 6)}`,
          };
        })
      );
      this.filterBlockFrame(lowerControlsLayer, branchBlock);
      for (const chip of branchBlock.chips) {
        this.filterButton(
          lowerControlsLayer,
          chip.id,
          chip.label,
          chip.x,
          chip.y,
          chip.width,
          chip.height,
          runFilters.branchId === chip.id.slice('run.filter.branch.'.length),
          snapshot.onActivate
        );
      }
      controlsBottom = branchBlock.y + branchBlock.height + FILTER_BLOCK_GAP;
    }

    const completed = new Set(run.events.filter((event) => event.kind === 'llm').map((event) => event.id));
    const inFlight = run.events.filter(
      (event) =>
        event.kind === 'llm-start' &&
        typeof event.llmEventId === 'string' &&
        !completed.has(event.llmEventId)
    );
    if (isRunLive(run) && inFlight.length) {
      const liveY = controlsBottom + 5;
      this.panel(lowerControlsLayer, leftX + 14, liveY, leftWidth - 28, 52, 0x10263b, GPU_COLORS.cyan);
      const current = inFlight.at(-1)!;
      const tools = run.events.filter(
        (event) => event.kind === 'tool' && event.llmEventId === current.llmEventId
      );
      this.text(
        lowerControlsLayer,
        `${snapshot.t('now.title')} · ${(current.role ?? 'LLM').toUpperCase()} · ${current.actor?.name ?? '?'} · ${snapshot.t('now.elementCount', { count: tools.length })}`,
        leftX + 24,
        liveY + 11,
        { size: 10, color: GPU_COLORS.cyan, weight: '700' }
      );
      this.text(
        lowerControlsLayer,
        truncate(nowDescription(snapshot.t, current), 130),
        leftX + 24,
        liveY + 29,
        { size: 9, color: GPU_COLORS.muted, width: leftWidth - 48 }
      );
      controlsBottom = liveY + 57;
    }

    if (runFilters.branchId !== 'all') {
      const selectedBranch = overviewById.get(runFilters.branchId);
      const heading = selectedBranch
        ? timelineBranchHeading(selectedBranch, snapshot.t)
        : {
            eyebrow: snapshot.t('filters.branch', { id: runFilters.branchId.slice(0, 8) }),
            title: snapshot.t('filters.branch', { id: runFilters.branchId.slice(0, 8) }),
            lines: [] as const,
          };
      const expanded = snapshot.state.branchHeadingExpanded;
      const visibleLines = expanded ? heading.lines : [];
      const accent = selectedBranch ? timelineBranchColor(selectedBranch) : GPU_COLORS.primary;
      const blockX = leftX + 14;
      const blockWidth = leftWidth - 28;
      const padX = 14;
      const padY = 10;
      const innerWidth = blockWidth - padX * 2 - 36;
      const block = new Container();
      let cursor = padY;
      const eyebrow = this.text(block, heading.eyebrow.toUpperCase(), padX, cursor, {
        size: 10,
        weight: '700',
        color: accent,
      });
      this.collapseCaret(block, blockWidth - padX, cursor + 1, expanded, accent);
      cursor += eyebrow.height + 5;
      const title = this.text(block, heading.title, padX, cursor, {
        size: 14,
        weight: '700',
        color: GPU_COLORS.text,
        width: innerWidth,
      });
      cursor += title.height;
      if (visibleLines.length) cursor += 8;
      for (const line of visibleLines) {
        const row = this.text(block, `·  ${line}`, padX, cursor, {
          size: 11,
          color: GPU_COLORS.muted,
          width: innerWidth,
        });
        cursor += row.height + 3;
      }
      cursor += padY - 2;
      this.panel(
        lowerControlsLayer,
        blockX,
        controlsBottom,
        blockWidth,
        cursor,
        GPU_COLORS.panelRaised,
        accent
      );
      block.eventMode = 'static';
      block.cursor = 'pointer';
      block.hitArea = new Rectangle(0, 0, blockWidth, cursor);
      block.on('pointertap', () => snapshot.onActivate('branch.heading.toggle'));
      block.position.set(blockX, controlsBottom);
      lowerControlsLayer.addChild(block);
      this.metrics.hitTargets.push({
        id: 'branch.heading.toggle',
        role: 'button',
        label: snapshot.t(expanded ? 'timeline.collapse' : 'timeline.expand'),
        x: blockX,
        y: controlsBottom,
        width: blockWidth,
        height: cursor,
      });
      controlsBottom += cursor + FILTER_BLOCK_GAP;
    }

    const listY = controlsBottom + 7;
    const listHeight = height - listY - GPU_LAYOUT.gap;
    const listMask = new Graphics();
    // Card filters have 12px shader padding and hover-scale around center.
    // Keep vertical clipping strict (no overlap with filters) but use the full
    // pane width so right-side glow/scale is not guillotined.
    listMask.rect(leftX + 1, listY, leftWidth - 2, listHeight).fill(0xffffff);
    listMask.eventMode = 'none';
    lowerControlsLayer.addChild(listMask);
    const listLayer = new Container();
    listLayer.eventMode = 'static';
    listLayer.interactiveChildren = true;
    listLayer.hitArea = new Rectangle(leftX + 1, listY, leftWidth - 2, listHeight);
    listLayer.mask = listMask;
    lowerControlsLayer.addChild(listLayer);
    const timeline = buildTimelineLayout(run.events, runFilters);
    const rowHeight = timeline.rowHeight;
    const contentTopPadding = 18;
    const contentBottomPadding = 20;
    const cardRightPadding = 24;
    this.scrollMax.runs = Math.max(
      0,
      timeline.totalHeight +
        contentTopPadding +
        contentBottomPadding -
        listHeight
    );
    const scrollY = Math.min(
      snapshot.state.scrollY.runs,
      this.scrollMax.runs
    );
    const start = Math.max(
      0,
      Math.floor(Math.max(0, scrollY - contentTopPadding) / rowHeight)
    );
    const count = Math.ceil(listHeight / rowHeight) + 2;
    const laneSpacing =
      timeline.maxLane > 0
        ? Math.min(22, 96 / timeline.maxLane)
        : 22;
    const railInset = 28;
    const labelGutter = 46;
    const branchCardOffset = 10;
    const railX = (lane: number) => leftX + railInset + lane * laneSpacing;
    const cardBaseX = railX(timeline.maxLane) + labelGutter;
    const cardBaseWidth = Math.min(
      520,
      leftX + leftWidth - cardRightPadding - cardBaseX
    );
    const rowCenterY = (row: number) =>
      listY +
      contentTopPadding +
      row * rowHeight -
      scrollY +
      (rowHeight - 10) / 2;
    this.metrics.timelineViewport = {
      left: leftX,
      top: listY,
      width: leftWidth,
      height: listHeight,
      railBaseX: railX(0),
      laneSpacing,
      cardBaseX,
      cardBaseWidth,
      branchCardOffset,
      contentTopPadding,
      contentBottomPadding,
      rowHeight,
      totalHeight:
        timeline.totalHeight + contentTopPadding + contentBottomPadding,
      scrollY,
    };
    if (timeline.items.length === 0) {
      this.text(listLayer, snapshot.t('filters.noMatch'), leftX + 24, listY + 22, {
        size: 11,
        color: GPU_COLORS.muted,
        width: leftWidth - 48,
      });
    }
    const graph = new Graphics();
    if (timeline.items.length > 0) {
      graph
        .moveTo(railX(0), rowCenterY(0))
        .lineTo(railX(0), rowCenterY(timeline.items.length - 1));
      graph.stroke({ color: GPU_COLORS.primary, width: 2.2, alpha: 0.42 });
    }
    for (const branch of timeline.branches) {
      const color = timelineBranchColor(branch);
      graph
        .moveTo(railX(branch.lane), rowCenterY(branch.firstRow))
        .lineTo(railX(branch.lane), rowCenterY(branch.lastRow));
      graph.stroke({ color, width: 2.4, alpha: 0.72 });
    }
    for (const connector of timeline.connectors) {
      const branch = timeline.branches.find(
        (candidate) => candidate.id === connector.branchId
      );
      const color = branch ? timelineBranchColor(branch) : GPU_COLORS.primary;
      const fromX = railX(connector.fromLane);
      const toX = railX(connector.toLane);
      const connectorY = rowCenterY(connector.row);
      const bend = Math.max(5, Math.abs(toX - fromX) * 0.45);
      graph.moveTo(fromX, connectorY);
      graph.bezierCurveTo(
        fromX + Math.sign(toX - fromX) * bend,
        connectorY,
        toX - Math.sign(toX - fromX) * bend,
        connectorY,
        toX,
        connectorY
      );
      graph.stroke({
        color,
        width: connector.kind === 'fork' ? 1.8 : 1.2,
        alpha: connector.kind === 'fork' ? 0.78 : 0.48,
      });
    }
    for (const item of timeline.items.slice(start, start + count)) {
      const branch = item.branchId
        ? timeline.branches.find((candidate) => candidate.id === item.branchId)
        : undefined;
      graph
        .circle(railX(item.lane), rowCenterY(item.row), item.branchStart ? 4 : 2.4);
      graph.fill({
        color: branch ? timelineBranchColor(branch) : GPU_COLORS.primary,
        alpha: item.branchStart || item.branchEnd ? 0.95 : 0.62,
      });
    }
    listLayer.addChild(graph);

    if (timeline.items.length > 0) {
      const startY = rowCenterY(0);
      const endY = rowCenterY(timeline.items.length - 1);
      if (startY >= listY - 20 && startY <= listY + listHeight + 20) {
        this.text(listLayer, snapshot.t('timeline.start').toUpperCase(), railX(0) + 7, startY - 7, {
          size: 8,
          color: GPU_COLORS.primary,
          weight: '700',
        });
      }
      if (endY >= listY - 20 && endY <= listY + listHeight + 20) {
        this.text(listLayer, snapshot.t('timeline.end').toUpperCase(), railX(0) + 7, endY - 7, {
          size: 8,
          color: GPU_COLORS.primary,
          weight: '700',
        });
      }
    }

    timeline.items.slice(start, start + count).forEach((item) => {
      const event = item.event;
      const y =
        listY +
        contentTopPadding +
        item.row * rowHeight -
        scrollY;
      if (y > listY + listHeight || y + rowHeight < listY) return;
      const selected = snapshot.state.selectedEventId === event.id;
      const branch = item.branchId
        ? timeline.branches.find((candidate) => candidate.id === item.branchId)
        : undefined;
      const branchOffset = item.lane * branchCardOffset;
      const cardX = cardBaseX + branchOffset;
      const cardWidth = cardBaseWidth - branchOffset;
      const cardHeight = rowHeight - 10;
      const tierDepth = item.tier === 3 ? 0.9 : item.tier === 2 ? 0.58 : item.tier === 1 ? 0.3 : 0.12;
      const zDepth = Math.min(1, tierDepth + item.lane * 0.08);
      const cardContent = this.eventCard(
        listLayer,
        event.id,
        cardX,
        y,
        cardWidth,
        cardHeight,
        eventAccent(event),
        gpuCardShaderMode(event),
        selected,
        snapshot.onActivate,
        zDepth
      );
      const copy = gpuEventCardCopy(event);
      this.text(cardContent, truncate(copy.title, 28), 11, 6, {
        size: 11,
        weight: '700',
        color: eventAccent(event),
      });
      const rawMeta = copy.meta.replace(/(?: · )?⑂ [^ ·]+/g, '').trim();
      const actor = rawMeta.split(' · ')[0] ?? '';
      if (actor) {
        this.text(cardContent, truncate(actor, 28), 118, 7, {
          size: 9,
          color: GPU_COLORS.muted,
          width: Math.max(80, cardWidth - 250),
        });
      }
      if (copy.decision) {
        this.text(cardContent, copy.decision, cardWidth - 118, 6, {
          size: 10,
          color: copy.decision.startsWith('✕') || copy.decision.startsWith('↑')
            ? GPU_COLORS.warning
            : GPU_COLORS.success,
          weight: '700',
        });
      }
      const detail = [copy.body, copy.footer].filter(Boolean).join(' · ');
      this.text(cardContent, truncate(detail, 160), 11, 28, {
        size: 9,
        color: event.error ? GPU_COLORS.error : GPU_COLORS.muted,
        width: cardWidth - 22,
      });
      if (item.branchStart && branch) {
        this.text(
          listLayer,
          branch.parallel
            ? `B${branch.path.join('.')}`
            : `P${branch.path.join('.')}`,
          railX(branch.lane) + 6,
          y + 4,
          {
            size: 8,
            color: timelineBranchColor(branch),
            weight: '700',
          }
        );
      }
    });

    if (twoPane) {
      this.panel(this.root, rightX, top, rightWidth, height - top - GPU_LAYOUT.gap);
      const summaryHeight = this.drawRunSummaryCard(
        snapshot,
        run,
        rightX,
        top,
        rightWidth
      );
      const detailTop = top + summaryHeight;
      const event = run.events.find((value) => value.id === snapshot.state.selectedEventId);
      const atom = snapshot.state.selectedAtomName
        ? atoms.get(snapshot.state.selectedAtomName)
        : undefined;
      if (event) {
        this.drawEventDetail(
          snapshot,
          event,
          rightX,
          detailTop,
          rightWidth,
          height - detailTop
        );
      } else if (atom) {
        this.drawAtomDetail(snapshot, atom.snapshot, rightX, detailTop, rightWidth);
      } else if (!snapshot.state.runSummaryExpanded) {
        this.text(this.root, snapshot.t('pane.selectEvent'), rightX + 18, detailTop + 12, {
          size: 12,
          color: GPU_COLORS.muted,
          width: rightWidth - 36,
        });
      }
    }
  }

  private drawRunSummaryCard(
    snapshot: GpuRenderSnapshot,
    run: VizRun,
    x: number,
    y: number,
    width: number
  ): number {
    const expanded = snapshot.state.runSummaryExpanded;
    const padX = 16;
    const cardWidth = width - 20;
    const innerWidth = cardWidth - padX * 2;
    const block = new Container();
    let cursor = 12;
    this.text(block, snapshot.t('run.summary').toUpperCase(), padX, cursor, {
      size: 10,
      weight: '700',
      color: GPU_COLORS.cyan,
    });
    this.collapseCaret(block, cardWidth - padX, cursor + 1, expanded, GPU_COLORS.cyan);
    cursor += 18;
    const title = this.text(block, truncate(run.label, 90), padX, cursor, {
      size: 13,
      weight: '700',
      color: GPU_COLORS.text,
      width: innerWidth - 8,
    });
    cursor += title.height + 6;
    const facts = [
      fmtMs(run.durationMs),
      snapshot.t('runs.calls', { count: run.totals?.calls ?? 0 }),
      fmtCost(run.totals?.costUsd),
    ].filter(Boolean).join('  ·  ');
    this.text(block, facts, padX, cursor, {
      size: 10,
      color: GPU_COLORS.muted,
    });
    cursor += 18;
    const goal = run.task?.description ?? '';
    if (goal) {
      this.text(block, snapshot.t('run.goal').toUpperCase(), padX, cursor, {
        size: 9,
        weight: '700',
        color: GPU_COLORS.muted,
      });
      cursor += 16;
      const goalText = this.text(
        block,
        expanded ? goal : truncate(goal, 140),
        padX,
        cursor,
        {
          size: 11,
          color: GPU_COLORS.text,
          width: innerWidth,
        }
      );
      cursor += goalText.height + 10;
    } else {
      cursor += 8;
    }
    this.panel(
      this.root,
      x + 10,
      y + 10,
      width - 20,
      cursor,
      GPU_COLORS.panelRaised,
      GPU_COLORS.cyan
    );
    block.eventMode = 'static';
    block.cursor = 'pointer';
    block.hitArea = new Rectangle(0, 0, width - 20, cursor);
    block.on('pointertap', () => snapshot.onActivate('run.summary.toggle'));
    block.position.set(x + 10, y + 10);
    this.root.addChild(block);
    this.metrics.hitTargets.push({
      id: 'run.summary.toggle',
      role: 'button',
      label: snapshot.t(expanded ? 'run.collapse' : 'run.expand'),
      x: x + 10,
      y: y + 10,
      width: width - 20,
      height: cursor,
    });
    return cursor + 18;
  }

  private drawEventDetail(
    snapshot: GpuRenderSnapshot,
    event: VizEvent,
    x: number,
    y: number,
    width: number,
    height: number
  ) {
    if (event.kind === 'skill') {
      const title = this.text(this.root, skillEventTitle(event, snapshot.t), x + 18, y + 16, {
        size: 15,
        weight: '700',
        color: eventAccent(event),
        width: width - 36,
      });
      const subtitle = this.text(this.root, skillEventSubtitle(event), x + 18, y + 22 + title.height, {
        size: 10,
        color: GPU_COLORS.muted,
        width: width - 36,
      });
      const skill =
        snapshot.data.skillDetail?.id === event.skillId ? snapshot.data.skillDetail : null;
      const structured = buildSkillEventDetail(event, skill, snapshot.t);
      const detailTop = y + 36 + title.height + subtitle.height;
      const detailBottom = y + height - 62;
      const detailHeight = Math.max(40, detailBottom - detailTop);
      this.detailBounds = new Rectangle(x + 12, detailTop - 6, width - 24, detailHeight + 6);
      const detailLayer = new Container();
      detailLayer.position.y = -this.detailScrollY;
      this.root.addChild(detailLayer);
      const mask = this.detailMask(x + 12, detailTop - 6, width - 24, detailHeight + 6);
      detailLayer.mask = mask;
      const contentBottom = this.drawStructuredDetailNodes(
        detailLayer,
        structured,
        x + 18,
        detailTop,
        width - 42
      );
      this.detailScrollMax = Math.max(0, contentBottom - detailBottom + 8);
      this.detailScrollY = Math.min(this.detailScrollY, this.detailScrollMax);
      detailLayer.position.y = -this.detailScrollY;
      if (this.detailScrollMax > 0) {
        const trackHeight = detailHeight;
        const thumbHeight = Math.max(
          28,
          trackHeight * Math.min(1, detailHeight / (detailHeight + this.detailScrollMax))
        );
        const thumbY =
          detailTop +
          (trackHeight - thumbHeight) * (this.detailScrollY / this.detailScrollMax);
        const scrollbar = new Graphics();
        scrollbar.roundRect(x + width - 8, detailTop, 3, trackHeight, 2);
        scrollbar.fill({ color: GPU_COLORS.border, alpha: 0.55 });
        scrollbar.roundRect(x + width - 8, thumbY, 3, thumbHeight, 2);
        scrollbar.fill({ color: GPU_COLORS.primary, alpha: 0.9 });
        this.root.addChild(scrollbar);
      }
      if (event.l1Name && event.skillId) {
        this.button(
          this.root,
          `skill.open.${event.l1Name}::${event.skillId}`,
          'button',
          snapshot.t('registry.openSkill'),
          x + 18,
          y + height - 55,
          width - 36,
          34,
          false,
          snapshot.onActivate
        );
      }
      return;
    }
    this.text(
      this.root,
      event.kind === 'llm' ? eventRoleLabel(event.role, snapshot.t) : event.kind,
      x + 18,
      y + 16,
      {
      size: 15,
      weight: '700',
      color: eventAccent(event),
      }
    );
    this.text(this.root, `${event.actor?.name ?? ''} ${event.model ?? ''}`, x + 18, y + 42, {
      size: 10,
      color: GPU_COLORS.muted,
      width: width - 36,
    });
    if (event.kind === 'cache') {
      this.text(this.root, snapshot.t('detail.cache.title'), x + 18, y + 72, {
        size: 13,
        color: GPU_COLORS.cyan,
        weight: '700',
        width: width - 36,
      });
      this.text(this.root, scalar(event.outcome), x + 18, y + 108, {
        size: 12,
        weight: '700',
        width: width - 36,
      });
      this.text(this.root, event.reasoning ?? '', x + 18, y + 142, {
        size: 10,
        color: GPU_COLORS.muted,
        width: width - 36,
      });
      this.text(this.root, snapshot.t('detail.cache.explain'), x + 18, y + 220, {
        size: 10,
        color: GPU_COLORS.muted,
        width: width - 36,
      });
      return;
    }
    const raw =
      event.kind === 'llm'
        ? event.response ?? event.error ?? ''
        : event.error ?? event.reasoning ?? '';
    const structured =
      event.kind === 'llm'
        ? tryParseJson(raw)
        : event.kind === 'tool' && !event.error
          ? { args: event.args ?? {}, result: event.result }
          : !event.error
            ? event
            : undefined;
    const detailTop = y + 68;
    const detailBottom = y + height - 14;
    const detailHeight = Math.max(40, detailBottom - detailTop);
    this.detailBounds = new Rectangle(x + 12, detailTop - 6, width - 24, detailHeight + 6);
    const detailLayer = new Container();
    detailLayer.position.y = -this.detailScrollY;
    this.root.addChild(detailLayer);
    const mask = this.detailMask(x + 12, detailTop - 6, width - 24, detailHeight + 6);
    detailLayer.mask = mask;
    const contentBottom =
      structured === undefined
        ? detailTop +
          this.text(detailLayer, truncate(raw, 8000), x + 18, detailTop, {
            size: 10,
            mono: true,
            color: 0xcbd5e1,
            width: width - 42,
          }).height
        : this.drawStructuredDetailNodes(
            detailLayer,
            buildStructuredDetail(structured, snapshot.t, {
              markdownPath: event.kind === 'tool' ? filePathFromArgs(event.args) : undefined,
            }),
            x + 18,
            detailTop,
            width - 42
          );
    this.detailScrollMax = Math.max(0, contentBottom - detailBottom + 8);
    this.detailScrollY = Math.min(this.detailScrollY, this.detailScrollMax);
    detailLayer.position.y = -this.detailScrollY;
    if (this.detailScrollMax > 0) {
      const trackHeight = detailHeight;
      const thumbHeight = Math.max(
        28,
        trackHeight * Math.min(1, detailHeight / (detailHeight + this.detailScrollMax))
      );
      const thumbY =
        detailTop +
        (trackHeight - thumbHeight) * (this.detailScrollY / this.detailScrollMax);
      const scrollbar = new Graphics();
      scrollbar.roundRect(x + width - 8, detailTop, 3, trackHeight, 2);
      scrollbar.fill({ color: GPU_COLORS.border, alpha: 0.55 });
      scrollbar.roundRect(x + width - 8, thumbY, 3, thumbHeight, 2);
      scrollbar.fill({ color: GPU_COLORS.primary, alpha: 0.9 });
      this.root.addChild(scrollbar);
    }
  }

  private drawStructuredDetailNodes(
    parent: Container,
    nodes: readonly StructuredDetailNode[],
    x: number,
    startY: number,
    width: number,
    depth = 0
  ): number {
    let cursor = startY;
    for (const node of nodes) {
      const inset = depth * 12;
      const nodeX = x + inset;
      const nodeWidth = Math.max(120, width - inset);
      if (node.kind === 'field') {
        const background = new Graphics();
        parent.addChild(background);
        this.text(parent, node.label, nodeX + 10, cursor + 7, {
          size: 9,
          color: GPU_COLORS.muted,
          weight: '600',
          width: nodeWidth - 20,
        });
        if (node.presentation === 'badge') {
          const accent = detailToneColor(node.tone);
          const badgeWidth = Math.min(
            nodeWidth - 20,
            Math.max(72, node.value.length * 6.4 + 22)
          );
          const badge = new Graphics();
          badge.roundRect(nodeX + 10, cursor + 25, badgeWidth, 24, 6);
          badge.fill({ color: accent, alpha: node.tone === 'neutral' ? 0.08 : 0.18 });
          badge.stroke({ color: accent, width: 1, alpha: 0.75 });
          parent.addChild(badge);
          this.text(parent, node.value, nodeX + 20, cursor + 30, {
            size: 10,
            color: node.tone === 'neutral' ? GPU_COLORS.text : accent,
            weight: '700',
            width: badgeWidth - 18,
          });
          background.roundRect(nodeX, cursor, nodeWidth, 59, 7);
          background.fill({ color: GPU_COLORS.panelRaised, alpha: 0.55 });
          background.stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.65 });
          cursor += 67;
          continue;
        }

        const valueText = this.text(
          parent,
          truncate(node.value, 4000),
          nodeX + 10,
          cursor + 25,
          {
            size: 10,
            mono: node.presentation === 'code',
            color: node.tone === 'info' ? GPU_COLORS.cyan : 0xcbd5e1,
            width: nodeWidth - 20,
          }
        );
        const fieldHeight = Math.max(58, valueText.height + 36);
        background.roundRect(nodeX, cursor, nodeWidth, fieldHeight, 7);
        background.fill({ color: GPU_COLORS.panelRaised, alpha: 0.55 });
        background.stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.65 });
        cursor += fieldHeight + 8;
        continue;
      }

      const rail = new Graphics();
      parent.addChild(rail);
      const title = node.count === undefined ? node.label : `${node.label} · ${node.count}`;
      this.text(parent, title, nodeX + 10, cursor + 3, {
        size: depth === 0 ? 12 : 10,
        color: depth === 0 ? GPU_COLORS.primary : GPU_COLORS.text,
        weight: '700',
        width: nodeWidth - 20,
      });
      const railTop = cursor + 25;
      cursor += 29;
      cursor = this.drawStructuredDetailNodes(
        parent,
        node.children,
        x,
        cursor,
        width,
        depth + 1
      );
      rail.moveTo(nodeX + 2, railTop).lineTo(nodeX + 2, Math.max(railTop, cursor - 7));
      rail.stroke({
        color: depth === 0 ? GPU_COLORS.primary : GPU_COLORS.border,
        width: depth === 0 ? 2 : 1,
        alpha: 0.65,
      });
      cursor += 5;
    }
    return cursor;
  }

  private detailMask(x: number, y: number, width: number, height: number) {
    const mask = new Graphics();
    mask.rect(x, y, width, height).fill(0xffffff);
    mask.eventMode = 'none';
    this.root.addChild(mask);
    return mask;
  }

  private drawAtomDetail(
    snapshot: GpuRenderSnapshot,
    atom: RegistryType,
    x: number,
    y: number,
    width: number
  ) {
    const taxonomy = taxonomyForTier(atom.tier as 1 | 2 | 3);
    this.text(this.root, atom.name, x + 18, y + 16, { size: 16, weight: '700' });
    this.text(this.root, `L${atom.tier} ${snapshot.t(`rank.${taxonomy.rank}`)} · v${atom.version} · ✓${atom.successes}/✗${atom.failures}`, x + 18, y + 43, {
      size: 10,
      color: GPU_COLORS.tiers[atom.tier as 1 | 2 | 3],
    });
    this.text(this.root, atom.description, x + 18, y + 67, {
      size: 11,
      color: GPU_COLORS.muted,
      width: width - 36,
    });
    this.text(this.root, truncate(atom.systemPrompt, 5000), x + 18, y + 130, {
      size: 10,
      mono: true,
      width: width - 36,
    });
  }

  private drawRegistry(snapshot: GpuRenderSnapshot, width: number, height: number) {
    const payload = snapshot.data.registry;
    const x = GPU_LAYOUT.gap;
    const top = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
    const leftWidth = Math.min(560, width * 0.45);
    this.panel(this.root, x, top, leftWidth, height - top - GPU_LAYOUT.gap);
    this.text(this.root, snapshot.t('nav.registry'), x + 16, top + 14, {
      size: 16,
      weight: '700',
    });
    let selectorX = x + 16;
    for (const registry of snapshot.data.registries.slice(0, 4)) {
      const buttonWidth = Math.max(70, registry.label.length * 7 + 24);
      this.button(
        this.root,
        `registry.select.${registry.id}`,
        'button',
        `${registry.label} · ${registry.counts.total}`,
        selectorX,
        top + 44,
        buttonWidth,
        30,
        snapshot.state.selectedRegistryId === registry.id,
        snapshot.onActivate
      );
      selectorX += buttonWidth + 6;
    }
    if (!payload) {
      this.text(this.root, snapshot.t('common.loading'), x + 16, top + 96);
      return;
    }
    const query = snapshot.state.search.registry;
    let y = top + 92 - snapshot.state.scrollY.registry;
    for (const tier of [3, 2, 1]) {
      const atoms = payload.types.filter(
        (atom) =>
          atom.tier === tier &&
          matchesSearchQuery(atomSearchText(atom), query)
      );
      if (!atoms.length) continue;
      this.text(this.root, snapshot.t(`lanes.l${tier}`), x + 16, y + 8, {
        size: 11,
        weight: '700',
        color: GPU_COLORS.tiers[tier as 1 | 2 | 3],
      });
      y += 28;
      for (const atom of atoms) {
        if (y > height - 35) break;
        this.button(
          this.root,
          `registry.atom.${atom.name}`,
          'button',
          `${atom.name} · ✓${atom.successes}/✗${atom.failures}`,
          x + 16,
          y,
          leftWidth - 32,
          32,
          snapshot.state.selectedRegistryAtom === atom.name,
          snapshot.onActivate,
          GPU_COLORS.tiers[tier as 1 | 2 | 3]
        );
        y += 37;
      }
      y += 8;
    }
    const rightX = x + leftWidth + GPU_LAYOUT.gap;
    this.panel(this.root, rightX, top, width - rightX - GPU_LAYOUT.gap, height - top - GPU_LAYOUT.gap);
    const atom = payload.types.find((item) => item.name === snapshot.state.selectedRegistryAtom) ?? payload.types[0];
    if (atom) this.drawAtomDetail(snapshot, atom, rightX, top, width - rightX - GPU_LAYOUT.gap);
  }

  private drawSkills(snapshot: GpuRenderSnapshot, width: number, height: number) {
    const top = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
    const leftWidth = Math.min(560, width * 0.45);
    this.panel(this.root, GPU_LAYOUT.gap, top, leftWidth, height - top - GPU_LAYOUT.gap);
    this.text(this.root, snapshot.t('nav.skills'), 26, top + 14, { size: 16, weight: '700' });
    const query = snapshot.state.search.skills;
    let y = top + 100 - snapshot.state.scrollY.skills;
    for (const namespace of snapshot.data.skillNamespaces) {
      const skills = (snapshot.data.skillsByNamespace[namespace.l1Name] ?? []).filter((skill) =>
        matchesSearchQuery(skillSearchText(skill, namespace.l1Name), query)
      );
      if (!skills.length) continue;
      this.text(this.root, `${namespace.l1Name} (${skills.length})`, 26, y, {
        size: 11,
        weight: '700',
        color: GPU_COLORS.tiers[1],
      });
      y += 24;
      for (const skill of skills) {
        if (y > height - 36) break;
        this.button(
          this.root,
          `skill.select.${namespace.l1Name}::${skill.id}`,
          'button',
          `${skill.id} · ✓${skill.successes}/✗${skill.failures}`,
          26,
          y,
          leftWidth - 32,
          31,
          snapshot.state.selectedSkill?.l1Name === namespace.l1Name &&
            snapshot.state.selectedSkill.id === skill.id,
          snapshot.onActivate,
          skill.kind === 'script' ? GPU_COLORS.warning : GPU_COLORS.primary
        );
        y += 36;
      }
      y += 10;
    }
    const rightX = leftWidth + GPU_LAYOUT.gap * 2;
    const rightWidth = width - rightX - GPU_LAYOUT.gap;
    this.panel(this.root, rightX, top, rightWidth, height - top - GPU_LAYOUT.gap);
    const skill = snapshot.data.skillDetail;
    if (!skill) {
      this.text(this.root, snapshot.t('pane.selectSkill'), rightX + 18, top + 20, {
        color: GPU_COLORS.muted,
      });
      return;
    }
    this.text(this.root, skill.id, rightX + 18, top + 16, { size: 16, weight: '700' });
    this.text(this.root, `${skill.kind} · ✓${skill.successes}/✗${skill.failures}`, rightX + 18, top + 44, {
      size: 10,
      color: skill.kind === 'script' ? GPU_COLORS.warning : GPU_COLORS.primary,
    });
    this.text(this.root, skill.description, rightX + 18, top + 70, {
      size: 11,
      width: rightWidth - 36,
    });
    let bodyY = top + 132;
    if (skill.shareability) {
      const blocked = skill.shareability.verdict === 'blocked';
      this.panel(
        this.root,
        rightX + 18,
        top + 118,
        rightWidth - 36,
        58,
        blocked ? 0x361921 : 0x112c25,
        blocked ? GPU_COLORS.error : GPU_COLORS.success
      );
      this.text(
        this.root,
        snapshot.t(`skill.share.${skill.shareability.verdict}`),
        rightX + 30,
        top + 130,
        {
          size: 10,
          color: blocked ? GPU_COLORS.error : GPU_COLORS.success,
          weight: '700',
          width: rightWidth - 60,
        }
      );
      bodyY = top + 192;
    }
    this.text(this.root, truncate(skill.body ?? '', 6000), rightX + 18, bodyY, {
      size: 10,
      mono: true,
      width: rightWidth - 36,
    });
  }

  private drawBurninChart(
    parent: Container,
    x: number,
    y: number,
    width: number,
    height: number,
    rows: BurninRow[]
  ) {
    const firstAppearance = !this.seenAnimatedControls.has('burnin.chart');
    this.seenAnimatedControls.add('burnin.chart');
    const chart = new Container();
    chart.position.set(x, y);
    chart.eventMode = 'static';
    chart.cursor = 'crosshair';
    chart.hitArea = new Rectangle(0, 0, width, height);

    const frame = new Graphics();
    frame.roundRect(0, 0, width, height, 8);
    frame.fill({ color: 0x0d1626, alpha: 0.9 });
    frame.stroke({ color: 0x263a5a, width: 1.1, alpha: 0.9 });
    chart.addChild(frame);

    const grid = new Graphics();
    for (let index = 1; index < 6; index++) {
      const gx = 28 + index / 6 * (width - 48);
      grid.moveTo(gx, 14).lineTo(gx, height - 24);
    }
    for (let index = 1; index < 5; index++) {
      const gy = 12 + index / 5 * (height - 38);
      grid.moveTo(28, gy).lineTo(width - 14, gy);
    }
    grid.stroke({ color: 0x4e6d9f, width: 0.6, alpha: 0.16 });
    chart.addChild(grid);

    const timestamps = rows
      .map((row) => Date.parse(row.ts))
      .filter(Number.isFinite);
    const minTime = Math.min(...timestamps);
    const maxTime = Math.max(...timestamps);
    const maxCost = Math.max(0.01, ...rows.map((row) => row.costUsd ?? 0));
    const familyColors: Record<string, number> = {
      app: 0x6ea8ff,
      cli: 0x2dd4bf,
      'cli-trio': 0x22d3ee,
      files: 0xc084fc,
      http: 0xfbbf24,
      web: 0xe879f9,
    };
    const plotWidth = width - 48;
    const plotHeight = height - 42;
    const points = rows.flatMap((row, index) => {
      if (row.costUsd === null) return [];
      const timestamp = Date.parse(row.ts);
      const px =
        28 +
        (Number.isFinite(timestamp) && maxTime > minTime
          ? (timestamp - minTime) / (maxTime - minTime)
          : index / Math.max(1, rows.length - 1)) *
          plotWidth;
      const py = 12 + plotHeight - row.costUsd / maxCost * plotHeight;
      return [{
        row,
        x: px,
        y: py,
        color:
          row.outcome === 'delivered'
            ? familyColors[row.family] ?? GPU_COLORS.success
            : GPU_COLORS.error,
      }];
    });
    this.metrics.hitTargets.push({
      id: 'burnin.chart',
      role: 'figure',
      label: 'Burn-in cost scatter',
      x,
      y,
      width,
      height,
    });
    for (const point of points) {
      this.metrics.hitTargets.push({
        id: `burnin.point.${point.row.taskId}`,
        role: 'graphics-symbol',
        label: point.row.taskId,
        x: x + point.x - 8,
        y: y + point.y - 8,
        width: 16,
        height: 16,
      });
    }

    const pointGraphics = new Graphics();
    for (const point of points) {
      pointGraphics
        .circle(point.x, point.y, point.row.outcome === 'delivered' ? 2.8 : 4.5)
        .fill({ color: point.color, alpha: 0.88 });
    }
    chart.addChild(pointGraphics);

    const sweepTrail = Array.from({ length: 5 }, (_, index) => {
      const line = new Graphics();
      line.rect(0, 12, 1.2 + index * 0.35, plotHeight).fill({
        color: index % 2 ? GPU_COLORS.primary : GPU_COLORS.cyan,
        alpha: 0.14,
      });
      line.alpha = 0.02 + index * 0.015;
      chart.addChild(line);
      return line;
    });

    const highlight = new Graphics();
    highlight.circle(0, 0, 8).stroke({ color: 0xffffff, width: 1.4, alpha: 0.9 });
    highlight.circle(0, 0, 4).fill(0xffffff);
    highlight.alpha = 0;
    chart.addChild(highlight);

    const tooltip = new Container();
    const tooltipBg = new Graphics();
    tooltipBg.roundRect(0, 0, 210, 54, 7);
    tooltipBg.fill({ color: 0x080e19, alpha: 0.96 });
    tooltipBg.stroke({ color: GPU_COLORS.primary, width: 1.1, alpha: 0.9 });
    tooltip.addChild(tooltipBg);
    const tooltipTitle = this.text(tooltip, '', 10, 7, {
      size: 10,
      color: GPU_COLORS.text,
      weight: '700',
    });
    const tooltipMeta = this.text(tooltip, '', 10, 28, {
      size: 9,
      color: GPU_COLORS.muted,
    });
    tooltip.alpha = 0;
    chart.addChild(tooltip);

    this.text(chart, `$${maxCost.toFixed(2)}`, 5, 8, {
      size: 8,
      color: GPU_COLORS.muted,
    });
    this.text(chart, '$0', 10, height - 25, {
      size: 8,
      color: GPU_COLORS.muted,
    });
    if (Number.isFinite(minTime) && Number.isFinite(maxTime)) {
      this.text(chart, new Date(minTime).toLocaleDateString(), 28, height - 18, {
        size: 8,
        color: GPU_COLORS.muted,
      });
      const endLabel = this.text(
        chart,
        new Date(maxTime).toLocaleDateString(),
        width - 14,
        height - 18,
        { size: 8, color: GPU_COLORS.muted }
      );
      endLabel.anchor.x = 1;
    }

    let hoveredPoint: typeof points[number] | null = null;
    chart.on('pointermove', (event) => {
      const local = event.getLocalPosition(chart);
      let nearest: typeof points[number] | null = null;
      let nearestDistance = 15 * 15;
      for (const point of points) {
        const dx = point.x - local.x;
        const dy = point.y - local.y;
        const distance = dx * dx + dy * dy;
        if (distance < nearestDistance) {
          nearest = point;
          nearestDistance = distance;
        }
      }
      hoveredPoint = nearest;
      if (!nearest) {
        tooltip.alpha = 0;
        highlight.alpha = 0;
        return;
      }
      highlight.position.set(nearest.x, nearest.y);
      highlight.tint = nearest.color;
      highlight.alpha = 1;
      tooltipTitle.text = truncate(nearest.row.taskId, 32);
      tooltipMeta.text =
        `${nearest.row.family} · ${fmtCost(nearest.row.costUsd)} · ` +
        `${nearest.row.durationS ?? '?'}s · ${nearest.row.outcome}`;
      tooltip.position.set(
        Math.max(8, Math.min(width - 218, nearest.x + 12)),
        Math.max(8, Math.min(height - 62, nearest.y - 62))
      );
      tooltip.alpha = 1;
    });
    chart.on('pointerout', () => {
      hoveredPoint = null;
      tooltip.alpha = 0;
      highlight.alpha = 0;
    });

    let elapsed = firstAppearance ? 0 : performance.now();
    chart.alpha = firstAppearance ? 0 : 1;
    const animate = (ticker: Ticker) => {
      elapsed += ticker.deltaMS;
      const entrance = Math.min(1, elapsed / 420);
      chart.alpha = 1 - (1 - entrance) ** 3;
      const sweep = 28 + (elapsed * 0.055) % Math.max(32, plotWidth);
      sweepTrail.forEach((line, index) => {
        line.x = sweep - index * 7;
        line.alpha = (0.025 + index * 0.016) * (0.55 + Math.sin(elapsed / 230) * 0.25);
      });
      if (hoveredPoint) {
        const pulse = 0.5 + Math.sin(elapsed / 110) * 0.5;
        highlight.scale.set(0.9 + pulse * 0.28);
        highlight.alpha = 0.62 + pulse * 0.38;
      }
    };
    this.addTicker(animate);
    parent.addChild(chart);
    return chart;
  }

  private drawBurnin(snapshot: GpuRenderSnapshot, width: number, height: number) {
    const payload = snapshot.data.burnin;
    if (!payload?.rows.length) {
      this.text(this.root, snapshot.t('burnin.empty', { path: payload?.csvPath ?? '' }), 20, 78, {
        size: 13,
      });
      return;
    }
    const top = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
    const latestTimestamp = Math.max(
      ...payload.rows.map((row) => Date.parse(row.ts)).filter(Number.isFinite)
    );
    const presetDays =
      snapshot.state.burninPreset === 'all' ? null : Number(snapshot.state.burninPreset);
    const rows = payload.rows.filter((row) => {
      if (snapshot.state.burninFamily !== 'all' && row.family !== snapshot.state.burninFamily) return false;
      if (
        snapshot.state.burninOutcome !== 'all' &&
        (snapshot.state.burninOutcome === 'delivered'
          ? row.outcome !== 'delivered'
          : row.outcome === 'delivered')
      ) return false;
      if (
        presetDays !== null &&
        Number.isFinite(latestTimestamp) &&
        Date.parse(row.ts) < latestTimestamp - presetDays * 86_400_000
      ) return false;
      return true;
    });
    const families = [...new Set(payload.rows.map((row) => row.family))].sort();
    let x = GPU_LAYOUT.gap;
    let familyY = top;
    const addFamilyFilter = (id: string, label: string, active: boolean) => {
      const buttonWidth = gpuFilterButtonWidth(label);
      if (x + buttonWidth > width - GPU_LAYOUT.gap && x > GPU_LAYOUT.gap) {
        x = GPU_LAYOUT.gap;
        familyY += 34;
      }
      this.filterButton(
        this.root,
        id,
        label,
        x,
        familyY,
        buttonWidth,
        30,
        active,
        snapshot.onActivate
      );
      x += buttonWidth + 6;
    };
    addFamilyFilter('burnin.family.all', snapshot.t('burnin.all'), snapshot.state.burninFamily === 'all');
    for (const family of families.slice(0, 7)) {
      addFamilyFilter(`burnin.family.${family}`, family, snapshot.state.burninFamily === family);
    }
    let optionX = GPU_LAYOUT.gap;
    let optionY = familyY + 36;
    const addOptionFilter = (id: string, label: string, active: boolean) => {
      const buttonWidth = gpuFilterButtonWidth(label);
      if (optionX + buttonWidth > width - GPU_LAYOUT.gap && optionX > GPU_LAYOUT.gap) {
        optionX = GPU_LAYOUT.gap;
        optionY += 32;
      }
      this.filterButton(
        this.root,
        id,
        label,
        optionX,
        optionY,
        buttonWidth,
        28,
        active,
        snapshot.onActivate
      );
      optionX += buttonWidth + 6;
    };
    for (const outcome of ['all', 'delivered', 'failed']) {
      const label =
        outcome === 'all'
          ? snapshot.t('burnin.all')
          : outcome === 'delivered'
            ? snapshot.t('burnin.deliveredOnly')
            : snapshot.t('burnin.failedOnly');
      addOptionFilter(
        `burnin.outcome.${outcome}`,
        label,
        snapshot.state.burninOutcome === outcome
      );
    }
    optionX += 10;
    for (const preset of ['all', '1', '7', '30']) {
      const label =
        preset === 'all'
          ? snapshot.t('burnin.allTime')
          : preset === '1'
            ? snapshot.t('burnin.last24h')
            : preset === '7'
              ? snapshot.t('burnin.last7d')
              : snapshot.t('burnin.last30d');
      addOptionFilter(
        `burnin.preset.${preset}`,
        label,
        snapshot.state.burninPreset === preset
      );
    }
    const delivered = rows.filter((row) => row.outcome === 'delivered').length;
    const costs = rows.flatMap((row) => row.costUsd === null ? [] : [row.costUsd]);
    const durations = rows.flatMap((row) => row.durationS === null ? [] : [row.durationS]);
    const stats = [
      [snapshot.t('burnin.runsSelected'), String(rows.length)],
      [snapshot.t('burnin.deliveryRate'), `${Math.round(delivered / Math.max(1, rows.length) * 100)}%`],
      [snapshot.t('burnin.medianCost'), fmtCost(quantile(costs, 0.5))],
      [snapshot.t('burnin.p90Duration'), `${quantile(durations, 0.9) ?? '—'}s`],
    ];
    const burninStatAccents = [
      GPU_COLORS.primary,
      GPU_COLORS.success,
      GPU_COLORS.cyan,
      GPU_COLORS.warning,
    ];
    const statsY = optionY + 38;
    const statWidth = (width - GPU_LAYOUT.gap * 5) / 4;
    stats.forEach(([label, value], index) => {
      const statX = GPU_LAYOUT.gap + index * (statWidth + GPU_LAYOUT.gap);
      this.statCard(
        this.root,
        `burnin.stat.${index}`,
        label!,
        value!,
        statX,
        statsY,
        statWidth,
        58,
        burninStatAccents[index] ?? GPU_COLORS.primary
      );
    });
    const chartY = statsY + 68;
    const chartHeight = Math.min(280, height * 0.34);
    this.drawBurninChart(
      this.root,
      GPU_LAYOUT.gap,
      chartY,
      width - GPU_LAYOUT.gap * 2,
      chartHeight,
      rows
    );

    const tableY = chartY + chartHeight + 10;
    const availableRows = Math.min(PAGE_SIZE, Math.max(1, Math.floor((height - tableY - 40) / 25)));
    const pageCount = Math.max(1, Math.ceil(rows.length / availableRows));
    const page = Math.min(snapshot.state.burninPage, pageCount);
    const pageRows = rows.slice().reverse().slice((page - 1) * availableRows, page * availableRows);
    pageRows.forEach((row, index) => {
      const rowY = tableY + index * 25;
      if (index % 2 === 0) this.panel(this.root, GPU_LAYOUT.gap, rowY, width - GPU_LAYOUT.gap * 2, 24, 0x0f1725, 0x0f1725, 0);
      this.text(this.root, row.outcome === 'delivered' ? '✓' : '✗', 18, rowY + 4, {
        size: 11,
        color: row.outcome === 'delivered' ? GPU_COLORS.success : GPU_COLORS.error,
      });
      this.text(this.root, truncate(row.taskId, 60), 40, rowY + 4, { size: 10, width: width * 0.5 });
      this.text(this.root, `${fmtCost(row.costUsd)} · ${row.durationS ?? '?'}s`, width * 0.58, rowY + 4, {
        size: 10,
        color: GPU_COLORS.muted,
      });
      const lifecycle = [
        row.deterministicPhases ? `⚡${row.deterministicPhases}` : '',
        row.refusals ? `⛔${row.refusals}` : '',
        row.compileErrors ? `⚠${row.compileErrors}` : '',
        row.demotions ? `🛡${row.demotions}` : '',
        row.dispatchFallbacks ? `↩${row.dispatchFallbacks}` : '',
      ].filter(Boolean).join(' ');
      this.text(this.root, lifecycle, width * 0.79, rowY + 4, {
        size: 10,
        color: row.compileErrors ? GPU_COLORS.error : GPU_COLORS.muted,
      });
      if (row.trace) {
        this.button(this.root, `burnin.trace.${row.trace.replace(/\.json$/, '')}`, 'button', '', GPU_LAYOUT.gap, rowY, width - GPU_LAYOUT.gap * 2, 24, false, snapshot.onActivate).alpha = 0.001;
      }
    });
    this.text(this.root, `${page}/${pageCount}`, width - 110, height - 26, {
      size: 10,
      color: GPU_COLORS.muted,
    });
    if (page > 1) this.button(this.root, 'burnin.page.prev', 'button', '‹', width - 172, height - 34, 34, 25, false, snapshot.onActivate);
    if (page < pageCount) this.button(this.root, 'burnin.page.next', 'button', '›', width - 66, height - 34, 34, 25, false, snapshot.onActivate);
  }

  private drawLaunch(snapshot: GpuRenderSnapshot, width: number, height: number) {
    const top = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
    const panelWidth = Math.min(920, width - GPU_LAYOUT.gap * 2);
    const x = (width - panelWidth) / 2;
    this.panel(this.root, x, top, panelWidth, height - top - GPU_LAYOUT.gap);
    this.text(this.root, snapshot.t('nav.launch'), x + 22, top + 18, { size: 18, weight: '700' });
    this.text(this.root, snapshot.t('launch.help'), x + 22, top + 52, {
      size: 11,
      color: GPU_COLORS.muted,
      width: panelWidth - 44,
    });
    const profile = snapshot.data.profiles[0];
    if (profile) {
      this.text(this.root, profile.label, x + 22, top + 92, {
        size: 13,
        weight: '700',
        color: GPU_COLORS.primary,
      });
      this.text(this.root, profile.help, x + 22, top + 122, {
        size: 11,
        color: GPU_COLORS.muted,
        width: panelWidth - 44,
      });
      let exampleY = top + 240;
      const exampleWidth = (panelWidth - 66) / 2;
      profile.examples.forEach((example, index) => {
        this.button(
          this.root,
          `launch.example.${index}`,
          'button',
          truncate(example, 90),
          x + 22,
          exampleY,
          exampleWidth,
          36,
          false,
          snapshot.onActivate
        );
        exampleY += 43;
      });
      const command = snapshot.state.search.launch.trim()
        ? `npm run ${profile.npmScript} -- "${snapshot.state.search.launch.trim().replace(/"/g, '\\"')}"`
        : snapshot.t('launch.empty');
      const commandY = Math.min(height - 118, Math.max(top + 430, exampleY + 18));
      this.panel(this.root, x + 22, commandY, panelWidth - 150, 68, 0x0b111e);
      this.text(this.root, command, x + 34, commandY + 12, {
        size: 10,
        mono: true,
        width: panelWidth - 180,
      });
      this.button(this.root, 'launch.copy', 'button', snapshot.t('launch.copy'), x + panelWidth - 114, commandY, 92, 68, false, snapshot.onActivate);
    }
  }
}

// Pixi owns an imperative object graph whose instances survive React Fast
// Refresh. Replacing this class in place can leave an old instance calling a
// newly-added prototype method, so renderer edits deliberately trigger one
// clean reload instead of attempting stateful HMR.
if (import.meta.hot) {
  import.meta.hot.accept(() => window.location.reload());
}
