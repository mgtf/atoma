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
