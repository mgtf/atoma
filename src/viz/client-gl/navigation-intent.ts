import { useCallback, useRef } from 'react';
import type { SceneCameraMode } from './scene-camera.js';

/**
 * WHAT A ROUTE WAS: how far the click travelled down the rail, in which
 * direction, and whether it left the group it was in.
 *
 * The cube turn reads all three — rows set the duration, the group boundary
 * sets the axis, the direction sets which way the box swings. It is kept apart
 * from the driver because remembering the PREVIOUS destination is the whole
 * subtlety here, and it belongs to the last committed effect rather than to
 * the last render.
 */

export interface NavigationIntent {
  /** The destination. A change of KEY is what makes a route a route: a
   *  re-render for data, a selection or a resize must never look like one. */
  readonly key: string;
  /** Row in the visible rail, or -1 for a surface reached from elsewhere. */
  readonly rank: number;
  /** The rail group the destination belongs to. */
  readonly group: string;
}

export interface NavigationRoute {
  readonly rowDistance: number;
  readonly sameGroup: boolean;
  /** True when the destination sits further DOWN the rail than the origin. */
  readonly descending: boolean;
}

export interface NavigationChange {
  /** A route happened: same camera mode, a different destination. */
  readonly navigated: boolean;
  readonly route: NavigationRoute;
}

const FIRST_ROUTE: NavigationRoute = {
  rowDistance: 1,
  sameGroup: true,
  descending: true,
};

/**
 * Returns the reader to call INSIDE a layout effect, never during a render.
 *
 * The previous destination is state that belongs to the last committed effect,
 * not to the last render: React may render twice for one commit, and a reader
 * that advanced its memory during a render would report the second pass as a
 * route to the place it already was.
 */
export function useNavigationTracker(): (
  mode: SceneCameraMode,
  navigation: NavigationIntent | undefined
) => NavigationChange {
  const previous = useRef<{ mode: SceneCameraMode; intent: NavigationIntent } | null>(null);
  // STABLE across renders, and that is not a micro-optimisation: the reader is
  // a dependency of the effects that move the scene, so a fresh identity per
  // render would re-run them, and the camera's settle callback re-renders —
  // the loop React caught as "maximum update depth exceeded".
  return useCallback((mode, navigation) => {
    const last = previous.current;
    if (navigation) previous.current = { mode, intent: navigation };
    else previous.current = last ? { ...last, mode } : null;
    if (!last || !navigation || last.mode !== mode || last.intent.key === navigation.key) {
      return { navigated: false, route: FIRST_ROUTE };
    }
    const ranked = last.intent.rank >= 0 && navigation.rank >= 0;
    return {
      navigated: true,
      route: {
        rowDistance: ranked ? Math.abs(navigation.rank - last.intent.rank) : 1,
        sameGroup: last.intent.group === navigation.group,
        // A surface with no row of its own is reached, never descended to.
        descending: ranked ? navigation.rank > last.intent.rank : true,
      },
    };
  }, []);
}
