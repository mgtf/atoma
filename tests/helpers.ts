import type {
  Limits,
  Logger,
  RunContext,
} from '../src/core/types.js';
import { MockLlmClient } from '../src/core/llm.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';

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
