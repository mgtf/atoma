import { homedir } from 'node:os';
import { sep } from 'node:path';
import type { ProjectRun } from '../contracts/projects.js';
import { skillsDirPath } from '../core/stores.js';
import { repoRoot } from '../mcp/run.js';

/**
 * WHAT A TENANT MAY NOT READ: THE HOST'S LAYOUT.
 *
 * A runner log and a run's error name where the host keeps a run (`workspace
 * seeded from …`, `skills root: …`, npm's argv with `--seed`, an `ENOENT`
 * path). Below the platform tier those are the deployment's layout, which the
 * public run projection and `commonsForTier` already withhold (2026-09-25
 * review, 2.2). One module, because the MCP log reader and the projects
 * service must withhold the same thing.
 */

/** A host location to replace by a label a tenant may read. */
export interface HostPathRedaction {
  readonly path: string;
  readonly label: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace each host location by its label, longest first so a nested root is
 * never half-replaced, and only where the location is WHOLE: `/home/atoma`
 * is not a prefix of `/home/atoma2` nor the tail of `/srv/home/atoma`.
 */
export function redactHostPaths(text: string, redactions: readonly HostPathRedaction[]): string {
  let out = text;
  const ordered = redactions.filter((redaction) => redaction.path.length > 1)
    .sort((a, b) => b.path.length - a.path.length);
  for (const { path, label } of ordered) {
    const trimmed = path.replace(/[\\/]+$/, '');
    if (trimmed.length <= 1) continue;
    out = out.replace(new RegExp(`(?<![\\w.-])${escapeRegExp(trimmed)}(?![\\w.-])`, 'g'), () => label);
  }
  return out;
}

/**
 * The locations one project run's text may name: its project root, the
 * skills trees, the installation and the home directory. A project's runs
 * live under `…/<projectId>` in both layouts — `orgs/<org>/projects/<project>`
 * on the host and `projects/<org>/<project>` under the launcher's workspace
 * root — so the root is cut at the project id, which is a UUID.
 */
export function projectRunHostRedactions(run: ProjectRun): HostPathRedaction[] {
  const projectRoot = (location: string): string | null => {
    for (const separator of new Set([sep, '/', '\\'])) {
      const marker = `${separator}${run.projectId}`;
      const at = location.indexOf(marker);
      if (at >= 0) return location.slice(0, at + marker.length);
    }
    return null;
  };
  const roots = [run.hostPaths.workspacePath, run.hostPaths.logPath, run.hostPaths.runsPath]
    .map(projectRoot).filter((root): root is string => root !== null);
  return [
    ...[...new Set(roots)].map((path) => ({ path, label: '<project>' })),
    ...(run.hostPaths.skillsPath ? [{ path: run.hostPaths.skillsPath, label: '<platform-skills>' }] : []),
    { path: skillsDirPath(), label: '<platform-skills>' },
    { path: repoRoot(), label: '<atoma>' },
    { path: homedir(), label: '~' },
  ];
}
