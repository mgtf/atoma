import {
  Application,
  Container,
  Graphics,
  Rectangle,
  RendererType,
  Text,
  TextStyle,
  Ticker,
} from 'pixi.js';
import {
  buildAtomMap,
  filterEvents,
  fmtCost,
  fmtMs,
  isRunLive,
  toolArgSummary,
  tryParseJson,
} from '../client/run-utils.js';
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
import type { GpuUiState, ViewName } from './store.js';
import { GPU_COLORS, GPU_LAYOUT } from './theme.js';

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

export interface GpuRenderMetrics {
  backend: 'webgpu' | 'webgl' | 'unknown';
  objectCount: number;
  runCollapseOffset: number;
  visibleLabels: string[];
  hitTargets: GpuHitTarget[];
}

export interface GpuRenderSnapshot {
  state: GpuUiState;
  data: GpuDataSnapshot;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onActivate: (id: string) => void;
  onScroll: (view: ViewName, delta: number) => void;
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

function eventDecision(event: VizEvent): string {
  if (event.kind !== 'llm') return '';
  const parsed = tryParseJson(event.response) as Record<string, unknown> | undefined;
  if (!parsed || Array.isArray(parsed)) return '';
  if (event.role === 'prefilter') {
    return parsed['outcome'] === 'reuse'
      ? `→ ${scalar(parsed['target'], 'reuse')}`
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
  const title =
    event.kind === 'llm'
      ? event.role ?? 'llm'
      : event.kind === 'tool'
        ? event.name ?? 'tool'
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
  private previousFilterBounds = new Map<string, FilterVisualTarget>();
  private currentFilterBounds = new Map<string, FilterVisualTarget>();
  private handledExitIds = new Set<string>();
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
    for (const child of this.root.removeChildren()) child.destroy({ children: true });
    this.metrics.visibleLabels = [];
    this.metrics.hitTargets = [];
    this.metrics.runCollapseOffset = 0;
    this.currentFilterBounds = new Map();
    this.handledExitIds = new Set();
    this.scrollMax.runs = 0;

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
    this.previousFilterBounds = this.currentFilterBounds;
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

  private drawExitingFilterButtons(
    targets: FilterVisualTarget[],
    collapsingLayer: Container,
    collapseDistance: number
  ) {
    if (!targets.length) return;
    const snapshotAtStart = this.snapshot;
    collapsingLayer.y = collapseDistance;
    this.metrics.runCollapseOffset = collapseDistance;
    const groups = targets.map((target, targetIndex) => {
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

    let elapsed = 0;
    let completed = false;
    let groupsRemoved = false;
    const exitDuration = 460 + (groups.length - 1) * 18;
    const collapseDuration = 390;
    const dissolve = (ticker: Ticker) => {
      elapsed += ticker.deltaMS;
      if (!groupsRemoved) {
        for (const group of groups) {
          const local = Math.max(0, elapsed - group.delay);
          const progress = Math.min(1, local / 460);
          const dissolveProgress = Math.max(0, (progress - 0.16) / 0.84);
          group.container.alpha = 1 - dissolveProgress ** 1.45;
          const scale = 1 - dissolveProgress * 0.12;
          group.container.scale.set(scale);
          group.container.position.set(
            group.container.position.x,
            group.container.position.y - ticker.deltaMS * 0.008 * dissolveProgress
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
            fragment.fragment.rotation += ticker.deltaMS * 0.004;
          }
        }
      }
      if (!groupsRemoved && elapsed >= exitDuration) {
        groupsRemoved = true;
        for (const group of groups) {
          group.container.removeFromParent();
          group.container.destroy({ children: true });
        }
      }
      const collapseProgress = Math.max(
        0,
        Math.min(1, (elapsed - exitDuration) / collapseDuration)
      );
      if (collapseProgress > 0) {
        // A restrained ease-out-back: the content rises, overshoots by about
        // one pixel, then settles instead of snapping at the layout boundary.
        const overshoot = 1.35;
        const shifted = collapseProgress - 1;
        const eased =
          1 +
          (overshoot + 1) * shifted ** 3 +
          overshoot * shifted ** 2;
        collapsingLayer.y = collapseDistance * (1 - eased);
        this.metrics.runCollapseOffset = collapsingLayer.y;
      }
      if (!completed && collapseProgress >= 1) {
        completed = true;
        collapsingLayer.y = 0;
        this.metrics.runCollapseOffset = 0;
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

  private animateEnteringFilterSpace(layer: Container, distance: number) {
    if (distance <= 0) return;
    layer.y = -distance;
    this.metrics.runCollapseOffset = -distance;
    let elapsed = 0;
    const duration = 390;
    const expand = (ticker: Ticker) => {
      elapsed += ticker.deltaMS;
      const progress = Math.min(1, elapsed / duration);
      const overshoot = 1.35;
      const shifted = progress - 1;
      const eased =
        1 +
        (overshoot + 1) * shifted ** 3 +
        overshoot * shifted ** 2;
      layer.y = -distance * (1 - eased);
      this.metrics.runCollapseOffset = layer.y;
      if (progress >= 1) {
        layer.y = 0;
        this.metrics.runCollapseOffset = 0;
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
    [GPU_COLORS.tiers[3], GPU_COLORS.tiers[2], GPU_COLORS.tiers[1]].forEach((color, index) => {
      const dot = new Graphics();
      dot.circle(16 + index * 11, 26, 4).fill(color);
      this.root.addChild(dot);
    });
    this.text(this.root, 'Atoma', 52, 17, { size: 15, weight: '700' });

    const views: ViewName[] = ['runs', 'registry', 'skills', 'burnin', 'launch'];
    let x = 112;
    for (const view of views) {
      const label = snapshot.t(`nav.${view}`).toUpperCase();
      this.button(
        this.root,
        `nav.${view}`,
        'tab',
        label,
        x,
        10,
        Math.max(66, label.length * 7 + 22),
        32,
        snapshot.state.view === view,
        snapshot.onActivate,
        GPU_COLORS.primary,
        true
      );
      x += Math.max(66, label.length * 7 + 22) + 6;
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

  private drawOverlays(snapshot: GpuRenderSnapshot, width: number, _height: number) {
    if (snapshot.state.view !== 'runs' || snapshot.state.focusedInput !== 'run') return;
    const x = Math.max(480, width * 0.42);
    const popupWidth = Math.max(260, width - x - 120);
    const query = snapshot.state.search.run.toLocaleLowerCase();
    const matching = snapshot.data.runs
      .filter((run) => `${run.id} ${run.label}`.toLocaleLowerCase().includes(query))
      .slice(0, 12);
    const popupHeight = Math.max(42, matching.length * 43 + 8);
    this.panel(this.root, x, GPU_LAYOUT.headerHeight - 2, popupWidth, popupHeight, 0x0c1321, GPU_COLORS.primary);
    matching.forEach((run, index) => {
      const y = GPU_LAYOUT.headerHeight + 3 + index * 43;
      const active = snapshot.state.selectedRunId === run.id;
      this.button(
        this.root,
        `run.select.${run.id}`,
        'option',
        truncate(run.label.replace(/^(?:build-app|baseline):\s*/i, ''), 82),
        x + 5,
        y,
        popupWidth - 10,
        38,
        active,
        snapshot.onActivate,
        run.hasError ? GPU_COLORS.error : run.inFlight ? GPU_COLORS.success : GPU_COLORS.primary
      );
    });
    if (!matching.length) {
      this.text(this.root, snapshot.t('runs.none'), x + 14, GPU_LAYOUT.headerHeight + 12, {
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
    const statWidth = (leftWidth - 28 - GPU_LAYOUT.gap * 3) / 4;
    stats.forEach(([label, value], index) => {
      const x = leftX + 14 + index * (statWidth + GPU_LAYOUT.gap);
      this.panel(this.root, x, statsY, statWidth, 55, GPU_COLORS.panelRaised);
      this.text(this.root, label!, x + 9, statsY + 7, { size: 9, color: GPU_COLORS.muted });
      this.text(this.root, value!, x + 9, statsY + 25, { size: 13, weight: '700' });
    });

    const atoms = buildAtomMap(run);
    const laneY = statsY + 65;
    let nextLaneY = laneY;
    for (const tier of [3, 2, 1]) {
      let y = nextLaneY;
      this.text(this.root, `L${tier}`, leftX + 14, y + 7, {
        size: 10,
        color: GPU_COLORS.tiers[tier as 1 | 2 | 3],
        weight: '700',
      });
      let atomX = leftX + 46;
      for (const entry of [...atoms.values()].filter((value) => value.snapshot.tier === tier)) {
        const name = entry.snapshot.name;
        const buttonWidth = Math.min(140, gpuFilterButtonWidth(name));
        if (atomX + buttonWidth > leftX + leftWidth - 12) {
          atomX = leftX + 46;
          y += 33;
        }
        this.button(
          this.root,
          `atom.${name}`,
          'button',
          name,
          atomX,
          y,
          buttonWidth,
          28,
          snapshot.state.selectedAtomName === name,
          snapshot.onActivate,
          GPU_COLORS.tiers[tier as 1 | 2 | 3],
          true
        );
        atomX += buttonWidth + 5;
      }
      nextLaneY = y + 38;
    }

    const filterY = nextLaneY + 4;
    const kinds = ['all', 'llm', 'tool', 'trust', 'skill', 'cache', 'registry'];
    let filterX = leftX + 14;
    let kindY = filterY;
    for (const kind of kinds) {
      const label = kind.toUpperCase();
      const buttonWidth = gpuFilterButtonWidth(label);
      if (filterX + buttonWidth > leftX + leftWidth - 12 && filterX > leftX + 14) {
        filterX = leftX + 14;
        kindY += 32;
      }
      this.filterButton(
        this.root,
        `run.filter.kind.${kind}`,
        label,
        filterX,
        kindY,
        buttonWidth,
        27,
        snapshot.state.runFilters.kind === kind,
        snapshot.onActivate
      );
      filterX += buttonWidth + 5;
    }

    const controlsBottomWithoutRoles = kindY + 32;
    let controlsBottom = controlsBottomWithoutRoles;
    const roleWasVisible = [...this.previousFilterBounds.keys()].some((id) =>
      id.startsWith('run.filter.role.')
    );
    if (snapshot.state.runFilters.kind === 'all' || snapshot.state.runFilters.kind === 'llm') {
      const roles = [...new Set(run.events.flatMap((event) => event.role ? [event.role] : []))];
      if (roles.length) {
        let roleX = leftX + 14;
        let roleY = controlsBottom + 4;
        const roleOptions = ['all', ...roles];
        for (const role of roleOptions) {
          const label = role === 'all' ? 'ALL ROLES' : role.toUpperCase();
          const buttonWidth = gpuFilterButtonWidth(label);
          if (roleX + buttonWidth > leftX + leftWidth - 12 && roleX > leftX + 14) {
            roleX = leftX + 14;
            roleY += 30;
          }
          this.filterButton(
            this.root,
            `run.filter.role.${role}`,
            label,
            roleX,
            roleY,
            buttonWidth,
            25,
            snapshot.state.runFilters.role === role,
            snapshot.onActivate
          );
          roleX += buttonWidth + 5;
        }
        controlsBottom = roleY + 29;
      }
    }
    const exitingRoleFilters =
      snapshot.state.runFilters.kind !== 'all' &&
      snapshot.state.runFilters.kind !== 'llm'
        ? [...this.previousFilterBounds.values()].filter((target) =>
          target.id.startsWith('run.filter.role.')
        )
        : [];
    const lowerControlsLayer = new Container();
    this.root.addChild(lowerControlsLayer);
    if (exitingRoleFilters.length) {
      const previousRoleBottom = Math.max(
        ...exitingRoleFilters.map((target) => target.y + target.height + 4)
      );
      const collapseDistance = Math.max(0, previousRoleBottom - controlsBottom);
      this.drawExitingFilterButtons(
        exitingRoleFilters,
        lowerControlsLayer,
        collapseDistance
      );
    } else if (controlsBottom > controlsBottomWithoutRoles && !roleWasVisible) {
      this.animateEnteringFilterSpace(
        lowerControlsLayer,
        controlsBottom - controlsBottomWithoutRoles
      );
    }
    const branches = [...new Set(run.events.flatMap((event) => event.branchId ? [event.branchId] : []))];
    if (branches.length > 1) {
      let branchX = leftX + 14;
      let branchY = controlsBottom + 4;
      for (const branch of ['all', ...branches.slice(0, 5)]) {
        const label = branch === 'all' ? 'ALL BRANCHES' : `⑂ ${branch.slice(0, 6)}`;
        const buttonWidth = gpuFilterButtonWidth(label);
        if (branchX + buttonWidth > leftX + leftWidth - 12 && branchX > leftX + 14) {
          branchX = leftX + 14;
          branchY += 30;
        }
        this.filterButton(
          lowerControlsLayer,
          `run.filter.branch.${branch}`,
          label,
          branchX,
          branchY,
          buttonWidth,
          25,
          snapshot.state.runFilters.branchId === branch,
          snapshot.onActivate
        );
        branchX += buttonWidth + 5;
      }
      controlsBottom = branchY + 29;
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
        `${snapshot.t('now.title')} · ${(current.role ?? 'LLM').toUpperCase()} · ${current.actor?.name ?? '?'} · ${tools.length} tool`,
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

    const listY = controlsBottom + 7;
    const listHeight = height - listY - GPU_LAYOUT.gap;
    const listMask = new Graphics();
    listMask.rect(leftX + 10, listY, leftWidth - 20, listHeight).fill(0xffffff);
    lowerControlsLayer.addChild(listMask);
    const listLayer = new Container();
    listLayer.mask = listMask;
    lowerControlsLayer.addChild(listLayer);
    const events = filterEvents(run.events, snapshot.state.runFilters)
      .filter((event) => event.kind !== 'llm-start' || !completed.has(String(event.llmEventId)))
      .reverse();
    const rowHeight = 80;
    this.scrollMax.runs = Math.max(0, events.length * rowHeight - listHeight);
    const scrollY = snapshot.state.scrollY.runs;
    const start = Math.max(0, Math.floor(scrollY / rowHeight));
    const count = Math.ceil(listHeight / rowHeight) + 2;
    events.slice(start, start + count).forEach((event, visibleIndex) => {
      const index = start + visibleIndex;
      const y = listY + index * rowHeight - scrollY;
      if (y > listY + listHeight || y + rowHeight < listY) return;
      const selected = snapshot.state.selectedEventId === event.id;
      this.panel(
        listLayer,
        leftX + 14,
        y,
        leftWidth - 28,
        rowHeight - 6,
        selected ? 0x182b49 : GPU_COLORS.panelRaised,
        selected ? GPU_COLORS.primary : eventAccent(event)
      );
      const copy = gpuEventCardCopy(event);
      this.text(listLayer, truncate(copy.title, 30), leftX + 25, y + 8, {
        size: 11,
        weight: '700',
        color: eventAccent(event),
      });
      if (copy.meta) {
        this.text(listLayer, truncate(copy.meta, 50), leftX + 220, y + 9, {
          size: 9,
          color: GPU_COLORS.muted,
        });
      }
      if (copy.decision) {
        this.text(listLayer, copy.decision, leftX + leftWidth - 135, y + 8, {
          size: 10,
          color: copy.decision.startsWith('✕') || copy.decision.startsWith('↑')
            ? GPU_COLORS.warning
            : GPU_COLORS.success,
          weight: '700',
        });
      }
      this.text(
        listLayer,
        truncate(copy.body, 180),
        leftX + 25,
        y + 31,
        { size: 10, color: GPU_COLORS.muted, width: leftWidth - 54 }
      );
      this.text(listLayer, truncate(copy.footer, 110), leftX + 25, y + 56, {
        size: 9,
        color: event.error ? GPU_COLORS.error : GPU_COLORS.muted,
      });
      this.button(
        listLayer,
        `event.${event.id}`,
        'button',
        '',
        leftX + 14,
        y,
        leftWidth - 28,
        rowHeight - 6,
        selected,
        snapshot.onActivate,
        eventAccent(event)
      ).alpha = 0.001;
    });

    if (twoPane) {
      this.panel(this.root, rightX, top, rightWidth, height - top - GPU_LAYOUT.gap);
      const event = run.events.find((value) => value.id === snapshot.state.selectedEventId);
      const atom = snapshot.state.selectedAtomName
        ? atoms.get(snapshot.state.selectedAtomName)
        : undefined;
      if (event) this.drawEventDetail(snapshot, event, rightX, top, rightWidth, height - top);
      else if (atom) this.drawAtomDetail(atom.snapshot, rightX, top, rightWidth);
      else this.text(this.root, snapshot.t('pane.selectEvent'), rightX + 18, top + 20, {
        size: 12,
        color: GPU_COLORS.muted,
        width: rightWidth - 36,
      });
    }
  }

  private drawEventDetail(
    snapshot: GpuRenderSnapshot,
    event: VizEvent,
    x: number,
    y: number,
    width: number,
    height: number
  ) {
    this.text(this.root, event.kind === 'llm' ? event.role ?? 'LLM' : event.kind, x + 18, y + 16, {
      size: 15,
      weight: '700',
      color: eventAccent(event),
    });
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
        : event.kind === 'tool'
          ? JSON.stringify(event.error ?? event.result ?? event.args, null, 2)
          : event.reasoning ?? JSON.stringify(event, null, 2);
    const parsed = event.kind === 'llm' ? tryParseJson(raw) : undefined;
    const body = parsed === undefined ? raw : JSON.stringify(parsed, null, 2);
    this.text(this.root, truncate(body, 5000), x + 18, y + 68, {
      size: 10,
      mono: true,
      color: 0xcbd5e1,
      width: width - 36,
    }).mask = this.detailMask(x + 12, y + 62, width - 24, height - 76);
    if (event.kind === 'skill' && event.l1Name && event.skillId) {
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
  }

  private detailMask(x: number, y: number, width: number, height: number) {
    const mask = new Graphics();
    mask.rect(x, y, width, height).fill(0xffffff);
    this.root.addChild(mask);
    return mask;
  }

  private drawAtomDetail(atom: RegistryType, x: number, y: number, width: number) {
    this.text(this.root, atom.name, x + 18, y + 16, { size: 16, weight: '700' });
    this.text(this.root, `L${atom.tier} · v${atom.version} · ✓${atom.successes}/✗${atom.failures}`, x + 18, y + 43, {
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
    const query = snapshot.state.search.registry.toLowerCase();
    let y = top + 92 - snapshot.state.scrollY.registry;
    for (const tier of [3, 2, 1]) {
      this.text(this.root, `L${tier}`, x + 16, y + 8, {
        size: 11,
        weight: '700',
        color: GPU_COLORS.tiers[tier as 1 | 2 | 3],
      });
      y += 28;
      const atoms = payload.types.filter(
        (atom) =>
          atom.tier === tier &&
          `${atom.name} ${atom.description}`.toLowerCase().includes(query)
      );
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
    if (atom) this.drawAtomDetail(atom, rightX, top, width - rightX - GPU_LAYOUT.gap);
  }

  private drawSkills(snapshot: GpuRenderSnapshot, width: number, height: number) {
    const top = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
    const leftWidth = Math.min(560, width * 0.45);
    this.panel(this.root, GPU_LAYOUT.gap, top, leftWidth, height - top - GPU_LAYOUT.gap);
    this.text(this.root, snapshot.t('nav.skills'), 26, top + 14, { size: 16, weight: '700' });
    const query = snapshot.state.search.skills.toLowerCase();
    let y = top + 100 - snapshot.state.scrollY.skills;
    for (const namespace of snapshot.data.skillNamespaces) {
      const skills = (snapshot.data.skillsByNamespace[namespace.l1Name] ?? []).filter((skill) =>
        `${skill.id} ${skill.description} ${skill.whenToUse}`.toLowerCase().includes(query)
      );
      if (query && !skills.length) continue;
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
    const statsY = optionY + 38;
    const statWidth = (width - GPU_LAYOUT.gap * 5) / 4;
    stats.forEach(([label, value], index) => {
      const statX = GPU_LAYOUT.gap + index * (statWidth + GPU_LAYOUT.gap);
      this.panel(this.root, statX, statsY, statWidth, 58, GPU_COLORS.panelRaised);
      this.text(this.root, label!, statX + 10, statsY + 8, { size: 9, color: GPU_COLORS.muted });
      this.text(this.root, value!, statX + 10, statsY + 28, { size: 14, weight: '700' });
    });
    const chartY = statsY + 68;
    const chartHeight = Math.min(280, height * 0.34);
    this.panel(this.root, GPU_LAYOUT.gap, chartY, width - GPU_LAYOUT.gap * 2, chartHeight);
    const plot = new Graphics();
    const usableWidth = width - GPU_LAYOUT.gap * 2 - 48;
    const usableHeight = chartHeight - 44;
    const withCost = rows.filter((row) => row.costUsd !== null);
    const maxCost = Math.max(0.01, ...withCost.map((row) => row.costUsd ?? 0));
    withCost.forEach((row, index) => {
      const px = GPU_LAYOUT.gap + 30 + index / Math.max(1, withCost.length - 1) * usableWidth;
      const py = chartY + 16 + usableHeight - (row.costUsd ?? 0) / maxCost * usableHeight;
      const color = row.outcome === 'delivered' ? GPU_COLORS.success : GPU_COLORS.error;
      plot.circle(px, py, row.outcome === 'delivered' ? 3 : 5).fill({ color, alpha: 0.85 });
    });
    this.root.addChild(plot);

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
