import { describe, it, expect } from 'vitest';
import {
  EGRESS_ASYNC_CLEANUP_BUDGET_MS,
  EGRESS_EXIT_REMOVE_ATTEMPTS,
  EGRESS_EXIT_REMOVE_RETRY_MS,
  EGRESS_NETWORK_REMOVE_RETRY_MS,
  EgressExitRegistry,
  egressObjectId,
  startEgressSidecar,
} from '../src/tools/egressSidecar.js';

describe('egress sidecar hard-exit registry', () => {
  it('force-removes the proxy, every attached worker, then both per-run networks', () => {
    const registry = new EgressExitRegistry();
    registry.track('atoma-egress-run', 'atoma-proxy-run', 'atoma-uplink-run');
    const calls: string[][] = [];
    const runSync = (args: string[]): string => {
      calls.push(args);
      return args[0] === 'network' &&
        args[1] === 'inspect' &&
        args.at(-1) === 'atoma-egress-run'
        ? 'worker-generated-name'
        : '';
    };

    registry.cleanup(runSync);
    expect(calls).toEqual([
      ['rm', '-f', 'atoma-proxy-run'],
      [
        'network',
        'inspect',
        '--format',
        '{{range .Containers}}{{.Name}} {{end}}',
        'atoma-egress-run',
      ],
      ['rm', '-f', 'worker-generated-name'],
      ['network', 'rm', 'atoma-egress-run'],
      [
        'network',
        'inspect',
        '--format',
        '{{range .Containers}}{{.Name}} {{end}}',
        'atoma-uplink-run',
      ],
      ['network', 'rm', 'atoma-uplink-run'],
    ]);

    registry.cleanup(runSync);
    expect(calls).toHaveLength(6);
  });

  it('does nothing after orderly cleanup untracks the run', () => {
    const registry = new EgressExitRegistry();
    registry.track('network', 'proxy', 'uplink');
    registry.untrack('network');
    const calls: string[][] = [];
    registry.cleanup((args) => {
      calls.push(args);
      return '';
    });
    expect(calls).toEqual([]);
  });

  it('retries a transient hard-exit race without inheriting the long async budget', () => {
    const registry = new EgressExitRegistry();
    registry.track('internal', 'proxy', 'uplink');
    const calls: string[][] = [];
    const waits: number[] = [];
    let internalRemoveAttempts = 0;
    let internalInspectAttempts = 0;

    registry.cleanup((args) => {
      calls.push(args);
      if (args[0] === 'network' && args[1] === 'inspect') {
        if (args.at(-1) === 'internal' && internalInspectAttempts++ === 0) {
          throw new Error('Docker daemon temporarily unavailable');
        }
        return '';
      }
      if (args[0] === 'network' && args[1] === 'rm' && args[2] === 'internal') {
        internalRemoveAttempts++;
        if (internalRemoveAttempts < EGRESS_EXIT_REMOVE_ATTEMPTS) {
          throw new Error('endpoint is still being torn down');
        }
      }
      return args.at(-1) ?? '';
    }, (delayMs) => waits.push(delayMs));

    expect(internalRemoveAttempts).toBe(EGRESS_EXIT_REMOVE_ATTEMPTS);
    expect(waits).toEqual([
      EGRESS_EXIT_REMOVE_RETRY_MS,
    ]);
    expect(
      calls.filter(
        (args) => args[0] === 'network' && args[1] === 'rm' && args[2] === 'uplink'
      )
    ).toHaveLength(1);
  });
});

describe('egress sidecar Docker topology', () => {
  it('keeps colliding/truncated run labels in distinct Docker namespaces', () => {
    expect(egressObjectId('run/42')).not.toBe(egressObjectId('run:42'));
    expect(egressObjectId('x'.repeat(80) + 'a')).not.toBe(
      egressObjectId('x'.repeat(80) + 'b')
    );
  });

  it('uses a private uplink instead of the shared bridge and bounds proxy resources', async () => {
    const calls: string[][] = [];
    const sidecar = await startEgressSidecar(
      { runId: 'run/42', image: 'worker-image' },
      {
        runDocker: async (args) => {
          calls.push(args);
          return args.at(-1) ?? '';
        },
        waitUntilReady: async () => undefined,
        sleep: async () => undefined,
      }
    );

    try {
      const id = egressObjectId('run/42');
      expect(sidecar.network).toBe(`atoma-egress-${id}`);
      expect(sidecar.uplinkNetwork).toBe(`atoma-uplink-${id}`);
      expect(calls).toContainEqual([
        'network',
        'create',
        '--internal',
        '--label',
        'dev.atoma.owner=egress',
        '--label',
        `dev.atoma.run=${id}`,
        '--opt',
        'com.docker.network.bridge.gateway_mode_ipv4=isolated',
        '--opt',
        'com.docker.network.bridge.gateway_mode_ipv6=isolated',
        sidecar.network,
      ]);
      expect(calls).toContainEqual([
        'network',
        'create',
        '--label',
        'dev.atoma.owner=egress',
        '--label',
        `dev.atoma.run=${id}`,
        sidecar.uplinkNetwork,
      ]);
      expect(calls).toContainEqual([
        'network',
        'connect',
        sidecar.uplinkNetwork,
        sidecar.proxyHost,
      ]);
      expect(calls).not.toContainEqual(['network', 'connect', 'bridge', sidecar.proxyHost]);

      const proxyRun = calls.find((args) => args[0] === 'run');
      expect(proxyRun).toBeDefined();
      expect(proxyRun).toContain('dev.atoma.owner=egress');
      expect(proxyRun).toContain(`dev.atoma.run=${id}`);
      expect(proxyRun![proxyRun!.indexOf('--network') + 1]).toBe(sidecar.network);
      expect(proxyRun![proxyRun!.indexOf('--memory') + 1]).toBe('256m');
      expect(proxyRun![proxyRun!.indexOf('--memory-swap') + 1]).toBe('256m');
      expect(proxyRun![proxyRun!.indexOf('--cpus') + 1]).toBe('0.5');
      expect(proxyRun![proxyRun!.indexOf('--pids-limit') + 1]).toBe('64');
    } finally {
      await sidecar.stop();
    }
  });

  it('orderly stop retries the same transient endpoint-removal race', async () => {
    const internalNetwork = `atoma-egress-${egressObjectId('retry')}`;
    const liveNetworks = new Set<string>();
    const calls: string[][] = [];
    const waits: number[] = [];
    let stopping = false;
    let transientFailures = 2;
    const sidecar = await startEgressSidecar(
      { runId: 'retry', image: 'worker-image' },
      {
        runDocker: async (args) => {
          calls.push(args);
          if (args[0] === 'network' && args[1] === 'create') {
            liveNetworks.add(args.at(-1)!);
            return args.at(-1)!;
          }
          if (args[0] === 'network' && args[1] === 'inspect') {
            const network = args[2]!;
            if (!liveNetworks.has(network)) throw new Error('no such network');
            return network;
          }
          if (args[0] === 'network' && args[1] === 'rm') {
            const network = args[2]!;
            if (!liveNetworks.has(network)) throw new Error('no such network');
            if (stopping && network === internalNetwork && transientFailures-- > 0) {
              throw new Error('endpoint is still being torn down');
            }
            liveNetworks.delete(network);
            return network;
          }
          return args.at(-1) ?? '';
        },
        waitUntilReady: async () => undefined,
        sleep: async (delayMs) => {
          waits.push(delayMs);
        },
      }
    );

    stopping = true;
    const beforeStop = calls.length;
    await sidecar.stop();
    expect(
      calls
        .slice(beforeStop)
        .filter(
          (args) =>
            args[0] === 'network' &&
            args[1] === 'rm' &&
            args[2] === internalNetwork
        )
    ).toHaveLength(3);
    expect(waits).toEqual([
      EGRESS_NETWORK_REMOVE_RETRY_MS,
      EGRESS_NETWORK_REMOVE_RETRY_MS,
    ]);
    expect(liveNetworks).toEqual(new Set());

    const afterStop = calls.length;
    await sidecar.stop();
    expect(calls).toHaveLength(afterStop);
  });

  it('bounds orderly cleanup when Docker commands themselves keep hanging', async () => {
    let stopping = false;
    let hanging = true;
    let nowMs = 0;
    const calls: string[][] = [];
    const sidecar = await startEgressSidecar(
      { runId: 'deadline', image: 'worker-image' },
      {
        runDocker: async (args) => {
          calls.push(args);
          if (
            stopping &&
            hanging &&
            args[0] === 'network' &&
            (args[1] === 'rm' || args[1] === 'inspect')
          ) {
            nowMs += 2_000;
            throw new Error('Docker daemon timed out');
          }
          return args.at(-1) ?? '';
        },
        waitUntilReady: async () => undefined,
        sleep: async (delayMs) => {
          nowMs += delayMs;
        },
        now: () => nowMs,
      }
    );

    stopping = true;
    const beforeStop = calls.length;
    await expect(sidecar.stop()).rejects.toThrow(/cleanup exceeded/);
    const cleanupCalls = calls.slice(beforeStop);
    expect(nowMs).toBeGreaterThanOrEqual(EGRESS_ASYNC_CLEANUP_BUDGET_MS);
    expect(
      cleanupCalls.filter((args) => args[0] === 'network' && args[1] === 'rm')
    ).toHaveLength(1);

    // An incomplete stop remains retryable and untracks after Docker recovers.
    hanging = false;
    await sidecar.stop();
  });
});
