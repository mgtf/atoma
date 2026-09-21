// Real process/socket boundary, fake engine: this fixture never calls Docker.
import { DockerLauncher } from '../../src/launcher/docker.ts';
import { serveLauncher } from '../../src/launcher/service.ts';

class RecordingLauncher extends DockerLauncher {
  armHardExitCleanup() {}
  disarmHardExitCleanup() {}
}
const launcher = new RecordingLauncher({
  image: 'worker-image', workspaceRoot: process.env.ATOMA_TEST_WORKSPACES,
  runDocker: async (args) => {
    process.send?.({ kind: 'engine', args });
    return args[0] === 'network' && args[1] === 'inspect' && args.includes('--format') ? 'attached-worker' : '';
  },
  waitUntilReady: async () => undefined,
});
const service = await serveLauncher({
  socketPath: process.env.ATOMA_TEST_SOCKET,
  launcher,
  disconnectOwner: (family, ownerId) => launcher.reapDisconnectedOwner(family, ownerId),
  hello: { version: 2, image: 'worker-image', previewImage: 'preview-image', previewRuntime: 'runsc', previewOwnership: { uid: 10001, gid: 10001 } },
});
process.send?.({ kind: 'ready' });
process.on('message', () => { void service.close().then(() => process.exit(0)); });
