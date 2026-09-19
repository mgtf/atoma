import path from 'node:path';
import type { ContainerLauncher } from '../contracts/launcher.js';
import type { DockerLauncherOptions } from './docker.js';
import { SocketLauncher } from './client.js';

/** Host configuration selects the transport; socket failure never falls back. */
export async function connectContainerLauncher(
  options: DockerLauncherOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ContainerLauncher> {
  const socketPath = env['ATOMA_LAUNCHER_SOCKET'];
  if (socketPath === undefined) {
    const { createContainerLauncher } = await import('./docker.js');
    return createContainerLauncher(options);
  }
  if (!socketPath || !path.isAbsolute(socketPath)) throw new Error('ATOMA_LAUNCHER_SOCKET must be an absolute socket path');
  const client = await SocketLauncher.connect(socketPath);
  const actual = client.configuration;
  // These are comparisons, not options sent to the service. The caller must
  // not record an image/runtime different from the profile that actually ran.
  if (actual.image !== options.image
    || (options.previewImage !== undefined && actual.previewImage !== options.previewImage)
    || (options.previewRuntime !== undefined && actual.previewRuntime !== options.previewRuntime)) {
    client.close();
    throw new Error('Launcher profile does not match the host configuration');
  }
  return client;
}
