import type { LaunchProfile } from './types.js';

export function launchCommand(profile: LaunchProfile | undefined, goal: string): string {
  if (!profile || !goal.trim()) return '';
  return `npm run ${profile.npmScript} -- "${goal.trim().replace(/"/g, '\\"')}"`;
}
