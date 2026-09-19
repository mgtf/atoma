/** Deployment images are registry manifest identities, never local image IDs. */
export function requireDigest(value, name) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a repository@sha256 digest reference`);
  }
}

export function validateWebEnvironment(env) {
  for (const name of ['ATOMA_VIZ_AUTH', 'ATOMA_CONTAINER', 'ATOMA_PREVIEW']) {
    if (env[name] !== '1') throw new Error(`${name} must be 1 in the web image`);
  }
  if (!env.ATOMA_LAUNCHER_SOCKET?.startsWith('/')) throw new Error('An absolute launcher socket is required');
  requireDigest(env.ATOMA_WORKER_IMAGE, 'ATOMA_WORKER_IMAGE');
  requireDigest(env.ATOMA_PREVIEW_IMAGE, 'ATOMA_PREVIEW_IMAGE');
  const origin = new URL(env.ATOMA_VIZ_PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.ATOMA_VIZ_PUBLIC_ORIGIN) throw new Error('An exact HTTPS public origin is required');
  if (env.ATOMA_PREVIEW_RUNTIME !== 'runsc') throw new Error('The hosted preview requires runsc');
  for (const name of ['ATOMA_PREVIEW_ALLOW_RUNC_DEV', 'ATOMA_PREVIEW_ALLOW_HTTP_DEV']) {
    if (env[name] && env[name] !== '0' && env[name] !== 'false') throw new Error(`${name} is forbidden in the web image`);
  }
}

/** Inspect rendered Compose JSON without printing credentials. */
export function validateStack(config) {
  for (const [name, service] of Object.entries(config.services ?? {})) requireDigest(service.image, `${name}.image`);
  const web = config.services?.web;
  const launcher = config.services?.launcher;
  if (!web || !launcher) throw new Error('web and launcher services are required');
  validateWebEnvironment(web.environment);
  requireDigest(launcher.environment.ATOMA_LAUNCHER_WORKER_IMAGE, 'launcher worker image');
  if (web.environment.ATOMA_WORKER_IMAGE !== launcher.environment.ATOMA_LAUNCHER_WORKER_IMAGE ||
      web.environment.ATOMA_PREVIEW_IMAGE !== launcher.environment.ATOMA_LAUNCHER_PREVIEW_IMAGE) {
    throw new Error('Web and launcher workload image pins must match');
  }
  if (web.network_mode !== 'host' || launcher.network_mode !== 'host') throw new Error('The reference stack requires Linux host networking');
  if ((web.volumes ?? []).some(v => v.source === '/var/run/docker.sock')) throw new Error('The web must not mount docker.sock');
}
