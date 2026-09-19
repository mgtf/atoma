/**
 * `docker run` arguments that carry the isolation. Exported so a test can
 * assert them rather than trusting a comment — every one of them was
 * verified against a real container before this file existed.
 */
export function workerRunArgs(opts: {
  image: string;
  workspaceHostPath: string;
  workspaceVolume?: string;
  /** Launcher-created socket FILE, mounted read-only; never its control endpoint. */
  socketHostPath?: string;
  memory?: string;
  cpus?: string;
  /** Numeric uid:gid allowed to write the host-owned bind mount. */
  user?: string;
  /**
   * EGRESS MODE. When set, the run joins a per-run Docker network created
   * with `--internal` AND bridge gateway mode `isolated`
   * instead of getting no network at all, and `HTTP_PROXY` points at the one
   * peer on it. Measured, which is why the shape is this and not `bridge`:
   *   --network none      control plane blocked, internet blocked
   *   default bridge      control plane REACHED, internet reached
   *   isolated internal  control plane blocked, internet blocked
   * Plain `--internal` is NOT enough: its bridge gateway can reach host
   * services. Removing that gateway makes the network equivalent to `none`
   * for host/external routes while still BEING a LAN, so a proxy attached
   * to it and to an external network can
   * carry egress selectively — and `decideEgress` is the whole of what it
   * carries. Plain `bridge` is never an option: it hands the run the control
   * plane, the same reachability that made an HTTP-served launch token
   * worthless.
   */
  egress?: { network: string; proxyHost: string; proxyPort: number };
}): string[] {
  return [
    'run',
    '--rm',
    ...(opts.socketHostPath ? ['-d', '--mount', `type=bind,src=${opts.socketHostPath},dst=/run/atoma-worker.sock,readonly`, '-e', 'ATOMA_WORKER_SOCKET=/run/atoma-worker.sock'] : ['-i']),
    // NO NETWORK ROUTE OUT. The container keeps its own loopback — verified:
    // a server started inside is reachable from inside — so the HTTP bucket
    // (`start_node_server` + `fetch_url` at 127.0.0.1) works unchanged, while
    // the control plane is unreachable: `host.docker.internal` does not even
    // resolve. This is the network half of invariant T1
    // (docs/saas-architecture.md) and it costs nothing.
    '--network',
    opts.egress ? opts.egress.network : 'none',
    ...(opts.egress
      ? [
          '-e',
          `HTTP_PROXY=http://${opts.egress.proxyHost}:${opts.egress.proxyPort}`,
          '-e',
          `HTTPS_PROXY=http://${opts.egress.proxyHost}:${opts.egress.proxyPort}`,
          '-e',
          `npm_config_proxy=http://${opts.egress.proxyHost}:${opts.egress.proxyPort}`,
          '-e',
          `npm_config_https_proxy=http://${opts.egress.proxyHost}:${opts.egress.proxyPort}`,
          // The HTTP bucket probes servers inside this SAME container.
          // Loopback must never leave through the default-deny proxy.
          '-e',
          'NO_PROXY=127.0.0.1,localhost,::1',
          '-e',
          'no_proxy=127.0.0.1,localhost,::1',
          // Node 22+ does not consult HTTP_PROXY for fetch() unless this is
          // explicitly enabled. Without it fetch_url had no route on the
          // internal network even for allowlisted hosts.
          '-e',
          'NODE_USE_ENV_PROXY=1',
        ]
      : []),
    // ONLY the workspace. The atom registry, the skill bodies, the ledger and
    // other runs' traces are simply not on this filesystem, so the
    // `../../atoma-build.db` walk that works today finds nothing.
    ...(opts.workspaceVolume ? ['--mount', `type=volume,src=${opts.workspaceVolume},dst=/workspace,volume-nocopy`]
      : ['-v', `${opts.workspaceHostPath}:/workspace`]),
    '-w',
    '/workspace',
    // Drop every capability and forbid regaining privilege: nothing the
    // builtins do needs either, and a container that can re-acquire them is
    // one kernel bug away from not being a boundary.
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    ...(opts.user ? ['--user', opts.user, '-e', 'HOME=/tmp/atoma-home'] : []),
    // Bounds, so a runaway build cannot take the host down with it. A run
    // already has a wall-clock budget; this is the resource equivalent.
    '--memory',
    opts.memory ?? '2g',
    '--cpus',
    opts.cpus ?? '2',
    opts.image,
  ];
}
