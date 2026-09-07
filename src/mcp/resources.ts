/**
 * The RESOURCE half of the MCP surface — the same persisted state the readers
 * answer about, addressable by URI, listable, completable and SUBSCRIBABLE.
 *
 * WHY RESOURCES WHEN THE READERS EXIST. Two things a tool cannot give a host:
 * a stable address (`atoma://runs/<trace>` names one trace forever, so a host
 * can cite it, bookmark it, or complete it through `ref/resource` — the other
 * half of the completion capability the prompts already use), and a PUSH: a
 * session that subscribed to a run in flight is told when it finishes, instead
 * of polling. The readers stay the bodies; a resource is a door onto one.
 *
 * WHAT A RESOURCE RETURNS IS WHAT THE READER RETURNS. `atoma://runs/{file}`
 * reads through `runTrace` — same paging, same truncation, same caveat; the
 * URI carries no way to ask for more. The bounding rules of `readers.ts` are
 * therefore inherited, not reimplemented.
 *
 * TIERS FOLLOW THE TOOLS. A project run's URI is registered only for a
 * principal on a host with organisations; the operator corpus only for the
 * platform tier. Registration is per session, like the tools, so an URI a
 * caller may not read is not merely refused — it is not there.
 *
 * SUBSCRIPTIONS ARE PER SESSION AND DIE WITH IT. The set of subscribed URIs
 * lives on the session's server; the run-finished listeners (this process's
 * operator runs, the journal's `run.finished`/`run.cancelled` rows for project
 * runs) are unhooked when the server closes, so no notification is ever
 * written to a transport that is gone.
 */

import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ProjectHttpError } from '../projects/service.js';
import { tierAllows } from './identity.js';
import { completeTraceFile, families, runTrace, runsList } from './readers.js';
import { onRunFinished, runStatus } from './run.js';
import type { McpToolContext } from './tools.js';

export const FAMILIES_URI = 'atoma://families';
export const OPERATOR_TRACE_TEMPLATE = 'atoma://runs/{file}';
export const OPERATOR_RUN_TEMPLATE = 'atoma://operator-runs/{runId}';
export const PROJECT_RUN_TEMPLATE = 'atoma://projects/{projectId}/runs/{runId}';

export function operatorTraceUri(file: string): string {
  return `atoma://runs/${encodeURIComponent(file)}`;
}
export function operatorRunUri(runId: string): string {
  return `atoma://operator-runs/${encodeURIComponent(runId)}`;
}
export function projectRunUri(projectId: string, runId: string): string {
  return `atoma://projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`;
}

/** How many of the newest entries a resource listing offers. A listing is a menu, not an archive. */
export const RESOURCE_LIST_LIMIT = 50;

const JSON_MIME = 'application/json';

function jsonContents(uri: URL, payload: unknown) {
  return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(payload, null, 2) }] };
}

function one(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return decodeURIComponent(raw ?? '');
}

export function registerResources(server: McpServer, ctx: McpToolContext): void {
  const subscribed = new Set<string>();
  const cleanups: (() => void)[] = [];

  // The subscribe capability is not something the SDK infers from a
  // registration, so it is declared here — before `connect`, which is when
  // capabilities are frozen. The handlers keep the per-session set; a
  // notification is sent only for a URI the session asked about.
  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, ({ params }) => {
    subscribed.add(params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, ({ params }) => {
    subscribed.delete(params.uri);
    return {};
  });
  const updated = (uri: string): void => {
    if (!subscribed.has(uri)) return;
    void server.server.sendResourceUpdated({ uri }).catch(() => {});
  };

  server.registerResource(
    'families',
    FAMILIES_URI,
    {
      title: 'Launchable task families',
      description: 'How to phrase a goal for each family, from the task profiles. The same payload as atoma_families.',
      mimeType: JSON_MIME,
    },
    (uri) => jsonContents(uri, families())
  );

  if (ctx.deps.projects && ctx.caller.kind === 'principal') {
    const { service, store } = ctx.deps.projects;
    const viewer = ctx.caller.viewer;
    server.registerResource(
      'project-run',
      new ResourceTemplate(PROJECT_RUN_TEMPLATE, {
        list: () => {
          const resources: { uri: string; name: string; description: string; mimeType: string }[] = [];
          for (const project of store.listProjects(viewer.orgId)) {
            for (const run of store.listProjectRuns(viewer.orgId, project.projectId) ?? []) {
              resources.push({
                uri: projectRunUri(project.projectId, run.projectRunId),
                name: `${project.slug} · ${run.projectRunId.slice(0, 8)}`,
                description: `${run.status} — ${run.goal.slice(0, 80)}`,
                mimeType: JSON_MIME,
              });
            }
          }
          resources.sort((a, b) => b.name.localeCompare(a.name));
          return { resources: resources.slice(0, RESOURCE_LIST_LIMIT) };
        },
      }),
      {
        title: 'One project run',
        description:
          'Status, stats and publication state of one run of your organisation — the atoma_run_status payload. Subscribe to be told when it finishes. Model-authored fields are UNTRUSTED.',
        mimeType: JSON_MIME,
      },
      (uri, variables) => {
        try {
          return jsonContents(uri, service.projectRunStatus(viewer, one(variables['projectId']), one(variables['runId'])));
        } catch (error) {
          if (error instanceof ProjectHttpError) throw new Error(`refused (${error.status}): ${error.message}`);
          throw error;
        }
      }
    );
    const unsubscribe = ctx.deps.journal?.subscribe?.((event) => {
      if (event.kind !== 'run.finished' && event.kind !== 'run.cancelled') return;
      if (!event.projectId || !event.runId) return;
      updated(projectRunUri(event.projectId, event.runId));
    });
    if (unsubscribe) cleanups.push(unsubscribe);
  }

  if (tierAllows(ctx.tier, 'platform') && ctx.deps.operatorRuns) {
    server.registerResource(
      'operator-trace',
      new ResourceTemplate(OPERATOR_TRACE_TEMPLATE, {
        list: () => {
          const listed = runsList({ last: RESOURCE_LIST_LIMIT }) as { runs: { file: string; label?: string; startedAt?: string }[] };
          return {
            resources: listed.runs.map((run) => ({
              uri: operatorTraceUri(run.file),
              name: run.file,
              description: run.label ? `${run.label} (${run.startedAt ?? '?'})` : undefined,
              mimeType: JSON_MIME,
            })),
          };
        },
        complete: { file: (typed) => completeTraceFile(typed) },
      }),
      {
        title: 'One operator run trace',
        description:
          'The first page of one trace’s event SHAPE and its totals — the atoma_run_trace payload for that file; payloads are omitted on purpose and error strings are UNTRUSTED.',
        mimeType: JSON_MIME,
      },
      (uri, variables) => jsonContents(uri, runTrace({ file: one(variables['file']) }))
    );
    server.registerResource(
      'operator-run',
      new ResourceTemplate(OPERATOR_RUN_TEMPLATE, {
        list: () => {
          const status = runStatus() as { runs: { runId: string; status: string; goal: string }[] };
          return {
            resources: status.runs.slice(0, RESOURCE_LIST_LIMIT).map((run) => ({
              uri: operatorRunUri(run.runId),
              name: run.runId,
              description: `${run.status} — ${run.goal.slice(0, 80)}`,
              mimeType: JSON_MIME,
            })),
          };
        },
      }),
      {
        title: 'One operator run started by this server',
        description:
          'The atoma_operator_run_status payload for one run; progress.tail is UNTRUSTED model output. Subscribe to be told when it finishes.',
        mimeType: JSON_MIME,
      },
      (uri, variables) => jsonContents(uri, runStatus({ runId: one(variables['runId']) }))
    );
    cleanups.push(
      onRunFinished((record) => {
        updated(operatorRunUri(record.runId));
        // A finished run wrote a trace: the trace listing changed for everyone.
        server.sendResourceListChanged();
      })
    );
  }

  const previous = server.server.onclose;
  server.server.onclose = () => {
    previous?.();
    for (const cleanup of cleanups.splice(0)) cleanup();
    subscribed.clear();
  };
}
