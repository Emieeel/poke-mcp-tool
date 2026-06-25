#!/usr/bin/env node
/**
 * index.ts — stdio entry point for the Pokémon Champions MCP server.
 *
 * Transport: stdio (the client launches this as a subprocess). This is the default for
 * desktop MCP clients (Claude Desktop, Claude Code, Cursor) that run the server locally.
 * IMPORTANT: stdout is the protocol channel — we log ONLY to stderr.
 *
 * The tool definitions live in src/server.ts (transport-agnostic). For the hosted HTTP
 * deployment see src/worker.ts (Cloudflare Workers). We re-export createServer so existing
 * importers (e.g. the smoke test) keep working.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
// Side-effect import: registers the filesystem data loaders with the pure data modules.
// MUST come before createServer() is used so tools can lazily read their JSON from disk.
import './diskdata.js';
import { createServer } from './server.js';

export { createServer };

// ---- start -----------------------------------------------------------------

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is reserved for the MCP protocol.
  console.error('[pokemon-champions] MCP server running on stdio.');
}

// Only auto-start the stdio server when this file is executed directly (not when
// imported by the test harness).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[pokemon-champions] fatal:', err);
    process.exit(1);
  });
}
