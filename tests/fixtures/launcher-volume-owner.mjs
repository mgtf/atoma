import { WorkspaceVolumes } from '../../src/launcher/volumes.ts';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const volumes = new WorkspaceVolumes({
  stateRoot: process.env.ATOMA_TEST_STATE, workspaceRoot: process.env.ATOMA_TEST_WORKSPACES,
  uid: process.getuid(), gid: process.getgid(), runDocker: async () => '',
});
const row = await volumes.create('worker', 'crashed-run', 'runs/crashed-run');
writeFileSync(path.join(row.hostPath, 'evidence.txt'), 'retain this run');
process.send?.({ row });
setInterval(() => {}, 1000);
