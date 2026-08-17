export type EscalationPhase = 'plan' | 'exec' | 'repeat';

export class EscalationSignal extends Error {
  constructor(public readonly phase: EscalationPhase) {
    super(`escalation:${phase}`);
    this.name = 'EscalationSignal';
  }
}

export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelResolutionError';
  }
}

export class RegistryFullError extends Error {
  constructor(tier: number) {
    super(`registry tier ${tier} is full (taxonomy exhausted)`);
    this.name = 'RegistryFullError';
  }
}

export class RegistryNotFoundError extends Error {
  constructor(name: string) {
    super(`atom type not found: ${name}`);
    this.name = 'RegistryNotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Invalid launch input (timeout, seed, tier pin, credentials). `startTask`
 * throws it; the CLI shell maps it to exit 2.
 *
 * Lives here rather than in `run/runner.ts` so the credential path
 * (`run/auth.ts`) can throw it without importing the runner it is imported
 * BY — a cycle. `run/runner.ts` re-exports it, so the documented library
 * contract ("startTask throws RunnerConfigError on bad input") is unchanged.
 */
export class RunnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerConfigError';
  }
}
