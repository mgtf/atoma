import { describe, it, expect } from 'vitest';
import { EgressExitRegistry } from '../src/tools/egressSidecar.js';

describe('egress sidecar hard-exit registry', () => {
  it('force-removes the proxy, every attached worker, then the network', () => {
    const registry = new EgressExitRegistry();
    registry.track('atoma-egress-run', 'atoma-proxy-run');
    const calls: string[][] = [];
    const runSync = (args: string[]): string => {
      calls.push(args);
      return args[0] === 'network' && args[1] === 'inspect' ? 'worker-generated-name' : '';
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
    ]);

    registry.cleanup(runSync);
    expect(calls).toHaveLength(4);
  });

  it('does nothing after orderly cleanup untracks the run', () => {
    const registry = new EgressExitRegistry();
    registry.track('network', 'proxy');
    registry.untrack('network');
    const calls: string[][] = [];
    registry.cleanup((args) => {
      calls.push(args);
      return '';
    });
    expect(calls).toEqual([]);
  });
});
