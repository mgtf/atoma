import { useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { Group } from 'three';
import { buildTimelineLayout } from '../client/timeline-layout.js';
import type { EventFilters } from '../client/run-utils.js';
import type { VizRun } from '../client/types.js';
import type { GpuTimelineViewport } from './gpu-renderer.js';

const BRANCH_COLORS = [
  '#22d3ee',
  '#e879f9',
  '#4ade80',
  '#fbbf24',
  '#6ea8ff',
  '#fb7185',
  '#a78bfa',
  '#2dd4bf',
] as const;

function Segment({
  from,
  to,
  z,
  color,
  opacity,
  thickness,
}: {
  from: readonly [number, number];
  to: readonly [number, number];
  z: number;
  color: string;
  opacity: number;
  thickness: number;
}) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  return (
    <mesh
      position={[(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, z]}
      rotation={[0, 0, Math.atan2(dy, dx)]}
    >
      <boxGeometry args={[Math.max(0.001, length), thickness, thickness * 1.7]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.8}
        transparent
        opacity={opacity}
        depthWrite={false}
        roughness={0.28}
        metalness={0.35}
      />
    </mesh>
  );
}

export function RunsTimelineRails({
  run,
  filters,
  timelineViewport,
  animate,
}: {
  run: VizRun | null;
  filters: EventFilters;
  timelineViewport: GpuTimelineViewport | null;
  animate: boolean;
}) {
  const group = useRef<Group>(null);
  const { size, viewport } = useThree();
  // Same row space as the Pixi timeline it projects behind, newest first
  // included: a chronological layout mirrors every row and the backdrop rails
  // end nowhere near the branch they belong to.
  const layout = useMemo(
    () => buildTimelineLayout(run?.events ?? [], filters, { newestFirst: true }),
    [filters, run?.events]
  );
  useFrame((state) => {
    if (!group.current) return;
    group.current.position.z = animate
      ? Math.sin(state.clock.elapsedTime * 0.55) * 0.025
      : 0;
  });
  if (!timelineViewport || layout.items.length === 0) return null;

  const worldX = (pixels: number) =>
    (pixels / Math.max(1, size.width) - 0.5) * viewport.width;
  const worldY = (pixels: number) =>
    (0.5 - pixels / Math.max(1, size.height)) * viewport.height;
  const worldWidth = (pixels: number) =>
    pixels / Math.max(1, size.width) * viewport.width;
  const worldHeight = (pixels: number) =>
    pixels / Math.max(1, size.height) * viewport.height;
  const rowCenterPx = (row: number) =>
    timelineViewport.top +
    timelineViewport.contentTopPadding +
    row * timelineViewport.rowHeight -
    timelineViewport.scrollY +
    (timelineViewport.rowHeight - 10) / 2;
  // The view frames its events with bookend rows; overlays project onto the
  // same grid or they drift by exactly one row.
  const displayRow = (row: number) => row + timelineViewport.rowOffset;
  const railPx = (lane: number) =>
    timelineViewport.railBaseX + lane * timelineViewport.laneSpacing;
  const minRow = Math.max(
    0,
    Math.floor(
      Math.max(
        0,
        timelineViewport.scrollY - timelineViewport.contentTopPadding
      ) / timelineViewport.rowHeight
    ) - 1
  );
  const maxRow = Math.min(
    layout.items.length + timelineViewport.rowOffset,
    Math.ceil(
      Math.max(
        0,
        timelineViewport.scrollY +
          timelineViewport.height -
          timelineViewport.contentTopPadding
      ) / timelineViewport.rowHeight
    ) + 1
  );
  const visibleItems = layout.items.filter(
    (item) => displayRow(item.row) >= minRow && displayRow(item.row) <= maxRow
  );
  const visibleBranches = layout.branches
    .filter(
      (branch) =>
        displayRow(branch.subtreeLastRow) >= minRow &&
        displayRow(branch.subtreeFirstRow) <= maxRow
    )
    .slice(0, 8);
  const shownBranchIds = new Set(visibleBranches.map((branch) => branch.id));
  const topPx = timelineViewport.top;
  const bottomPx = timelineViewport.top + timelineViewport.height;
  const clampY = (value: number) => Math.max(topPx, Math.min(bottomPx, value));

  return (
    <group ref={group}>
      <Segment
        from={[worldX(railPx(0)), worldY(clampY(rowCenterPx(minRow)))]}
        to={[worldX(railPx(0)), worldY(clampY(rowCenterPx(maxRow)))]}
        z={-0.42}
        color="#6ea8ff"
        opacity={0.38}
        thickness={0.025}
      />
      {visibleBranches.map((branch) => {
        const color = BRANCH_COLORS[branch.colorIndex % BRANCH_COLORS.length]!;
        const selected = filters.branchId === branch.id;
        return (
          <Segment
            key={`rail-${branch.id}`}
            from={[
              worldX(railPx(branch.lane)),
              worldY(clampY(rowCenterPx(displayRow(branch.subtreeFirstRow)))),
            ]}
            to={[
              worldX(railPx(branch.lane)),
              worldY(clampY(rowCenterPx(displayRow(branch.subtreeLastRow)))),
            ]}
            z={-0.34 + branch.lane * 0.055}
            color={color}
            opacity={selected ? 0.88 : 0.52}
            thickness={selected ? 0.036 : 0.027}
          />
        );
      })}
      {layout.connectors
        .filter(
          (connector) =>
            shownBranchIds.has(connector.branchId) &&
            displayRow(connector.row) >= minRow &&
            displayRow(connector.row) <= maxRow
        )
        .map((connector) => {
          const branch = layout.branches.find(
            (candidate) => candidate.id === connector.branchId
          );
          const color = branch
            ? BRANCH_COLORS[branch.colorIndex % BRANCH_COLORS.length]!
            : '#6ea8ff';
          const y = worldY(clampY(rowCenterPx(displayRow(connector.row))));
          return (
            <Segment
              key={`${connector.kind}-${connector.branchId}-${connector.row}`}
              from={[worldX(railPx(connector.fromLane)), y]}
              to={[worldX(railPx(connector.toLane)), y]}
              z={-0.3 + connector.toLane * 0.055}
              color={color}
              opacity={connector.kind === 'fork' ? 0.7 : 0.42}
              thickness={connector.kind === 'fork' ? 0.028 : 0.02}
            />
          );
        })}
      {visibleItems.map((item) => {
        const branchOffset = item.lane * timelineViewport.branchCardOffset;
        const cardLeft = timelineViewport.cardBaseX + branchOffset;
        const cardWidth = Math.max(
          80,
          timelineViewport.cardBaseWidth - branchOffset
        );
        const cardTop =
          timelineViewport.top +
          timelineViewport.contentTopPadding +
          displayRow(item.row) * timelineViewport.rowHeight -
          timelineViewport.scrollY;
        const tierDepth =
          item.tier === 3 ? 0.18 : item.tier === 2 ? 0.1 : item.tier === 1 ? 0.03 : -0.03;
        const branch = item.branchId
          ? layout.branches.find((candidate) => candidate.id === item.branchId)
          : undefined;
        const color = branch
          ? BRANCH_COLORS[branch.colorIndex % BRANCH_COLORS.length]!
          : '#6ea8ff';
        return (
          <mesh
            key={`card-${item.event.id}`}
            position={[
              worldX(cardLeft + cardWidth / 2),
              worldY(cardTop + (timelineViewport.rowHeight - 10) / 2),
              tierDepth + item.lane * 0.045,
            ]}
          >
            <boxGeometry
              args={[
                worldWidth(cardWidth),
                worldHeight(timelineViewport.rowHeight - 10),
                0.055 + item.lane * 0.008,
              ]}
            />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={0.22}
              transparent
              opacity={0.045 + item.lane * 0.012}
              depthWrite={false}
              roughness={0.4}
              metalness={0.25}
            />
          </mesh>
        );
      })}
    </group>
  );
}
