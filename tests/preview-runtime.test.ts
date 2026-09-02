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
import { previewOrigin } from '../src/preview/gateway.js';
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
  const ORG = '33333333-3333-4333-8333-333333333333';
  const RUN = '11111111-1111-4111-8111-111111111111';

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
    // Behind a REACHABLE gate, never — a deployment other people can log in to
    // is a deployment with tenants.
    expect(() =>
      snapshotPreviewConfig(
        { ...valid, [PREVIEW_ENV.runtime]: 'runc', [PREVIEW_ENV.allowRuncDev]: '1' },
        { visualizerOrigin: 'https://app.example.com' }
      )
    ).toThrow(/refuses to boot behind a REACHABLE auth gate/);
  });

  it('lets one operator run runc on a machine nobody else can reach', () => {
    // THE HATCH WAS UNREACHABLE. Previews REQUIRE the auth gate, and the gate
    // being on was the whole test, so `runc` was refused on every machine
    // including the one-person laptop the hatch exists for — and Docker
    // Desktop cannot register gVisor, so the feature could not be run at all.
    //
    // A loopback public origin settles reachability: a session is what gates a
    // claim, a claim is the only way to reach a preview origin, and a session
    // needs an OAuth round trip against THAT origin. Nobody else can resolve
    // it, so there are no other tenants.
    const dev = { ...valid, [PREVIEW_ENV.runtime]: 'runc', [PREVIEW_ENV.allowRuncDev]: '1' };

    for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://[::1]:5173']) {
      expect(snapshotPreviewConfig(dev, { visualizerOrigin: origin }).runtime).toBe('runc');
    }
  });

  it('still refuses runc for every origin or bind that is not loopback', () => {
    const dev = { ...valid, [PREVIEW_ENV.runtime]: 'runc', [PREVIEW_ENV.allowRuncDev]: '1' };

    // A LAN address is not this machine, and neither is a public name.
    for (const origin of ['http://192.168.1.20:5173', 'https://atoma.example.com']) {
      expect(() => snapshotPreviewConfig(dev, { visualizerOrigin: origin })).toThrow(
        /REACHABLE auth gate/
      );
    }
    // Loopback origin, but the isolate itself listening on every interface.
    expect(() =>
      snapshotPreviewConfig(
        { ...dev, [PREVIEW_ENV.gatewayHost]: '0.0.0.0' },
        { visualizerOrigin: 'http://127.0.0.1:5173' }
      )
    ).toThrow(/REACHABLE auth gate/);
    // An origin that will not parse never reaches the runtime branch at all:
    // `previewDomainCollides` already treats it as a collision, so it is
    // refused one check earlier. Unparseable is never proof of safety in
    // either place.
    expect(() => snapshotPreviewConfig(dev, { visualizerOrigin: 'not-a-url' })).toThrow(
      /separate registrable domain/
    );
  });

  it('never falls back to runc on its own', () => {
    // The carve-out widens WHO may ask for runc, never WHEN it is chosen.
    expect(snapshotPreviewConfig(valid, { visualizerOrigin: 'http://127.0.0.1:5173' }).runtime).toBe(
      'runsc'
    );
    expect(() =>
      snapshotPreviewConfig(
        { ...valid, [PREVIEW_ENV.runtime]: 'runc' },
        { visualizerOrigin: 'http://127.0.0.1:5173' }
      )
    ).toThrow(/requires ATOMA_PREVIEW_ALLOW_RUNC_DEV=1/);
  });

  it('serves previews over plain HTTP only under .localhost, on a loopback machine', () => {
    // MEASURED, not assumed (Chrome 152): a `.localhost` host is a SECURE
    // CONTEXT, so the grant cookie keeps every attribute it has in production
    // — `__Host-`, `Secure`, `SameSite=None`, `Partitioned` — and the browser
    // still stores and returns it inside the cross-site iframe over http.
    // That is what lets a developer drop wildcard TLS, wildcard DNS and a
    // proxy trusted by the operating system.
    const dev = {
      ...valid,
      [PREVIEW_ENV.domain]: 'previews.localhost',
      [PREVIEW_ENV.allowHttpDev]: '1',
    };
    const config = snapshotPreviewConfig(dev, { visualizerOrigin: 'http://127.0.0.1:5173' });

    expect(config.publicScheme).toBe('http');
    // The port IS part of the origin here: the browser talks to the gateway
    // directly, with no proxy terminating on 443.
    expect(config.publicPort).toBe(config.gatewayPort);
    expect(
      previewOrigin(
        { domain: config.domain, scheme: config.publicScheme, port: config.publicPort },
        ORG,
        RUN,
        1
      )
    ).toMatch(/^http:\/\/p[0-9a-f]{32}\.previews\.localhost:4311$/);
  });

  it('refuses cleartext previews for every condition, one at a time', () => {
    const dev = {
      ...valid,
      [PREVIEW_ENV.domain]: 'previews.localhost',
      [PREVIEW_ENV.allowHttpDev]: '1',
    };
    const loopback = { visualizerOrigin: 'http://127.0.0.1:5173' };

    // 2. a domain browsers do not make trustworthy.
    expect(() =>
      snapshotPreviewConfig({ ...dev, [PREVIEW_ENV.domain]: 'previews.example.net' }, loopback)
    ).toThrow(/not under \.localhost/);
    // 3a. NO visualizer origin at all. An absent origin is the ungated caller,
    // and absence must never read as proof that a machine is private.
    expect(() => snapshotPreviewConfig(dev)).toThrow(/no visualizer origin/);
    // 3b. an origin other people can reach.
    expect(() =>
      snapshotPreviewConfig(dev, { visualizerOrigin: 'https://atoma.example.com' })
    ).toThrow(/is not loopback/);
    // 4. the isolate listening on every interface.
    expect(() =>
      snapshotPreviewConfig({ ...dev, [PREVIEW_ENV.gatewayHost]: '0.0.0.0' }, loopback)
    ).toThrow(/is not loopback/);
  });

  it('keeps HTTPS as the only production answer, with no silent fallback', () => {
    // Without the flag, a `.localhost` domain changes nothing: the relaxation
    // is never DERIVED from the configuration, only ever asked for out loud.
    const quiet = { ...valid, [PREVIEW_ENV.domain]: 'previews.localhost' };
    const config = snapshotPreviewConfig(quiet, { visualizerOrigin: 'http://127.0.0.1:5173' });

    expect(config.publicScheme).toBe('https');
    expect(config.publicPort).toBeNull();
    // And the production shape is untouched by any of this.
    expect(snapshotPreviewConfig(valid).publicScheme).toBe('https');
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
