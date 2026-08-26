/**
 * One interactive target in the final Pixi renderer plane. A diagnostic that
 * drives the projected canvas must pass its centre through
 * `__ATOMA_GPU__.projectRendererPoint`; these are not raw client pixels.
 */
export interface GpuHitTarget {
  id: string;
  role: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
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
  /**
   * Display rows the view inserts above the first EVENT row (its "run ended"
   * bookend). Overlays project `layout` rows onto this grid, so they must
   * add it — the layout knows nothing about the view's bookends.
   */
  rowOffset: number;
}

export interface GpuRenderMetrics {
  backend: 'webgpu' | 'webgl' | 'unknown';
  objectCount: number;
  runCollapseOffset: number;
  visibleLabels: string[];
  hitTargets: GpuHitTarget[];
  timelineViewport?: GpuTimelineViewport;
  /**
   * Wall time of the last `render()` — the scene REBUILD, not the frame. The
   * two are measured separately on purpose: an rAF interval saturates at
   * vsync, so it detects dropped frames but can never show the margin a
   * rebuild eats. This is the number that moves when a wheel tick gets
   * cheaper.
   */
  renderMs: number;
  /** Labels built from scratch in the last render — see `LabelCache.created`. */
  labelsCreated: number;
  /** Labels served from the retention pool in the last render. */
  labelsReused: number;
}

/**
 * THE zero state for render metrics. The renderer, the app shell and the view
 * tests all need one before a first render has happened; three hand-written
 * literals meant every new counter had to be added in three places.
 */
export function emptyRenderMetrics(): GpuRenderMetrics {
  return {
    backend: 'unknown',
    objectCount: 0,
    runCollapseOffset: 0,
    visibleLabels: [],
    hitTargets: [],
    renderMs: 0,
    labelsCreated: 0,
    labelsReused: 0,
  };
}
