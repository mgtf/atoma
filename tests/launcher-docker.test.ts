import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_EGRESS_PROXY_SPEC,
  launcherNetworkSpecSchema,
  launcherUnitSpecSchema,
} from '../src/contracts/launcher.js';
import {
  DockerLauncher,
  isIsolatedGatewayUnsupported,
  launcherObjectId,
  LauncherExitRegistry,
  LAUNCHER_OWNER_LABEL,
} from '../src/launcher/docker.js';

/**
 * The launcher is the one component allowed to create containers, so its
 * primitives are asserted at the COMMAND level: what it would tell the engine
 * to do, not what a comment says it does. The composed order lives with its
 * caller and is pinned by `tests/egress-sidecar-lifecycle.test.ts`.
 */

function recordingLauncher(
  reply: (args: string[]) => string = () => ''
): { launcher: DockerLauncher; calls: string[][] } {
  const calls: string[][] = [];
  const launcher = new DockerLauncher({
    image: 'worker-image',
    runDocker: async (args) => {
      calls.push(args);
      return reply(args);
    },
    waitUntilReady: async () => undefined,
    sleep: async () => undefined,
  });
  return { launcher, calls };
}

describe('launcher contract shapes', () => {
  it('parses its own example', () => {
    expect(EXAMPLE_EGRESS_PROXY_SPEC.kind).toBe('egress-proxy');
    expect(launcherUnitSpecSchema.safeParse(EXAMPLE_EGRESS_PROXY_SPEC).success).toBe(true);
  });

  it('refuses an owner id that could reach into an engine namespace', () => {
    for (const owner of ['', 'a b', 'a/b', 'a;rm', 'x'.repeat(201)]) {
      expect(launcherNetworkSpecSchema.safeParse({ family: 'egress', kind: 'internal', ownerId: owner }).success).toBe(
        false
      );
    }
    expect(
      launcherNetworkSpecSchema.safeParse({ family: 'egress', kind: 'internal', ownerId: 'run-4f2c' }).success
    ).toBe(true);
  });

  it('refuses a spec carrying an engine option, which is the whole point', () => {
    const smuggled = {
      ...EXAMPLE_EGRESS_PROXY_SPEC,
      image: 'attacker/image',
      command: ['sh', '-c', 'curl evil'],
    };
    expect(launcherUnitSpecSchema.safeParse(smuggled).success).toBe(false);
  });
});

describe('launcher object naming', () => {
  it('is deterministic, and keeps colliding or truncated owners apart', () => {
    const { launcher } = recordingLauncher();
    expect(launcher.networkName({ family: 'egress', kind: 'internal', ownerId: 'run-a' })).toBe(
      launcher.networkName({ family: 'egress', kind: 'internal', ownerId: 'run-a' })
    );
    expect(launcherObjectId('run/42')).not.toBe(launcherObjectId('run:42'));
    expect(launcherObjectId('x'.repeat(80) + 'a')).not.toBe(launcherObjectId('x'.repeat(80) + 'b'));
  });

  it('gives the internal network, the uplink and the unit three distinct names', () => {
    const { launcher } = recordingLauncher();
    const names = new Set([
      launcher.networkName({ family: 'egress', kind: 'internal', ownerId: 'run-a' }),
      launcher.networkName({ family: 'egress', kind: 'uplink', ownerId: 'run-a' }),
      launcher.unitName('egress-proxy', 'run-a'),
    ]);
    expect(names.size).toBe(3);
  });
});

describe('launcher network creation', () => {
  it('removes the host gateway on the internal network and labels both', async () => {
    const { launcher, calls } = recordingLauncher();
    const handle = await launcher.createNetwork({ family: 'egress', kind: 'internal', ownerId: 'run-a' });
    const id = launcherObjectId('run-a');

    expect(handle.name).toBe(`atoma-egress-${id}`);
    expect(calls).toEqual([
      [
        'network',
        'create',
        '--internal',
        '--label',
        `${LAUNCHER_OWNER_LABEL}=egress`,
        '--label',
        `dev.atoma.run=${id}`,
        '--opt',
        'com.docker.network.bridge.gateway_mode_ipv4=isolated',
        '--opt',
        'com.docker.network.bridge.gateway_mode_ipv6=isolated',
        handle.name,
      ],
    ]);
  });

  it('gives the uplink outbound NAT and never the isolated gateway', async () => {
    const { launcher, calls } = recordingLauncher();
    await launcher.createNetwork({ family: 'egress', kind: 'uplink', ownerId: 'run-a' });
    expect(calls[0]).not.toContain('--internal');
    expect(calls[0]?.join(' ')).not.toMatch(/gateway_mode/);
  });
});

describe('launcher unit start', () => {
  it('bounds the unit, drops privilege, and carries only launcher-derived inputs', async () => {
    const { launcher, calls } = recordingLauncher();
    const internal = await launcher.createNetwork({ family: 'egress', kind: 'internal', ownerId: 'run-a' });
    const uplink = await launcher.createNetwork({ family: 'egress', kind: 'uplink', ownerId: 'run-a' });
    calls.length = 0;

    const unit = await launcher.startUnit(
      { kind: 'egress-proxy', ownerId: 'run-a', allowlist: ['registry.npmjs.org'] },
      [internal, uplink]
    );

    const runArgs = calls[0]!;
    expect(runArgs[runArgs.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(runArgs[runArgs.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
    expect(runArgs[runArgs.indexOf('--network') + 1]).toBe(internal.name);
    // Memory and swap are equal, so the unit cannot escape its cap by swapping.
    expect(runArgs[runArgs.indexOf('--memory') + 1]).toBe(
      runArgs[runArgs.indexOf('--memory-swap') + 1]
    );
    expect(runArgs).toContain('--pids-limit');
    // The image is the LAUNCHER's, never the caller's.
    expect(runArgs).toContain('worker-image');
    expect(runArgs.slice(-3)).toEqual(['worker-image', 'node', '/app/dist/tools/egressProxy.js']);
    expect(runArgs).toContain('ATOMA_EGRESS_ALLOWLIST=registry.npmjs.org');

    // The second leg is connected, never granted at creation.
    expect(calls[1]).toEqual(['network', 'connect', uplink.name, unit.name]);
  });

  it('refuses a unit with no network rather than defaulting to the shared bridge', async () => {
    const { launcher } = recordingLauncher();
    await expect(
      launcher.startUnit({ kind: 'egress-proxy', ownerId: 'run-a', allowlist: [] }, [])
    ).rejects.toThrow(/at least one network/);
  });
});

describe('launcher purge and reconciliation', () => {
  it('purges an owner best-effort, in unit-then-networks order', async () => {
    const calls: string[][] = [];
    const launcher = new DockerLauncher({
      image: 'worker-image',
      runDocker: async (args) => {
        calls.push(args);
        throw new Error('no such object');
      },
    });

    await expect(launcher.purgeOwner('egress', 'run-a')).resolves.toBeUndefined();
    const id = launcherObjectId('run-a');
    expect(calls).toEqual([
      ['rm', '-f', `atoma-proxy-${id}`],
      ['network', 'rm', `atoma-egress-${id}`],
      ['network', 'rm', `atoma-uplink-${id}`],
    ]);
  });

  it('lists both families and names each unit by its own kind', async () => {
    // The stub answers PER FILTER, because that is how the engine answers:
    // a sweep that ignored the family label would count every object twice.
    const { launcher } = recordingLauncher((args) => {
      if (args[0] !== 'ps') return '';
      const filter = args[args.indexOf('--filter') + 1] ?? '';
      if (filter.endsWith('=egress')) {
        return ['atoma-proxy-abc\trunning', 'someone-elses\trunning'].join('\n');
      }
      return ['atoma-preview-app-xyz\trunning', 'atoma-preview-relay-xyz\texited'].join('\n');
    });

    const units = await launcher.listUnits();
    expect(units.map((u) => u.kind)).toEqual([
      'egress-proxy',
      'preview-app',
      'preview-ingress',
    ]);
    expect(units.map((u) => u.running)).toEqual([true, true, false]);
  });

  it('narrows a sweep to one kind', async () => {
    const { launcher } = recordingLauncher((args) => {
      if (args[0] !== 'ps') return '';
      const filter = args[args.indexOf('--filter') + 1] ?? '';
      return filter.endsWith('=egress') ? 'atoma-proxy-abc\trunning' : 'atoma-preview-app-xyz\trunning';
    });
    const units = await launcher.listUnits('preview-app');
    expect(units.map((u) => u.name)).toEqual(['atoma-preview-app-xyz']);
  });

  it('removes every labelled orphan of both families, containers first', async () => {
    const { launcher, calls } = recordingLauncher((args) => {
      const filter = args[args.indexOf('--filter') + 1] ?? '';
      if (args[0] === 'ps') return filter.endsWith('=egress') ? 'atoma-proxy-abc\texited' : '';
      if (args[0] === 'network' && args[1] === 'ls') {
        return filter.endsWith('=egress')
          ? 'atoma-egress-abc\natoma-uplink-abc'
          : 'atoma-preview-net-xyz';
      }
      return '';
    });

    await expect(launcher.reconcileOrphans()).resolves.toBe(4);
    // A network with an endpoint still attached refuses removal, so the
    // container must go first or the whole retry budget is spent losing.
    const removedContainer = calls.findIndex((c) => c[0] === 'rm');
    const removedNetwork = calls.findIndex((c) => c[0] === 'network' && c[1] === 'rm');
    expect(removedContainer).toBeLessThan(removedNetwork);
    expect(calls).toContainEqual(['network', 'rm', 'atoma-preview-net-xyz']);
  });
});

describe('launcher preview profiles', () => {
  function previewLauncher(): { launcher: DockerLauncher; calls: string[][] } {
    const calls: string[][] = [];
    const launcher = new DockerLauncher({
      image: 'worker-image',
      previewImage: 'preview-image@sha256:abc',
      previewRuntime: 'runsc',
      workspaceRoot: '/var/lib/atoma/previews',
      runDocker: async (args) => {
        calls.push(args);
        return args[0] === 'port' ? '127.0.0.1:49154' : args[0] === 'inspect' ? '172.30.0.2' : '';
      },
      waitUntilReady: async () => undefined,
      sleep: async () => undefined,
    });
    return { launcher, calls };
  }

  it('labels preview objects as previews, never as egress', async () => {
    const { launcher, calls } = previewLauncher();
    await launcher.createNetwork({ family: 'preview', kind: 'internal', ownerId: 'prev-1' });
    const args = calls[0]!;
    expect(args).toContain(`${LAUNCHER_OWNER_LABEL}=preview`);
    expect(args.join(' ')).not.toContain('=egress');
    // A preview network is as isolated as a run's: no host gateway.
    expect(args).toContain('com.docker.network.bridge.gateway_mode_ipv4=isolated');
  });

  it('derives a preview app proxy from its own generation and labels its proxy for cleanup', async () => {
    const { launcher, calls } = previewLauncher();
    const net = await launcher.createNetwork({ family: 'preview', kind: 'internal', ownerId: 'prev-net' });
    await launcher.startUnit({ kind: 'preview-egress-proxy', ownerId: 'prev-net', allowlist: ['fonts.googleapis.com'] }, [net]);
    const proxy = calls.find((args) => args.includes('/app/dist/tools/egressProxy.js'))!;
    expect(proxy).toContain('dev.atoma.owner=preview');
    await launcher.startUnit({
      kind: 'preview-app', ownerId: 'prev-net', entry: 'server.js', egress: true,
      workspace: { ownerId: 'prev-net', id: launcherObjectId('prev-net') },
    }, [net]);
    expect(calls).toContainEqual([
      'inspect', '--format',
      `{{with index .NetworkSettings.Networks ${JSON.stringify(net.name)}}}{{.IPAddress}}{{end}}`,
      launcher.unitName('preview-egress-proxy', 'prev-net'),
    ]);
    expect(calls.at(-1)).toContain('HTTPS_PROXY=http://172.30.0.2:3128');
    expect(calls.at(-1)).toContain('HTTP_PROXY=http://172.30.0.2:3128');
    expect(calls.at(-1)).toContain('NODE_USE_ENV_PROXY=1');
    await launcher.purgeOwner('preview', 'prev-net');
    expect(calls).toContainEqual(['rm', '-f', launcher.unitName('preview-egress-proxy', 'prev-net')]);
  });

  it.each(['', '<no value>', 'proxy.example', '172.30.0.2 172.31.0.2'])(
    'refuses to start when the isolated proxy endpoint is invalid: %s', async (address) => {
      const { launcher, calls } = recordingLauncher(() => address);
      const net = await launcher.createNetwork({ family: 'preview', kind: 'internal', ownerId: 'missing-proxy' });
      await expect(launcher.startUnit({
        kind: 'preview-app', ownerId: 'missing-proxy', entry: 'server.js', egress: true,
        workspace: { ownerId: 'missing-proxy', id: launcherObjectId('missing-proxy') },
      }, [net])).rejects.toThrow('no isolated network address');
      expect(calls.some((args) => args[0] === 'run')).toBe(false);
    }
  );

  it('runs the application under gVisor, read-only, non-root and bounded', async () => {
    const { launcher, calls } = previewLauncher();
    const net = await launcher.createNetwork({
      family: 'preview',
      kind: 'internal',
      ownerId: 'prev-1',
    });
    calls.length = 0;

    await launcher.startUnit(
      {
        kind: 'preview-app',
        ownerId: 'prev-1',
        entry: 'server.js',
        workspace: { ownerId: 'prev-1', id: launcherObjectId('prev-1') },
      },
      [net]
    );

    const args = calls[0]!;
    expect(args[args.indexOf('--runtime') + 1]).toBe('runsc');
    expect(args).toContain('--read-only');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
    expect(args[args.indexOf('--user') + 1]).not.toBe('0:0');
    expect(args[args.indexOf('--memory') + 1]).toBe(args[args.indexOf('--memory-swap') + 1]);
    expect(args).toContain('--pids-limit');
    // The start command is EXACTLY `node <entry>` — never a shell, and never
    // whatever the image's own ENTRYPOINT would have wrapped it with.
    expect(args[args.indexOf('--entrypoint') + 1]).toBe('node');
    expect(args.slice(-2)).toEqual(['preview-image@sha256:abc', 'server.js']);
    // Exactly one mount, and it is the launcher-owned workspace.
    const mounts = args.filter((a, i) => args[i - 1] === '-v');
    expect(mounts).toEqual([`/var/lib/atoma/previews/${launcherObjectId('prev-1')}:/workspace`]);
    // The environment is the five the profile names, and nothing inherited.
    const env = args.filter((a, i) => args[i - 1] === '-e');
    expect(env.map((e) => e.split('=')[0]).sort()).toEqual([
      'ATOMA_DATA_DIR',
      'HOME',
      'HOST',
      'NODE_ENV',
      'PORT',
    ]);
    expect(env).toContain('PORT=8080');
  });

  it('publishes the relay on loopback only and reads back the assigned port', async () => {
    const { launcher, calls } = previewLauncher();
    const net = await launcher.createNetwork({
      family: 'preview',
      kind: 'internal',
      ownerId: 'prev-1',
    });
    calls.length = 0;

    const relay = await launcher.startUnit({ kind: 'preview-ingress', ownerId: 'prev-1' }, [net]);

    const args = calls[0]!;
    const publish = args[args.indexOf('-p') + 1];
    expect(publish).toBe('127.0.0.1::8081');
    // The relay's upstream is the app of the SAME owner, resolved here rather
    // than accepted, which is what makes it impossible to point elsewhere.
    expect(args).toContain(`ATOMA_PREVIEW_UPSTREAM_HOST=${launcher.unitName('preview-app', 'prev-1')}`);
    expect(args).toContain('ATOMA_PREVIEW_UPSTREAM_PORT=8080');
    // `--entrypoint node` makes the command exact whatever the image
    // declares: an image ENTRYPOINT would otherwise wrap it.
    expect(args[args.indexOf('--entrypoint') + 1]).toBe('node');
    expect(args.slice(-2)).toEqual(['worker-image', '/app/dist/tools/previewIngress.js']);
    expect(relay.hostPort).toBe(49154);
  });

  it('purges a preview owner without touching a run of the same name', async () => {
    const { launcher, calls } = previewLauncher();
    await launcher.purgeOwner('preview', 'prev-1');
    const flat = calls.map((c) => c.join(' '));
    expect(flat.some((c) => c.includes('atoma-egress-'))).toBe(false);
    expect(flat.some((c) => c.includes('atoma-uplink-'))).toBe(false);
    expect(flat).toContain(`network rm ${launcher.networkName({ family: 'preview', kind: 'internal', ownerId: 'prev-1' })}`);
    // The relay goes before the app: it is what holds the network open and
    // what a member is still connected to.
    expect(flat[0]).toContain('atoma-preview-relay-');
    expect(flat[1]).toContain('atoma-preview-app-');
  });
});

describe('launcher network removal', () => {
  it('treats an already-absent network as removed rather than retrying to the budget', async () => {
    let attempts = 0;
    const launcher = new DockerLauncher({
      image: 'worker-image',
      runDocker: async () => {
        attempts += 1;
        throw new Error('Error: No such network: atoma-egress-x');
      },
      sleep: async () => undefined,
    });
    await expect(
      launcher.removeNetwork({ family: 'egress', kind: 'internal', ownerId: 'run-a', name: 'atoma-egress-x' })
    ).resolves.toBe(true);
    expect(attempts).toBe(1);
  });

  it('reports failure instead of claiming a durable object is gone', async () => {
    const launcher = new DockerLauncher({
      image: 'worker-image',
      runDocker: async () => {
        throw new Error('network is in use');
      },
      sleep: async () => undefined,
    });
    await expect(
      launcher.removeNetwork({ family: 'egress', kind: 'internal', ownerId: 'run-a', name: 'atoma-egress-x' })
    ).resolves.toBe(false);
  });

  it('shares ONE deadline across several removals in a teardown', async () => {
    let clock = 0;
    const launcher = new DockerLauncher({
      image: 'worker-image',
      runDocker: async () => {
        clock += 10_000; // blow past the budget on the first attempt
        throw new Error('network is in use');
      },
      sleep: async () => undefined,
      now: () => clock,
    });
    const deadline = clock + 3_500;
    await expect(
      launcher.removeNetworkBefore(
        { family: 'egress', kind: 'internal', ownerId: 'run-a', name: 'atoma-egress-x' },
        deadline
      )
    ).resolves.toBe(false);
    await expect(
      launcher.removeNetworkBefore(
        { family: 'egress', kind: 'uplink', ownerId: 'run-a', name: 'atoma-uplink-x' },
        deadline
      )
    ).resolves.toBe(false);
  });
});

describe('launcher hard-exit registry', () => {
  it('force-removes the unit, every attached container, then both networks', () => {
    const registry = new LauncherExitRegistry();
    registry.track('egress:run', {
      containers: ['atoma-proxy-run'],
      networks: ['atoma-egress-run', 'atoma-uplink-run'],
    });
    const calls: string[][] = [];
    const runSync = (args: string[]): string => {
      calls.push(args);
      return args[0] === 'network' && args[1] === 'inspect' && args.at(-1) === 'atoma-egress-run'
        ? 'worker-generated-name'
        : '';
    };

    registry.cleanup(runSync);
    expect(calls[0]).toEqual(['rm', '-f', 'atoma-proxy-run']);
    expect(calls).toContainEqual(['rm', '-f', 'worker-generated-name']);
    expect(calls).toContainEqual(['network', 'rm', 'atoma-egress-run']);
    expect(calls).toContainEqual(['network', 'rm', 'atoma-uplink-run']);
  });

  it('arms and disarms by owner, so a caller needs no handle to be safe', () => {
    const { launcher } = recordingLauncher();
    expect(() => launcher.armHardExitCleanup('egress', 'run-a')).not.toThrow();
    expect(() => launcher.disarmHardExitCleanup('egress', 'run-a')).not.toThrow();
  });
});

describe('engine capability refusal', () => {
  it('recognises an engine too old for an isolated bridge gateway', () => {
    expect(isIsolatedGatewayUnsupported(new Error('unknown option gateway_mode_ipv4'))).toBe(true);
    expect(isIsolatedGatewayUnsupported(new Error('invalid --opt gateway mode'))).toBe(true);
    expect(isIsolatedGatewayUnsupported(new Error('isolated bridge is unsupported'))).toBe(true);
  });

  it('does not read an ordinary teardown failure as an engine-capability problem', () => {
    // The qualifier must FOLLOW "isolated" in the second alternative, so prose
    // that merely contains "invalid" somewhere is not a capability verdict.
    // Reading one as the other would turn a busy network into a refusal that
    // tells the operator to upgrade Docker.
    expect(isIsolatedGatewayUnsupported(new Error('network is in use'))).toBe(false);
    expect(isIsolatedGatewayUnsupported(new Error('invalid reference format'))).toBe(false);
  });
});
