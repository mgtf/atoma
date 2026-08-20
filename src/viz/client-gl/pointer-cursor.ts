/**
 * The custom pointer's silhouette. Shared by the HTML cursor overlay and the
 * Pixi echo that the welcome gem reflects — one path, two places it is drawn.
 */
export const ATOMA_CURSOR_HOTSPOT = { x: 12, y: 12 } as const;
export const ATOMA_CURSOR_PATH =
  'M12 12 L13.15 31.7 L18.45 27.15 L22.15 35.45 L26.3 33.55 L22.55 25.55 L30.85 24.25 Z';

export function atomaCursorPoints(): { x: number; y: number }[] {
  const nums = [...ATOMA_CURSOR_PATH.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) =>
    Number(match[0])
  );
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index + 1 < nums.length; index += 2) {
    points.push({ x: nums[index]!, y: nums[index + 1]! });
  }
  return points;
}
