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
      expect(launcherNetworkSpecSchema.safeParse({ kind: 'internal', ownerId: owner }).success).toBe(
        false
      );
    }
    expect(
      launcherNetworkSpecSchema.safeParse({ kind: 'internal', ownerId: 'run-4f2c' }).success
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
    expect(launcher.networkName({ kind: 'internal', ownerId: 'run-a' })).toBe(
      launcher.networkName({ kind: 'internal', ownerId: 'run-a' })
    );
    expect(launcherObjectId('run/42')).not.toBe(launcherObjectId('run:42'));
    expect(launcherObjectId('x'.repeat(80) + 'a')).not.toBe(launcherObjectId('x'.repeat(80) + 'b'));
  });

  it('gives the internal network, the uplink and the unit three distinct names', () => {
    const { launcher } = recordingLauncher();
    const names = new Set([
      launcher.networkName({ kind: 'internal', ownerId: 'run-a' }),
      launcher.networkName({ kind: 'uplink', ownerId: 'run-a' }),
      launcher.unitName('egress-proxy', 'run-a'),
    ]);
    expect(names.size).toBe(3);
  });
});

describe('launcher network creation', () => {
  it('removes the host gateway on the internal network and labels both', async () => {
    const { launcher, calls } = recordingLauncher();
    const handle = await launcher.createNetwork({ kind: 'internal', ownerId: 'run-a' });
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
    await launcher.createNetwork({ kind: 'uplink', ownerId: 'run-a' });
    expect(calls[0]).not.toContain('--internal');
    expect(calls[0]?.join(' ')).not.toMatch(/gateway_mode/);
  });
});

describe('launcher unit start', () => {
  it('bounds the unit, drops privilege, and carries only launcher-derived inputs', async () => {
    const { launcher, calls } = recordingLauncher();
    const internal = await launcher.createNetwork({ kind: 'internal', ownerId: 'run-a' });
    const uplink = await launcher.createNetwork({ kind: 'uplink', ownerId: 'run-a' });
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

    await expect(launcher.purgeOwner('run-a')).resolves.toBeUndefined();
    const id = launcherObjectId('run-a');
    expect(calls).toEqual([
      ['rm', '-f', `atoma-proxy-${id}`],
      ['network', 'rm', `atoma-egress-${id}`],
      ['network', 'rm', `atoma-uplink-${id}`],
    ]);
  });

  it('lists only its own labelled proxies and reports whether they run', async () => {
    const { launcher } = recordingLauncher((args) =>
      args[0] === 'ps'
        ? ['atoma-proxy-abc\trunning', 'atoma-proxy-def\texited', 'someone-elses\trunning'].join('\n')
        : ''
    );
    const units = await launcher.listUnits();
    expect(units.map((u) => u.name)).toEqual(['atoma-proxy-abc', 'atoma-proxy-def']);
    expect(units.map((u) => u.running)).toEqual([true, false]);
  });

  it('removes every labelled orphan and counts what it removed', async () => {
    const { launcher, calls } = recordingLauncher((args) => {
      if (args[0] === 'ps') return 'atoma-proxy-abc\texited';
      if (args[0] === 'network' && args[1] === 'ls') return 'atoma-egress-abc\natoma-uplink-abc';
      return '';
    });
    await expect(launcher.reconcileOrphans()).resolves.toBe(3);
    expect(calls).toContainEqual(['rm', '-f', 'atoma-proxy-abc']);
    expect(calls).toContainEqual(['network', 'rm', 'atoma-egress-abc']);
    expect(calls).toContainEqual(['network', 'rm', 'atoma-uplink-abc']);
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
      launcher.removeNetwork({ kind: 'internal', ownerId: 'run-a', name: 'atoma-egress-x' })
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
      launcher.removeNetwork({ kind: 'internal', ownerId: 'run-a', name: 'atoma-egress-x' })
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
        { kind: 'internal', ownerId: 'run-a', name: 'atoma-egress-x' },
        deadline
      )
    ).resolves.toBe(false);
    await expect(
      launcher.removeNetworkBefore(
        { kind: 'uplink', ownerId: 'run-a', name: 'atoma-uplink-x' },
        deadline
      )
    ).resolves.toBe(false);
  });
});

describe('launcher hard-exit registry', () => {
  it('force-removes the unit, every attached container, then both networks', () => {
    const registry = new LauncherExitRegistry();
    registry.track('atoma-egress-run', 'atoma-proxy-run', 'atoma-uplink-run');
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
    expect(() => launcher.armHardExitCleanup('run-a')).not.toThrow();
    expect(() => launcher.disarmHardExitCleanup('run-a')).not.toThrow();
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
