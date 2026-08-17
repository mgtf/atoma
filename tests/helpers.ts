import type {
  Limits,
  Logger,
  RunContext,
} from '../src/core/types.js';
import { MockLlmClient } from '../src/core/llm.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { namespaceOf, type SkillNamespace } from '../src/skills/namespace.js';

export function silentLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

export function makeCtx(opts?: {
  llm?: MockLlmClient;
  limits?: Limits;
  logger?: Logger;
}): RunContext & { llm: MockLlmClient } {
  const llm = opts?.llm ?? new MockLlmClient();
  return {
    llm,
    logger: opts?.logger ?? silentLogger(),
    signal: new AbortController().signal,
    limits: opts?.limits ?? DEFAULT_LIMITS,
  };
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

export function jsonTextPair(a: unknown, b: unknown): string {
  return JSON.stringify([a, b]);
}

/**
 * The skill namespace an atom's recipes live under, resolved from the registry
 * by display name.
 *
 * Skill namespaces are keyed by atom id (T4), while tests naturally speak in
 * taxonomy names. Seeding a namespace with a literal name used to work only
 * because the two were the same string; once they diverged, a test that seeded
 * `'Water'` and drove an L2 whose L1 looks under its id found nothing.
 */
export function nsOf(reg: AtomRegistry, name: string): SkillNamespace {
  const type = reg.getByName(name);
  if (!type) throw new Error(`nsOf: no atom named "${name}" in this registry`);
  return namespaceOf(type);
}
