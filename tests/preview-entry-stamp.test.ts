import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ToolSandbox } from '../src/tools/sandbox.js';
import {
  defaultBuiltinTools,
  fetchUrlTool,
  startNodeServerTool,
  type BuiltinTool,
  type NodeServerEntries,
} from '../src/tools/builtin.js';
import {
  PROBE_MANIFEST_FILENAME,
  appendHttpProbe,
  validateProbeManifest,
} from '../src/contracts/probeManifest.js';

/**
 * THE ONE CROSS-TOOL CHANNEL that carries the machine-observed entry file.
 *
 * `start_node_server` knows WHICH FILE it spawned and never writes the
 * manifest; `fetch_url record:true` writes the http entry and only ever sees a
 * URL. The shared `nodeServers` map is the only thing that lets the recorded
 * evidence say which file was the server — which is exactly what a later
 * reader (a replayer, a preview boot) needs in order to start it again.
 *
 * These tests exercise the real exported tools against real child processes
 * and real loopback sockets: nothing about this channel is observable through
 * a mock, because both halves of the fact are produced by the runtime.
 */

/** A server that binds `process.env.PORT` and announces the port it bound. */
const ENTRY_SOURCE = `
const http = require('node:http');
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});
srv.listen(Number(process.env.PORT) || 0, '127.0.0.1', () => {
  console.log('LISTENING_ON_PORT=' + srv.address().port);
});
`;

interface RecordedHttpEntry {
  probe: string;
  method: string;
  path: string;
  status: number;
  body?: string;
  note?: string;
  entry?: string;
}

function readManifestEntries(root: string): RecordedHttpEntry[] {
  const raw = readFileSync(join(root, PROBE_MANIFEST_FILENAME), 'utf8');
  const doc = JSON.parse(raw) as { version: number; entries: RecordedHttpEntry[] };
  return doc.entries;
}

/**
 * A non-internal IPv4 address of this host, or undefined when the machine has
 * none (an isolated container, a laptop with every interface down). Used to
 * prove the non-loopback rule WITHOUT reaching the network: the request still
 * never leaves the host, but the URL's hostname is genuinely not loopback.
 */
function hostIpv4(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return undefined;
}

describe('start_node_server records the entry file against the bound port', () => {
  let root: string;
  let sandbox: ToolSandbox;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atoma-entry-stamp-'));
    sandbox = new ToolSandbox(root);
  });

  afterEach(async () => {
    // MANDATORY: cleanup SIGKILLs the tracked child. Without it a spawned
    // server survives the test file and squats its port.
    await sandbox.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the entry and publishes it into the shared nodeServers map', async () => {
    writeFileSync(join(root, 'server.js'), ENTRY_SOURCE, 'utf8');
    const nodeServers: NodeServerEntries = new Map();
    const start = startNodeServerTool({ sandbox, nodeServers });

    const res = (await start.execute({ entry: 'server.js' })) as {
      ok: boolean;
      url: string;
      port: number;
      entry: string;
    };

    expect(res.ok).toBe(true);
    expect(res.port).toBeGreaterThan(0);
    // The RESULT carries the entry the caller passed — an observation of the
    // argument that was spawned, not a claim the model made about its layout.
    expect(res.entry).toBe('server.js');
    // ...and the same observation is published on the cross-tool channel,
    // keyed by the port the child actually bound.
    expect(nodeServers.get(res.port)).toBe('server.js');
    expect(nodeServers.size).toBe(1);
  });

  it('stamps the started entry onto the http evidence fetch_url records', async () => {
    writeFileSync(join(root, 'server.js'), ENTRY_SOURCE, 'utf8');
    const nodeServers: NodeServerEntries = new Map();
    const start = startNodeServerTool({ sandbox, nodeServers });
    const fetchUrl = fetchUrlTool({ sandbox, nodeServers });

    const started = (await start.execute({ entry: 'server.js' })) as { port: number };
    // The tool returns a `localhost` URL but the entry binds 127.0.0.1;
    // probe the numeric form so a DNS quirk cannot decide the test.
    const probe = (await fetchUrl.execute({
      url: `http://127.0.0.1:${started.port}/health`,
      record: true,
      note: 'health endpoint answers',
    })) as { ok: boolean; status: number; recorded?: boolean };

    expect(probe.ok).toBe(true);
    expect(probe.status).toBe(200);
    expect(probe.recorded).toBe(true);

    const entries = readManifestEntries(root);
    expect(entries).toHaveLength(1);
    const recorded = entries[0]!;
    expect(recorded.probe).toBe('http');
    expect(recorded.method).toBe('GET');
    expect(recorded.path).toBe('/health');
    expect(recorded.status).toBe(200);
    expect(recorded.note).toBe('health endpoint answers');
    // The point of the whole channel: the evidence names the file that served it.
    expect(recorded.entry).toBe('server.js');
    // And the stamped entry is still a well-formed manifest.
    expect(validateProbeManifest(readFileSync(join(root, PROBE_MANIFEST_FILENAME), 'utf8'))).toEqual(
      []
    );
  });

  it('shares ONE channel through defaultBuiltinTools, end to end', async () => {
    writeFileSync(join(root, 'server.js'), ENTRY_SOURCE, 'utf8');
    // Built ONCE, with no nodeServers supplied — defaultBuiltinTools has to
    // create the map itself and hand the SAME one to both tools. If it ever
    // built two, or forwarded none, this stamp disappears while both tools
    // keep working in isolation.
    const tools = defaultBuiltinTools({ sandbox });
    const byName = (name: string): BuiltinTool => {
      const tool = tools.find((t) => t.declaration.name === name);
      if (!tool) throw new Error(`missing built-in tool ${name}`);
      return tool;
    };

    const started = (await byName('start_node_server').execute({ entry: 'server.js' })) as {
      port: number;
      entry: string;
    };
    expect(started.entry).toBe('server.js');

    const probe = (await byName('fetch_url').execute({
      url: `http://127.0.0.1:${started.port}/status`,
      record: true,
    })) as { ok: boolean; recorded?: boolean };
    expect(probe.ok).toBe(true);
    expect(probe.recorded).toBe(true);

    const entries = readManifestEntries(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe('/status');
    expect(entries[0]!.entry).toBe('server.js');
  });
});

describe('fetch_url stamps ONLY what this tool set actually started', () => {
  let root: string;
  let sandbox: ToolSandbox;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'atoma-entry-unstamped-'));
    sandbox = new ToolSandbox(root);
    server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('foreign');
    });
    // 0.0.0.0 so the same port answers on loopback AND on this host's own
    // IPv4 address — the controlled pair the host-rule test below needs.
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sandbox.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  it('records NO entry key for a loopback port start_node_server never started', async () => {
    // Empty channel: a server this run did not spawn is a server this run
    // cannot name. Omission means "unknown", and the field must be ABSENT
    // rather than empty/null, because a replayer distinguishes the two.
    const nodeServers: NodeServerEntries = new Map();
    const fetchUrl = fetchUrlTool({ sandbox, nodeServers });

    const probe = (await fetchUrl.execute({
      url: `http://127.0.0.1:${port}/foreign`,
      record: true,
    })) as { ok: boolean; recorded?: boolean };
    expect(probe.ok).toBe(true);
    expect(probe.recorded).toBe(true);

    const entries = readManifestEntries(root);
    expect(entries).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(entries[0]!, 'entry')).toBe(false);
    // Still valid evidence — the stamp is an enrichment, never a requirement.
    expect(validateProbeManifest(readFileSync(join(root, PROBE_MANIFEST_FILENAME), 'utf8'))).toEqual(
      []
    );
  });

  it('does not stamp a DIFFERENT port than the one that was started', async () => {
    // The lookup is exact and the bound port is OS-assigned: a map holding
    // 443 (the external-API port an L1 might also have fetched) must not
    // bleed onto an unrelated loopback request.
    const nodeServers: NodeServerEntries = new Map([[443, 'server.js']]);
    expect(nodeServers.has(port)).toBe(false);
    const fetchUrl = fetchUrlTool({ sandbox, nodeServers });

    await fetchUrl.execute({ url: `http://127.0.0.1:${port}/other`, record: true });

    const entries = readManifestEntries(root);
    expect(entries).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(entries[0]!, 'entry')).toBe(false);
  });

  // Same port, same map, same live server — ONLY the hostname differs. That
  // isolates the loopback rule itself: a non-loopback host is never stamped,
  // even when the port is one we started, because an external service
  // answering on that port is not our server and stamping it would
  // MANUFACTURE evidence. Skipped when the host exposes no non-internal IPv4
  // (nothing leaves the machine either way — this is not a network test).
  const externalIp = hostIpv4();
  it.skipIf(externalIp === undefined)(
    'does not stamp a non-loopback host on a port it did start',
    async () => {
      const nodeServers: NodeServerEntries = new Map([[port, 'server.js']]);
      const fetchUrl = fetchUrlTool({ sandbox, nodeServers });

      // Control: loopback spelling of the very same port IS stamped.
      const loopback = (await fetchUrl.execute({
        url: `http://127.0.0.1:${port}/control`,
        record: true,
      })) as { ok: boolean };
      expect(loopback.ok).toBe(true);

      const external = (await fetchUrl.execute({
        url: `http://${externalIp!}:${port}/external`,
        record: true,
      })) as { ok: boolean };
      expect(external.ok).toBe(true);

      const entries = readManifestEntries(root);
      expect(entries.map((e) => e.path)).toEqual(['/control', '/external']);
      expect(entries[0]!.entry).toBe('server.js');
      expect(Object.prototype.hasOwnProperty.call(entries[1]!, 'entry')).toBe(false);
    }
  );

  it('leaves no manifest at all when record is not requested', async () => {
    const nodeServers: NodeServerEntries = new Map([[port, 'server.js']]);
    const fetchUrl = fetchUrlTool({ sandbox, nodeServers });
    const res = (await fetchUrl.execute({ url: `http://127.0.0.1:${port}/quiet` })) as {
      ok: boolean;
      recorded?: boolean;
    };
    expect(res.ok).toBe(true);
    expect(res.recorded).toBeUndefined();
    expect(existsSync(join(root, PROBE_MANIFEST_FILENAME))).toBe(false);
  });
});

describe('appendHttpProbe carries the stamp and keeps http entries a SEQUENCE', () => {
  it('preserves an "entry" field through the append', () => {
    const raw = appendHttpProbe(null, {
      probe: 'http',
      method: 'GET',
      path: '/health',
      status: 200,
      body: 'ok',
      entry: 'server.js',
    });
    const doc = JSON.parse(raw) as { version: number; entries: RecordedHttpEntry[] };
    expect(doc.version).toBe(1);
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0]!.entry).toBe('server.js');
  });

  it('appends the same route twice instead of merging by route', () => {
    // HTTP has NO entry identity: the same route legitimately appears several
    // times with different outcomes (POST /recipes → 201, then 400). Merging
    // on the route would collapse the sequence and delete the error cases —
    // and the stamp must survive that ordering unchanged.
    const first = appendHttpProbe(null, {
      probe: 'http',
      method: 'POST',
      path: '/recipes',
      status: 201,
      body: '{"id":1}',
      entry: 'server.js',
    });
    const second = appendHttpProbe(first, {
      probe: 'http',
      method: 'POST',
      path: '/recipes',
      status: 400,
      body: 'missing fields',
      entry: 'server.js',
    });
    const doc = JSON.parse(second) as { entries: RecordedHttpEntry[] };
    expect(doc.entries).toHaveLength(2);
    expect(doc.entries.map((e) => e.status)).toEqual([201, 400]);
    expect(doc.entries.map((e) => e.entry)).toEqual(['server.js', 'server.js']);
  });

  it('keeps entries a valid manifest that also survives a shape check', () => {
    const raw = appendHttpProbe(
      appendHttpProbe(null, { probe: 'http', method: 'GET', path: '/a', status: 200 }),
      { probe: 'http', method: 'GET', path: '/a', status: 500, entry: 'server.js' }
    );
    expect(validateProbeManifest(raw)).toEqual([]);
  });
});

describe('validateProbeManifest tolerates the machine stamp', () => {
  it('reports no problem for an http entry carrying "entry"', () => {
    const manifest = JSON.stringify({
      version: 1,
      entries: [
        {
          probe: 'http',
          method: 'GET',
          path: '/health',
          status: 200,
          body: '{"ok":true}',
          entry: 'server.js',
        },
      ],
    });
    // The field is UNTAUGHT and forward-compatible: the health check must not
    // report an unknown extra field, or every stamped manifest would be
    // MALFORMED to the read-back probe that gates the result.
    expect(validateProbeManifest(manifest)).toEqual([]);
  });

  it('still reports a genuinely malformed http entry that carries the stamp', () => {
    // Tolerance is for UNKNOWN fields only — it must not become a blanket
    // pass that hides a missing canonical field.
    const manifest = JSON.stringify({
      version: 1,
      entries: [{ probe: 'http', method: 'GET', path: '/health', entry: 'server.js' }],
    });
    const problems = validateProbeManifest(manifest);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/missing numeric "status"/);
  });
});
