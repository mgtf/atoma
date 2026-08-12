import { Writable } from 'node:stream';

/**
 * Claim fd 1 for MCP before the application import graph is loaded.
 *
 * The returned stream owns the original write function. Every later write to
 * process.stdout — console.log included — is redirected to stderr.
 */
export function claimStdoutForProtocol(): Writable {
  const realWrite = process.stdout.write.bind(process.stdout);
  const protocolOut = new Writable({
    write(
      chunk: string | Uint8Array,
      encoding: BufferEncoding,
      callback: (error?: Error | null) => void
    ) {
      realWrite(chunk, encoding, callback);
    },
  });
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding,
    callback?: (error?: Error | null) => void
  ): boolean => process.stderr.write(chunk, encoding, callback)) as typeof process.stdout.write;
  return protocolOut;
}
