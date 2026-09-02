import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ContainerLauncher,
  LauncherFamily,
  LauncherNetworkHandle,
  LauncherNetworkSpec,
  LauncherOwnerId,
  LauncherUnitHandle,
  LauncherUnitKind,
  LauncherUnitSpec,
  LauncherUnitSummary,
  LauncherWorkspaceHandle,
} from '../src/contracts/launcher.js';
import {
  PreviewRuntimeError,
  startPreview,
  teardownPreview,
} from '../src/preview/runtime.js';
import {
  PREVIEW_ENV,
  PreviewConfigError,
  previewConfigPresent,
  previewDomainCollides,
  previewEnabled,
  snapshotPreviewConfig,
} from '../src/preview/config.js';

/**
 * The orchestration is an ORDER, so it is asserted as one: what was created,
 * in which sequence, and what was removed when a step failed. A fake launcher
 * records the calls; the engine's own behaviour is proved elsewhere, against a
 * real container.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`;

let root: string;
let source: string;
let workspaces: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atoma-preview-runtime-'));
  source = join(root, 'delivered');
  workspaces = join(root, 'workspaces');
  mkdirSync(source, { recursive: true });
  mkdirSync(workspaces, { recursive: true });
  writeFileSync(join(source, 'server.js'), 'console.log("LISTENING_ON_PORT=8080");');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface FakeOptions {
  readonly failAt?: LauncherUnitKind | 'network' | 'workspace';
  readonly readyFails?: LauncherUnitKind;
  readonly hostPort?: number | undefined;
}

class FakeLauncher implements ContainerLauncher {
  readonly calls: string[] = [];
  armed = false;

  constructor(private readonly options: FakeOptions = {}) {}

  networkName(spec: LauncherNetworkSpec): string {
    return `net-${spec.family}-${spec.ownerId}`;
  }

  unitName(kind: LauncherUnitKind, ownerId: LauncherOwnerId): string {
    return `${kind}-${ownerId}`;
  }

  async purgeOwner(family: LauncherFamily, ownerId: LauncherOwnerId): Promise<void> {
    this.calls.push(`purge:${family}:${ownerId}`);
  }

  armHardExitCleanup(family: LauncherFamily, ownerId: LauncherOwnerId): void {
    this.armed = true;
    this.calls.push(`arm:${family}:${ownerId}`);
  }

  disarmHardExitCleanup(family: LauncherFamily, ownerId: LauncherOwnerId): void {
    this.armed = false;
    this.calls.push(`disarm:${family}:${ownerId}`);
  }

  async createWorkspace(ownerId: LauncherOwnerId): Promise<LauncherWorkspaceHandle> {
    if (this.options.failAt === 'workspace') throw new Error('no space');
    this.calls.push('createWorkspace');
    const hostPath = join(workspaces, ownerId);
    mkdirSync(hostPath, { recursive: true });
    return { ownerId, id: ownerId, hostPath };
  }

  async removeWorkspace(handle: LauncherWorkspaceHandle): Promise<void> {
    this.calls.push('removeWorkspace');
    rmSync(join(workspaces, handle.ownerId), { recursive: true, force: true });
  }

  async createNetwork(spec: LauncherNetworkSpec): Promise<LauncherNetworkHandle> {
    if (this.options.failAt === 'network') throw new Error('engine refused');
    this.calls.push('createNetwork');
    return { ...spec, name: this.networkName(spec) };
  }

  async removeNetwork(): Promise<boolean> {
    this.calls.push('removeNetwork');
    return true;
  }

  async removeNetworkBefore(): Promise<boolean> {
    return true;
  }

  async startUnit(spec: LauncherUnitSpec): Promise<LauncherUnitHandle> {
    if (this.options.failAt === spec.kind) throw new Error('engine refused');
    this.calls.push(`start:${spec.kind}`);
    const name = this.unitName(spec.kind, spec.ownerId);
    if (spec.kind !== 'preview-ingress') return { kind: spec.kind, ownerId: spec.ownerId, name };
    const hostPort = 'hostPort' in this.options ? this.options.hostPort : 49_154;
    return {
      kind: spec.kind,
      ownerId: spec.ownerId,
      name,
      ...(hostPort === undefined ? {} : { hostPort }),
    };
  }

  async awaitUnitReady(handle: LauncherUnitHandle): Promise<void> {
    if (this.options.readyFails === handle.kind) throw new Error('never reported ready');
    this.calls.push(`ready:${handle.kind}`);
  }

  async stopUnit(handle: LauncherUnitHandle): Promise<void> {
    this.calls.push(`stop:${handle.kind}`);
  }

  async listUnits(): Promise<LauncherUnitSummary[]> {
    return [];
  }

  async reconcileOrphans(): Promise<number> {
    return 0;
  }
}

function deps(launcher: FakeLauncher, probe = async (): Promise<boolean> => true) {
  return {
    launcher,
    imageDigest: DIGEST,
    runtime: 'runsc' as const,
    probe,
    log: () => undefined,
  };
}

const input = () => ({ ownerId: 'prev-1', sourceWorkspace: source, entry: 'server.js' });

describe('preview start order', () => {
  it('purges, arms, then creates in dependency order', async () => {
    const launcher = new FakeLauncher();

    const running = await startPreview(deps(launcher), input());

    expect(launcher.calls).toEqual([
      'purge:preview:prev-1',
      // ARMED BEFORE ANYTHING EXISTS: a purge that raced the engine's endpoint
      // teardown can make creation itself fail while old objects are durable.
      'arm:preview:prev-1',
      'createWorkspace',
      // TWO networks: the isolate's, and the publishable one the relay is
      // reached on. A container whose only network is `--internal` gets no
      // published port at all.
      'createNetwork',
      'createNetwork',
      'start:preview-app',
      'ready:preview-app',
      'start:preview-ingress',
      'ready:preview-ingress',
    ]);
    expect(running.hostPort).toBe(49_154);
    expect(running.imageDigest).toBe(DIGEST);
    expect(running.runtime).toBe('runsc');
  });

  it('copies the delivered workspace instead of mounting it', async () => {
    const launcher = new FakeLauncher();
    await startPreview(deps(launcher), input());

    const copied = join(workspaces, 'prev-1');
    expect(readdirSync(copied)).toContain('server.js');
    // The original is untouched: it is the durable deliverable and the seed of
    // the next run.
    writeFileSync(join(copied, 'written-by-the-app.txt'), 'state');
    expect(existsSync(join(source, 'written-by-the-app.txt'))).toBe(false);
  });

  it('exposes nothing until a real request comes back through the relay', async () => {
    const order: string[] = [];
    const launcher = new FakeLauncher();
    const probing = deps(launcher, async () => {
      order.push('probe');
      return true;
    });

    await startPreview(probing, input());

    // The probe is the LAST thing that happens: a marker says a process bound
    // a port, only a round trip says a member will find something there.
    expect(order).toEqual(['probe']);
    expect(launcher.calls.at(-1)).toBe('ready:preview-ingress');
  });
});

describe('preview start failure leaves nothing behind', () => {
  const cases: Array<{
    readonly name: string;
    readonly options: FakeOptions;
    readonly code: string;
    readonly removes: string[];
  }> = [
    {
      name: 'the engine refuses the network',
      options: { failAt: 'network' },
      code: 'runtime-unavailable',
      removes: ['removeWorkspace'],
    },
    {
      name: 'the application container will not start',
      options: { failAt: 'preview-app' },
      code: 'image-unavailable',
      removes: ['removeNetwork', 'removeWorkspace'],
    },
    {
      name: 'the application never reports the port it was given',
      options: { readyFails: 'preview-app' },
      code: 'readiness-timeout',
      removes: ['stop:preview-app', 'removeNetwork', 'removeWorkspace'],
    },
    {
      name: 'the relay will not start',
      options: { failAt: 'preview-ingress' },
      code: 'gateway-unavailable',
      removes: ['stop:preview-app', 'removeNetwork', 'removeWorkspace'],
    },
    {
      name: 'the relay is published on no reachable port',
      options: { hostPort: undefined },
      code: 'gateway-unavailable',
      removes: ['stop:preview-ingress', 'stop:preview-app', 'removeNetwork', 'removeWorkspace'],
    },
  ];

  for (const one of cases) {
    it(`tears down and reports a bounded code when ${one.name}`, async () => {
      const launcher = new FakeLauncher(one.options);

      const error = await startPreview(deps(launcher), input()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PreviewRuntimeError);
      expect((error as PreviewRuntimeError).code).toBe(one.code);
      for (const removal of one.removes) expect(launcher.calls).toContain(removal);
      // The hard-exit fallback is disarmed only once everything is gone.
      expect(launcher.armed).toBe(false);
      expect(launcher.calls.at(-1)).toBe('disarm:preview:prev-1');
      expect(existsSync(join(workspaces, 'prev-1'))).toBe(false);
    });
  }

  it('reports copy-limit rather than internal when the workspace is too large', async () => {
    const launcher = new FakeLauncher();
    writeFileSync(join(source, 'big.bin'), Buffer.alloc(4096));

    const error = await startPreview(
      { ...deps(launcher), copyMaxBytes: 1024 },
      input()
    ).catch((e: unknown) => e);

    expect((error as PreviewRuntimeError).code).toBe('copy-limit');
  });

  it('reports server-exited when the application stops answering before exposure', async () => {
    const launcher = new FakeLauncher();

    const error = await startPreview(
      deps(launcher, async () => false),
      input()
    ).catch((e: unknown) => e);

    expect((error as PreviewRuntimeError).code).toBe('server-exited');
    expect(launcher.calls).toContain('stop:preview-ingress');
    expect(launcher.calls).toContain('stop:preview-app');
  });
});

describe('preview teardown', () => {
  it('removes relay, application, network and copy, in that order', async () => {
    const launcher = new FakeLauncher();
    const created = {
      workspace: { ownerId: 'prev-1', id: 'prev-1', hostPath: join(workspaces, 'prev-1') },
      networks: [
        {
          family: 'preview' as const,
          kind: 'internal' as const,
          ownerId: 'prev-1',
          name: 'net',
        },
      ],
      app: { kind: 'preview-app' as const, ownerId: 'prev-1', name: 'app' },
      relay: { kind: 'preview-ingress' as const, ownerId: 'prev-1', name: 'relay' },
    };

    await teardownPreview({ launcher }, 'prev-1', created);

    expect(launcher.calls).toEqual([
      // The relay first: it is what a member is still connected to and what
      // holds the network open.
      'stop:preview-ingress',
      'stop:preview-app',
      'removeNetwork',
      'removeWorkspace',
      // A final sweep by OWNER, because handles only cover what was recorded:
      // a `startUnit` that created a container and then threw on a later step
      // leaves one behind that no handle names.
      'purge:preview:prev-1',
      'disarm:preview:prev-1',
    ]);
  });

  it('never throws, and keeps going when a step cannot finish', async () => {
    const launcher = new FakeLauncher();
    launcher.stopUnit = async (): Promise<void> => {
      throw new Error('engine unreachable');
    };

    await expect(
      teardownPreview({ launcher }, 'prev-1', {
        networks: [
          { family: 'preview' as const, kind: 'internal' as const, ownerId: 'prev-1', name: 'net' },
        ],
        app: { kind: 'preview-app', ownerId: 'prev-1', name: 'app' },
        relay: { kind: 'preview-ingress', ownerId: 'prev-1', name: 'relay' },
      })
    ).resolves.toBeUndefined();
    // A failure in one step must not abandon the steps after it.
    expect(launcher.calls).toContain('removeNetwork');
  });

  it('is safe on a partial creation', async () => {
    const launcher = new FakeLauncher();
    await expect(teardownPreview({ launcher }, 'prev-1', {})).resolves.toBeUndefined();
    expect(launcher.calls).toEqual(['purge:preview:prev-1', 'disarm:preview:prev-1']);
  });
});

describe('preview configuration', () => {
  const valid = {
    [PREVIEW_ENV.enabled]: '1',
    [PREVIEW_ENV.domain]: 'previews.example.net',
    [PREVIEW_ENV.image]: `atoma-preview@${DIGEST}`,
  };

  it('refuses a value the gate would not recognise', () => {
    expect(previewEnabled({})).toBe(false);
    expect(previewEnabled({ [PREVIEW_ENV.enabled]: '1' })).toBe(true);
    expect(() => previewEnabled({ [PREVIEW_ENV.enabled]: 'yes' })).toThrow(PreviewConfigError);
  });

  it('treats any preview variable as an armed configuration', () => {
    expect(previewConfigPresent({})).toBe(false);
    expect(previewConfigPresent({ [PREVIEW_ENV.image]: 'x' })).toBe(true);
  });

  it('requires the image to be pinned by digest', () => {
    expect(() =>
      snapshotPreviewConfig({ ...valid, [PREVIEW_ENV.image]: 'atoma-preview:latest' })
    ).toThrow(/pinned by digest/);
    expect(snapshotPreviewConfig(valid).image).toBe(`atoma-preview@${DIGEST}`);
  });

  it('refuses a preview domain that shares a registrable domain with the visualizer', () => {
    expect(previewDomainCollides('previews.example.com', 'https://app.example.com')).toBe(true);
    expect(previewDomainCollides('app.example.com', 'https://app.example.com')).toBe(true);
    expect(previewDomainCollides('previews.example.net', 'https://app.example.com')).toBe(false);
    // An origin that will not parse is not proof of safety.
    expect(previewDomainCollides('previews.example.net', 'not-a-url')).toBe(true);

    expect(() =>
      snapshotPreviewConfig(
        { ...valid, [PREVIEW_ENV.domain]: 'previews.example.com' },
        { visualizerOrigin: 'https://app.example.com' }
      )
    ).toThrow(/separate registrable domain/);
  });

  it('refuses runc without the explicit escape hatch, and always behind the gate', () => {
    expect(() => snapshotPreviewConfig({ ...valid, [PREVIEW_ENV.runtime]: 'runc' })).toThrow(
      /requires ATOMA_PREVIEW_ALLOW_RUNC_DEV=1/
    );
    // With the hatch and no gate, a developer may run it.
    expect(
      snapshotPreviewConfig({
        ...valid,
        [PREVIEW_ENV.runtime]: 'runc',
        [PREVIEW_ENV.allowRuncDev]: '1',
      }).runtime
    ).toBe('runc');
    // With the gate on, never — a deployment with accounts has tenants.
    expect(() =>
      snapshotPreviewConfig(
        { ...valid, [PREVIEW_ENV.runtime]: 'runc', [PREVIEW_ENV.allowRuncDev]: '1' },
        { visualizerOrigin: 'https://app.example.com' }
      )
    ).toThrow(/refuses to boot behind the auth gate/);
  });

  it('refuses a bound it cannot honour rather than falling back', () => {
    expect(() => snapshotPreviewConfig({ ...valid, [PREVIEW_ENV.idleMs]: 'soon' })).toThrow(
      /is not an integer/
    );
    expect(() => snapshotPreviewConfig({ ...valid, [PREVIEW_ENV.idleMs]: '10' })).toThrow(
      /is not an integer in/
    );
  });

  it('refuses caps and bounds that contradict each other', () => {
    expect(() =>
      snapshotPreviewConfig({
        ...valid,
        [PREVIEW_ENV.maxPerOrg]: '8',
        [PREVIEW_ENV.maxGlobal]: '4',
      })
    ).toThrow(/cannot exceed/);
    expect(() =>
      snapshotPreviewConfig({
        ...valid,
        [PREVIEW_ENV.idleMs]: '3600000',
        [PREVIEW_ENV.hardMs]: '600000',
      })
    ).toThrow(/must be shorter than/);
  });

  it('carries the documented defaults when a deployment states only the essentials', () => {
    const config = snapshotPreviewConfig(valid);
    expect(config.runtime).toBe('runsc');
    expect(config.maxGlobal).toBe(4);
    expect(config.maxPerOrg).toBe(2);
    expect(config.idleMs).toBe(900_000);
    expect(config.hardMs).toBe(7_200_000);
    expect(config.copyMaxBytes).toBe(536_870_912);
  });
});
