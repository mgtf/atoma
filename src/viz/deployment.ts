import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEPLOYMENT_LOCK_ENV = 'ATOMA_DEPLOY_LOCK_PATH';

const STATEFUL_GET_PATHS = new Set([
  '/auth/login',
  '/auth/callback',
  '/auth/github/connect',
  '/auth/github/authorize',
  '/auth/github/setup',
]);

/**
 * The host-owned marker that closes write admission before code activation.
 * Absence keeps the existing developer/release behaviour unchanged.
 */
export function deploymentPaused(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): boolean {
  const configured = env[DEPLOYMENT_LOCK_ENV]?.trim();
  return configured ? exists(resolve(configured)) : false;
}

/** Requests that may create or mutate durable/runtime state wait for deploy. */
export function requestWaitsForDeployment(
  method: string | undefined,
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): boolean {
  if (!deploymentPaused(env, exists)) return false;
  const verb = (method ?? 'GET').toUpperCase();
  if (verb !== 'GET' && verb !== 'HEAD' && verb !== 'OPTIONS') return true;
  // OAuth uses redirects, so several GET routes are writes despite their
  // verb: login/authorize/connect create state, while callbacks consume it
  // and persist identity, installation or session data.
  return STATEFUL_GET_PATHS.has(pathname);
}
