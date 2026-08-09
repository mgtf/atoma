import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * APPEND-ONLY LIFECYCLE LEDGER (P2 — event-sourced provenance, stage 1).
 * ======================================================================
 * Every trust/lifecycle mutation in the system appends one JSONL event
 * here, from the storage choke points themselves (AtomRegistry counter
 * methods, SkillRegistry lifecycle methods) — so the ledger sees exactly
 * what the mutable stores see, with zero extra call sites to maintain.
 *
 * Stage 1 is DUAL-WRITE: the SQLite counters and _meta.json sidecars
 * remain authoritative for runtime decisions, and the ledger is the
 * durable record that lets `npm run ledger -- check` recompute what the
 * counters SHOULD be and flag drift. The end-state (counters as pure
 * projections of the ledger) can be adopted store by store once the
 * dual-write has proven itself over a few epochs.
 *
 * Fail-open by design: a ledger write must NEVER take down a run —
 * telemetry that crashes production is worse than no telemetry. Errors
 * are swallowed after a single console.warn.
 *
 * Path: ATOMA_LEDGER_PATH, default ./atoma-ledger.jsonl (gitignored —
 * runtime data, same policy as the registry DBs and skills store).
 */

export type LedgerEventKind =
  | 'type-success'
  | 'type-failure'
  | 'skill-success'
  | 'skill-failure'
  | 'skill-save'
  | 'promote'
  | 'demote'
  | 'promotion-refused'
  | 'direct-failure'
  | 'direct-failures-cleared'
  | 'counters-reset'
  // Catalog-hygiene verbs (CLI `skills drop` / `skills merge`). The entity
  // disappears from the store afterwards; `ledger check` iterates the STORE,
  // so a dropped entity's stale projection is never compared — no special
  // handling needed in projectCounters.
  | 'skill-drop'
  | 'skill-merge';

export interface LedgerEvent {
  readonly at: string;
  readonly kind: LedgerEventKind;
  /** `Hydrogen` for atom types, `Hydrogen/web-build-loop` for skills. */
  readonly entity: string;
  readonly detail?: Record<string, unknown>;
}

/**
 * Is the ledger writable by THIS process, or would it pollute someone else's?
 *
 * The ledger's one hard rule is that ONE ledger maps to ONE authoritative
 * store (see the KNOWN LIMIT in CLAUDE.md): events carry no store identity,
 * so `ledger check` compares a projection against whichever store you point
 * it at. An in-memory registry is by construction NOT that store — it is a
 * test fixture or a throwaway script — so its events belong nowhere near the
 * default file.
 *
 * MEASURED THE HARD WAY: two ad-hoc `tsx` scripts on 2026-08-09 opened
 * `:memory:` registries, called `recordSuccess('Helium')`, and appended four
 * phantom successes to the real ledger. `ledger check` then reported
 * `IMPOSSIBLE  Helium: store 2 < ledger 6` — a permanent false alarm on an
 * integrity checker, which is the fastest way to teach an operator to ignore
 * one. vitest pins ATOMA_LEDGER_PATH so tests were never the problem; ad-hoc
 * scripts are, and they are exactly what nobody remembers to configure.
 *
 * An EXPLICIT `ATOMA_LEDGER_PATH` always wins: a caller that named a file
 * has taken responsibility for the pairing, which is precisely what the
 * test suite and `viz:demo` do.
 */
export function ledgerWritesAllowed(dbPath: string | undefined): boolean {
  if (process.env['ATOMA_LEDGER_PATH'] !== undefined) return true;
  return dbPath !== undefined && dbPath !== ':memory:' && !dbPath.startsWith('file::memory:');
}

export function ledgerPath(): string {
  return resolve(process.env['ATOMA_LEDGER_PATH'] ?? './atoma-ledger.jsonl');
}

let warnedOnce = false;

/** Append one event. Fail-open: never throws. */
export function appendLedger(event: Omit<LedgerEvent, 'at'>): void {
  try {
    const p = ledgerPath();
    mkdirSync(dirname(p), { recursive: true });
    const row: LedgerEvent = { at: new Date().toISOString(), ...event };
    appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      // eslint-disable-next-line no-console
      console.warn(`[ledger] append failed (further failures silent): ${(err as Error).message}`);
    }
  }
}

/** Read every event, skipping unparseable lines (a torn write must not blind the reader). */
export function readLedger(path = ledgerPath()): LedgerEvent[] {
  if (!existsSync(path)) return [];
  const out: LedgerEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as LedgerEvent;
      if (typeof obj.kind === 'string' && typeof obj.entity === 'string') out.push(obj);
    } catch {
      // torn/corrupt line — skip, never crash the projection
    }
  }
  return out;
}

export interface ProjectedCounters {
  successes: number;
  failures: number;
}

/**
 * Project per-entity success/failure counters from the ledger, honouring
 * the events that RESET them (counters-reset, promote — promotion zeroes
 * the counters by contract, the script form re-earns trust; skill-save
 * does NOT reset, matching SkillRegistry.save's counter-preserving
 * contract).
 */
export function projectCounters(events: LedgerEvent[]): Map<string, ProjectedCounters> {
  const map = new Map<string, ProjectedCounters>();
  const get = (e: string): ProjectedCounters => {
    let c = map.get(e);
    if (!c) {
      c = { successes: 0, failures: 0 };
      map.set(e, c);
    }
    return c;
  };
  for (const ev of events) {
    const c = get(ev.entity);
    switch (ev.kind) {
      case 'type-success':
      case 'skill-success':
        c.successes++;
        break;
      case 'type-failure':
      case 'skill-failure':
        c.failures++;
        break;
      case 'counters-reset':
      case 'promote':
        c.successes = 0;
        c.failures = 0;
        break;
      default:
        break;
    }
  }
  return map;
}
