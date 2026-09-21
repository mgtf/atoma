import type { ProjectWorkspaceIdentity } from '../contracts/launcherVolumes.js';
import type { Tool, ToolExecutor } from '../core/types.js';
import { LocalContainerToolExecutor } from '../launcher/localWorker.js';
import { RemoteWorkerExecutor } from '../launcher/remoteWorker.js';
export { workerRunArgs } from '../launcher/workerProfile.js';
export { hostContainerUser } from '../launcher/docker.js';
export { DEFAULT_WORKER_IMAGE, type ContainerSpawn } from '../launcher/localWorker.js';

/** Compatibility facade. Only the launcher subsystem owns engine processes. */
export class ContainerToolExecutor implements ToolExecutor {
  private readonly backend: LocalContainerToolExecutor | RemoteWorkerExecutor;
  constructor(options: ConstructorParameters<typeof LocalContainerToolExecutor>[0] & {
    project?: ProjectWorkspaceIdentity; workspaceId?: string; ownerId?: string; proxiedEgress?: boolean;
  }) {
    const endpoint = process.env['ATOMA_LAUNCHER_SOCKET'];
    if (endpoint !== undefined) {
      if (options.egress || options.docker || options.spawnFn || options.containerUser) throw new Error('Engine options are forbidden with the launcher service');
      const workspaceId = options.project ? undefined : options.workspaceId ?? process.env['ATOMA_LAUNCHER_WORKSPACE_ID'];
      if (!workspaceId && !options.project) throw new Error('ATOMA_LAUNCHER_WORKSPACE_ID is required for service workers');
      this.backend = new RemoteWorkerExecutor({ ...options, endpoint, workspaceId, image: options.image ?? process.env['ATOMA_WORKER_IMAGE'] ?? 'atoma-worker:latest' });
    } else this.backend = new LocalContainerToolExecutor(options);
  }
  start(): Promise<void> { return this.backend.start(); }
  toolDeclarations(): Tool[] { return this.backend.toolDeclarations(); }
  has(name: string): boolean { return this.backend.has(name); }
  execute(name: string, args: Record<string, unknown>): Promise<unknown> { return this.backend.execute(name, args); }
  stop(): void { this.backend.stop(); }
  drain(): Promise<void> { return this.backend.drain(); }
}
