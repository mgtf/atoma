import { createInterface } from 'node:readline';
import { createConnection, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { ToolSandbox } from './sandbox.js';
import { defaultBuiltinTools } from './builtin.js';
import { InMemoryToolRegistry } from './registry.js';
import { encodeMessage, toolCallRequestSchema, WORKER_FRAME_BYTES } from '../contracts/workerProtocol.js';
import type { Logger } from '../core/types.js';

/** The same tool loop serves legacy stdio and the launcher-issued private socket. */
function serve(root: string, input: Readable, output: Writable, socket?: Socket): void {
  const sandbox = new ToolSandbox(root);
  const write = (message: Parameters<typeof encodeMessage>[0]) => {
    const line = encodeMessage(message);
    if (socket && (Buffer.byteLength(line) > WORKER_FRAME_BYTES || output.writableLength > WORKER_FRAME_BYTES)) {
      socket.destroy(); return;
    }
    if (!output.destroyed) output.write(line);
  };
  const log = (level: string, message: string, meta?: unknown) => {
    const text = `[worker${level}] ${message} ${meta ? JSON.stringify(meta) : ''}\n`;
    if (socket) write({ log: text });
    else process.stderr.write(text);
  };
  const logger: Logger = {
    debug: (m, v) => log('', m, v), info: (m, v) => log('', m, v),
    warn: (m, v) => log(':warn', m, v), error: (m, v) => log(':error', m, v),
  };
  const registry = new InMemoryToolRegistry();
  registry.registerAll(defaultBuiltinTools({ sandbox, logger }));
  write({ ready: true, tools: registry.declarations(), root: sandbox.root });
  // Bound a partial line before readline can retain it indefinitely.
  let bytes = 0;
  if (socket) socket.on('data', (chunk: Buffer) => {
    for (const byte of chunk) { bytes = byte === 10 ? 0 : bytes + 1; if (bytes > WORKER_FRAME_BYTES) { socket.destroy(); break; } }
  });
  const rl = createInterface({ input });
  const active = new Set<number>();
  rl.on('line', (line) => {
    if (socket?.destroyed) return;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    const parsed = toolCallRequestSchema.safeParse(raw);
    if (!parsed.success) { socket?.destroy(); return; }
    const req = parsed.data;
    if (active.size >= 256 || active.has(req.id)) { socket?.destroy(); return; }
    active.add(req.id);
    // Deliberately concurrent: a shell cannot block a read behind it.
    void (async () => {
      try { write({ id: req.id, ok: true, result: await registry.execute(req.name, req.args) }); }
      catch (error) { write({ id: req.id, ok: false, error: error instanceof Error ? error.message : 'Tool failed' }); }
      finally { active.delete(req.id); }
    })();
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void sandbox.cleanup().finally(() => process.exit(0));
  };
  rl.on('close', close);
  socket?.on('error', () => socket.destroy());
  socket?.on('close', close);
}

export function startWorker(root: string, socketPath?: string): void {
  if (!socketPath) { serve(root, process.stdin, process.stdout); return; }
  // The launcher owns the listening socket, mounted read-only as one file.
  // The worker can neither replace it nor reach a sibling run's endpoint.
  const socket = createConnection(socketPath);
  const timer = setTimeout(() => process.exit(1), 60_000);
  socket.on('error', () => process.exit(1));
  socket.once('connect', () => { clearTimeout(timer); serve(root, socket, socket, socket); });
}

if (process.argv[1] && /worker\.(ts|js)$/.test(process.argv[1])) {
  startWorker(process.env['ATOMA_WORKER_ROOT'] ?? '/workspace', process.env['ATOMA_WORKER_SOCKET']);
}
