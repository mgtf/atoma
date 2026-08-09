import type { TaskProfile } from '../profile.js';
import { buildProfile } from './build.js';

/**
 * A family the operator can actually start, and the npm script that starts it.
 *
 * The registry and the command are ONE object on purpose: a family that
 * appears in a picker but has no way to be launched is a dead entry, and a
 * command list maintained separately from the family list is the drift this
 * whole refactor exists to stop (measured twice already — `research-brief.ts`
 * and the curriculum provider switch).
 */
export interface LaunchableProfile {
  readonly profile: TaskProfile;
  /** npm script name, as in `npm run <npmScript> -- "<goal>"`. */
  readonly npmScript: string;
}

export const LAUNCHABLE_PROFILES: readonly LaunchableProfile[] = [
  { profile: buildProfile, npmScript: 'run:build' },
];

export function findLaunchable(id: string): LaunchableProfile | undefined {
  return LAUNCHABLE_PROFILES.find((p) => p.profile.id === id);
}
