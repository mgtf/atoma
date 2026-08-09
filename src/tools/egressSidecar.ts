import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_EGRESS_ALLOWLIST } from './egressPolicy.js';

const run = promisify(execFile);

/**
 * The egress proxy that a containerised run may reach, and nothing else.
 *
 * PER RUN, not shared, and that is a correctness requirement rather than
 * tidiness. REPRODUCED: with two containers on one `--internal` network, the
 * second read the first's HTTP server — `REACHED: TENANT_A_WORKSPACE_SECRET`.
 * A docker network is a LAN; putting two tenants on it hands each other's
 * workspaces over. So every run gets its own network and its own proxy, both
 * named after the run and both torn down with it.
 *
 * Topology:
 *   run container  → atoma-egress-<id>   (--internal: no route anywhere)
 *   proxy          → atoma-egress-<id> AND the default bridge
 * The proxy is therefore the single peer the run can reach, and
 * `decideEgress` is the whole of what it will carry.
 */
export interface EgressSidecar {
  /** Docker network the run must join. */
  readonly network: string;
  /** Hostname the run uses for the proxy (its container name on that net). */
  readonly proxyHost: string;
  readonly proxyPort: number;
  /** Remove the proxy and the network. Safe to call twice. */
  stop(): Promise<void>;
}

const PROXY_PORT = 3128;

/** Docker object names: run ids can contain characters docker refuses. */
function sanitiseId(runId: string): string {
  const s = runId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 40);
  return s || 'run';
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function quiet(args: string[]): Promise<void> {
  try {
    await docker(args);
  } catch {
    /* teardown is best-effort: a missing object is the desired end state */
  }
}


/**
 * Block until the proxy has logged that it is listening.
 *
 * Reading the container's own log rather than probing a port: the proxy sits
 * on an `--internal` network the host cannot reach, so there is nothing to
 * connect to from here — the log line is the only readiness signal available.
 */
async function waitForProxy(proxyHost: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let logs = '';
    try {
      // BOTH STREAMS. `docker logs` mirrors the container's stdout and stderr
      // onto its own, and the proxy deliberately logs to STDERR — stdout is
      // the stdio protocol for the worker image. Reading only stdout here
      // made readiness never arrive, and the symptom was an empty
      // node_modules three layers away. The hand-run reproduction saw the
      // line only because the shell merged the streams with 2>&1.
      const { stdout, stderr } = await run('docker', ['logs', proxyHost], {
        maxBuffer: 4 * 1024 * 1024,
      });
      logs = stdout + stderr;
    } catch {
      /* container not up yet */
    }
    if (/\[egress\] listening on/.test(logs)) return;
    if (Date.now() > deadline) {
      throw new Error(`egress proxy ${proxyHost} did not start listening in ${timeoutMs}ms: ${logs.slice(-300)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function startEgressSidecar(opts: {
  runId: string;
  image: string;
  allowlist?: readonly string[];
  /** Widen only for a private registry on a non-standard port. */
  allowedPorts?: readonly number[];
}): Promise<EgressSidecar> {
  const id = sanitiseId(opts.runId);
  const network = `atoma-egress-${id}`;
  const proxyHost = `atoma-proxy-${id}`;
  const allowlist = opts.allowlist ?? DEFAULT_EGRESS_ALLOWLIST;

  // Clean any debris from a previous crashed run with the same id before
  // creating: `docker network create` fails on an existing name, and the
  // failure would be reported as "egress unavailable" for a stale object.
  await quiet(['rm', '-f', proxyHost]);
  await quiet(['network', 'rm', network]);

  await docker(['network', 'create', '--internal', network]);
  try {
    await docker([
      'run',
      '-d',
      '--name',
      proxyHost,
      '--network',
      network,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '-e',
      `ATOMA_EGRESS_PORT=${PROXY_PORT}`,
      '-e',
      `ATOMA_EGRESS_ALLOWLIST=${allowlist.join(',')}`,
      ...(opts.allowedPorts ? ['-e', `ATOMA_EGRESS_PORTS=${opts.allowedPorts.join(',')}`] : []),
      opts.image,
      'node',
      '/app/dist/tools/egressProxy.js',
    ]);
    // The proxy's SECOND leg. Attaching it to the default bridge is what
    // gives it a route out; the run never joins this network, which is the
    // entire separation.
    await docker(['network', 'connect', 'bridge', proxyHost]);
    // WAIT FOR IT TO LISTEN. `docker run -d` returns as soon as the container
    // is created, not when the process inside is serving — and the run's very
    // first `npm install` hits the proxy immediately. Found the hard way: the
    // hand-driven reproduction had a `sleep 2` and worked, the orchestrated
    // path had none and npm failed with an empty node_modules while every
    // other check passed, which reads like a policy problem and is not one.
    await waitForProxy(proxyHost);
  } catch (err) {
    await quiet(['rm', '-f', proxyHost]);
    await quiet(['network', 'rm', network]);
    throw err;
  }

  let stopped = false;
  return {
    network,
    proxyHost,
    proxyPort: PROXY_PORT,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await quiet(['rm', '-f', proxyHost]);
      // RETRY the network removal. The worker container is `--rm`, but
      // `ContainerToolExecutor.stop()` only signals it — docker may still be
      // tearing it down, and a network with an attached endpoint refuses to
      // be removed. Observed: exactly one leaked network per run.
      for (let i = 0; i < 25; i++) {
        try {
          await docker(['network', 'rm', network]);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      await quiet(['network', 'rm', network]);
    },
  };
}
