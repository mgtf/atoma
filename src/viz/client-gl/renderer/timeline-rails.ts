/**
 * Pure rail geometry for the runs timeline: where a fork/join connector meets
 * the two rails it links. No Pixi objects here — a recording test can assert
 * every endpoint without a renderer.
 *
 * One rule, both kinds: the connector ENDS on the branch rail at the
 * connector's own row, and ANCHORS on the PARENT rail just outside the
 * branch's span. Reading `fromLane`/`toLane` literally put the anchor on the
 * CHILD for joins, so a branch's end was drawn as a hook floating half a row
 * above its own rail, pointing at the trunk from nowhere (observed on a real
 * run, 2026-08-15).
 */

/** Half-row offset that keeps the anchor clear of the branch's own end dot. */
export const CONNECTOR_ANCHOR_ROWS = 0.55;

export interface TimelineConnectorGeometry {
  readonly parentLane: number;
  readonly branchLane: number;
  /** On the parent rail, just outside the branch's span — never past its end. */
  readonly parentY: number;
  /** On the branch rail, exactly at the causal end the connector describes. */
  readonly branchY: number;
}

export function timelineConnectorGeometry(options: {
  readonly kind: 'fork' | 'join';
  readonly fromLane: number;
  readonly toLane: number;
  readonly connectorY: number;
  readonly rowHeight: number;
  /** `TimelineLayout.chronological`: true when row 0 is the oldest event. */
  readonly chronological: boolean;
  /** Drawn span of the parent rail, so the anchor can never leave it. */
  readonly parentTopY: number;
  readonly parentBottomY: number;
}): TimelineConnectorGeometry {
  const fork = options.kind === 'fork';
  // The layout names the lanes by travel direction; the geometry needs them by
  // role, and a join travels child → parent.
  const branchLane = fork ? options.toLane : options.fromLane;
  const parentLane = fork ? options.fromLane : options.toLane;
  // A fork is the branch's causally FIRST moment and a join its last, so the
  // anchor sits on the earlier/later side of it. Which way that is on screen
  // depends on the row order, not on the kind alone.
  const outward = fork === options.chronological ? -1 : 1;
  const anchorY =
    options.connectorY + outward * options.rowHeight * CONNECTOR_ANCHOR_ROWS;
  const upper = Math.min(options.parentTopY, options.parentBottomY);
  const lower = Math.max(options.parentTopY, options.parentBottomY);
  return {
    parentLane,
    branchLane,
    parentY: Math.max(upper, Math.min(lower, anchorY)),
    branchY: options.connectorY,
  };
}
