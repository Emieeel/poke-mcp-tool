/**
 * worker.ts — Cloudflare Workers entry point (hosted, "paste-a-URL" deployment).
 *
 * Same ten MCP tools as the stdio server (src/index.ts), exposed over the MCP **Streamable
 * HTTP** transport so any remote MCP client can connect by URL — no local install, works from
 * Claude web/mobile, Cursor, etc.
 *
 * Why this file exists separately:
 *   - Workers has NO filesystem, so the data modules can't readFileSync. We `import` the JSON
 *     (esbuild/wrangler inline it into the bundle) and INJECT it via provide*Data() at startup.
 *   - We use the **web-standard** transport (Request/Response), which runs on Workers natively.
 *   - The server is **stateless** (sessionIdGenerator: undefined) and **unauthenticated** —
 *     correct here because every tool is read-only over public Pokémon data (no secrets, no
 *     user state). A fresh server+transport is created per request to avoid any cross-request
 *     state, which is also the simplest correct model on Workers.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from './server.js';
import { provideDexData } from './dex.js';
import { provideItemsData } from './items.js';
import { provideRegulationData } from './regulations.js';

// Data bundled into the Worker at build time (no filesystem at runtime). The `with { type:
// 'json' }` import attribute is required under NodeNext and accepted by esbuild/wrangler.
// Every regulation must be imported and injected explicitly — Workers can't enumerate a
// directory the way the stdio server's diskdata.ts does, so a new regulations/<id>.json is
// invisible here until it's added below.
import dexData from '../data/champions-dex.json' with { type: 'json' };
import itemsData from '../data/champions-items.json' with { type: 'json' };
import mbRegulation from '../regulations/m-b.json' with { type: 'json' };
import mcRegulation from '../regulations/m-c.json' with { type: 'json' };

// Inject once, at module load (module scope persists across requests on a warm isolate).
provideDexData(dexData);
provideItemsData(itemsData);
provideRegulationData('m-b', mbRegulation);
provideRegulationData('m-c', mcRegulation);

// CORS so browser-based MCP clients can connect. The data is public, so `*` is fine.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function json(body: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight.
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    // Health check / landing — handy for "is it up?" without an MCP client.
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        name: 'pokemon-champions',
        status: 'ok',
        transport: 'streamable-http',
        mcpEndpoint: '/mcp',
        tools: 10,
      });
    }

    // MCP endpoint.
    if (url.pathname === '/mcp') {
      // Stateless: a fresh server + transport per request (no session, no shared state).
      const server = createServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        const res = await transport.handleRequest(request);
        return withCors(res);
      } finally {
        // Release per-request resources.
        await transport.close();
        await server.close();
      }
    }

    return json({ error: `Not found: ${url.pathname}. MCP endpoint is /mcp.` }, 404);
  },
};
