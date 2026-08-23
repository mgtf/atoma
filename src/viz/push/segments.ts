import type { AnnouncementSegment } from '../../contracts/announcements.js';

/**
 * WHICH ORGANISATIONS A SEGMENT NAMES.
 *
 * A pure function over the project rows, so the rule is testable without a
 * database and so the router never learns what a project is: the emitter
 * resolves the segment once, at send time, and journals the answer.
 *
 * `null` means "name no organisations", which the audience resolver reads as
 * the widest reach. That is deliberately NOT an empty array: an empty list
 * would say "these zero organisations" and must never be mistaken for
 * "everyone" — the difference between a broadcast and a send to nobody.
 */

export interface SegmentProject {
  readonly orgId: string;
  readonly status: string;
}

export function organisationsForSegment(
  segment: AnnouncementSegment,
  projects: readonly SegmentProject[]
): string[] | null {
  if (segment === 'all') return null;
  const matching = projects.filter(
    (project) => segment === 'with-project' || project.status === 'published'
  );
  return [...new Set(matching.map((project) => project.orgId))].sort();
}
