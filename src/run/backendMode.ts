export interface ToolBackendMode {
  readonly container: boolean;
  readonly egress: boolean;
}

/**
 * One definition for the run's local/container mode.
 *
 * Doctor must diagnose the mode the runner will actually use. Keeping the
 * env and flag precedence here prevents a preflight from saying "local" while
 * `runTask` starts Docker (or the inverse). Egress always implies a container.
 */
export function resolveToolBackendMode(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): ToolBackendMode {
  let container = env['ATOMA_CONTAINER'] === '1';
  let egress = env['ATOMA_EGRESS'] === '1';
  for (const arg of argv) {
    if (arg === '--container') container = true;
    else if (arg === '--no-container') container = false;
    else if (arg === '--egress') {
      egress = true;
      container = true;
    } else if (arg === '--no-egress') {
      egress = false;
    }
  }
  if (egress) container = true;
  return { container, egress };
}
