import {
  previewDescriptorSchema,
  type PreviewDescriptor,
  type PreviewUnavailableReason,
} from '../contracts/preview.js';
import { PROBE_MANIFEST_FILENAME, probeManifestSchema } from '../contracts/probeManifest.js';
import { normalizeArtifactPath } from '../projects/artifacts.js';
import { previewWorkspaceHasFile, readPreviewClassifierFile } from './policy.js';

/**
 * WHAT KIND OF THING DID THIS RUN DELIVER?
 *
 * Decided ONCE, at delivery, from machine-observed facts, and persisted — so
 * unavailability has a stable reason and no request ever probes the filesystem
 * (design §6). Two properties are load-bearing:
 *
 * 1. NOTHING HERE READS MODEL PROSE. Not `result.output`, not a README, not
 *    trace text, and no `run_shell` is replayed. The inputs are the probe
 *    manifest — written by the machine from what tools actually did — plus the
 *    presence of files on disk. Verification is read-only, and a classifier
 *    that trusted a model's claim about its own deliverable would be the
 *    supervisor replaying a child's command by another name.
 * 2. THE ANSWER IS TOTAL. Every delivered run gets a descriptor: available
 *    with a kind, or unavailable with a bounded reason a member can read. A
 *    button that fails after the click is worse than a stated absence.
 */

const NODE_ENTRY_FALLBACKS = ['server.js', 'index.js', 'app.js'] as const;
const STATIC_INDEX = 'index.html';
const JS_ENTRY = /\.(?:c|m)?js$/i;

export interface PreviewClassification {
  readonly availability: 'available' | 'unavailable';
  readonly kind: 'static' | 'node' | null;
  readonly entry: string | null;
  readonly unavailableReason: PreviewUnavailableReason | null;
}

function unavailable(reason: PreviewUnavailableReason): PreviewClassification {
  return { availability: 'unavailable', kind: null, entry: null, unavailableReason: reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The manifest's own kind dispatch, as `validateProbeManifest` performs it:
 * the explicit `probe` discriminator wins, then `cmd` claims the shell shape,
 * and only then are http and web inferred from distinctive fields. Mirrored
 * rather than re-invented so a manifest cannot mean one thing to the validator
 * and another to the classifier.
 */
function entryKind(entry: Record<string, unknown>): 'http' | 'web' | 'shell' | null {
  if (entry['probe'] === 'http') return 'http';
  if (entry['probe'] === 'web') return 'web';
  if (typeof entry['cmd'] === 'string') return 'shell';
  if (typeof entry['path'] === 'string') return 'http';
  if (typeof entry['smoke'] === 'string') return 'web';
  return null;
}

/**
 * The entry file, from the tool argument that actually started a server.
 *
 * LAST WINS. HTTP entries are an ordered SEQUENCE and never merge by route
 * (`src/contracts/probeManifest.ts`), so a run that restarted its server under
 * a new filename leaves both stamps behind; the newest observation is the one
 * describing the deliverable as it ended.
 *
 * An unusable stamp is treated as no stamp rather than as a refusal — the
 * fallbacks below still have a chance, and a run is not unpreviewable because
 * one recorded field is malformed.
 */
function stampedEntry(entries: readonly unknown[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entryKind(entry) !== 'http') continue;
    const stamped = entry['entry'];
    if (typeof stamped !== 'string' || stamped.length === 0) continue;
    try {
      return normalizeArtifactPath(stamped);
    } catch {
      continue;
    }
  }
  return null;
}

/** `package.json`'s `main`, only when it names a regular file in this tree. */
function packageMainEntry(workspaceRoot: string): string | null {
  const raw = readPreviewClassifierFile(workspaceRoot, 'package.json');
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A deliverable whose package.json does not parse is not a reason to
    // refuse a preview: the fallback names below still describe most servers.
    return null;
  }
  if (!isRecord(parsed) || typeof parsed['main'] !== 'string') return null;
  try {
    return normalizeArtifactPath(parsed['main']);
  } catch {
    return null;
  }
}

function usableEntry(workspaceRoot: string, candidate: string | null): string | null {
  if (candidate === null) return null;
  // `node <entry>` is the ONLY start command a preview will ever run (design
  // D7), so an entry node cannot execute is not an entry. Saying so here turns
  // a runtime crash a member would have to interpret into `not-runnable`.
  if (!JS_ENTRY.test(candidate)) return null;
  return previewWorkspaceHasFile(workspaceRoot, candidate) ? candidate : null;
}

/**
 * Classify one delivered workspace.
 *
 * Throws nothing: every failure it can meet — an unreadable workspace, a
 * manifest that will not parse — is one of the bounded reasons, because this
 * runs inside the delivery path and a run must never be un-delivered by the
 * host failing to describe it.
 */
export function classifyDeliveredWorkspace(workspaceRoot: string): PreviewClassification {
  let manifestRaw: string | null;
  try {
    manifestRaw = readPreviewClassifierFile(workspaceRoot, PROBE_MANIFEST_FILENAME);
  } catch {
    // The jail refused, the file changed under the read, or the workspace is
    // not a directory any more. All three mean the same to a member.
    return unavailable('workspace-unreadable');
  }

  let entries: readonly unknown[] | null = null;
  if (manifestRaw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestRaw);
    } catch {
      return unavailable('manifest-unreadable');
    }
    const document = probeManifestSchema.safeParse(parsed);
    if (!document.success) return unavailable('manifest-unreadable');
    entries = document.data.entries;
  }

  const kinds = (entries ?? [])
    .filter(isRecord)
    .map(entryKind);

  if (kinds.includes('http')) {
    const resolved =
      usableEntry(workspaceRoot, stampedEntry(entries ?? [])) ??
      usableEntry(workspaceRoot, packageMainEntry(workspaceRoot)) ??
      NODE_ENTRY_FALLBACKS.map((name) => usableEntry(workspaceRoot, name)).find(
        (name): name is string => name !== null
      ) ??
      null;
    if (resolved === null) return unavailable('not-runnable');
    return {
      availability: 'available',
      kind: 'node',
      entry: resolved,
      unavailableReason: null,
    };
  }

  // A web probe means a browser validated a page in this workspace; the page
  // itself is what a member wants to open. No manifest at all still classifies
  // static when the conventional entry document is present — a run may deliver
  // a page without ever recording a browser probe.
  if (kinds.includes('web') || previewWorkspaceHasFile(workspaceRoot, STATIC_INDEX)) {
    return { availability: 'available', kind: 'static', entry: null, unavailableReason: null };
  }

  return unavailable('unsupported-deliverable');
}

/**
 * The immutable row, built and validated in one place.
 *
 * `requestedHosts` is an INPUT rather than something read from the workspace,
 * and it is empty in v1: there is no run-side channel through which a run
 * declares the HTTPS hosts its deliverable needs. Inventing one from the
 * probe manifest would mean reading localhost probes as internet destinations.
 * The column and the approval flow exist so that channel lands without a
 * migration; until it does, every descriptor requests nothing and every
 * preview starts with egress denied, which is the correct default anyway.
 */
export function buildPreviewDescriptor(input: {
  readonly projectRunId: string;
  readonly projectId: string;
  readonly orgId: string;
  readonly workspaceRoot: string;
  readonly requestedHosts?: readonly string[];
  readonly now?: Date;
}): PreviewDescriptor {
  const classification = classifyDeliveredWorkspace(input.workspaceRoot);
  return previewDescriptorSchema.parse({
    projectRunId: input.projectRunId,
    projectId: input.projectId,
    orgId: input.orgId,
    availability: classification.availability,
    kind: classification.kind,
    entry: classification.entry,
    unavailableReason: classification.unavailableReason,
    requestedHosts: [...(input.requestedHosts ?? [])],
    createdAt: (input.now ?? new Date()).toISOString(),
  });
}
