import Database from 'better-sqlite3';
import { haystackLaunchSchema, type HaystackLaunch } from '../contracts/retrievalHaystack.js';
import { openProjectRunRetrievalAuthority, ProjectRetrievalLaunchStore } from './retrievalLaunch.js';
import { prepareProjectRetrievalCorpus, assertRetrievalTime } from './retrievalCorpus.js';
import { createHaystackRetrievalBinding } from './retrievalHaystack.js';
import type { ProjectRetrievalBinding, ProjectRetrievalCallContext } from '../tools/projectRetrieval.js';

/** Read-only preflight; allocate Python only after the runner owns teardown and its watchdog. */
export function openProjectRunHaystack(input: Parameters<typeof openProjectRunRetrievalAuthority>[0], config: HaystackLaunch) {
  const launch = haystackLaunchSchema.parse(config);
  const authority = openProjectRunRetrievalAuthority(input);
  const db = new Database(input.dbPath, { readonly: true, fileMustExist: true, timeout: 0 });
  let receipt;
  try { receipt = new ProjectRetrievalLaunchStore(db, { initialize: false }).resolve(input.runId); }
  finally { db.close(); }
  if (!receipt) throw new Error('project retrieval launch is unavailable or denied');
  const source = receipt;
  let delegate: ProjectRetrievalBinding | undefined;
  let closed = false;
  const cancelled = new AbortController();
  let preparing: Promise<void> | undefined;
  const binding: ProjectRetrievalBinding = { scope: authority.scope, service: {
    authorize: async (scope, context) => !closed && await authority.service.authorize(scope, context) === true,
    search: async (scope, query, context) => delegate && !closed ? delegate.service.search(scope, query, context) : { ok: false, status: 'unavailable' },
    dispose: async () => {
      if (closed) return;
      closed = true; cancelled.abort();
      try { await preparing; } catch { /* Preparation retains its original error. */ }
      if (delegate) await delegate.service.dispose(); else await authority.service.dispose();
    },
  } };
  return { binding, prepare: (context: ProjectRetrievalCallContext): Promise<void> => {
    context = { signal: AbortSignal.any([context.signal, cancelled.signal]), deadlineAt: context.deadlineAt };
    preparing ??= (async () => {
      try {
        assertRetrievalTime(context);
        if (closed || await authority.service.authorize(authority.scope, context) !== true) throw new Error('project retrieval denied');
        const corpus = await prepareProjectRetrievalCorpus(source.sourceRoot, source.manifest, context);
        delegate = await createHaystackRetrievalBinding({ authority, corpus, ...launch, context });
        if (closed) { await delegate.service.dispose(); throw new Error('project retrieval closed'); }
      } catch { throw new Error('project retrieval preparation is unavailable or denied'); }
    })();
    return preparing;
  } };
}
