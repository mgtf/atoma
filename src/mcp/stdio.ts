#!/usr/bin/env tsx

/**
 * Minimal MCP bootstrap.
 *
 * This file must stay quiet and tiny: claim stdout first, THEN dynamically
 * import the server and its dependencies. A static server import would execute
 * the whole ESM graph before fd 1 was protected.
 */
import { claimStdoutForProtocol } from './protocolStdout.js';

const protocolOut = claimStdoutForProtocol();
const { boot } = await import('./server.js');
await boot(protocolOut);
