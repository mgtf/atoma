/**
 * One definition of where an atoma RUN may execute.
 *
 * A run is not just a process: it is a detached process GROUP, signalled
 * through a SIGTERM → grace → SIGKILL sequence, whose L1 children spawn
 * shells, interpreters and browsers under a filesystem sandbox. Every one of
 * those primitives is POSIX on this codebase's terms — measured on a Windows
 * host 2026-08-30: `npm` is a `.cmd` shim Node refuses to spawn without a
 * shell, `process.kill(-pid)` has no meaning without process groups so
 * cancellation reported success while orphans kept running, and the reap
 * sequence silently became a no-op.
 *
 * The honest contract is therefore narrow and STATED, because the failure it
 * replaces was not a Windows limitation but SILENCE: a run started, died with
 * a bare `spawn npm ENOENT` several processes deep, and nothing in the
 * product said the host was the reason. Windows remains a DEVELOPMENT host —
 * `typecheck`, `lint`, `docs:check`, `build` and the compiled MCP smoke all
 * pass there (measured 2026-08-30); parts of the TEST SUITE are POSIX-shaped
 * on purpose, because they drive the shells, `chmod`, `tar` and process
 * groups the product's own boundaries are made of. WSL2, with the checkout on
 * ext4, is the supported way to run — and to run the full suite — from
 * Windows; `docs/development-setup.md` is the per-platform procedure.
 *
 * There is deliberately NO override switch. A flag that lets a run start on a
 * host where the kill sequence cannot work would restore exactly the silent
 * failure this contract exists to end.
 */
export const SUPPORTED_RUN_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'linux'];

/** Whether this platform can execute a run (not merely develop atoma). */
export function runHostSupported(platform: NodeJS.Platform = process.platform): boolean {
  return SUPPORTED_RUN_PLATFORMS.includes(platform);
}

/** The remedy, in one place, for every surface that reports the refusal. */
export const UNSUPPORTED_RUN_HOST_REMEDY =
  'Start runs from WSL2, with the checkout on ext4 — see docs/development-setup.md. ' +
  'Editing, typecheck, lint, docs:check and build remain supported on this host.';

/** The mechanical fact, for a surface that reports the remedy separately. */
export function unsupportedRunHostReason(platform: NodeJS.Platform = process.platform): string {
  return (
    `atoma runs are not supported on ${platform}: the run path needs POSIX process groups ` +
    'for its SIGTERM→SIGKILL reap sequence, which cannot be honoured here.'
  );
}

/**
 * The refusal a run surface writes when the host cannot execute runs. Reason
 * AND remedy, for the one-string surfaces — a run log, an MCP run record —
 * that have nowhere else to put the way out.
 */
export function unsupportedRunHostMessage(platform: NodeJS.Platform = process.platform): string {
  return `${unsupportedRunHostReason(platform)} ${UNSUPPORTED_RUN_HOST_REMEDY}`;
}
